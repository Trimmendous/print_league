import {APIError,field} from './validation.mjs';
import {accountActions,availableUsername,memberAccountActions,memberFor} from './league-accounts.mjs';
import {createRound,roundAction} from './league-rounds.mjs';

async function leagueState(query,member) {
 // Build the public projection in one query, with explicit scopes for votes and accounts.
 const [{state}]=await query(`select jsonb_build_object(
  'user',public_member($1),
  'server_now',extract(epoch from now()),
  'csrf','bearer',
  'users',coalesce((select jsonb_agg(public_member(id)-'admin'-'has_password' order by id) from members),'[]'),
  'rounds',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object(
   'voter_count',(select count(distinct v.user_id) from votes v where v.round_id=r.id),
   'tied_topic_ids',case when r.phase='tie' and ($2 or r.creator_id=$1) then
    (select coalesce(jsonb_agg(id),'[]') from (
     select t.id,rank() over(order by count(v.user_id) desc) as position
     from topics t left join votes v on v.topic_id=t.id and v.round_id=t.round_id
     where t.round_id=r.id group by t.id
    ) ranked where position=1)
    else '[]'::jsonb end,
   'created_at',extract(epoch from r.created_at),
   'printing_started_at',extract(epoch from r.printing_started_at),
   'voting_started_at',extract(epoch from r.voting_started_at),
   'vote_opens_at',extract(epoch from r.vote_opens_at),
   'votes_close_at',extract(epoch from r.votes_close_at)
  ) order by r.id) from rounds r),'[]'),
  'topics',coalesce((select jsonb_agg(to_jsonb(t)-'normalized' order by id) from topics t),'[]'),
  'poll_results',coalesce((select jsonb_agg(b order by b.round_id,b.ballot_number)
   from poll_ballots b join rounds r on r.id=b.round_id
   where b.ballot_number<r.runoff_number or r.phase in ('printing','judging','completed','tie')),'[]'),
  'votes',coalesce((select jsonb_agg(v order by round_id,user_id) from votes v where user_id=$1),'[]'),
  'participants',coalesce((select jsonb_agg(p order by round_id,user_id) from participants p),'[]'),
  'entries',coalesce((select jsonb_agg(e order by id) from entries e),'[]'),
  'winners',coalesce((select jsonb_agg(w order by round_id,category) from winners w),'[]'),
  'print_links',coalesce((select jsonb_agg(l order by id) from print_links l),'[]'),
  'feature_ideas',coalesce((select jsonb_agg(to_jsonb(f)-'normalized'||jsonb_build_object(
   'created_at',extract(epoch from created_at)) order by id) from feature_ideas f),'[]')
 ) as state`,[member.id,member.admin]);
 return state;
}

async function createInvitation(query,payload,member) {
 if(!member.admin)throw new APIError(403,'Organizer access required.');
 const [{invite}]=await query(`with created as (
  insert into invites(token_hash,created_by,expires_at,max_uses,label)
  values($1,$2,invite_expiry($3),invite_limit($4),$5)
  returning id,expires_at,max_uses,label
 ) select to_jsonb(created) as invite from created`,
 [payload.invite_hash??null,member.id,payload.expiry??'7d',payload.usage??'once',payload.label??'']);
 return invite;
}

async function changeFeature(query,payload,member) {
 const id=payload.id??null;
 const [idea]=await query('select user_id,stage from feature_ideas where id=$1',[id]);
 if(!idea)throw new APIError(404,'Idea not found.');
 if(payload.action==='move'&&member.admin){
  if(!['ideas','progress','review'].includes(payload.stage))throw new APIError(400,'Choose a board column.');
  await query('update feature_ideas set stage=$2 where id=$1',[id,payload.stage]);
 }else if(payload.action==='delete'&&(member.admin||(String(idea.user_id)===String(member.id)&&idea.stage==='ideas'))){
  await query('delete from feature_ideas where id=$1',[id]);
 }else{
  throw new APIError(403,'You cannot modify this idea.');
 }
}

async function leagueAction(query,operation,payload,member) {
 await query('select sync_rounds()');
 switch(operation){
  case 'state': return leagueState(query,member);
  case 'profile':
   await query('update members set display_name=$2 where id=$1',[member.id,field(payload,'display_name',80)]);
   break;
  case 'invites': return createInvitation(query,payload,member);
  case 'rounds':
  case 'round-action': {
   const [{epoch}]=await query('select extract(epoch from now())::double precision * 1000 as epoch');
   return operation==='rounds'?createRound(query,payload,member,epoch):roundAction(query,payload,member,epoch);
  }
  case 'delete-link': {
   const removed=await query('delete from print_links where id=$1 and user_id=$2 returning id',[payload.id??null,member.id]);
   if(!removed.length)throw new APIError(403,'You can only remove your own links.');
   break;
  }
  case 'features':
   await query(`insert into feature_ideas(user_id,title,normalized,description) values($1,$2,$3,$4)`,
    [member.id,field(payload,'title',120),field(payload,'normalized',480),payload.description??'']);
   break;
  case 'feature-action':
   await changeFeature(query,payload,member);
   break;
  default: throw new APIError(404,'Unknown operation.');
 }
 return {ok:true};
}

export function createLeague(runTransaction) {
 if(!runTransaction)return null;
 return async (operation,payload={},sessionHash='')=>{
  try{
   return await runTransaction(async query=>{
    await query('set local search_path = pg_catalog, league_private');
    await query("set local statement_timeout = '10s'");
    // Match the lock used by the existing SQL account, stage, and rollback paths.
    await query('select pg_advisory_xact_lock(747230011)');
    if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new APIError(400,'Invalid request');
    if(Object.hasOwn(accountActions,operation))return accountActions[operation](query,payload);
    const member=await memberFor(query,sessionHash);
    if(operation==='availability')return availableUsername(query,payload.normalized,member);
    if(!member)throw new APIError(401,'Please sign in again.');
    if(Object.hasOwn(memberAccountActions,operation))return memberAccountActions[operation](query,payload,member,sessionHash);
    return leagueAction(query,operation,payload,member);
   });
  }catch(error){
   if(error instanceof APIError)throw error;
   if(error.code==='P0001'){
    const match=/^(400|401|403|404|409|429)\|(.+)$/.exec(error.message);
    if(match)throw new APIError(Number(match[1]),match[2]);
   }
   if(error.code==='23505')throw new APIError(409,'That username, topic, idea or link already exists.');
   if(['22P02','22003','22007','22008','23514','23502','22021'].includes(error.code))throw new APIError(400,'Invalid request values.');
   if(!error.code||/^(08|53|57P0|57014|42)/.test(error.code))
    throw new APIError(503,'The database is temporarily unavailable.');
   throw error;
  }
 };
}
