import time
import unittest
from test_flow import app, db
from werkzeug.security import generate_password_hash

class Accounts(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        with db() as c:
            c.execute('INSERT INTO users(name,password) VALUES(?,?)', ('Captain', generate_password_hash('original-password')))
            self.uid = c.execute('SELECT id FROM users WHERE name=?', ('Captain',)).fetchone()['id']
            c.execute('INSERT INTO invites(code) VALUES(?)', ('test-invite',))
        self.assertEqual(self.post(self.client, 'auth/login', {'name':'CAPTAIN','password':'original-password'}).status_code, 200)

    def tearDown(self):
        with db() as c:
            c.execute('DELETE FROM users')
            c.execute('DELETE FROM invites')

    def post(self, client, path, data):
        token = client.get('/api/state').json['csrf']
        return client.post('/api/'+path, json=data, headers={'X-CSRF-Token':token})

    def test_case_insensitive_registration_is_atomic(self):
        guest=app.test_client()
        response=self.post(guest,'auth/register',{'name':'cApTaIn','password':'another-password','confirm_password':'another-password','invite':'test-invite'})
        self.assertEqual(response.status_code,409)
        with db() as c: self.assertIsNotNone(c.execute('SELECT 1 FROM invites WHERE code=?',('test-invite',)).fetchone())
        self.assertFalse(guest.get('/api/username-availability?name=CAPTAIN').json['available'])
        self.assertTrue(self.client.get('/api/username-availability?name=captain').json['available'])
        # Fullwidth and case variants normalize to the same username.
        self.assertEqual(self.post(guest,'auth/register',{'name':'ＣＡＰＴＡＩＮ','password':'another-password','confirm_password':'another-password','invite':'test-invite'}).status_code,409)
        self.assertEqual(self.post(guest,'auth/register',{'name':'Deckhand','password':'another-password','confirm_password':'another-password','invite':'test-invite'}).status_code,200)
        self.assertEqual(self.post(app.test_client(),'auth/register',{'name':'Other','password':'another-password','confirm_password':'another-password','invite':'test-invite'}).status_code,403)

    def test_display_name_and_password_rotation(self):
        other=app.test_client()
        self.post(other,'auth/login',{'name':'captain','password':'original-password'})
        self.assertEqual(self.post(self.client,'profile',{'display_name':'Captain of the fleet'}).status_code,200)
        state=self.client.get('/api/state').json
        self.assertEqual(state['user']['display_name'],'Captain of the fleet')
        self.assertEqual(state['user']['name'],'Captain')
        payload={'name':'NewCaptain','current_password':'wrong','password':'replacement-password','confirm_password':'replacement-password'}
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,403)
        payload['current_password']='original-password'; payload['confirm_password']='different'
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,400)
        payload['confirm_password']=payload['password']
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,200)
        self.assertIsNone(other.get('/api/state').json['user'])
        self.assertEqual(self.post(other,'auth/login',{'name':'newcaptain','password':'replacement-password'}).status_code,200)
        self.assertEqual(self.post(app.test_client(),'auth/login',{'name':'NewCaptain','password':'original-password'}).status_code,401)

    def test_credentials_cannot_take_existing_username(self):
        with db() as c: c.execute('INSERT INTO users(name,password) VALUES(?,?)', ('Taken',generate_password_hash('another-password')))
        payload={'name':'TAKEN','current_password':'original-password','password':'replacement-password','confirm_password':'replacement-password'}
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,409)
        self.assertEqual(self.post(app.test_client(),'auth/login',{'name':'CAPTAIN','password':'original-password'}).status_code,200)

    def test_profile_requires_session_and_csrf(self):
        self.assertEqual(self.post(app.test_client(),'profile',{'display_name':'Intruder'}).status_code,401)
        self.assertEqual(self.client.post('/api/profile',json={'display_name':'Intruder'}).status_code,403)
        self.assertEqual(self.post(self.client,'profile',{'display_name':'   '}).status_code,400)

    def test_add_password_requires_recent_server_verified_google_session(self):
        with db() as c: c.execute('UPDATE users SET password=NULL WHERE id=?',(self.uid,))
        payload={'name':'Captain','password':'new-local-password','confirm_password':'new-local-password','auth_provider':'google','auth_at':time.time()}
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,403)
        with self.client.session_transaction() as session:
            session['auth_provider']='google';session['auth_at']=time.time()-601
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,403)
        with self.client.session_transaction() as session: session['auth_at']=time.time()
        self.assertEqual(self.post(self.client,'profile/credentials',payload).status_code,200)
        self.assertEqual(self.post(app.test_client(),'auth/login',{'name':'CAPTAIN','password':'new-local-password'}).status_code,200)
