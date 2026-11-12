import os, tempfile, unittest, io
os.environ['DATA_DIR']=tempfile.mkdtemp()
from app import app, db
from werkzeug.security import generate_password_hash
class Flow(unittest.TestCase):
 def test_lifecycle(self):
  a=app.test_client(); b=app.test_client()
  def post(client,path,data):
   csrf=client.get('/api/state').json['csrf']
   return client.post('/api/'+path,json=data,headers={'X-CSRF-Token':csrf})
  with db() as c: c.execute('INSERT INTO users(name,password,admin) VALUES(?,?,1)',('host',generate_password_hash('a-long-password')))
  self.assertEqual(post(a,'auth/login',{'name':'host','password':'a-long-password'}).status_code,200)
  code=post(a,'invites',{}).json['code']
  self.assertEqual(post(b,'auth/register',{'name':'maker','password':'another-long-password','confirm_password':'another-long-password','invite':code}).status_code,200)
  self.assertEqual(post(b,'invites',{}).status_code,403)
  self.assertEqual(a.post('/api/rounds',json={}).status_code,403)
  self.assertEqual(post(a,'rounds',{'title':'Round one','deadline':'2026-12-01'}).status_code,200)
  post(b,'rounds/1/topic',{'title':'Tiny cities'})
  post(b,'rounds/1/vote',{'topic_id':1}); post(b,'rounds/1/vote',{'topic_id':1})
  self.assertEqual(len(b.get('/api/state').json['votes']),1)
  post(b,'rounds/1/participate',{'status':'in'})
  self.assertEqual(post(b,'rounds/1/advance',{'topic_id':1}).status_code,403)
  post(a,'rounds/1/advance',{'topic_id':1})
  self.assertEqual(post(b,'rounds/1/vote',{'topic_id':1}).status_code,403)
  self.assertEqual(post(b,'rounds/1/entry',{'title':'Pocket skyline'}).status_code,200)
  post(a,'rounds/1/advance',{})
  self.assertEqual(post(a,'rounds/1/advance',{}).status_code,400)
  post(a,'rounds/1/winner',{'category':'Best design','entry_id':1})
  self.assertEqual(post(a,'rounds/1/advance',{}).status_code,200)
  csrf=b.get('/api/state').json['csrf']
  self.assertEqual(b.post('/api/entries/1/file',data={'file':(io.BytesIO(b'project'),'project.zip')},headers={'X-CSRF-Token':csrf}).status_code,403)
  with a.get('/api/entries/1/file') as response: self.assertEqual(response.status_code,404)
  self.assertEqual(app.test_client().get('/api/entries/1/file').status_code,401)
  self.assertEqual(len(a.get('/api/state').json['winners']),1)
if __name__=='__main__': unittest.main()
