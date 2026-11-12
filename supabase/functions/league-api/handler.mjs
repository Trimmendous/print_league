import {APIError,field,password,normalize,collapse,topicKey,date,printLink} from '../_shared/validation.mjs';
import {digest,token,hashPassword,verifyPassword} from '../_shared/passwords.mjs';
const allowedOrigin='https://trimmendous.github.io';
import fallbackReleases from '../_shared/releases.mjs';
async function jsonBody(request) {
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))throw new APIError(400,'Send a JSON request.');
 // Enforce the limit while streaming, even when Content-Length is absent or false.
 const reader=request.body?.getReader();if(!reader)throw new APIError(400,'Missing request.');
 let total=0;const chunks=[];
 while(true) {const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>16384){await reader.cancel();throw new APIError(413,'Request is too large.');}chunks.push(value);}
 const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new APIError(400,'Invalid JSON request.');}
 if(!body||typeof body!=='object'||Array.isArray(body))throw new APIError(400,'Invalid JSON request.');return body;
}
export function createHandler({rpc=null,photos=null,adminRPC=null,googleRPC=null,google=null,releases=fallbackReleases}={}) {
 return async function handle(request) {
  const origin=request.headers.get('Origin');
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','Vary':'Origin','X-Content-Type-Options':'nosniff'};
  const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(origin && origin!==allowedOrigin)return reply({error:'Origin not allowed'},403);
  if(origin)headers['Access-Control-Allow-Origin']=allowedOrigin;
  if(request.method==='OPTIONS') {
   const method=request.headers.get('Access-Control-Request-Method');
   const requested=(request.headers.get('Access-Control-Request-Headers')||'').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
   if(!['GET','POST'].includes(method)||requested.some(h=>!['authorization','content-type','x-csrf-token'].includes(h)))return reply({error:'Preflight not allowed'},403);
   headers['Access-Control-Allow-Methods']='GET, POST';headers['Access-Control-Allow-Headers']='authorization, content-type, x-csrf-token';
   return new Response(null,{status:204,headers});
  }
  try {
   const url=new URL(request.url);
   const path=url.pathname.replace(/^\/functions\/v1/,'').replace(/^\/league-api\/?/,'');
   if(path==='health' && request.method==='GET')return reply({service:'print-league',authentication_ready:!!rpc});
   if(!rpc)throw new APIError(503,'The league backend is being prepared. Please check back soon.');
   if(!['GET','POST'].includes(request.method))throw new APIError(405,'Method not allowed.');
   const bearer=request.headers.get('Authorization');
   const rawToken=bearer?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
   if(bearer && !rawToken)throw new APIError(401,'Please sign in again.');
   const sessionHash=rawToken?await digest(rawToken):'';
   const call=(op,payload={})=>rpc(op,payload,sessionHash);
   const limit=async key=>{if(!(await rpc('rate',{key:await digest(key)})).allowed)throw new APIError(429,'Too many attempts. Please wait a minute.');};
   if(request.method==='GET') {
    const photo=/^users\/(\d+)\/avatar$/.exec(path);
    if(photo&&photos){if(!sessionHash)throw new APIError(401,'Please sign in again.');const bytes=await photos.get(Number(photo[1]),sessionHash);return new Response(bytes,{headers:{...headers,'Content-Type':'image/jpeg'}});}
    if(path==='state') {
     const capabilities={recovery:true,avatars:!!photos,admin_management:!!adminRPC,google_client_id:google?.clientID||null};
     if(!sessionHash)return reply({user:null,csrf:'bearer',server_now:Date.now()/1000,releases,capabilities});
     const state=await call('state');
     if(googleRPC)state.user.google_linked=(await googleRPC('status',{},sessionHash)).linked;
     return reply({...state,releases,capabilities});
    }
    if(path==='admin'){if(!sessionHash||!adminRPC)throw new APIError(403,'Administrator access required.');return reply(await adminRPC('summary',{},sessionHash));}
    if(path==='username-availability') {
     const name=field({name:url.searchParams.get('name')},'name',40);
     return reply(await call('availability',{normalized:normalize(name)}));
    }
    throw new APIError(404,'Not found.');
   }
   if(/^entries\/\d+\/file$/.test(path))throw new APIError(403,'Project file uploads are disabled. Share a model link instead.');
   if(path==='profile/avatar'){if(!sessionHash)throw new APIError(401,'Please sign in again.');if(!photos)throw new APIError(503,'Photo uploads are unavailable.');await limit('photo:'+sessionHash);return reply(await photos.upload(request,sessionHash));}
   const body=await jsonBody(request);
   if(path==='auth/invitation') {
    if(!googleRPC)throw new APIError(503,'Invitation checks are unavailable.');
    const invite=field(body,'invite',160);await limit('invitation:'+await digest(invite));
    return reply(await googleRPC('invitation',{invite_hash:await digest(invite)},''));
   }
   if(path==='auth/google/challenge'||path==='auth/google') {
    if(!google||!googleRPC)throw new APIError(503,'Google sign-in is not configured yet.');
    await limit('google:'+String(body.challenge||sessionHash||body.invite||'login'));
    if(path.endsWith('challenge')) {
     const challenge=token(),nonce=token(),mode=field(body,'mode',20);
     const payload={mode,challenge_hash:await digest(challenge),nonce_hash:await digest(nonce)};
     if(mode==='register'){payload.invite_hash=await digest(field(body,'invite',160));payload.display_name=field(body,'display_name',80);}
     await googleRPC('challenge',payload,sessionHash);
     return reply({challenge,nonce,client_id:google.clientID});
    }
    const challenge=field(body,'challenge',64), identity=await google.verify(field(body,'credential',12000));
    const registration={};
    if(body.mode==='register'){
     registration.register=true;registration.invite_hash=await digest(field(body,'invite',160));
     registration.generated=body.username_mode==='gmail';
     if(registration.generated&&!identity.gmailName)throw new APIError(400,'Choose a username: this Google account does not have a verified Gmail address.');
     registration.name=registration.generated?identity.gmailName:field(body,'name',40);
     registration.normalized=normalize(registration.name);
    }
    const sessionToken=token();
    try{await googleRPC('complete',{...registration,challenge_hash:await digest(challenge),nonce_hash:await digest(identity.nonce),subject:identity.subject,token_hash:await digest(sessionToken)},sessionHash);}catch(error){
     if(error instanceof APIError&&error.message.startsWith('This Google account is not linked.'))return reply({code:'google_account_unlinked',error:'This Google account has not joined Print League yet. Enter an invitation in Join to create an account. Already a member? Sign in with your username and link Google from your profile.'},403);
     throw error;
    }
    return reply({ok:true,session_token:sessionToken});
   }
   if(path==='auth/reset-password') {
    if(!adminRPC)throw new APIError(503,'Password reset is unavailable.');
    const normalized=normalize(field(body,'name',40)),secret=password(body);
    await limit('login:'+normalized);
    if(secret!==body.confirm_password)throw new APIError(400,'Passwords do not match.');
    return reply(await adminRPC('complete-reset',{normalized,reset_hash:await digest(field(body,'temporary_password',160)),hash:await hashPassword(secret)},''));
   }
   if(path==='auth/login'||path==='auth/register'||path==='auth/recover') {
    const name=field(body,'name',40), normalized=normalize(name), secret=password(body,'password',path.endsWith('login')?1:6);
    await limit('login:'+normalized);
    const sessionToken=token(), tokenHash=await digest(sessionToken);
    if(path==='auth/recover') {
     if(secret!==body.confirm_password)throw new APIError(400,'Passwords do not match.');
     await rpc('recover',{normalized,recovery_hash:await digest(field(body,'recovery_code',160)),hash:await hashPassword(secret),token_hash:tokenHash});
    } else if(path==='auth/register') {
     if(secret!==body.confirm_password)throw new APIError(400,'Passwords do not match.');
     const invite=field(body,'invite',160);
     await rpc('register',{name,normalized,hash:await hashPassword(secret),invite_hash:await digest(invite),token_hash:tokenHash});
    } else {
     const user=await rpc('credentials',{normalized});
     if(!await verifyPassword(secret,user?.hash))throw new APIError(401,'Incorrect username or password.');
     await rpc('login',{id:user.id,verified_hash:user.hash,token_hash:tokenHash});
    }
    return reply({ok:true,session_token:sessionToken});
   }
   if(!sessionHash)throw new APIError(401,'Please sign in again.');
   if(path==='admin/promote'||path==='admin/demote'){if(!adminRPC)throw new APIError(403,'Administrator access required.');return reply(await adminRPC(path.split('/')[1],{member_id:body.member_id},sessionHash));}
   if(path==='admin/reset-password') {
    if(!adminRPC)throw new APIError(403,'Administrator access required.');
    await adminRPC('summary',{},sessionHash);await limit('admin-reset:'+sessionHash);
    const temporary=token().slice(0,32);
    await adminRPC('reset-password',{member_id:body.member_id,reset_hash:await digest(temporary)},sessionHash);
    return reply({ok:true,temporary_password:temporary});
   }
   if(path==='profile/google/unlink'){if(!googleRPC)throw new APIError(503,'Google linking is unavailable.');return reply(await googleRPC('unlink',{},sessionHash));}
   if(path==='auth/logout')return reply(await call('logout'));
   if(path==='profile/recovery-codes') {
    await limit('credentials:'+sessionHash);
    const current=await call('own-credentials');
    if(!await verifyPassword(password(body,'current_password',1),current?.hash))throw new APIError(403,'Your current password is incorrect.');
    const codes=Array.from({length:5},token);
    await call('recovery-codes',{verified_hash:current.hash,hashes:await Promise.all(codes.map(digest))});
    return reply({ok:true,recovery_codes:codes});
   }
   if(path==='profile/credentials') {
    await limit('credentials:'+sessionHash);
    const secret=password(body),name=field(body,'name',40);
    if(secret!==body.confirm_password)throw new APIError(400,'Passwords do not match.');
    const current=await call('own-credentials');
    if(!current?.hash){
     if(!googleRPC)throw new APIError(403,'Sign in with Google again.');
     const sessionToken=token();
     await googleRPC('add-password',{name,normalized:normalize(name),hash:await hashPassword(secret),token_hash:await digest(sessionToken)},sessionHash);
     return reply({ok:true,session_token:sessionToken});
    }
    if(!await verifyPassword(password(body,'current_password',1),current.hash))throw new APIError(403,'Your current password is incorrect.');
    const sessionToken=token();
    await call('change-credentials',{name,normalized:normalize(name),verified_hash:current.hash,hash:await hashPassword(secret),token_hash:await digest(sessionToken)});
    return reply({ok:true,session_token:sessionToken});
   }
   if(path==='profile')return reply(await call('profile',{display_name:field(body,'display_name',80)}));
   if(path==='invites') {
    const code=token();await call('invites',{invite_hash:await digest(code)});return reply({code});
   }
   if(path==='rounds')return reply(await call('rounds',{
    title:field(body,'title'),deadline:date(body.deadline,'deadline'),prevote:[true,'on','true','1'].includes(body.prevote),
    vote_opens_at:date(body.vote_opens_at,'voting start',true),votes_close_at:date(body.votes_close_at,'voting end',true)
   }));
   let match=/^rounds\/(\d+)\/([a-z-]+)$/.exec(path);
   if(match) {
    const action=match[2],data={round_id:match[1],action};
    if(['topic','entry'].includes(action))data.title=field(body,'title');
    if(action==='topic'){data.title=collapse(data.title);data.normalized=topicKey(data.title);}
    if(['vote','delete-topic','resolve-tie'].includes(action))data.topic_id=body.topic_id;
    if(action==='participate')data.status=body.status;
    if(action==='winner'){data.entry_id=body.entry_id;data.category=field(body,'category');}
    if(action==='links')Object.assign(data,printLink(body));
    return reply(await call('round-action',data));
   }
   if(path==='features') {
    const title=field(body,'title',120), description=body.description||'';
    if(typeof description!=='string'||Array.from(description).length>1000)throw new APIError(400,'Keep descriptions to 1,000 characters.');
    return reply(await call('features',{title,normalized:topicKey(title),description:description.trim()}));
   }
   match=/^features\/(\d+)\/(move|delete)$/.exec(path);
   if(match)return reply(await call('feature-action',{id:match[1],action:match[2],stage:body.stage}));
   match=/^print-links\/(\d+)\/delete$/.exec(path);
   if(match)return reply(await call('delete-link',{id:match[1]}));
   throw new APIError(404,'Not found.');
  } catch(error) {
   // Never expose SQL, password hashes, session tokens or upstream response bodies.
   return reply({error:error instanceof APIError?error.message:'The request could not be completed.'},error instanceof APIError?error.status:500);
  }
 };
}
export const handle=createHandler();
