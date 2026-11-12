begin;
create table league_private.admin_promotions (
 id bigint generated always as identity primary key,
 actor_id bigint not null references league_private.members(id),
 member_id bigint not null references league_private.members(id),
 created_at timestamptz not null default now()
);
alter table league_private.admin_promotions enable row level security;
create function public.league_admin(session_hash text, operation text, payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path=pg_catalog,league_private as $$
declare uid bigint; target_id bigint; begin
 perform pg_advisory_xact_lock(747230011);
 select s.member_id into uid from sessions s join members m on m.id=s.member_id
 where s.token_hash=session_hash and s.expires_at>now() and s.revoked_at is null and m.admin;
 if uid is null then perform fail(403,'Administrator access required.'); end if;
 if operation='summary' then
  return jsonb_build_object('member_count',(select count(*) from members),
   'admin_count',(select count(*) from members where admin),
   'pending_invites',(select count(*) from invites where redeemed_at is null and expires_at>now()),
   'members',coalesce((select jsonb_agg(public_member(id)||jsonb_build_object('joined_at',created_at) order by id) from members),'[]'));
 elsif operation='promote' then
  target_id:=(payload->>'member_id')::bigint;
  if not exists(select 1 from members where id=target_id) then perform fail(404,'Member not found.'); end if;
  update members set admin=true where id=target_id and not admin;
  if found then insert into admin_promotions(actor_id,member_id) values(uid,target_id); end if;
  return '{"ok":true}';
 end if;
 perform fail(404,'Unknown administrator action.');return null;
exception when invalid_text_representation then perform fail(400,'Choose a member.');return null;
end $$;
revoke all on function public.league_admin(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.league_admin(text,text,jsonb) to service_role;
commit;
