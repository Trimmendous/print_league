import {APIError,date,field} from './validation.mjs';

const available=(condition,message='This action is not available in this phase.')=>{
 if(!condition)throw new APIError(403,message);
};
const bad=(condition,message)=>{
 if(!condition)throw new APIError(400,message);
};

export async function createRound(query,payload,member,now) {
 available(member.admin,'Organizer access required.');
 const deadline=date(payload.deadline,'deadline');
 const opens=date(payload.vote_opens_at,'voting start',true);
 const closes=date(payload.votes_close_at,'voting end',true);
 const prevote=payload.prevote===true;
 const end=Date.parse(deadline),opensAt=opens?Date.parse(opens):now,closesAt=Date.parse(closes);
 bad(end>now,'The competition deadline must be in the future.');
 bad(!opens||(prevote&&opensAt>now&&opensAt<end),
  'Voting must open in the future, before the deadline, with topic collection enabled.');
 bad(!closes||(closesAt>opensAt&&closesAt<end),
  'Voting must close after opening and before the deadline.');
 await query(`insert into rounds(title,deadline,phase,creator_id,has_prevote,vote_opens_at,votes_close_at,voting_started_at)
  values($1,$2,$3,$4,$5,$6,$7,case when not $5 then now() else null end)`,
 [field(payload,'title'),deadline,prevote?'submissions':'topics',member.id,prevote,opens,closes]);
 return {ok:true};
}

async function isParticipant(query,roundId,uid) {
 const [participant]=await query("select 1 from participants where round_id=$1 and user_id=$2 and status='in'",[roundId,uid]);
 return !!participant;
}

const actions={
 async 'delete-competition'({query,member,round}) {
  available(member.admin);
  await query('delete from rounds where id=$1',[round.id]);
 },
 async topic({query,round,member,payload,collecting}) {
  available(collecting);
  const title=field(payload,'title'),normalized=field(payload,'normalized',640);
  const inserted=await query(`insert into topics(round_id,user_id,title,normalized)
   values($1,$2,$3,$4) on conflict(round_id,normalized) do nothing returning id`,
  [round.id,member.id,title,normalized]);
  if(!inserted.length)throw new APIError(409,'That topic is already in this poll. Add a different topic.');
 },
 async 'delete-topic'({query,round,member,topicId,collecting}) {
  available(collecting);
  const [topic]=await query('select id from topics where round_id=$1 and id=$2 and user_id=$3',[round.id,topicId,member.id]);
  available(topic,'You can only delete your own topics.');
  const [vote]=await query('select 1 from votes where topic_id=$1 limit 1',[topicId]);
  if(vote)throw new APIError(409,'A topic with votes cannot be deleted.');
  await query('delete from topics where id=$1',[topicId]);
 },
 async vote({query,round,member,topicId}) {
  available(round.phase==='topics');
  const [topic]=await query('select id from topics where round_id=$1 and id=$2',[round.id,topicId]);
  bad(topic,'Choose a topic from this competition.');
  bad(!round.runoff_number||round.runoff_topic_ids.some(id=>String(id)===String(topic.id)),
   'Choose a tied topic from this tiebreaker.');
  const removed=await query('delete from votes where round_id=$1 and user_id=$2 and topic_id=$3 returning topic_id',
   [round.id,member.id,topicId]);
  if(!removed.length)await query('insert into votes(round_id,user_id,topic_id) values($1,$2,$3)',[round.id,member.id,topicId]);
 },
 async 'open-voting'({query,round,manager}) {
  available(manager&&round.phase==='submissions');
  const [topic]=await query('select 1 from topics where round_id=$1 limit 1',[round.id]);
  bad(topic,'Add a topic before opening voting.');
  await query("update rounds set phase='topics',voting_started_at=now() where id=$1",[round.id]);
 },
 async 'close-poll'({query,round,manager}) {
  available(manager&&round.phase==='topics');
  await query('select close_poll($1,now())',[round.id]);
 },
 async 'resolve-tie'({query,round,manager,topicId}) {
  available(manager&&round.phase==='tie');
  const [topic]=await query(`select title from (
   select t.id,t.title,rank() over(order by count(v.user_id) desc) as position
   from topics t left join votes v on v.topic_id=t.id where t.round_id=$1 group by t.id
  ) ranked where position=1 and id=$2`,[round.id,topicId]);
  bad(topic,'Choose a tied leading topic.');
  await query("update rounds set phase='printing',topic=$2,printing_started_at=now() where id=$1",[round.id,topic.title]);
 },
 async 'reopen-topics'({query,round,manager,now}) {
  available(manager&&round.phase==='no_topics');
  bad(Date.parse(round.deadline)>now,'This competition has ended.');
  await query(`update rounds set phase='submissions',has_prevote=true,
   vote_opens_at=null,votes_close_at=null,voting_started_at=null where id=$1`,[round.id]);
 },
 async 'archive-empty'({query,round,manager}) {
  available(manager&&round.phase==='no_topics');
  await query("update rounds set phase='completed' where id=$1",[round.id]);
 },
 async participate({query,round,member,payload,now}) {
  available(['submissions','topics','tie','printing'].includes(round.phase)&&Date.parse(round.deadline)>now);
  bad(['in','out'].includes(payload.status),'Choose Yes or No.');
  await query(`insert into participants(round_id,user_id,status) values($1,$2,$3)
   on conflict(round_id,user_id) do update set status=excluded.status`,[round.id,member.id,payload.status]);
 },
 async entry({query,round,member,payload}) {
  available(round.phase==='printing');
  available(await isParticipant(query,round.id,member.id),'Join the round before submitting.');
  await query(`insert into entries(round_id,user_id,title) values($1,$2,$3)
   on conflict(round_id,user_id) do update set title=excluded.title`,[round.id,member.id,field(payload,'title')]);
 },
 async advance(context) {
  const {query,round,manager}=context;
  if(round.phase==='topics')return actions['close-poll'](context);
  available(manager&&['printing','judging'].includes(round.phase));
  if(round.phase==='judging'){
   const [missing]=await query(`select 1 where not exists(select 1 from winners where round_id=$1)
    and exists(select 1 from entries e join participants p using(round_id,user_id) where e.round_id=$1 and p.status='in')`,[round.id]);
   bad(!missing,'Record at least one winner first.');
  }
  await query('update rounds set phase=$2 where id=$1',[round.id,round.phase==='printing'?'judging':'completed']);
 },
 async winner({query,round,member,payload}) {
  available(member.admin&&round.phase==='judging');
  const entryId=payload.entry_id??null;
  const [entry]=await query(`select e.id from entries e join participants p using(round_id,user_id)
   where e.id=$1 and e.round_id=$2 and p.status='in'`,[entryId,round.id]);
  bad(entry,'Choose an eligible entry.');
  await query(`insert into winners(round_id,category,entry_id) values($1,$2,$3)
   on conflict(round_id,category) do update set entry_id=excluded.entry_id`,[round.id,field(payload,'category'),entryId]);
 },
 async links({query,round,member,payload}) {
  available(round.phase==='completed');
  const [award]=await query('select 1 from winners where round_id=$1 limit 1',[round.id]);
  available(award&&await isParticipant(query,round.id,member.id),'Only participants in completed, awarded rounds can share links.');
  await query(`insert into print_links(round_id,user_id,title,url,preview_image) values($1,$2,$3,$4,$5)`,
   [round.id,member.id,field(payload,'title',120),field(payload,'url',2048),payload.preview_image??'']);
 }
};

export async function roundAction(query,payload,member,now) {
 const [row]=await query('select to_jsonb(r) as round from rounds r where id=$1',[payload.round_id??null]);
 const round=row?.round;
 if(!round)throw new APIError(404,'Competition not found.');
 const action=payload.action;
 available(Object.hasOwn(actions,action));
 await actions[action]({query,round,member,payload,now,topicId:payload.topic_id??null,
  manager:member.admin||String(round.creator_id)===String(member.id),
  collecting:round.phase==='submissions'||(round.phase==='topics'&&!round.has_prevote&&!round.runoff_number)
 });
 await query('select sync_rounds()');
 return {ok:true};
}
