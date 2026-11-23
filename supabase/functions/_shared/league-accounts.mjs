import {APIError,field} from './validation.mjs';

export async function memberFor(query,sessionHash) {
 const [member]=await query(`select m.id,m.admin from sessions s
  join members m on m.id=s.member_id
  where s.token_hash=$1 and s.expires_at>now() and s.revoked_at is null`,[sessionHash]);
 return member;
}

export async function availableUsername(query,normalized,member) {
 const [row]=await query(`select not exists(
  select 1 from identifiers where kind='username' and normalized=$1
  and member_id is distinct from $2::bigint
 ) as available`,[normalized??null,member?.id??null]);
 return row;
}

async function startSession(query,uid,tokenHash) {
 await query(`insert into sessions(token_hash,member_id,csrf_hash,expires_at)
  values($1,$2,$1,now()+interval '7 days')`,[tokenHash??null,uid]);
}

async function replacePassword(query,uid,payload) {
 await query('update passwords set hash=$1,updated_at=now() where member_id=$2',[field(payload,'hash',256),uid]);
 await query('delete from sessions where member_id=$1',[uid]);
 await startSession(query,uid,payload.token_hash);
}

async function checkPasswordHash(query,uid,hash,status,message) {
 const [password]=await query('select hash from passwords where member_id=$1',[uid]);
 if(!password||password.hash!==hash)throw new APIError(status,message);
}

async function checkUsername(query,normalized,member) {
 if(!(await availableUsername(query,normalized,member)).available)throw new APIError(409,'That username is already taken.');
}

async function register(query,payload) {
 const codeHash=payload.invite_hash??null;
 const [invite]=await query(`select id,grants_admin,invited_username from invites
  where token_hash=$1 and invite_available($1)`,[codeHash]);
 if(!invite)throw new APIError(403,'Invalid or used invitation.');
 const name=field(payload,'name',40),normalized=field(payload,'normalized',160);
 if(invite.invited_username!==null&&invite.invited_username!==normalized)
  throw new APIError(403,'This invitation is reserved for another username.');
 await checkUsername(query,normalized);
 const [{id}]=await query(`insert into members(display_name,admin)
  values($1,$2) returning id`,[name,invite.grants_admin]);
 await query(`insert into identifiers(member_id,kind,value,normalized)
  values($1,'username',$2,$3)`,[id,name,normalized]);
 await query(`insert into passwords(member_id,hash,algorithm)
  values($1,$2,'pbkdf2-sha256-v1')`,[id,field(payload,'hash',256)]);
 await query('update invites set uses=uses+1,redeemed_at=now(),redeemed_by=$1 where id=$2',[id,invite.id]);
 return id;
}

export const accountActions={
 async rate(query,payload) {
  await query("delete from rate_limits where window_start<now()-interval '1 day'");
  for(const [bucket,cap] of [['global-auth',120],['identifier:'+field(payload,'key',160),8]]){
   const [{attempts}]=await query(`insert into rate_limits as limits values($1,now(),1)
    on conflict(bucket) do update set
     attempts=case when limits.window_start<now()-interval '1 minute' then 1 else limits.attempts+1 end,
     window_start=case when limits.window_start<now()-interval '1 minute' then now() else limits.window_start end
    returning attempts`,[bucket]);
   if(attempts>cap)return {allowed:false};
  }
  return {allowed:true};
 },
 async credentials(query,payload) {
  const [row]=await query(`select jsonb_build_object('id',i.member_id,'hash',p.hash) as credentials
   from identifiers i join passwords p on p.member_id=i.member_id
   where i.kind='username' and i.normalized=$1`,[payload.normalized??null]);
  return row?.credentials??null;
 },
 async recover(query,payload) {
  const code=payload.recovery_hash??null;
  const [member]=await query(`select i.member_id as id from identifiers i
   join recovery_codes c on c.member_id=i.member_id
   where i.kind='username' and i.normalized=$1 and c.token_hash=$2 and c.used_at is null`,[payload.normalized??null,code]);
  if(!member)throw new APIError(403,'Invalid username or recovery code.');
  await query('update recovery_codes set used_at=now() where token_hash=$1',[code]);
  await replacePassword(query,member.id,payload);
  return {ok:true};
 },
 async register(query,payload) {
  const uid=await register(query,payload);
  await loginSession(query,uid,payload.token_hash);
  return {ok:true};
 },
 async login(query,payload) {
  const uid=payload.id??null;
  await checkPasswordHash(query,uid,payload.verified_hash,401,'Sign in again.');
  await loginSession(query,uid,payload.token_hash);
  return {ok:true};
 }
};

async function loginSession(query,uid,tokenHash) {
 await query('delete from sessions where expires_at<now() or revoked_at is not null');
 await query(`delete from sessions where token_hash in (
  select token_hash from sessions where member_id=$1 order by created_at desc offset 9
 )`,[uid]);
 await startSession(query,uid,tokenHash);
}

export const memberAccountActions={
 async logout(query,payload,member,sessionHash) {
  await query('delete from sessions where token_hash=$1',[sessionHash]);
  return {ok:true};
 },
 async 'own-credentials'(query,payload,member) {
  const [row]=await query('select hash from passwords where member_id=$1',[member.id]);
  return row??null;
 },
 async 'recovery-codes'(query,payload,member) {
  await checkPasswordHash(query,member.id,payload.verified_hash,403,'Confirm your current password.');
  if(!Array.isArray(payload.hashes)||payload.hashes.length!==5||
     payload.hashes.some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))
   throw new APIError(400,'Invalid recovery codes.');
  await query('delete from recovery_codes where member_id=$1',[member.id]);
  await query(`insert into recovery_codes(member_id,token_hash)
   select $1,value from jsonb_array_elements_text($2::jsonb)`,[member.id,JSON.stringify(payload.hashes)]);
  return {ok:true};
 },
 async 'change-credentials'(query,payload,member) {
  await checkPasswordHash(query,member.id,payload.verified_hash,403,'Sign in again before changing your password.');
  const name=field(payload,'name',40),normalized=field(payload,'normalized',160);
  await checkUsername(query,normalized,member);
  await query("update identifiers set value=$1,normalized=$2 where member_id=$3 and kind='username'",[name,normalized,member.id]);
  await replacePassword(query,member.id,payload);
  return {ok:true};
 }
};
