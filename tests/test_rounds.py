import io
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import patch
from PIL import Image
from test_flow import app, db

class Rounds(unittest.TestCase):
    def setUp(self):
        self.clear()
        self.now = int(time.time())
        self.clock = patch('app.time.time', return_value=self.now)
        self.clock.start()
        with db() as c:
            for name, admin in [('organizer',1),('maker',0),('other',0)]:
                c.execute('INSERT INTO users(name,password,admin) VALUES(?,?,?)',(name,'unused',admin))
        self.host=self.client(1);self.maker=self.client(2);self.other=self.client(3)

    def clear(self):
        with db() as c:
            for table in ['print_links','feature_ideas','winners','entries','participants','votes','topics','rounds','invites','users']:
                c.execute('DELETE FROM '+table)

    def tearDown(self):
        self.clock.stop();self.clear()

    def client(self, uid):
        client=app.test_client()
        with client.session_transaction() as session: session['uid']=uid;session['version']=0
        return client

    def post(self, client, path, data):
        token=client.get('/api/state').json['csrf']
        return client.post('/api/'+path,json=data,headers={'X-CSRF-Token':token})

    def iso(self, offset):
        return datetime.fromtimestamp(self.now+offset,timezone.utc).isoformat()

    def create(self, **overrides):
        payload={'title':'Test voyage','deadline':self.iso(3600),'prevote':True}
        payload.update(overrides)
        response=self.post(self.host,'rounds',payload)
        self.assertEqual(response.status_code,200,response.json)
        with db() as c: return c.execute('SELECT MAX(id) FROM rounds').fetchone()[0]

    def state(self, rid=1):
        return next(r for r in self.host.get('/api/state').json['rounds'] if r['id']==rid)

    def topic(self, client, title, rid=1):
        return self.post(client,f'rounds/{rid}/topic',{'title':title})

    def test_collection_ownership_duplicates_and_frozen_ballot(self):
        self.create()
        self.assertEqual(self.topic(self.maker,'Tiny Boats').status_code,200)
        self.assertEqual(self.topic(self.other,'  TINY   boats ').status_code,409)
        self.assertEqual(self.topic(self.other,'Ｔｉｎｙ Ｂｏａｔｓ').status_code,409)
        self.assertEqual(self.post(self.maker,'rounds/1/vote',{'topic_id':1}).status_code,403)
        self.assertEqual(self.post(self.other,'rounds/1/delete-topic',{'topic_id':1}).status_code,403)
        self.assertEqual(self.post(self.host,'rounds/1/delete-topic',{'topic_id':1}).status_code,403)
        self.assertEqual(self.post(self.maker,'rounds/1/delete-topic',{'topic_id':1}).status_code,200)
        self.topic(self.maker,'Tiny Boats')
        self.assertEqual(self.post(self.maker,'rounds/1/open-voting',{}).status_code,403)
        self.assertEqual(self.post(self.host,'rounds/1/open-voting',{}).status_code,200)
        self.assertEqual(self.topic(self.maker,'New topic').status_code,403)
        self.assertEqual(self.post(self.maker,'rounds/1/delete-topic',{'topic_id':1}).status_code,403)
        self.assertEqual(self.post(self.maker,'rounds/1/vote',{'topic_id':1}).status_code,200)

    def test_timers_and_deadline_reject_stale_requests(self):
        self.create(vote_opens_at=self.iso(60),votes_close_at=self.iso(120))
        self.topic(self.maker,'Boats');self.topic(self.other,'Bridges')
        with patch('app.time.time',return_value=self.now+60):
            self.assertEqual(self.state()['phase'],'topics')
            self.post(self.maker,'rounds/1/vote',{'topic_id':1})
            self.post(self.host,'rounds/1/vote',{'topic_id':1})
            token=self.maker.get('/api/state').json['csrf']
        with patch('app.time.time',return_value=self.now+120):
            # No state refresh first: a stale browser still cannot vote after closing.
            response=self.maker.post('/api/rounds/1/vote',json={'topic_id':2},headers={'X-CSRF-Token':token})
            self.assertEqual(response.status_code,403)
            state=self.state();self.assertEqual(state['phase'],'printing');self.assertEqual(state['topic'],'Boats')
            self.assertAlmostEqual(state['printing_started_at'],self.now+120,places=5)
            self.post(self.maker,'rounds/1/participate',{'status':'in'})
            self.assertEqual(self.post(self.maker,'rounds/1/entry',{'title':'My boat'}).status_code,200)
        with patch('app.time.time',return_value=self.now+3600):
            self.assertEqual(self.post(self.maker,'rounds/1/entry',{'title':'Too late'}).status_code,403)
            self.assertEqual(self.state()['phase'],'judging')

    def test_manual_close_requires_manager_and_ties_only_resolve_to_leaders(self):
        self.create(prevote=False)
        for title in ['Boats','Bridges','Cities']: self.topic(self.maker,title)
        self.post(self.maker,'rounds/1/vote',{'topic_id':1});self.post(self.other,'rounds/1/vote',{'topic_id':2})
        self.assertEqual(self.post(self.maker,'rounds/1/close-poll',{}).status_code,403)
        self.assertEqual(self.post(self.host,'rounds/1/close-poll',{}).status_code,200)
        self.assertEqual(self.state()['phase'],'tie')
        self.assertEqual(self.post(self.maker,'rounds/1/vote',{'topic_id':1}).status_code,403)
        self.assertEqual(self.post(self.host,'rounds/1/resolve-tie',{'topic_id':3}).status_code,400)
        # Creator retains management access even if they are no longer an admin.
        with db() as c: c.execute('UPDATE users SET admin=0 WHERE id=1')
        self.assertEqual(self.post(self.host,'rounds/1/resolve-tie',{'topic_id':2}).status_code,200)
        self.assertEqual(self.state()['topic'],'Bridges')

    def test_dates_and_empty_polls(self):
        for changes in [{'deadline':self.iso(-1)}, {'vote_opens_at':self.iso(100),'votes_close_at':self.iso(50)}, {'votes_close_at':self.iso(4000)}, {'deadline':'2027-01-01T12:00'}, {'prevote':False,'vote_opens_at':self.iso(50)}]:
            payload={'title':'Bad schedule','deadline':self.iso(3600),'prevote':True};payload.update(changes)
            self.assertEqual(self.post(self.host,'rounds',payload).status_code,400)
        self.create(votes_close_at=self.iso(60))
        with patch('app.time.time',return_value=self.now+60):
            self.assertEqual(self.state()['phase'],'no_topics')
            self.assertEqual(self.post(self.host,'rounds/1/reopen-topics',{}).status_code,200)
            self.assertIsNone(self.state()['votes_close_at'])
        with patch('app.time.time',return_value=self.now+3600):
            self.assertEqual(self.state()['phase'],'no_topics')
            self.assertEqual(self.post(self.host,'rounds/1/archive-empty',{}).status_code,200)
            self.assertEqual(self.state()['phase'],'completed')

    def test_topics_cannot_cross_rounds_and_voted_topics_cannot_be_deleted(self):
        self.create(prevote=False);self.create(prevote=False)
        self.topic(self.maker,'Boats',rid=1)
        self.assertEqual(self.post(self.other,'rounds/2/vote',{'topic_id':1}).status_code,400)
        self.assertEqual(self.post(self.maker,'rounds/2/delete-topic',{'topic_id':1}).status_code,403)
        self.post(self.other,'rounds/1/vote',{'topic_id':1})
        self.assertEqual(self.post(self.maker,'rounds/1/delete-topic',{'topic_id':1}).status_code,409)

    def upload(self, raw, filename='photo.png', client=None):
        client=client or self.maker;token=client.get('/api/state').json['csrf']
        return client.post('/api/profile/avatar',data={'file':(io.BytesIO(raw),filename)},headers={'X-CSRF-Token':token})

    def test_profile_photo_validation_resize_and_member_access(self):
        raw=io.BytesIO();Image.new('RGB',(900,600),'blue').save(raw,'PNG')
        self.assertEqual(self.upload(raw.getvalue()).status_code,200)
        with self.other.get('/api/users/2/avatar') as response:
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.mimetype,'image/webp')
            with Image.open(io.BytesIO(response.data)) as image: self.assertEqual(image.size,(512,512))
        self.assertEqual(app.test_client().get('/api/users/2/avatar').status_code,401)
        self.assertEqual(self.upload(b'<svg><script>alert(1)</script></svg>','fake.png').status_code,400)
        self.assertEqual(self.upload(b'x'*(2*1024*1024+1)).status_code,413)
        raw=io.BytesIO();Image.new('RGB',(4100,4000)).save(raw,'PNG')
        self.assertEqual(self.upload(raw.getvalue()).status_code,400)
        self.assertEqual(self.upload(b'bad',client=app.test_client()).status_code,401)

    def test_links_require_participation_completion_and_recorded_awards(self):
        self.create(prevote=False)
        self.topic(self.maker,'Boats')
        self.post(self.host,'rounds/1/close-poll',{})
        self.post(self.maker,'rounds/1/participate',{'status':'in'})
        self.post(self.other,'rounds/1/participate',{'status':'out'})
        self.post(self.maker,'rounds/1/entry',{'title':'My boat'})
        link={'title':'My boat model','url':'https://makerworld.com/en/models/123'}
        self.assertEqual(self.post(self.maker,'rounds/1/links',link).status_code,403)
        self.post(self.host,'rounds/1/advance',{})
        self.assertEqual(self.post(self.maker,'rounds/1/winner',{'category':'Best build','entry_id':1}).status_code,403)
        self.post(self.host,'rounds/1/winner',{'category':'Best build','entry_id':1})
        self.assertEqual(self.post(self.maker,'rounds/1/links',link).status_code,403)
        self.post(self.host,'rounds/1/advance',{})
        self.assertEqual(self.post(self.other,'rounds/1/links',link).status_code,403)
        self.assertEqual(self.post(self.maker,'rounds/1/links',{**link,'preview_image':'https://127.0.0.1/pic.png'}).status_code,400)
        self.assertEqual(self.post(self.maker,'rounds/1/links',{**link,'preview_image':'https://makerworld.bblmw.com/model/photo.webp'}).status_code,200)
        preview=self.maker.get('/api/print-links/1/preview')
        self.assertEqual(preview.json['image_url'],'https://makerworld.bblmw.com/model/photo.webp')
        self.assertIn('https://makerworld.bblmw.com',preview.headers['Content-Security-Policy'])
        self.assertEqual(self.post(self.maker,'rounds/1/links',link).status_code,409)
        self.assertEqual(self.post(self.other,'print-links/1/delete',{}).status_code,403)
        for url in ['javascript:alert(1)','data:text/html,hi','https://user:password@example.com/','https://example.com/\nfoo','https://example.com\\evil','not-a-url']:
            self.assertEqual(self.post(self.maker,'rounds/1/links',{'url':url}).status_code,400,url)
        self.assertEqual(self.post(self.maker,'print-links/1/delete',{}).status_code,200)
        self.assertEqual(len(self.maker.get('/api/state').json['print_links']),0)

    def test_feature_board_permissions_and_persistence(self):
        self.assertEqual(self.post(self.maker,'features',{'title':'Link badges','description':'Preview print pages'}).status_code,200)
        self.assertEqual(self.post(self.other,'features',{'title':'LINK  BADGES'}).status_code,409)
        self.assertEqual(self.post(self.maker,'features/1/move',{'stage':'progress'}).status_code,403)
        self.assertEqual(self.post(self.other,'features/1/delete',{}).status_code,403)
        self.assertEqual(self.post(self.host,'features/1/move',{'stage':'invalid'}).status_code,400)
        self.assertEqual(self.post(self.host,'features/1/move',{'stage':'progress'}).status_code,200)
        self.assertEqual(self.post(self.maker,'features/1/delete',{}).status_code,403)
        self.assertEqual(self.post(self.host,'features/1/move',{'stage':'review'}).status_code,200)
        self.assertEqual(self.other.get('/api/state').json['feature_ideas'][0]['stage'],'review')
        self.assertEqual(self.post(self.host,'features/1/delete',{}).status_code,200)
        self.assertEqual(self.post(app.test_client(),'features',{'title':'Spam'}).status_code,401)
        self.assertEqual(self.post(self.maker,'features',{'title':'My next idea'}).status_code,200)
        idea=self.maker.get('/api/state').json['feature_ideas'][0]
        self.assertEqual(idea['stage'],'ideas')
        self.assertEqual(self.post(self.other,f"features/{idea['id']}/delete",{}).status_code,403)
        self.assertEqual(self.post(self.maker,f"features/{idea['id']}/delete",{}).status_code,200)

    def test_release_log_starts_with_initial_build(self):
        release=self.host.get('/api/state').json['releases'][0]
        self.assertEqual(release['version'],'0.0.0')
        self.assertEqual(release['title'],'Initial Build')

    def test_multiple_topics_and_votes_and_admin_deletion(self):
        rid=self.create()
        self.assertEqual(self.topic(self.maker,'First').status_code,200)
        self.assertEqual(self.topic(self.maker,'Second').status_code,200)
        self.assertEqual(self.post(self.host,f'rounds/{rid}/open-voting',{}).status_code,200)
        for tid in [1,2,1]:
            self.assertEqual(self.post(self.maker,f'rounds/{rid}/vote',{'topic_id':tid}).status_code,200)
        votes=self.maker.get('/api/state').json['votes']
        self.assertEqual(len(votes),2)
        self.assertEqual(self.topic(self.maker,'Too late').status_code,403)
        self.assertEqual(self.post(self.maker,f'rounds/{rid}/delete-competition',{}).status_code,403)
        self.assertEqual(self.post(self.host,f'rounds/{rid}/delete-competition',{}).status_code,200)
        for table in ['rounds','topics','votes']:
            self.assertEqual(self.host.get('/api/state').json[table],[])
