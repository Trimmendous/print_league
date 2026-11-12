import test from 'node:test';
import assert from 'node:assert/strict';
import * as jose from 'jose';
import {testDatabase} from './helpers/database.mjs';
import {createHandler} from '../supabase/functions/league-api/handler.mjs';
import {googleVerifier} from '../supabase/functions/_shared/google.mjs';
import {digest,token,hashPassword} from '../supabase/functions/_shared/passwords.mjs';
import {APIError} from '../supabase/functions/_shared/validation.mjs';
const base='https://fixture.supabase.co/functions/v1/league-api/';
async function fixture(){
 const {db,rpc}=await testDatabase();
 const named=name=>async(operation,payload={},session_hash='')=>{
  try{return (await db.query(`select public.${name}($1,$2::jsonb,$3) as result`,[operation,JSON.stringify(payload),session_hash])).rows[0].result;}
  catch(e){const m=/^(\d{3})\|(.+)$/.exec(e.message);if(m)throw new APIError(+m[1],m[2]);throw e;}
 };
 const googleRPC=named('league_google');
 const adminRPC=async(operation,payload={},session_hash='')=>{
  try{return (await db.query('select public.league_admin($1,$2,$3::jsonb) as result',[session_hash,operation,JSON.stringify(payload)])).rows[0].result;}
  catch(e){const m=/^(\d{3})\|(.+)$/.exec(e.message);if(m)throw new APIError(+m[1],m[2]);throw e;}
 };
 const invitation=async()=>{const code=token();await db.query("insert into league_private.invites(token_hash,expires_at) values($1,now()+interval '1 day')",[await digest(code)]);return code;};
 return {db,rpc,googleRPC,adminRPC,invitation};
}
function client(handle){return {token:null,async request(path,body){const r=await handle(new Request(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:'https://trimmendous.github.io',...(body===undefined?{}:{'Content-Type':'application/json'}),...(this.token?{Authorization:'Bearer '+this.token}:{})},body:body===undefined?undefined:JSON.stringify(body)}));const data=await r.json();if(data.session_token)this.token=data.session_token;return {status:r.status,...data};}};}
test('six-character signup requires confirmation; admin page and promotion are server-authorized',async()=>{
 const f=await fixture(),handle=createHandler(f),admin=client(handle),member=client(handle),guest=client(handle);
 try {
  const invite=await f.invitation();
  for(const p of [{password:'12345',confirm_password:'12345'},{password:'123456'},{password:'123456',confirm_password:'abcdef'}])assert.equal((await admin.request('auth/register',{name:'admin',invite,...p})).status,400);
  assert.equal((await admin.request('auth/register',{name:'admin',invite,password:'123456',confirm_password:'123456'})).status,200);
  const uid=(await admin.request('state')).user.id;await f.db.query('update league_private.members set admin=true where id=$1',[uid]);
  assert.equal((await member.request('auth/register',{name:'member',invite:await f.invitation(),password:'abcdef',confirm_password:'abcdef'})).status,200);
  const mid=(await member.request('state')).user.id;
  assert.equal((await guest.request('admin')).status,403);assert.equal((await member.request('admin')).status,403);
  assert.equal((await member.request('admin/promote',{member_id:mid,admin:true})).status,403);
  let summary=await admin.request('admin');assert.equal(summary.member_count,2);assert.equal(summary.admin_count,1);
  assert.equal((await admin.request('admin/promote',{member_id:mid})).status,200);
  summary=await admin.request('admin');assert.equal(summary.admin_count,2);
  assert.equal((await member.request('invites',{})).status,200);
  assert.equal((await f.db.query('select count(*)::integer as count from league_private.admin_promotions')).rows[0].count,1);
  assert.equal((await admin.request('profile/credentials',{name:'admin',current_password:'123456',password:'abcdef',confirm_password:'abcdef'})).status,200);
  await f.db.exec('set role anon');await assert.rejects(f.db.query("select public.league_admin('','summary')"),/permission denied/);await f.db.exec('reset role');
 }finally{await f.db.close();}
});
test('Google JWT validation rejects wrong app, issuer, expiry, signature and malformed nonce',async()=>{
 const {privateKey,publicKey}=await jose.generateKeyPair('RS256'), clientID='test.apps.googleusercontent.com';
 const verifier=googleVerifier(clientID,jose,publicKey);
 const sign=(changes={})=>new jose.SignJWT({nonce:token(),sub:'google-subject',iss:'https://accounts.google.com',aud:clientID,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...changes}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
 assert.equal((await verifier.verify(await sign())).subject,'google-subject');
 for(const changes of [{aud:'other.apps.googleusercontent.com'},{iss:'https://evil.example'},{exp:1},{nonce:'wrong'},{sub:''}])await assert.rejects(verifier.verify(await sign(changes)),/could not be verified/);
 const signed=await sign();await assert.rejects(verifier.verify(signed.slice(0,-8)+'AAAAAAAA'),/could not be verified/);
});
test('Google signup remains invite-only; nonce/replay checks, explicit linking and last-method protection',async()=>{
 const f=await fixture();const {privateKey,publicKey}=await jose.generateKeyPair('RS256'),clientID='test.apps.googleusercontent.com';
 const google=googleVerifier(clientID,jose,publicKey),handle=createHandler({...f,google}),g=client(handle),other=client(handle);
 const sign=(nonce,sub='subject-one')=>new jose.SignJWT({nonce,sub,email:'private@example.test',name:'Private Google Name'}).setProtectedHeader({alg:'RS256'}).setIssuer('https://accounts.google.com').setAudience(clientID).setIssuedAt().setExpirationTime('5m').sign(privateKey);
 const complete=async(c,ch,sub)=>c.request('auth/google',{challenge:ch.challenge,credential:await sign(ch.nonce,sub)});
 try{
  assert.equal((await g.request('auth/google/challenge',{mode:'register',display_name:'Maker',invite:'bad'})).status,403);
  let ch=await g.request('auth/google/challenge',{mode:'login'});assert.equal(ch.status,200);
  assert.equal((await complete(g,ch)).status,403);
  ch=await g.request('auth/google/challenge',{mode:'register',display_name:'Public maker',invite:await f.invitation()});assert.equal(ch.status,200);
  assert.equal((await g.request('auth/google',{challenge:ch.challenge,credential:await sign(token())})).status,403);
  assert.equal((await complete(g,ch)).status,200);
  let state=await g.request('state');const uid=state.user.id;
  assert.equal(state.user.display_name,'Public maker');assert.equal(state.user.name,'');assert.equal(state.user.has_password,false);
  assert(!JSON.stringify(state).includes('private@example'));assert(!JSON.stringify(state).includes('Private Google Name'));
  assert.equal((await complete(g,ch)).status,403);
  assert.equal((await g.request('profile/google/unlink',{})).status,400);
  assert.equal((await g.request('profile/credentials',{name:'boat',password:'123456',confirm_password:'123456'})).status,200);
  assert.equal((await g.request('state')).user.id,uid);
  // Password signup cannot hijack an existing Google identity by matching email or flags.
  await other.request('auth/register',{name:'other',password:'abcdef',confirm_password:'abcdef',invite:await f.invitation()});
  ch=await other.request('auth/google/challenge',{mode:'link'});assert.equal(ch.status,200);assert.equal((await complete(other,ch)).status,409);
  ch=await other.request('auth/google/challenge',{mode:'link'});assert.equal((await complete(other,ch,'subject-two')).status,200);
  const oid=(await other.request('state')).user.id;await other.request('auth/logout',{});other.token=null;
  ch=await other.request('auth/google/challenge',{mode:'login'});assert.equal((await complete(other,ch,'subject-two')).status,200);assert.equal((await other.request('state')).user.id,oid);
  assert.equal((await g.request('profile/google/unlink',{})).status,200);
  await f.db.exec('set role authenticated');await assert.rejects(f.db.query("select public.league_google('complete','{}','')"),/permission denied/);await f.db.exec('reset role');
 }finally{await f.db.close();}
});
test('admin demotion and one-use temporary passwords enforce access, expiry and session revocation',async()=>{
 const f=await fixture(),handle=createHandler(f),admin=client(handle),member=client(handle),guest=client(handle);
 try{
  for(const [c,name] of [[admin,'captain'],[member,'crew']])assert.equal((await c.request('auth/register',{name,password:'abcdef',confirm_password:'abcdef',invite:await f.invitation()})).status,200);
  const aid=(await admin.request('state')).user.id,mid=(await member.request('state')).user.id;
  await f.db.query('update league_private.members set admin=true where id=$1',[aid]);
  assert.equal((await member.request('admin/reset-password',{member_id:aid})).status,403);
  assert.equal((await member.request('admin/demote',{member_id:aid})).status,403);
  assert.equal((await admin.request('admin/demote',{member_id:aid})).status,400);
  await admin.request('admin/promote',{member_id:mid});
  assert.equal((await admin.request('admin/demote',{member_id:mid})).status,200);
  assert.equal((await member.request('admin')).status,403);
  assert.equal((await admin.request('admin/reset-password',{member_id:aid})).status,400);
  const first=await admin.request('admin/reset-password',{member_id:mid});assert.equal(first.status,200);assert.match(first.temporary_password,/^[a-f0-9]{32}$/);
  const reset=p=>guest.request('auth/reset-password',{name:'crew',temporary_password:p,password:'new123',confirm_password:'new123'});
  const second=await admin.request('admin/reset-password',{member_id:mid});assert.equal((await reset(first.temporary_password)).status,403);
  await f.db.query("update league_private.password_resets set expires_at=now()-interval '1 second'");
  assert.equal((await reset(second.temporary_password)).status,403);
  const third=await admin.request('admin/reset-password',{member_id:mid});
  assert.equal((await reset(third.temporary_password)).status,200);
  assert.equal((await member.request('state')).status,401);
  assert.equal((await reset(third.temporary_password)).status,403);
  assert.equal((await guest.request('auth/login',{name:'crew',password:'abcdef'})).status,401);
  assert.equal((await guest.request('auth/login',{name:'crew',password:'new123'})).status,200);
  const fourth=await admin.request('admin/reset-password',{member_id:mid});
  assert.equal((await guest.request('profile/credentials',{name:'crew',current_password:'new123',password:'other1',confirm_password:'other1'})).status,200);
  assert.equal((await reset(fourth.temporary_password)).status,403);
 }finally{await f.db.close();}
});
test('Google buttons can complete invite signup with chosen or Gmail-generated usernames',async()=>{
 const f=await fixture();const {privateKey,publicKey}=await jose.generateKeyPair('RS256'),clientID='test.apps.googleusercontent.com';
 const handle=createHandler({...f,google:googleVerifier(clientID,jose,publicKey)});
 const signup=async(c,sub,fields,email='maker@gmail.com',verified=true)=>{
  const ch=await c.request('auth/google/challenge',{mode:'login'});
  const credential=await new jose.SignJWT({nonce:ch.nonce,sub,email,email_verified:verified}).setProtectedHeader({alg:'RS256'}).setIssuer('https://accounts.google.com').setAudience(clientID).setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return c.request('auth/google',{mode:'register',challenge:ch.challenge,credential,...fields});
 };
 try{
  const a=client(handle),b=client(handle),c=client(handle);
  assert.equal((await signup(a,'one',{username_mode:'custom',name:'Chosen',invite:'bad'})).status,403);
  assert.equal((await signup(a,'one',{username_mode:'custom',name:'Chosen',invite:await f.invitation()})).status,200);
  assert.equal((await a.request('state')).user.name,'Chosen');
  assert.equal((await signup(b,'two',{username_mode:'custom',name:'chosen',invite:await f.invitation()})).status,409);
  assert.equal((await signup(b,'two',{username_mode:'gmail',invite:await f.invitation()},'private@example.test')).status,400);
  assert.equal((await signup(b,'two',{username_mode:'gmail',invite:await f.invitation()},'maker@gmail.com',false)).status,400);
  assert.equal((await signup(b,'two',{username_mode:'gmail',invite:await f.invitation()})).status,200);
  assert.equal((await b.request('state')).user.name,'maker');
  assert.equal((await signup(c,'three',{username_mode:'gmail',invite:await f.invitation()})).status,200);
  const state=await c.request('state');assert.equal(state.user.name,'maker_1');assert(!JSON.stringify(state).includes('@gmail.com'));
  assert.equal((await c.request('profile/credentials',{name:'maker_1',password:'abcdef',confirm_password:'abcdef'})).status,200);
 }finally{await f.db.close();}
});
test('invitation entry validates without consuming and rejects used or expired codes',async()=>{
 const f=await fixture(),handle=createHandler(f),guest=client(handle);
 try{
  assert.equal((await guest.request('auth/invitation',{invite:'bad'})).status,403);
  const invite=await f.invitation();
  let out=await guest.request('auth/invitation',{invite});assert.equal(out.status,200);assert.equal(out.google_allowed,true);
  assert.equal((await guest.request('auth/invitation',{invite})).status,200);
  assert.equal((await guest.request('auth/register',{name:'newmaker',invite,password:'abcdef',confirm_password:'abcdef'})).status,200);
  assert.equal((await guest.request('auth/invitation',{invite})).status,403);
  const expired=await f.invitation();await f.db.query("update league_private.invites set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=$1",[await digest(expired)]);
  assert.equal((await guest.request('auth/invitation',{invite:expired})).status,403);
  const setup=await f.invitation();await f.db.query('update league_private.invites set grants_admin=true where token_hash=$1',[await digest(setup)]);
  out=await guest.request('auth/invitation',{invite:setup});assert.equal(out.status,200);assert.equal(out.google_allowed,false);
 }finally{await f.db.close();}
});
