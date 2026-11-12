import base64
import previews
import os, sqlite3, secrets, functools, unicodedata, time, io, warnings, json
from pathlib import Path
from contextlib import contextmanager
from urllib.parse import urlsplit
from datetime import timedelta, datetime, timezone
from PIL import Image, ImageOps, UnidentifiedImageError
from flask import Flask, request, session, jsonify, abort, send_file
from werkzeug.security import generate_password_hash, check_password_hash

RELEASES = json.loads((Path(__file__).parent/'CHANGELOG.json').read_text())

DATA = Path(os.environ.get('DATA_DIR', 'data'))
DATA.mkdir(parents=True, exist_ok=True)
(DATA / 'uploads').mkdir(exist_ok=True)
key = DATA / 'secret'
if not key.exists():
    key.write_text(secrets.token_hex(32)); key.chmod(0o600)
app = Flask(__name__, static_url_path='/static')
app.config.update(SECRET_KEY=key.read_text(), MAX_CONTENT_LENGTH=2*1024*1024 + 65536,
    SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=os.environ.get('HTTPS') == '1', PERMANENT_SESSION_LIFETIME=timedelta(days=7))
def username_key(value):
    return unicodedata.normalize("NFKC", value).casefold()

def topic_key(value):
    return " ".join(username_key(value).split())

@contextmanager
def db():
    c = sqlite3.connect(DATA / 'league.db'); c.row_factory = sqlite3.Row
    c.create_collation('USERNAME', lambda a,b: (username_key(a)>username_key(b))-(username_key(a)<username_key(b)))
    c.create_collation('TOPIC', lambda a,b: (topic_key(a)>topic_key(b))-(topic_key(a)<topic_key(b)))
    c.execute('PRAGMA foreign_keys=ON')
    try:
        with c: yield c
    finally:
        c.close()
with db() as c:
    c.executescript('''
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, name TEXT UNIQUE, password TEXT, admin INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS rounds(id INTEGER PRIMARY KEY, title TEXT, phase TEXT DEFAULT 'topics', topic TEXT DEFAULT '', deadline TEXT);
    CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, round_id INTEGER REFERENCES rounds, title TEXT, UNIQUE(round_id,title));
    CREATE TABLE IF NOT EXISTS votes(round_id INTEGER REFERENCES rounds, user_id INTEGER REFERENCES users, topic_id INTEGER REFERENCES topics, PRIMARY KEY(round_id,user_id,topic_id));
    CREATE TABLE IF NOT EXISTS participants(round_id INTEGER REFERENCES rounds, user_id INTEGER REFERENCES users, status TEXT, PRIMARY KEY(round_id,user_id));
    CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, round_id INTEGER REFERENCES rounds, user_id INTEGER REFERENCES users, title TEXT, filename TEXT DEFAULT '', stored TEXT DEFAULT '', UNIQUE(round_id,user_id));
    CREATE TABLE IF NOT EXISTS winners(round_id INTEGER REFERENCES rounds, category TEXT, entry_id INTEGER REFERENCES entries, PRIMARY KEY(round_id,category));
    CREATE TABLE IF NOT EXISTS print_links(id INTEGER PRIMARY KEY, round_id INTEGER REFERENCES rounds, user_id INTEGER REFERENCES users, title TEXT, url TEXT, UNIQUE(round_id,user_id,url));
    CREATE TABLE IF NOT EXISTS feature_ideas(id INTEGER PRIMARY KEY, title TEXT, description TEXT DEFAULT '', stage TEXT DEFAULT 'ideas', user_id INTEGER REFERENCES users, created_at REAL);
    CREATE TABLE IF NOT EXISTS app_meta(key TEXT PRIMARY KEY, value TEXT);

    ''')
    if not c.execute("SELECT 1 FROM app_meta WHERE key='feature_board_seed'").fetchone():
        c.execute('INSERT INTO feature_ideas(title,description,stage,created_at) VALUES(?,?,?,?)',
                  ('Print link previews', 'Turn MakerWorld and Printables links into rich preview badges on completed competitions.', 'ideas', time.time()))
        c.execute("INSERT INTO app_meta VALUES('feature_board_seed','1')")
    columns = {r['name'] for r in c.execute('PRAGMA table_info(users)')}
    for column, declaration in [('display_name', "TEXT NOT NULL DEFAULT ''"), ('session_version', 'INTEGER NOT NULL DEFAULT 0'), ('avatar', "TEXT NOT NULL DEFAULT ''")]:
        if column not in columns: c.execute(f'ALTER TABLE users ADD COLUMN {column} {declaration}')
    # Fail clearly on legacy collisions rather than silently merging people's accounts.
    try:
        c.execute('CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(name COLLATE USERNAME)')
    except sqlite3.IntegrityError:
        raise RuntimeError('Existing usernames differ only by capitalization or Unicode normalization. Rename the conflicting accounts before starting.')
    for table, additions in {
        'rounds': [('creator_id','INTEGER REFERENCES users'), ('has_prevote','INTEGER NOT NULL DEFAULT 0'),
                   ('voting_started_at','REAL'), ('vote_opens_at','REAL'), ('votes_close_at','REAL'), ('printing_started_at','REAL'),
                   ('created_at','REAL NOT NULL DEFAULT 0')],
        'topics': [('user_id','INTEGER REFERENCES users')],
        'print_links': [('preview_image', "TEXT NOT NULL DEFAULT ''")],
    }.items():
        columns = {r['name'] for r in c.execute(f'PRAGMA table_info({table})')}
        for column, declaration in additions:
            if column not in columns: c.execute(f'ALTER TABLE {table} ADD COLUMN {column} {declaration}')
    # Upgrade the vote key without discarding existing votes.
    vote_key=[r['name'] for r in sorted(c.execute('PRAGMA table_info(votes)'), key=lambda r:r['pk']) if r['pk']]
    if vote_key == ['round_id','user_id']:
        c.execute('ALTER TABLE votes RENAME TO votes_single_choice')
        c.execute('CREATE TABLE votes(round_id INTEGER REFERENCES rounds, user_id INTEGER REFERENCES users, topic_id INTEGER REFERENCES topics, PRIMARY KEY(round_id,user_id,topic_id))')
        c.execute('INSERT INTO votes SELECT round_id,user_id,topic_id FROM votes_single_choice')
        c.execute('DROP TABLE votes_single_choice')
    c.execute("UPDATE rounds SET voting_started_at=CASE WHEN vote_opens_at<=? THEN vote_opens_at ELSE created_at END WHERE phase='topics' AND voting_started_at IS NULL", (time.time(),))
    # Preserve votes when consolidating legacy duplicate topic spellings.
    seen = {}
    for t in c.execute('SELECT id,round_id,title FROM topics ORDER BY id').fetchall():
        key = (t['round_id'], topic_key(t['title']))
        if key in seen:
            c.execute('INSERT OR IGNORE INTO votes SELECT round_id,user_id,? FROM votes WHERE topic_id=?', (seen[key], t['id']))
            c.execute('DELETE FROM votes WHERE topic_id=?', (t['id'],))
            c.execute('DELETE FROM topics WHERE id=?', (t['id'],))
        else: seen[key] = t['id']
    c.execute('CREATE UNIQUE INDEX IF NOT EXISTS topics_title_unique ON topics(round_id,title COLLATE TOPIC)')


def timestamp(value, label='date'):
    try:
        if len(value) == 10: value += 'T23:59:59+00:00'  # Legacy date-only deadlines.
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None: raise ValueError()
        return parsed.timestamp()
    except (ValueError, TypeError, AttributeError, OverflowError):
        abort(400, f'Invalid {label}. Include a date, time, and timezone.')


def leaders(c, rid):
    rows = c.execute('SELECT t.id,t.title,COUNT(v.user_id) AS votes FROM topics t LEFT JOIN votes v ON v.topic_id=t.id AND v.round_id=t.round_id WHERE t.round_id=? GROUP BY t.id ORDER BY votes DESC,t.id', (rid,)).fetchall()
    return [t for t in rows if t['votes'] == rows[0]['votes']] if rows else []


def close_poll(c, r, now):
    top = leaders(c, r['id'])
    if len(top) == 1:
        c.execute("UPDATE rounds SET phase='printing',topic=?,printing_started_at=? WHERE id=?", (top[0]['title'], now, r['id']))
    else:
        c.execute("UPDATE rounds SET phase=? WHERE id=?", ('tie' if top else 'no_topics', r['id']))


def sync_rounds(c, now):
    for r in c.execute("SELECT * FROM rounds WHERE phase='submissions' AND vote_opens_at IS NOT NULL AND vote_opens_at<=?", (now,)).fetchall():
        c.execute("UPDATE rounds SET phase='topics',voting_started_at=? WHERE id=?", (r['vote_opens_at'],r['id']))
    for r in c.execute("SELECT * FROM rounds WHERE phase IN ('submissions','topics') AND votes_close_at IS NOT NULL AND votes_close_at<=?", (now,)).fetchall():
        close_poll(c, r, r['votes_close_at'])
    # Even manually managed polls cannot run beyond the competition deadline.
    for r in c.execute("SELECT * FROM rounds WHERE phase IN ('submissions','topics','printing')").fetchall():
        if timestamp(r['deadline']) <= now:
            if r['phase'] in ('submissions','topics'): close_poll(c, r, timestamp(r['deadline']))
            c.execute("UPDATE rounds SET phase='judging' WHERE id=? AND phase='printing'", (r['id'],))


def user():
    with db() as c:
        u = c.execute('SELECT id,name,display_name,avatar,admin,password IS NOT NULL AND length(password) > 0 AS has_password,session_version FROM users WHERE id=?',(session.get('uid'),)).fetchone()
    if u and session.get('version', 0) == u['session_version']: return u
    return None
def protected(admin=False):
    def deco(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            u=user()
            if not u: abort(401)
            if admin and not u['admin']: abort(403)
            return fn(*args, **kwargs)
        return wrapped
    return deco
@app.before_request
def csrf():
    if request.path == '/api/profile/avatar': request.max_content_length = 2*1024*1024 + 65536
    if request.method == 'POST' and request.headers.get('X-CSRF-Token') != session.get('csrf', secrets.token_hex(32)): abort(403)
@app.before_request
def scheduled_transitions():
    if request.path.startswith('/api/') and user():
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            sync_rounds(c, time.time())

@app.after_request
def headers(r):
    r.headers['X-Content-Type-Options']='nosniff'
    r.headers['Content-Security-Policy']="default-src 'self'; img-src 'self' https://makerworld.bblmw.com https://media.printables.com https://media.prusaprinters.org; style-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    r.headers['Cache-Control']='no-store'
    return r
@app.errorhandler(400)
@app.errorhandler(401)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(409)
@app.errorhandler(413)
def error(e):
    if e.code == 404 and not request.path.startswith('/api/'):
        return app.send_static_file('404.html'), 404
    return jsonify(error=e.description), e.code
def field(name, maximum=160):
    v=str(request.json.get(name,'')).strip()
    if not v or len(v)>maximum: abort(400, f'Invalid {name}')
    return v
@app.get('/favicon.ico')
def favicon(): return app.send_static_file('assets/benchy.svg')

@app.get('/')
def index(): return app.send_static_file('index.html')
@app.get('/api/state')
def state():
    session.setdefault('csrf',secrets.token_hex(24)); u=user()
    result={'csrf':session['csrf'], 'user':dict(u) if u else None, 'server_now':time.time(), 'releases':RELEASES}
    if u:
        with db() as c:
            for table in ['rounds','topics','votes','participants','entries','winners','print_links','feature_ideas']:
                result[table]=[dict(r) for r in c.execute('SELECT * FROM '+table)]
            for entry in result['entries']: entry.pop('stored')
            result['users']=[dict(r) for r in c.execute('SELECT id,name,display_name,avatar FROM users')]
    return jsonify(result)
@app.post('/api/auth/<action>')
def auth(action):
    if action=='logout': session.clear(); return jsonify(ok=True)
    if action=='invitation':
        with db() as c:
            valid=c.execute('SELECT 1 FROM invites WHERE code=?',(field('invite'),)).fetchone()
        if not valid: abort(403,'This invitation is invalid or already used. Ask an admin for a new one.')
        return jsonify(ok=True,google_allowed=False)
    name=field('name',40); password=field('password',256)
    with db() as c:
        if action=='register':
            if password != request.json.get('confirm_password'): abort(400, 'Passwords do not match.')
            if len(password)<6: abort(400,'Use at least 6 characters for your password.')
            # Atomic invite consumption prevents reuse during simultaneous requests.
            c.execute('BEGIN IMMEDIATE')
            if c.execute('DELETE FROM invites WHERE code=?',(field('invite'),)).rowcount!=1: abort(403,'Invalid or used invite.')
            try: c.execute('INSERT INTO users(name,password) VALUES(?,?)',(name,generate_password_hash(password)))
            except sqlite3.IntegrityError: abort(409,'That name is already taken.')
        elif action!='login': abort(404)
        u=c.execute('SELECT * FROM users WHERE name=? COLLATE USERNAME',(name,)).fetchone()
        if not u or not u['password'] or not check_password_hash(u['password'],password): abort(401,'Incorrect name or password.')
    session.clear(); session['uid']=u['id']; session['version']=u['session_version']; session['auth_at']=time.time(); session['csrf']=secrets.token_hex(24); session.permanent=True
    return jsonify(ok=True)
@app.get('/api/username-availability')
def username_availability():
    candidate = request.args.get('name', '').strip()
    if not candidate or len(candidate) > 40: abort(400, 'Use a username between 1 and 40 characters.')
    u = user()
    with db() as c:
        existing = c.execute('SELECT id FROM users WHERE name=? COLLATE USERNAME', (candidate,)).fetchone()
    return jsonify(available=not existing or bool(u and existing['id'] == u['id']))

@app.post('/api/profile')
@protected()
def profile():
    display_name = field('display_name', 80)
    with db() as c: c.execute('UPDATE users SET display_name=? WHERE id=?', (display_name, user()['id']))
    return jsonify(ok=True)

@app.post('/api/profile/avatar')
@protected()
def upload_avatar():
    f = request.files.get('file')
    if not f: abort(400, 'Choose a JPEG, PNG, or WebP photo.')
    raw = f.stream.read(2*1024*1024+1)
    if len(raw) > 2*1024*1024: abort(413, 'Profile photos must be 2 MB or smaller.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw), formats=['JPEG','PNG','WEBP']) as original:
                if original.width*original.height > 16_000_000: abort(400, 'Photo must be at most 16 megapixels.')
                if getattr(original, 'is_animated', False): abort(400, 'Choose a still photo rather than an animation.')
                original.load()
                photo = ImageOps.fit(ImageOps.exif_transpose(original).convert('RGB'), (512,512), method=Image.Resampling.LANCZOS)
                photo.info.clear()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        abort(400, 'That file is not a supported photo. Use JPEG, PNG, or WebP.')
    folder = DATA/'avatars'; folder.mkdir(exist_ok=True)
    filename = secrets.token_hex(24)+'.webp'
    photo.save(folder/filename, 'WEBP', quality=88)
    try:
        with db() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT avatar FROM users WHERE id=?', (user()['id'],)).fetchone()['avatar']
            c.execute('UPDATE users SET avatar=? WHERE id=?', (filename,user()['id']))
    except Exception:
        (folder/filename).unlink(missing_ok=True)
        raise
    if old: (folder/old).unlink(missing_ok=True)
    return jsonify(ok=True)

@app.get('/api/users/<int:uid>/avatar')
@protected()
def avatar(uid):
    with db() as c: row = c.execute('SELECT avatar FROM users WHERE id=?', (uid,)).fetchone()
    if not row or not row['avatar']: abort(404)
    return send_file((DATA/'avatars'/row['avatar']).resolve(), mimetype='image/webp')

@app.post('/api/profile/credentials')
@protected()
def credentials():
    uid = user()['id']
    name = field('name', 40)
    password = field('password', 256)
    if len(password) < 6: abort(400, 'Use at least 6 characters for your password.')
    if password != request.json.get('confirm_password'): abort(400, 'Passwords do not match.')
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        u = c.execute('SELECT * FROM users WHERE id=?', (uid,)).fetchone()
        if u['password']:
            if not check_password_hash(u['password'], request.json.get('current_password', '')):
                abort(403, 'Your current password is incorrect.')
        else:
            # An OAuth callback must establish these server-owned session values.
            # No client request may claim a provider or a recent authentication.
            if session.get('auth_provider') != 'google' or time.time()-session.get('auth_at', 0) > 600:
                abort(403, 'Sign in again with Google before adding a password.')
        try:
            c.execute('UPDATE users SET name=?,password=?,session_version=session_version+1 WHERE id=?',
                      (name, generate_password_hash(password), uid))
        except sqlite3.IntegrityError: abort(409, 'That username is already taken, regardless of capitalization.')
        version = u['session_version'] + 1
    session.clear()
    session.update(uid=uid, version=version, csrf=secrets.token_hex(24), auth_at=time.time())
    session.permanent = True
    return jsonify(ok=True)

@app.post('/api/invites')
@protected(True)
def invite():
    code=secrets.token_urlsafe(18)
    with db() as c: c.execute('INSERT INTO invites VALUES(?)',(code,))
    return jsonify(code=code)
@app.post('/api/rounds')
@protected(True)
def create_round():
    now = time.time(); payload = request.get_json(silent=True) or {}
    deadline = timestamp(field('deadline'), 'competition deadline')
    prevote = payload.get('prevote') in (True, 'on', 'true', '1')
    opens = timestamp(payload['vote_opens_at'], 'voting start') if payload.get('vote_opens_at') else None
    closes = timestamp(payload['votes_close_at'], 'poll closing time') if payload.get('votes_close_at') else None
    if deadline <= now: abort(400, 'The competition deadline must be in the future.')
    if opens and not prevote: abort(400, 'Enable topic collection to schedule voting to start later.')
    if opens and not now < opens < deadline: abort(400, 'Voting must start in the future and before the competition ends.')
    if closes and not (opens or now) < closes < deadline: abort(400, 'The poll must close after voting starts and before the competition ends.')
    with db() as c:
        c.execute('INSERT INTO rounds(title,deadline,phase,creator_id,has_prevote,vote_opens_at,votes_close_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
                  (field('title'), datetime.fromtimestamp(deadline,timezone.utc).isoformat(), 'submissions' if prevote else 'topics', user()['id'], int(prevote), opens, closes, now))
    return jsonify(ok=True)

@app.post('/api/rounds/<int:rid>/<action>')
@protected()
def round_action(rid,action):
    u=user()
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        sync_rounds(c, time.time())
        r=c.execute('SELECT * FROM rounds WHERE id=?',(rid,)).fetchone()
        if not r: abort(404)
        phase=r['phase']; payload=request.get_json(silent=True) or {}
        manager = bool(u['admin'] or r['creator_id']==u['id'])
        collecting = phase=='submissions' or (phase=='topics' and not r['has_prevote'])
        if action=='delete-competition' and u['admin']:
            # Legacy SQLite tables do not have cascading foreign keys.
            for table in ['print_links','winners','entries','participants','votes','topics']:
                c.execute('DELETE FROM '+table+' WHERE round_id=?',(rid,))
            c.execute('DELETE FROM rounds WHERE id=?',(rid,))
        elif action=='topic' and collecting:
            title = ' '.join(field('title').split())
            try: c.execute('INSERT INTO topics(round_id,title,user_id) VALUES(?,?,?)',(rid,title,u['id']))
            except sqlite3.IntegrityError: abort(409,'That topic has already been proposed, regardless of capitalization or spacing.')
        elif action=='delete-topic' and collecting:
            tid=payload.get('topic_id')
            t=c.execute('SELECT * FROM topics WHERE id=? AND round_id=?',(tid,rid)).fetchone()
            if not t or t['user_id']!=u['id']: abort(403,'You can only delete your own topics during topic collection.')
            if c.execute('SELECT 1 FROM votes WHERE topic_id=?',(tid,)).fetchone(): abort(409,'A topic with votes can no longer be deleted.')
            c.execute('DELETE FROM topics WHERE id=?',(tid,))
        elif action=='vote' and phase=='topics':
            tid=payload.get('topic_id')
            if not c.execute('SELECT 1 FROM topics WHERE id=? AND round_id=?',(tid,rid)).fetchone(): abort(400)
            c.execute('INSERT OR IGNORE INTO votes VALUES(?,?,?)',(rid,u['id'],tid))
        elif action=='open-voting' and manager and phase=='submissions':
            if not c.execute('SELECT 1 FROM topics WHERE round_id=?',(rid,)).fetchone(): abort(400,'Add at least one topic before opening voting.')
            if r['votes_close_at'] and r['votes_close_at']<=time.time(): abort(400,'The scheduled poll closing time has passed.')
            c.execute("UPDATE rounds SET phase='topics',voting_started_at=? WHERE id=?",(time.time(),rid))
        elif action in ('close-poll','advance') and manager and phase=='topics':
            close_poll(c, r, time.time())
        elif action=='resolve-tie' and manager and phase=='tie':
            top=leaders(c,rid)
            winner=next((t for t in top if str(t['id'])==str(payload.get('topic_id'))),None)
            if not winner: abort(400,'Choose one of the tied leading topics.')
            c.execute("UPDATE rounds SET phase='printing',topic=?,printing_started_at=? WHERE id=?",(winner['title'],time.time(),rid))
        elif action=='reopen-topics' and manager and phase=='no_topics':
            if timestamp(r['deadline'])<=time.time(): abort(400,'This competition has ended. Create a new round.')
            c.execute("UPDATE rounds SET phase='submissions',has_prevote=1,vote_opens_at=NULL,votes_close_at=NULL,voting_started_at=NULL WHERE id=?",(rid,))
        elif action=='archive-empty' and manager and phase=='no_topics':
            c.execute("UPDATE rounds SET phase='completed' WHERE id=?",(rid,))
        elif action=='participate' and phase in ('submissions','topics','tie','printing') and time.time()<timestamp(r['deadline']):
            status=payload.get('status')
            if status not in ('in','out'): abort(400)
            c.execute('INSERT OR REPLACE INTO participants VALUES(?,?,?)',(rid,u['id'],status))
        elif action=='entry' and phase=='printing':
            if not c.execute("SELECT 1 FROM participants WHERE round_id=? AND user_id=? AND status='in'",(rid,u['id'])).fetchone(): abort(403,'Join this round before submitting.')
            c.execute('INSERT INTO entries(round_id,user_id,title) VALUES(?,?,?) ON CONFLICT(round_id,user_id) DO UPDATE SET title=excluded.title',(rid,u['id'],field('title')))
        elif action=='advance' and manager and phase in ('printing','judging'):
            if phase=='judging' and not c.execute('SELECT 1 FROM winners WHERE round_id=?',(rid,)).fetchone():
                if c.execute("SELECT 1 FROM entries e JOIN participants p ON p.round_id=e.round_id AND p.user_id=e.user_id WHERE e.round_id=? AND p.status='in'",(rid,)).fetchone():
                    abort(400,'Record at least one category winner first.')
            c.execute('UPDATE rounds SET phase=? WHERE id=?',('judging' if phase=='printing' else 'completed',rid))
        elif action=='winner' and u['admin'] and phase=='judging':
            eid=payload.get('entry_id')
            if not c.execute("SELECT 1 FROM entries e JOIN participants p ON p.round_id=e.round_id AND p.user_id=e.user_id WHERE e.id=? AND e.round_id=? AND p.status='in'",(eid,rid)).fetchone(): abort(400,'Choose an eligible entry.')
            c.execute('INSERT OR REPLACE INTO winners VALUES(?,?,?)',(rid,field('category'),eid))
        else: abort(403,'This action is not available in this phase.')
        sync_rounds(c, time.time())
    return jsonify(ok=True)
@app.post('/api/rounds/<int:rid>/links')
@protected()
def add_print_link(rid):
    uid = user()['id']
    url = field('url', 2048)
    try:
        parsed = urlsplit(url)
        if parsed.scheme.lower() not in ('https','http') or not parsed.hostname or parsed.username is not None or parsed.password is not None:
            raise ValueError()
        if any(ord(ch) < 33 or ch == '\\' for ch in url): raise ValueError()
        _ = parsed.port
    except ValueError:
        abort(400, 'Use a complete http:// or https:// print URL without spaces or login details.')
    preview_image = str((request.get_json(silent=True) or {}).get('preview_image','')).strip()
    if preview_image:
        try:
            picture = urlsplit(preview_image)
            if (len(preview_image)>2048 or picture.scheme!='https' or picture.hostname not in
                    ('makerworld.bblmw.com','media.printables.com','media.prusaprinters.org')
                    or picture.username or picture.password or picture.port not in (None,443)
                    or any(ord(ch)<33 or ch=='\\' for ch in preview_image)):
                raise ValueError()
        except ValueError:
            abort(400, 'Use a direct HTTPS image link from MakerWorld or Printables.')
    title = str((request.get_json(silent=True) or {}).get('title','')).strip() or parsed.hostname
    if len(title)>120: abort(400, 'Keep link titles to 120 characters or fewer.')
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        r = c.execute('SELECT phase FROM rounds WHERE id=?',(rid,)).fetchone()
        if not r or r['phase']!='completed' or not c.execute('SELECT 1 FROM winners WHERE round_id=?',(rid,)).fetchone():
            abort(403, 'Print links open after the competition is completed and an admin records the awards.')
        if not c.execute("SELECT 1 FROM participants WHERE round_id=? AND user_id=? AND status='in'",(rid,uid)).fetchone():
            abort(403, 'Only members who participated in this competition can share print links.')
        try: c.execute('INSERT INTO print_links(round_id,user_id,title,url,preview_image) VALUES(?,?,?,?,?)',(rid,uid,title,url,preview_image))
        except sqlite3.IntegrityError: abort(409, 'You already shared that link for this competition.')
    return jsonify(ok=True)

@app.get('/api/print-links/<int:lid>/preview')
@app.get('/api/print-links/<int:lid>/image')
@protected()
def print_preview(lid):
    with db() as c:
        link = c.execute('SELECT url,preview_image FROM print_links WHERE id=?', (lid,)).fetchone()
    if not link: abort(404)
    if link['preview_image'] and not request.path.endswith('/image'):
        return jsonify(platform=previews.platform(link['url']), title='',
                       description='Explore this model and its print profiles on the original listing.',
                       image_url=link['preview_image'])
    preview = previews.cached(link['url'], DATA/'previews').copy()
    image = preview.pop('image', '')
    if request.path.endswith('/image'):
        if not image: abort(404)
        return send_file(io.BytesIO(base64.b64decode(image)), mimetype='image/webp')
    preview['image_url'] = f'/api/print-links/{lid}/image' if image else ''
    return jsonify(preview)

@app.post('/api/print-links/<int:lid>/delete')
@protected()
def delete_print_link(lid):
    with db() as c:
        if c.execute('DELETE FROM print_links WHERE id=? AND user_id=?',(lid,user()['id'])).rowcount!=1:
            abort(403, 'You can only remove your own print links.')
    return jsonify(ok=True)

@app.post('/api/features')
@protected()
def add_feature():
    title = field('title',120)
    description = str((request.get_json(silent=True) or {}).get('description','')).strip()
    if len(description)>1000: abort(400, 'Keep idea descriptions to 1,000 characters or fewer.')
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        if c.execute('SELECT 1 FROM feature_ideas WHERE title=? COLLATE TOPIC',(title,)).fetchone(): abort(409, 'That idea is already on the board.')
        c.execute('INSERT INTO feature_ideas(title,description,user_id,created_at) VALUES(?,?,?,?)',(title,description,user()['id'],time.time()))
    return jsonify(ok=True)

@app.post('/api/features/<int:fid>/<action>')
@protected()
def update_feature(fid,action):
    u = user()
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        idea = c.execute('SELECT * FROM feature_ideas WHERE id=?',(fid,)).fetchone()
        if not idea: abort(404)
        if action=='move' and u['admin']:
            stage = field('stage',20)
            if stage not in ('ideas','progress','review'): abort(400, 'Choose a board column.')
            c.execute('UPDATE feature_ideas SET stage=? WHERE id=?',(stage,fid))
        elif action=='delete' and (u['admin'] or (idea['user_id']==u['id'] and idea['stage']=='ideas')):
            c.execute('DELETE FROM feature_ideas WHERE id=?',(fid,))
        else: abort(403, 'Only admins can move ideas; authors can remove their own ideas before work starts.')
    return jsonify(ok=True)

@app.post('/api/entries/<int:eid>/file')
@protected()
def upload(eid):
    abort(403, 'Project file uploads are disabled. Share a MakerWorld or Printables link instead.')
@app.get('/api/entries/<int:eid>/file')
@protected()
def download(eid):
    with db() as c: e=c.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone()
    if not e or not e['stored']: abort(404)
    return send_file((DATA/'uploads'/e['stored']).resolve(),as_attachment=True,download_name=e['filename'])
if __name__=='__main__':
    import argparse, getpass
    p=argparse.ArgumentParser(); p.add_argument('--create-admin'); args=p.parse_args()
    if args.create_admin:
        password=getpass.getpass('Admin password (6+ characters): ')
        if len(password)<6: raise SystemExit('Password too short')
        with db() as c: c.execute('INSERT INTO users(name,password,admin) VALUES(?,?,1)',(args.create_admin,generate_password_hash(password)))
        print('Administrator created.')
    else:
        from waitress import serve
        serve(app,host=os.environ.get('HOST','127.0.0.1'),port=int(os.environ.get('PORT','8080')))
