begin;
-- A private, bounded bucket for sanitized profile photos only; no browser policies.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('league-avatars','league-avatars',false,262144,array['image/jpeg'])
 on conflict(id) do nothing;
create function public.league_avatar(session_hash text, operation text, target bigint default null, version text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,league_private as $$
declare uid bigint; key text; begin
 select member_id into uid from sessions where token_hash=session_hash and expires_at>now() and revoked_at is null;
 if uid is null then perform fail(401,'Please sign in again.'); end if;
 if operation='self' then return jsonb_build_object('id',uid,'key','member-'||uid||'.jpg');
 elsif operation='save' then
  if version !~ '^[a-f0-9]{64}$' then perform fail(400,'Invalid photo version.'); end if;
  update members set avatar_key=version where id=uid;
  return '{"ok":true}';
 elsif operation='get' then
  select avatar_key into key from members where id=target;
  if key is null then perform fail(404,'Photo not found.'); end if;
  return jsonb_build_object('key','member-'||target||'.jpg');
 end if;
 perform fail(400,'Invalid photo operation.');return null;
end $$;
revoke all on function public.league_avatar(text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.league_avatar(text,text,bigint,text) to service_role;
commit;
