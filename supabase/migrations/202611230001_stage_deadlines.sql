begin;
alter table league_private.rounds add column judging_ends_at timestamptz;

create function public.league_schedule(operation text, payload jsonb, session_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, league_private as $$
declare
 r rounds%rowtype;
 collection_end timestamptz;
 voting_end timestamptz;
 printing_end timestamptz;
 judging_end timestamptz;
begin
 -- Serialize these edits with automatic transitions and ballot writes.
 perform pg_advisory_xact_lock(747230011);
 if not exists(
  select 1 from sessions s join members m on m.id=s.member_id
  where s.token_hash=session_hash and s.expires_at>now() and s.revoked_at is null and m.admin
 ) then perform fail(403,'Administrator access required.'); end if;
 if operation<>'edit' then perform fail(404,'Unknown schedule operation.'); end if;

 perform sync_rounds();
 select * into r from rounds where id=(payload->>'round_id')::bigint;
 if not found then perform fail(404,'Competition not found.'); end if;
 if r.phase is distinct from payload->>'phase'
    or r.runoff_number is distinct from (payload->>'ballot')::integer then
  perform fail(409,'The stage changed. Refresh the page and try again.');
 end if;
 if r.phase in ('submissions','topics','tie','no_topics','printing') then
  printing_end:=(payload->>'deadline')::timestamptz;
  collection_end:=case when r.phase='submissions' then (payload->>'vote_opens_at')::timestamptz else r.vote_opens_at end;
  voting_end:=case when r.phase in ('submissions','topics') then (payload->>'votes_close_at')::timestamptz else r.votes_close_at end;
  -- Manual advancement can precede a previously scheduled end time.
  if r.phase<>'submissions' and collection_end>now() then collection_end:=r.voting_started_at; end if;
  if r.phase not in ('submissions','topics') and voting_end>printing_end then voting_end:=null; end if;
  if printing_end is null or printing_end<=now()
     or (collection_end is not null and collection_end>=printing_end)
     or (voting_end is not null and voting_end>printing_end) then
   perform fail(400,'Printing must end in the future, after collection and at or after voting.');
  end if;
  if r.phase='submissions' and collection_end<=now() then
   perform fail(400,'Topic collection must end in the future.');
  end if;
  if r.phase in ('submissions','topics') and voting_end is not null
     and (voting_end<=now() or voting_end<=collection_end) then
   perform fail(400,'Topic voting must end in the future and after scheduled collection.');
  end if;
  update rounds set deadline=printing_end,vote_opens_at=collection_end,votes_close_at=voting_end where id=r.id;
 elsif r.phase='judging' then
  judging_end:=(payload->>'judging_ends_at')::timestamptz;
  if judging_end<=now() then perform fail(400,'Judging must end in the future.'); end if;
  update rounds set judging_ends_at=judging_end where id=r.id;
 else
  perform fail(409,'This competition is complete.');
 end if;
 return '{"ok":true}';
end $$;

revoke all on function public.league_schedule(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.league_schedule(text,jsonb,text) to service_role;
commit;
