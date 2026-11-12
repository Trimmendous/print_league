begin;
create table league_private.password_resets (
 member_id bigint primary key references league_private.members(id) on delete cascade,
 token_hash text not null check(length(token_hash)=64), expires_at timestamptz not null
);
create table league_private.admin_actions (
 id bigint generated always as identity primary key,
 actor_id bigint not null references league_private.members(id),
 member_id bigint not null references league_private.members(id),
 action text not null, created_at timestamptz not null default now()
);
alter table league_private.password_resets enable row level security;
alter table league_private.admin_actions enable row level security;
create or replace function public.league_admin(session_hash text, operation text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,league_private as $$
declare uid bigint; target_id bigint; begin
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
   'pending_invites',(select count(*) from invites where redeemed_at is null and expires_at>now()),
   'members',coalesce((select jsonb_agg(public_member(id)||jsonb_build_object('joined_at',created_at) order by id) from members),'[]'));
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
create function league_private.clear_password_reset() returns trigger language plpgsql security definer set search_path=pg_catalog,league_private as $$
begin delete from password_resets where member_id=new.member_id;return new;end $$;
create trigger password_changed_clear_reset after update of hash on league_private.passwords for each row execute function league_private.clear_password_reset();
commit;
