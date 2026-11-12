begin;
alter table league_private.invites alter column expires_at drop not null;
alter table league_private.invites add column id bigint generated always as identity unique;
alter table league_private.invites add column label text not null default '' check(char_length(label)<=80);
alter table league_private.invites add column max_uses integer default 1 check(max_uses is null or max_uses=1);
alter table league_private.invites add column uses bigint not null default 0 check(uses>=0);
alter table league_private.invites add column revoked_at timestamptz;
update league_private.invites set uses=1 where redeemed_at is not null;
alter table league_private.invites add constraint reserved_invites_single_use check((not grants_admin and invited_username is null) or max_uses=1 and max_uses is not null);
create function league_private.invite_available(code_hash text) returns boolean language sql stable set search_path=pg_catalog,league_private as $$
 select exists(select 1 from invites where token_hash=code_hash and revoked_at is null and (expires_at is null or expires_at>now()) and (max_uses is null or uses<max_uses))
$$;
create function league_private.invite_expiry(choice text) returns timestamptz language plpgsql set search_path=pg_catalog,league_private as $$
begin
 case choice when '1h' then return now()+interval '1 hour'; when '24h' then return now()+interval '24 hours'; when '7d' then return now()+interval '7 days'; when 'never' then return null; else perform fail(400,'Choose an invitation expiry.');end case;
end $$;
create function league_private.invite_limit(choice text) returns integer language plpgsql set search_path=pg_catalog,league_private as $$
begin
 case choice when 'once' then return 1; when 'reusable' then return null; else perform fail(400,'Choose one-time use or reusable.');end case;
end $$;
create or replace function public.league_rpc(operation text, payload jsonb default '{}'::jsonb, session_hash text default '') returns jsonb
language plpgsql security definer set search_path = pg_catalog, league_private as $$
declare
 uid bigint; m members%rowtype; r rounds%rowtype; idea feature_ideas%rowtype;
 item bigint; rid bigint; action text; allowed boolean; collected boolean;
 result jsonb; username_label text; norm_value text; old_hash text; v text; bucket_key text;
 cutoff timestamptz; opens timestamptz; closes timestamptz; prevote boolean;
 attempts integer; ids bigint[]; cap integer; session_id text;
begin
 -- Small-league transactions serialize membership and league changes, including deadline
 -- catch-up and state snapshots. Lock is released by PostgreSQL at transaction end.
 perform pg_advisory_xact_lock(747230011);
 if jsonb_typeof(payload) <> 'object' then perform fail(400,'Invalid request'); end if;
 if operation='rate' then
  delete from rate_limits where window_start < now()-interval '1 day';
  foreach bucket_key in array array['global-auth', 'identifier:'||(payload->>'key')] loop
   cap := case when bucket_key='global-auth' then 120 else 8 end;
   insert into rate_limits as limits values(bucket_key,now(),1)
   on conflict(bucket) do update set
    attempts=case when limits.window_start < now()-interval '1 minute' then 1 else limits.attempts+1 end,
    window_start=case when limits.window_start < now()-interval '1 minute' then now() else limits.window_start end
   returning limits.attempts into attempts;
   if attempts>cap then return jsonb_build_object('allowed',false); end if;
  end loop;
  return jsonb_build_object('allowed',true);
 end if;
 if operation='credentials' then
  select jsonb_build_object('id',i.member_id,'hash',p.hash) into result
  from identifiers i join passwords p on p.member_id=i.member_id
  where i.kind='username' and i.normalized=payload->>'normalized';
  return coalesce(result,'null'::jsonb);
 end if;
 if operation='recover' then
  select i.member_id into uid from identifiers i join recovery_codes c on c.member_id=i.member_id
   where i.kind='username' and i.normalized=payload->>'normalized' and c.token_hash=payload->>'recovery_hash' and c.used_at is null;
  if uid is null then perform fail(403,'Invalid username or recovery code.'); end if;
  update recovery_codes set used_at=now() where token_hash=payload->>'recovery_hash';
  update passwords set hash=text_field(payload,'hash',256),updated_at=now() where member_id=uid;
  delete from sessions where member_id=uid;
  insert into sessions(token_hash,member_id,csrf_hash,expires_at) values(payload->>'token_hash',uid,payload->>'token_hash',now()+interval '7 days');
  return '{"ok":true}';
 end if;
 if operation in ('register','login') then
  if operation='register' then
   if not invite_available(payload->>'invite_hash') then
    perform fail(403,'Invalid or used invitation.');
   end if;
   username_label := text_field(payload,'name',40); norm_value := text_field(payload,'normalized',160);
   if exists(select 1 from invites where token_hash=payload->>'invite_hash' and invited_username is not null and invited_username<>norm_value) then perform fail(403,'This invitation is reserved for another username.'); end if;
   if exists(select 1 from identifiers where kind='username' and identifiers.normalized=norm_value) then perform fail(409,'That username is already taken.'); end if;
   insert into members(display_name,admin) select username_label,grants_admin from invites where token_hash=payload->>'invite_hash' returning id into uid;
   insert into identifiers(member_id,kind,value,normalized) values(uid,'username',username_label,norm_value);
   insert into passwords(member_id,hash,algorithm) values(uid,text_field(payload,'hash',256),'pbkdf2-sha256-v1');
   update invites set uses=uses+1,redeemed_at=now(),redeemed_by=uid where token_hash=payload->>'invite_hash';
  else
   uid := (payload->>'id')::bigint;
   if not exists(select 1 from passwords where member_id=uid and hash=payload->>'verified_hash') then perform fail(401,'Sign in again.'); end if;
  end if;
  -- Expired/revoked sessions do not grow indefinitely. Cap active sessions per member.
  delete from sessions where expires_at<now() or revoked_at is not null;
  delete from sessions where token_hash in (select token_hash from sessions where member_id=uid order by created_at desc offset 9);
  insert into sessions(token_hash,member_id,csrf_hash,expires_at)
   values(payload->>'token_hash',uid,payload->>'token_hash',now()+interval '7 days');
  return jsonb_build_object('ok',true);
 end if;
 select member_id into uid from sessions where token_hash=session_hash and expires_at>now() and revoked_at is null;
 if operation='availability' then
  return jsonb_build_object('available',not exists(select 1 from identifiers where kind='username' and identifiers.normalized=payload->>'normalized' and (uid is null or member_id<>uid)));
 end if;
 if uid is null then perform fail(401,'Please sign in again.'); end if;
 select * into m from members where id=uid;
 if operation='logout' then delete from sessions where token_hash=session_hash; return '{"ok":true}'; end if;
 if operation='own-credentials' then
  select jsonb_build_object('hash',hash) into result from passwords where member_id=uid;
  return coalesce(result,'null'::jsonb);
 end if;
 if operation='recovery-codes' then
  if not exists(select 1 from passwords where member_id=uid and hash=payload->>'verified_hash') then perform fail(403,'Confirm your current password.'); end if;
  if jsonb_array_length(payload->'hashes')<>5 then perform fail(400,'Invalid recovery codes.'); end if;
  delete from recovery_codes where member_id=uid;
  insert into recovery_codes(member_id,token_hash) select uid,value from jsonb_array_elements_text(payload->'hashes');
  return '{"ok":true}';
 end if;
 if operation='change-credentials' then
  select hash into old_hash from passwords where member_id=uid;
  if old_hash is null or old_hash is distinct from payload->>'verified_hash' then perform fail(403,'Sign in again before changing your password.'); end if;
  username_label:=text_field(payload,'name',40); norm_value:=text_field(payload,'normalized',160);
  if exists(select 1 from identifiers where kind='username' and identifiers.normalized=norm_value and member_id<>uid) then perform fail(409,'That username is already taken.'); end if;
  update identifiers set value=username_label,normalized=payload->>'normalized' where member_id=uid and kind='username';
  update passwords set hash=text_field(payload,'hash',256),updated_at=now() where member_id=uid;
  delete from sessions where member_id=uid;
  insert into sessions(token_hash,member_id,csrf_hash,expires_at) values(payload->>'token_hash',uid,payload->>'token_hash',now()+interval '7 days');
  return '{"ok":true}';
 end if;
 perform sync_rounds();
 if operation='state' then
  result:=jsonb_build_object('user',public_member(uid),'server_now',extract(epoch from now()),'csrf','bearer');
  result:=result || jsonb_build_object('users',coalesce((select jsonb_agg(public_member(id)-'admin'-'has_password' order by id) from members),'[]'));
  result:=result || jsonb_build_object('rounds',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object(
   'created_at',extract(epoch from x.created_at),'printing_started_at',extract(epoch from x.printing_started_at),
   'voting_started_at',extract(epoch from x.voting_started_at),'vote_opens_at',extract(epoch from x.vote_opens_at),'votes_close_at',extract(epoch from x.votes_close_at)) order by x.id) from rounds x),'[]'));
  result:=result || jsonb_build_object('topics',coalesce((select jsonb_agg(to_jsonb(x)-'normalized' order by x.id) from topics x),'[]'));
  result:=result || jsonb_build_object('votes',coalesce((select jsonb_agg(x order by round_id,user_id) from votes x),'[]'));
  result:=result || jsonb_build_object('participants',coalesce((select jsonb_agg(x order by round_id,user_id) from participants x),'[]'));
  result:=result || jsonb_build_object('entries',coalesce((select jsonb_agg(x order by id) from entries x),'[]'));
  result:=result || jsonb_build_object('winners',coalesce((select jsonb_agg(x order by round_id,category) from winners x),'[]'));
  result:=result || jsonb_build_object('print_links',coalesce((select jsonb_agg(x order by id) from print_links x),'[]'));
  result:=result || jsonb_build_object('feature_ideas',coalesce((select jsonb_agg(to_jsonb(x)-'normalized'||jsonb_build_object('created_at',extract(epoch from x.created_at)) order by x.id) from feature_ideas x),'[]'));
  return result;
 elsif operation='profile' then
  update members set display_name=text_field(payload,'display_name',80) where id=uid;
 elsif operation='invites' then
  if not m.admin then perform fail(403,'Organizer access required.'); end if;
  insert into invites(token_hash,created_by,expires_at,max_uses,label) values(payload->>'invite_hash',uid,invite_expiry(coalesce(payload->>'expiry','7d')),invite_limit(coalesce(payload->>'usage','once')),coalesce(payload->>'label',''));
  return (select jsonb_build_object('id',id,'expires_at',expires_at,'max_uses',max_uses,'label',label) from invites where token_hash=payload->>'invite_hash');
 elsif operation='rounds' then
  if not m.admin then perform fail(403,'Organizer access required.'); end if;
  cutoff:=(payload->>'deadline')::timestamptz; opens:=(payload->>'vote_opens_at')::timestamptz; closes:=(payload->>'votes_close_at')::timestamptz;
  prevote:=coalesce((payload->>'prevote')::boolean,false);
  if cutoff is null or cutoff<=now() then perform fail(400,'The competition deadline must be in the future.'); end if;
  if opens is not null and (not prevote or opens<=now() or opens>=cutoff) then perform fail(400,'Voting must open in the future, before the deadline, with topic collection enabled.'); end if;
  if closes is not null and (closes<=coalesce(opens,now()) or closes>=cutoff) then perform fail(400,'Voting must close after opening and before the deadline.'); end if;
  insert into rounds(title,deadline,phase,creator_id,has_prevote,vote_opens_at,votes_close_at,voting_started_at)
   values(text_field(payload,'title'),cutoff,case when prevote then 'submissions' else 'topics' end,uid,prevote,opens,closes,case when not prevote then now() else null end);
 elsif operation='round-action' then
  rid:=(payload->>'round_id')::bigint; action:=payload->>'action';
  select * into r from rounds where id=rid;
  if not found then perform fail(404,'Competition not found.'); end if;
  allowed:=m.admin or r.creator_id=uid;
  collected:=r.phase='submissions' or (r.phase='topics' and not r.has_prevote);
  if action='delete-competition' and m.admin then
   delete from rounds where id=rid;
  elsif action='topic' and collected then
   if exists(select 1 from topics where round_id=rid and normalized=payload->>'normalized') then perform fail(409,'That topic is already in this poll. Add a different topic.'); end if;
   insert into topics(round_id,user_id,title,normalized) values(rid,uid,text_field(payload,'title'),text_field(payload,'normalized',640));
  elsif action='delete-topic' and collected then
   item:=(payload->>'topic_id')::bigint;
   if not exists(select 1 from topics where id=item and round_id=rid and user_id=uid) then perform fail(403,'You can only delete your own topics.'); end if;
   if exists(select 1 from votes where topic_id=item) then perform fail(409,'A topic with votes cannot be deleted.'); end if;
   delete from topics where id=item;
  elsif action='vote' and r.phase='topics' then
   item:=(payload->>'topic_id')::bigint;
   if not exists(select 1 from topics where id=item and round_id=rid) then perform fail(400,'Choose a topic from this competition.'); end if;
   insert into votes values(rid,uid,item) on conflict(round_id,user_id,topic_id) do nothing;
  elsif action='open-voting' and allowed and r.phase='submissions' then
   if not exists(select 1 from topics where round_id=rid) then perform fail(400,'Add a topic before opening voting.'); end if;
   update rounds set phase='topics',voting_started_at=now() where id=rid;
  elsif action in ('close-poll','advance') and allowed and r.phase='topics' then
   perform close_poll(rid,now());
  elsif action='resolve-tie' and allowed and r.phase='tie' then
   select array_agg(id) into ids from (select t.id,rank() over(order by count(v.user_id) desc) as place from topics t left join votes v on v.topic_id=t.id where t.round_id=rid group by t.id) ranked where place=1;
   item:=(payload->>'topic_id')::bigint;
   if item is null or not item=any(ids) then perform fail(400,'Choose a tied leading topic.'); end if;
   update rounds set phase='printing',topic=(select title from topics where id=item),printing_started_at=now() where id=rid;
  elsif action='reopen-topics' and allowed and r.phase='no_topics' then
   if r.deadline<=now() then perform fail(400,'This competition has ended.'); end if;
   update rounds set phase='submissions',has_prevote=true,vote_opens_at=null,votes_close_at=null,voting_started_at=null where id=rid;
  elsif action='archive-empty' and allowed and r.phase='no_topics' then
   update rounds set phase='completed' where id=rid;
  elsif action='participate' and r.phase in ('submissions','topics','tie','printing') and r.deadline>now() then
   if coalesce(payload->>'status','') not in ('in','out') then perform fail(400,'Choose Yes or No.'); end if;
   insert into participants values(rid,uid,payload->>'status') on conflict(round_id,user_id) do update set status=excluded.status;
  elsif action='entry' and r.phase='printing' then
   if not exists(select 1 from participants where round_id=rid and user_id=uid and status='in') then perform fail(403,'Join the round before submitting.'); end if;
   insert into entries(round_id,user_id,title) values(rid,uid,text_field(payload,'title')) on conflict(round_id,user_id) do update set title=excluded.title;
  elsif action='advance' and allowed and r.phase in ('printing','judging') then
   if r.phase='judging' and not exists(select 1 from winners where round_id=rid) and exists(select 1 from entries e join participants p using(round_id,user_id) where e.round_id=rid and p.status='in') then perform fail(400,'Record at least one winner first.'); end if;
   update rounds set phase=case when r.phase='printing' then 'judging' else 'completed' end where id=rid;
  elsif action='winner' and m.admin and r.phase='judging' then
   item:=(payload->>'entry_id')::bigint;
   if not exists(select 1 from entries e join participants p using(round_id,user_id) where e.id=item and e.round_id=rid and p.status='in') then perform fail(400,'Choose an eligible entry.'); end if;
   insert into winners values(rid,text_field(payload,'category'),item) on conflict(round_id,category) do update set entry_id=excluded.entry_id;
  elsif action='links' and r.phase='completed' then
   if not exists(select 1 from winners where round_id=rid) or not exists(select 1 from participants where round_id=rid and user_id=uid and status='in') then perform fail(403,'Only participants in completed, awarded rounds can share links.'); end if;
   insert into print_links(round_id,user_id,title,url,preview_image) values(rid,uid,text_field(payload,'title',120),text_field(payload,'url',2048),coalesce(payload->>'preview_image',''));
  else perform fail(403,'This action is not available in this phase.');
  end if;
  perform sync_rounds();
 elsif operation='delete-link' then
  delete from print_links where id=(payload->>'id')::bigint and user_id=uid;
  if not found then perform fail(403,'You can only remove your own links.'); end if;
 elsif operation='features' then
  insert into feature_ideas(user_id,title,normalized,description) values(uid,text_field(payload,'title',120),text_field(payload,'normalized',480),coalesce(payload->>'description',''));
 elsif operation='feature-action' then
  select * into idea from feature_ideas where id=(payload->>'id')::bigint;
  if not found then perform fail(404,'Idea not found.'); end if;
  if payload->>'action'='move' and m.admin then
   if coalesce(payload->>'stage','') not in ('ideas','progress','review') then perform fail(400,'Choose a board column.'); end if;
   update feature_ideas set stage=payload->>'stage' where id=idea.id;
  elsif payload->>'action'='delete' and (m.admin or (idea.user_id=uid and idea.stage='ideas')) then delete from feature_ideas where id=idea.id;
  else perform fail(403,'You cannot modify this idea.'); end if;
 else perform fail(404,'Unknown operation.');
 end if;
 return '{"ok":true}';
exception
 when unique_violation then perform fail(409,'That username, topic, idea or link already exists.'); return null;
 when invalid_text_representation or datetime_field_overflow or invalid_datetime_format or check_violation or not_null_violation then perform fail(400,'Invalid request values.'); return null;
end $$;
create or replace function public.league_google(operation text,payload jsonb default '{}',session_hash text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,league_private as $$
declare c google_challenges%rowtype; uid bigint; existing_uid bigint; mode_value text; subject_value text; username_value text; normalized_value text; suffix integer:=0; begin
 perform pg_advisory_xact_lock(747230011);
 select member_id into uid from sessions where token_hash=session_hash and expires_at>now() and revoked_at is null;
 if operation='invitation' then
  if not exists(select 1 from invites where token_hash=payload->>'invite_hash' and invite_available(token_hash)) then perform fail(403,'This invitation is invalid, expired, or already used. Ask an admin for a new one.'); end if;
  return (select jsonb_build_object('ok',true,'google_allowed',not grants_admin and invited_username is null) from invites where token_hash=payload->>'invite_hash');
 elsif operation='status' then
  if uid is null then perform fail(401,'Please sign in again.'); end if;
  return jsonb_build_object('linked',exists(select 1 from identities where member_id=uid and provider='google'));
 elsif operation='challenge' then
  delete from google_challenges where expires_at<=now();
  mode_value:=payload->>'mode';
  if mode_value not in ('login','register','link') or mode_value is null then perform fail(400,'Invalid sign-in request.'); end if;
  if mode_value='register' then
   if not exists(select 1 from invites where token_hash=payload->>'invite_hash' and invite_available(token_hash) and not grants_admin and invited_username is null) then perform fail(403,'A valid member invitation is required.'); end if;
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
   if not exists(select 1 from invites where token_hash=c.invite_hash and invite_available(token_hash) and not grants_admin and invited_username is null) then perform fail(403,'Invalid or used invitation.'); end if;
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
   update invites set uses=uses+1,redeemed_at=now(),redeemed_by=uid where token_hash=c.invite_hash;
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
create or replace function public.league_admin(session_hash text, operation text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,league_private as $$
declare uid bigint; target_id bigint; inv invites%rowtype; chosen_limit integer; begin
 perform pg_advisory_xact_lock(747230011);
 if operation='complete-reset' then
  select i.member_id into target_id from identifiers i join password_resets r on r.member_id=i.member_id
  where i.kind='username' and i.normalized=payload->>'normalized' and r.token_hash=payload->>'reset_hash' and r.expires_at>now();
  if target_id is null then perform fail(403,'Temporary password is invalid or expired.'); end if;
  update passwords set hash=payload->>'hash',updated_at=now() where member_id=target_id;
  delete from password_resets where member_id=target_id;
  delete from recovery_codes where member_id=target_id;
  update sessions set revoked_at=now() where member_id=target_id;
  return '{"ok":true}';
 end if;
 select s.member_id into uid from sessions s join members m on m.id=s.member_id
 where s.token_hash=session_hash and s.expires_at>now() and s.revoked_at is null and m.admin;
 if uid is null then perform fail(403,'Administrator access required.'); end if;
 if operation='summary' then
  return jsonb_build_object('member_count',(select count(*) from members),
   'admin_count',(select count(*) from members where admin),
   'pending_invites',(select count(*) from invites where invite_available(token_hash)),
   'invitations',coalesce((select jsonb_agg(jsonb_build_object('id',id,'label',label,'uses',uses,'max_uses',max_uses,'expires_at',expires_at,'created_at',created_at,'revoked',revoked_at is not null,'active',invite_available(token_hash),'restricted',grants_admin or invited_username is not null) order by id desc) from invites),'[]'),
   'members',coalesce((select jsonb_agg(public_member(id)||jsonb_build_object('joined_at',created_at) order by id) from members),'[]'));
 elsif operation in ('invitation-edit','invitation-revoke') then
  select * into inv from invites where id=(payload->>'id')::bigint;
  if not found then perform fail(404,'Invitation not found.');end if;
  if operation='invitation-revoke' then update invites set revoked_at=coalesce(revoked_at,now()) where id=inv.id;return '{"ok":true}';end if;
  if inv.grants_admin or inv.invited_username is not null then perform fail(403,'Reserved setup invitations cannot be edited.');end if;
  if inv.revoked_at is not null then perform fail(409,'Revoked invitations cannot be reactivated. Generate a new code.');end if;
  chosen_limit:=invite_limit(payload->>'usage');
  if chosen_limit is not null and inv.uses>chosen_limit then perform fail(409,'This code has already been used more than once. Revoke it and generate a one-time code.');end if;
  update invites set label=coalesce(payload->>'label',label),max_uses=chosen_limit,
   expires_at=case when payload->>'expiry'='keep' then expires_at else invite_expiry(payload->>'expiry') end where id=inv.id;
  return '{"ok":true}';
 elsif operation in ('promote','demote','reset-password') then
  target_id:=(payload->>'member_id')::bigint;
  if not exists(select 1 from members where id=target_id) then perform fail(404,'Member not found.'); end if;
  if operation='reset-password' then
   if target_id=uid then perform fail(400,'Use your profile to change your own password.'); end if;
   if not exists(select 1 from passwords where member_id=target_id) then perform fail(400,'This member signs in with Google. They must recover access through Google.'); end if;
   insert into password_resets(member_id,token_hash,expires_at) values(target_id,payload->>'reset_hash',now()+interval '24 hours')
   on conflict(member_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at;
   insert into admin_actions(actor_id,member_id,action) values(uid,target_id,'reset-password');
   return '{"ok":true}';
  elsif operation='demote' then
   if (select admin from members where id=target_id) and (select count(*) from members where admin)<=1 then perform fail(400,'The league must keep at least one admin.'); end if;
   update members set admin=false where id=target_id and admin;
   if found then insert into admin_actions(actor_id,member_id,action) values(uid,target_id,'demote'); end if;
   return '{"ok":true}';
  end if;
  update members set admin=true where id=target_id and not admin;
  if found then insert into admin_promotions(actor_id,member_id) values(uid,target_id); end if;
  return '{"ok":true}';
 end if;
 perform fail(404,'Unknown administrator action.');return null;
exception when invalid_text_representation then perform fail(400,'Choose a member.');return null;
end $$;
revoke all on all functions in schema league_private from public,anon,authenticated;
commit;
