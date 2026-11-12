import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Image} from 'imagescript';
import {sanitizePhoto} from '../supabase/functions/_shared/photos.mjs';
import {avatars} from '../supabase/functions/_shared/avatars.mjs';
import {testDatabase} from './helpers/database.mjs';
import {digest,token} from '../supabase/functions/_shared/passwords.mjs';
test('avatar decoder sanitizes supported images to 512px JPEG and rejects unsafe inputs',async()=>{
 for(const file of ['static/assets/benchy-trophy.png','static/assets/example-benchy-trophy.webp']){
  const result=await sanitizePhoto(new Uint8Array(await readFile(file)),Image);const decoded=await Image.decode(result);
  assert.equal(decoded.width,512);assert.equal(decoded.height,512);assert(result.length<262144);assert.equal(result[0],255);
 }
 await assert.rejects(sanitizePhoto(new Uint8Array(2*1024*1024+1),Image),/2 MB/);
 await assert.rejects(sanitizePhoto(new TextEncoder().encode('<svg onload="evil"/>'),Image),/JPEG/);
 // Valid PNG signature with an animation control chunk is rejected before decoding.
 const animated=new Uint8Array(20);animated.set([137,80,78,71,13,10,26,10]);animated.set(new TextEncoder().encode('acTL'),12);
 await assert.rejects(sanitizePhoto(animated,Image),/still photo/);
 // JPEG invalid body cannot pass just because it has the correct magic bytes.
 await assert.rejects(sanitizePhoto(new Uint8Array([255,216,255,0,0,0]),Image),/valid still photo/);
 // Decoder performs maxPixels checks on headers before allocating the image.
 const large=new Image(4001,4000);const jpeg=await large.encodeJPEG(20);
 await assert.rejects(sanitizePhoto(jpeg,Image),/16 megapixels/);
});
test('private avatar SQL and storage adapter derive ownership from session',async()=>{
 const {db,rpc}=await testDatabase();const hash=token(),invite=token();
 try {
  await db.query("insert into league_private.invites(token_hash,expires_at) values($1,now()+interval '1 day')",[await digest(invite)]);
  await rpc('register',{name:'Photo',normalized:'photo',hash:'unused-test-password-hash',invite_hash:await digest(invite),token_hash:hash});
  const storage=new Map();
  const service=avatars('https://fixture.supabase.co','server-only',Image,async(url,options={})=>{
   if(url.endsWith('/rpc/league_avatar')){
    const p=JSON.parse(options.body);
    try {const result=await db.query('select public.league_avatar($1,$2,$3,$4) as result',[p.session_hash,p.operation,p.target,p.version]);return Response.json(result.rows[0].result);}
    catch(e){return Response.json({message:e.message},{status:400});}
   }
   assert.equal(options.headers.Authorization,'Bearer server-only');
   const key=url.split('/').pop();
   if(options.method==='POST'){storage.set(key,options.body);return Response.json({});}
   return new Response(storage.get(key),{status:storage.has(key)?200:404});
  });
  const form=new FormData();form.set('file',new Blob([await readFile('static/assets/example-benchy-trophy.webp')],{type:'image/webp'}),'photo.webp');
  assert.deepEqual(await service.upload(new Request('https://fixture/upload',{method:'POST',body:form}),hash),{ok:true});
  const state=await rpc('state',{},hash);assert.match(state.user.avatar,/^[a-f0-9]{64}$/);
  assert.equal(storage.size,1);assert.equal((await Image.decode(await service.get(state.user.id,hash))).width,512);
  await assert.rejects(service.get(state.user.id,token()),/sign in/);
  await db.exec('set role anon');await assert.rejects(db.query("select public.league_avatar('','self')"),/permission denied/);await db.exec('reset role');
 } finally {await db.close();}
});
