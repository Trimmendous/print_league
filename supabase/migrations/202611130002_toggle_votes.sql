-- Toggle only the current member’s vote while the poll is open.
begin;
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
   'voter_count',(select count(distinct user_id) from votes where round_id=x.id),
   'tied_topic_ids',case when x.phase='tie' and (m.admin or x.creator_id=uid) then
    (select coalesce(jsonb_agg(id),'[]') from (select t.id,rank() over(order by count(v.user_id) desc) as place from topics t left join votes v on v.topic_id=t.id and v.round_id=t.round_id where t.round_id=x.id group by t.id) ranked where place=1)
    else '[]'::jsonb end,
   'created_at',extract(epoch from x.created_at),'printing_started_at',extract(epoch from x.printing_started_at),
   'voting_started_at',extract(epoch from x.voting_started_at),'vote_opens_at',extract(epoch from x.vote_opens_at),'votes_close_at',extract(epoch from x.votes_close_at)) order by x.id) from rounds x),'[]'));
  result:=result || jsonb_build_object('topics',coalesce((select jsonb_agg(to_jsonb(x)-'normalized' order by x.id) from topics x),'[]'));
  result:=result || jsonb_build_object('votes',coalesce((select jsonb_agg(x order by round_id,user_id) from votes x where x.user_id=uid),'[]'));
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
   delete from votes where round_id=rid and user_id=uid and topic_id=item;
   if not found then insert into votes values(rid,uid,item); end if;
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
commit;
