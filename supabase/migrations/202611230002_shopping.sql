begin;
create table league_private.shopping_sprees (
 id bigint generated always as identity primary key,
 creator_id bigint not null references league_private.members(id),
 title text not null check (char_length(title) between 1 and 120),
 vendor text not null check (vendor in ('bambu','polymaker','sunlu')),
 target integer not null check (target between 1 and 10000),
 deadline timestamptz,
 status text not null default 'open' check (status in ('open','closed','cancelled')),
 closed_at timestamptz
);
create table league_private.shopping_items (
 id bigint generated always as identity primary key,
 spree_id bigint not null references league_private.shopping_sprees(id),
 user_id bigint not null references league_private.members(id),
 product text not null check (char_length(product) between 1 and 160),
 url text not null check (char_length(url) between 1 and 2048),
 quantity integer not null check (quantity between 1 and 1000)
);
create index shopping_items_spree on league_private.shopping_items(spree_id);
create table league_private.shopping_reads (
 spree_id bigint not null references league_private.shopping_sprees(id),
 user_id bigint not null references league_private.members(id),
 primary key (spree_id,user_id)
);
create table league_private.shopping_signal_outbox (
 id bigint generated always as identity primary key,
 spree_id bigint not null references league_private.shopping_sprees(id),
 event text not null check (event in ('opened','closed','cancelled','expired')),
 created_at timestamptz not null default now()
);
alter table league_private.shopping_sprees enable row level security;
alter table league_private.shopping_items enable row level security;
alter table league_private.shopping_reads enable row level security;
alter table league_private.shopping_signal_outbox enable row level security;

create function public.league_shopping(operation text, payload jsonb, session_hash text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, league_private as $$
declare
 uid bigint;
 spree shopping_sprees%rowtype;
 cutoff timestamptz;
 at_time timestamptz;
 rid bigint;
begin
 -- All shopping writes and deadline processing share a lock.
 perform pg_advisory_xact_lock(747230012);
 at_time:=clock_timestamp();
 if operation not in ('signal-events','signal-ack') then
  select member_id into uid from sessions where token_hash=session_hash and expires_at>now() and revoked_at is null;
  if uid is null then perform fail(401,'Please sign in again.'); end if;
 end if;

 with expired as (
  update shopping_sprees set status='closed',closed_at=deadline
  where status='open' and deadline<=at_time returning id
 )
 insert into shopping_signal_outbox(spree_id,event) select id,'expired' from expired;

 if operation='signal-events' then
  delete from shopping_signal_outbox where created_at<=now()-interval '7 days';
  return coalesce((
   select jsonb_agg(to_jsonb(e) order by e.id) from (
    select o.id,o.spree_id,o.event,s.title from shopping_signal_outbox o
    join shopping_sprees s on s.id=o.spree_id
    order by o.id limit 50
   ) e
  ),'[]'::jsonb);
 elsif operation='signal-ack' then
  delete from shopping_signal_outbox where id=(payload->>'id')::bigint;
 elsif operation='state' then
  return jsonb_build_object(
   'sprees',coalesce((select jsonb_agg(s order by s.id desc) from shopping_sprees s),'[]'),
   'items',coalesce((select jsonb_agg(i order by i.id) from shopping_items i),'[]'),
   'unread',coalesce((
    select jsonb_agg(s.id order by s.id desc) from shopping_sprees s where s.status<>'open'
    and exists(select 1 from shopping_items i where i.spree_id=s.id and i.user_id=uid)
    and not exists(select 1 from shopping_reads a where a.spree_id=s.id and a.user_id=uid)
   ),'[]')
  );
 elsif operation='create' then
  cutoff:=(payload->>'deadline')::timestamptz;
  if cutoff<=at_time then perform fail(400,'Choose a shopping deadline in the future.'); end if;
  insert into shopping_sprees(creator_id,title,vendor,target,deadline)
   values(uid,text_field(payload,'title',120),payload->>'vendor',(payload->>'target')::integer,cutoff)
   returning id into rid;
  insert into shopping_signal_outbox(spree_id,event) values(rid,'opened');
  return jsonb_build_object('id',rid);
 else
  select * into spree from shopping_sprees where id=(payload->>'id')::bigint;
  if not found then perform fail(404,'Shopping spree not found.'); end if;
  if operation='read' and spree.status<>'open' then
   insert into shopping_reads(spree_id,user_id) values(spree.id,uid) on conflict do nothing;
   return '{"ok":true}';
  end if;
  if spree.status<>'open' then perform fail(409,'This shopping list is closed.'); end if;
  if operation='add' then
   if payload->>'vendor' is distinct from spree.vendor then
    perform fail(400,'Use a product link from this spree’s store.');
   end if;
   insert into shopping_items(spree_id,user_id,product,url,quantity)
    values(spree.id,uid,text_field(payload,'product',160),text_field(payload,'url',2048),(payload->>'quantity')::integer);
  elsif operation='remove' then
   delete from shopping_items where id=(payload->>'item_id')::bigint and spree_id=spree.id and user_id=uid;
   if not found then perform fail(404,'Your item could not be found.'); end if;
  elsif operation in ('deadline','close','cancel') then
   if spree.creator_id<>uid then perform fail(403,'Only the organizer can manage this spree.'); end if;
   if operation='deadline' then
    cutoff:=(payload->>'deadline')::timestamptz;
    if cutoff<=at_time then perform fail(400,'Choose a shopping deadline in the future.'); end if;
    update shopping_sprees set deadline=cutoff where id=spree.id;
   else
    update shopping_sprees set status=case when operation='close' then 'closed' else 'cancelled' end,
      closed_at=at_time where id=spree.id;
    insert into shopping_signal_outbox(spree_id,event) values(spree.id,case when operation='close' then 'closed' else 'cancelled' end);
   end if;
  else
   perform fail(404,'Unknown shopping operation.');
  end if;
 end if;
 return '{"ok":true}';
exception when check_violation or not_null_violation or invalid_text_representation or numeric_value_out_of_range
 then perform fail(400,'Invalid shopping details.'); return null;
end $$;

revoke all on function public.league_shopping(text,jsonb,text) from public,anon,authenticated;
grant execute on function public.league_shopping(text,jsonb,text) to service_role;
commit;
