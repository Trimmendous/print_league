"""Add two repeatable local demo rounds without replacing existing league data.
Run: .venv/bin/python tools/seed_demo.py [--trophy-url https://makerworld.com/...]
"""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import DATA, db
from PIL import Image


def seed(trophy_url=None):
    if trophy_url:
        parsed = urlsplit(trophy_url)
        if (parsed.scheme != 'https' or parsed.hostname not in ('makerworld.com','www.makerworld.com')
                or not parsed.path.startswith('/en/models/') or parsed.username or parsed.password
                or parsed.port not in (None,443) or any(ord(ch)<33 or ch=='\\' for ch in trophy_url)):
            raise ValueError('Use the trophy’s https://makerworld.com/en/models/... URL.')
    now = time.time()
    iso = lambda stamp: datetime.fromtimestamp(stamp, timezone.utc).isoformat()
    # SQLite backup API makes a consistent copy even if the local app is running.
    backup = DATA / f'league-before-demo-{time.time_ns()}.sqlite'
    with sqlite3.connect(DATA/'league.db') as source, sqlite3.connect(backup) as target:
        source.backup(target)
    with db() as c:
        c.execute('BEGIN IMMEDIATE')
        owner = c.execute('SELECT id FROM users WHERE admin=1 ORDER BY id LIMIT 1').fetchone()
        if not owner:
            raise RuntimeError('Create an administrator before adding demo rounds.')
        owner = owner['id']
        winner = c.execute("SELECT id FROM users WHERE name='test-organizer' COLLATE USERNAME").fetchone()
        # Never create a new login or modify a password merely to seed a sample.
        winner = winner['id'] if winner else owner
        marker = c.execute("SELECT value FROM app_meta WHERE key='demo_rounds_v1'").fetchone()
        if marker:
            ids = json.loads(marker['value'])
        else:
            running = c.execute('INSERT INTO rounds(title,phase,topic,deadline,creator_id,created_at,printing_started_at) VALUES(?,?,?,?,?,?,?)',
                ('Sample · Tiny boats, big ideas','printing','A Benchy with a twist',iso(now+5*86400),owner,now-3*86400,now-2*86400)).lastrowid
            completed = c.execute('INSERT INTO rounds(title,phase,topic,deadline,creator_id,created_at,printing_started_at) VALUES(?,?,?,?,?,?,?)',
                ('Sample · Making waves','completed','Print a trophy worth winning',iso(now-86400),owner,now-10*86400,now-8*86400)).lastrowid
            for rid, topic in [(running,'A Benchy with a twist'),(completed,'Print a trophy worth winning')]:
                tid = c.execute('INSERT INTO topics(round_id,title,user_id) VALUES(?,?,?)',(rid,topic,owner)).lastrowid
                for uid in set((owner,winner)):
                    c.execute('INSERT INTO votes(round_id,user_id,topic_id) VALUES(?,?,?)',(rid,uid,tid))
                    c.execute('INSERT INTO participants(round_id,user_id,status) VALUES(?,?,?)',(rid,uid,'in'))
            c.execute('INSERT INTO entries(round_id,user_id,title) VALUES(?,?,?)',(running,winner,'Wave-rider Benchy — work in progress'))
            entry = c.execute('INSERT INTO entries(round_id,user_id,title) VALUES(?,?,?)',(completed,winner,'Making Waves · Benchy Trophy')).lastrowid
            c.execute('INSERT INTO winners(round_id,category,entry_id) VALUES(?,?,?)',(completed,'Best print',entry))
            ids = {'running':running,'completed':completed,'winner':winner}
            c.execute("INSERT INTO app_meta(key,value) VALUES('demo_rounds_v1',?)",(json.dumps(ids),))
        # A clearly labeled search is preferable to inventing a model ID.
        url = trophy_url or 'https://makerworld.com/en/search/models?keyword=Benchy%20Trophy'
        existing = c.execute("SELECT value FROM app_meta WHERE key='demo_trophy_link_v1'").fetchone()
        if existing:
            lid = int(existing['value'])
            if trophy_url:
                c.execute('UPDATE print_links SET url=?,title=? WHERE id=?',(url,'Making Waves · Benchy Trophy',lid))
            else:
                row = c.execute('SELECT url FROM print_links WHERE id=?',(lid,)).fetchone()
                if not row: raise RuntimeError('The demo link was removed; refusing to change unrelated data.')
                url = row['url']
        else:
            lid = c.execute('INSERT INTO print_links(round_id,user_id,title,url) VALUES(?,?,?,?)',
                (ids['completed'],ids['winner'],'Making Waves · Benchy Trophy' if trophy_url else 'Benchy Trophy · sample (source link pending)',url)).lastrowid
            c.execute("INSERT INTO app_meta(key,value) VALUES('demo_trophy_link_v1',?)",(str(lid),))
    with db() as c:
        if '/search/' in url:
            c.execute("UPDATE print_links SET preview_image='/static/assets/benchy-trophy.png' WHERE id=?", (lid,))
        elif trophy_url:
            c.execute("UPDATE print_links SET preview_image='' WHERE id=?", (lid,))
        deadline = c.execute('SELECT deadline FROM rounds WHERE id=?', (ids['running'],)).fetchone()['deadline']
    if '/search/' not in url:
        print(json.dumps({**ids, 'link': lid, 'url': url, 'backup': str(backup), 'running_deadline': deadline}, indent=2))
        return
    folder=DATA/'previews';folder.mkdir(exist_ok=True)
    with Image.open(ROOT/'static/assets/benchy-trophy.png') as image:
        image.thumbnail((720,860))
        out=io.BytesIO();image.save(out,'WEBP',quality=88)
    preview={'platform':'MakerWorld','title':'Making Waves · Benchy Trophy',
        'description':'Sample winning print, illustrated with our actual trophy rendering.' + (' Open the model on MakerWorld.' if '/models/' in url else ' Exact source link pending; opens a MakerWorld trophy search.'),
        'image':base64.b64encode(out.getvalue()).decode('ascii')}
    path=folder/(hashlib.sha256(url.encode()).hexdigest()+'.json')
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps({'saved':now,'preview':preview}));temporary.replace(path)
    print(json.dumps({**ids,'link':lid,'url':url,'backup':str(backup),'running_deadline':deadline},indent=2))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--trophy-url')
    seed(parser.parse_args().trophy_url)
