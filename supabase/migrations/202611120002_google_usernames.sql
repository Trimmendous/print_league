begin;
create or replace function public.league_google(operation text,payload jsonb default '{}',session_hash text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,league_private as $$
declare c google_challenges%rowtype; uid bigint; existing_uid bigint; mode_value text; subject_value text; username_value text; normalized_value text; suffix integer:=0; begin
 perform pg_advisory_xact_lock(747230011);
 select member_id into uid from sessions where token_hash=session_hash and expires_at>now() and revoked_at is null;
 if operation='status' then
  if uid is null then perform fail(401,'Please sign in again.'); end if;
  return jsonb_build_object('linked',exists(select 1 from identities where member_id=uid and provider='google'));
 elsif operation='challenge' then
  delete from google_challenges where expires_at<=now();
  mode_value:=payload->>'mode';
  if mode_value not in ('login','register','link') or mode_value is null then perform fail(400,'Invalid sign-in request.'); end if;
  if mode_value='register' then
   if not exists(select 1 from invites where token_hash=payload->>'invite_hash' and redeemed_at is null and expires_at>now() and not grants_admin and invited_username is null) then perform fail(403,'A valid member invitation is required.'); end if;
   perform text_field(payload,'display_name',80);
  elsif mode_value='link' then
   if uid is null or not exists(select 1 from sessions where token_hash=session_hash and authenticated_at>now()-interval '10 minutes') then perform fail(403,'Sign in again before linking Google.'); end if;
  end if;
  insert into google_challenges(token_hash,nonce_hash,mode,session_hash,invite_hash,display_name)
   values(payload->>'challenge_hash',payload->>'nonce_hash',mode_value,case when mode_value='link' then session_hash else null end,payload->>'invite_hash',payload->>'display_name');
  return '{"ok":true}';
 elsif operation='complete' then
  select * into c from google_challenges where token_hash=payload->>'challenge_hash' and expires_at>now();
  if not found or c.nonce_hash is distinct from payload->>'nonce_hash' then perform fail(403,'Google sign-in expired. Please try again.'); end if;
  if c.mode='login' and coalesce((payload->>'register')::boolean,false) then
   c.mode:='register';c.invite_hash:=payload->>'invite_hash';c.display_name:=text_field(payload,'name',40);
  end if;
  subject_value:=text_field(payload,'subject',255);
  select member_id into existing_uid from identities where provider='google' and subject=subject_value;
  if c.mode='link' then
   if uid is null or c.session_hash is distinct from session_hash or not exists(select 1 from sessions where token_hash=session_hash and authenticated_at>now()-interval '10 minutes') then perform fail(403,'Sign in again before linking Google.'); end if;
   if existing_uid is not null and existing_uid<>uid then perform fail(409,'That Google account belongs to another league member.'); end if;
   if exists(select 1 from identities where member_id=uid and provider='google' and subject<>subject_value) then perform fail(409,'A different Google account is already linked.'); end if;
   insert into identities(member_id,provider,subject) values(uid,'google',subject_value) on conflict(provider,subject) do nothing;
  elsif existing_uid is not null then uid:=existing_uid;
  elsif c.mode='register' then
   if not exists(select 1 from invites where token_hash=c.invite_hash and redeemed_at is null and expires_at>now() and not grants_admin and invited_username is null) then perform fail(403,'Invalid or used invitation.'); end if;
   insert into members(display_name) values(c.display_name) returning id into uid;
   if payload->>'name' is not null then
    username_value:=text_field(payload,'name',40);normalized_value:=text_field(payload,'normalized',160);
    if coalesce((payload->>'generated')::boolean,false) then
     while exists(select 1 from identifiers where kind='username' and normalized=normalized_value) loop
      suffix:=suffix+1;username_value:=left(payload->>'name',32)||'_'||suffix::text;normalized_value:=left(payload->>'normalized',32)||'_'||suffix::text;
     end loop;
    end if;
    insert into identifiers(member_id,kind,value,normalized) values(uid,'username',username_value,normalized_value);
    update members set display_name=username_value where id=uid;
   end if;
   insert into identities values(uid,'google',subject_value);
   update invites set redeemed_at=now(),redeemed_by=uid where token_hash=c.invite_hash;
  else perform fail(403,'This Google account is not linked. Join with an invitation or link Google from your existing profile.');
  end if;
  delete from google_challenges where token_hash=c.token_hash;
  delete from sessions where expires_at<now() or revoked_at is not null;
  if c.mode='link' then delete from sessions where token_hash=session_hash; end if;
  delete from sessions where token_hash in (select token_hash from sessions where member_id=uid order by created_at desc offset 9);
  insert into sessions(token_hash,member_id,csrf_hash,expires_at,auth_provider) values(payload->>'token_hash',uid,payload->>'token_hash',now()+interval '7 days','google');
  return '{"ok":true}';
 elsif operation='unlink' then
  if uid is null or not exists(select 1 from sessions where token_hash=session_hash and authenticated_at>now()-interval '10 minutes') then perform fail(403,'Sign in again before disconnecting Google.'); end if;
  if not exists(select 1 from passwords where member_id=uid) then perform fail(400,'Add a username and password before disconnecting Google.'); end if;
  delete from identities where member_id=uid and provider='google';
  delete from sessions where member_id=uid and token_hash<>session_hash;
  return '{"ok":true}';
 elsif operation='add-password' then
  if uid is null or not exists(select 1 from sessions where token_hash=session_hash and auth_provider='google' and authenticated_at>now()-interval '10 minutes') then perform fail(403,'Sign in again with Google before adding a password.'); end if;
  if exists(select 1 from passwords where member_id=uid) then perform fail(409,'This account already has a password.'); end if;
  insert into identifiers(member_id,kind,value,normalized) values(uid,'username',text_field(payload,'name',40),text_field(payload,'normalized',160)) on conflict(member_id,kind) do update set value=excluded.value,normalized=excluded.normalized;
  insert into passwords(member_id,hash,algorithm) values(uid,text_field(payload,'hash',256),'pbkdf2-sha256-v1');
  delete from sessions where member_id=uid;
  insert into sessions(token_hash,member_id,csrf_hash,expires_at) values(payload->>'token_hash',uid,payload->>'token_hash',now()+interval '7 days');
  return '{"ok":true}';
 end if;
 perform fail(404,'Unknown sign-in operation.');return null;
exception when unique_violation then perform fail(409,'That username or Google account is already linked.');return null;
end $$;
commit;
