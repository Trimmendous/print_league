import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase} from './helpers/database.mjs';
test('automatic runoffs reset ballots, restrict candidates, repeat at half the original duration and select a winner',async()=>{
 const {db,rpc}=await testDatabase();
 try {
  await db.exec(`insert into league_private.members(id,display_name,admin) values(1,'Host',true);
   insert into league_private.sessions(token_hash,member_id,csrf_hash,expires_at) values('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',1,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now()+interval '1 day');
   insert into league_private.rounds(id,title,creator_id,phase,deadline,created_at,voting_started_at,votes_close_at)
    values(1,'Current poll',1,'tie',now()+interval '9 days',now()-interval '3 days',now()-interval '3 days',now()-interval '1 day');
   insert into league_private.topics(id,round_id,user_id,title,normalized) values(1,1,1,'A','a'),(2,1,1,'B','b'),(3,1,1,'C','c');
   insert into league_private.votes values(1,1,1),(1,1,2);
   select league_private.close_poll(1,now()-interval '1 day');`);
  let state=await rpc('state',{},'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),r=state.rounds[0];
  assert.equal(r.runoff_number,1);assert.deepEqual(r.runoff_topic_ids,[1,2]);
  assert.equal(r.votes_close_at-r.voting_started_at,86400);assert.equal(r.original_vote_seconds,172800);
  assert.equal(r.voter_count,0);assert.deepEqual(state.votes,[]);
  const action=(action,extra={})=>rpc('round-action',{round_id:1,action,...extra},'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  await assert.rejects(action('vote',{topic_id:3}),/tied topic/);
  await assert.rejects(action('topic',{title:'D',normalized:'d'}),/not available/);
  await assert.rejects(action('delete-topic',{topic_id:1}),/not available/);
  // A second tie narrows only among existing runoff candidates, even with no votes.
  await action('close-poll');r=(await rpc('state',{},'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rounds[0];
  assert.equal(r.runoff_number,2);assert.deepEqual(r.runoff_topic_ids,[1,2]);
  assert.equal(r.votes_close_at-r.voting_started_at,86400);
  assert.equal((await db.query('select * from league_private.poll_ballots')).rows.length,2);
  await action('vote',{topic_id:2});
  // Scheduled expiry closes automatically on the next request.
  await db.exec("update league_private.rounds set votes_close_at=now()-interval '1 second' where id=1");
  r=(await rpc('state',{},'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).rounds[0];assert.equal(r.phase,'printing');assert.equal(r.topic,'B');
 } finally {await db.close();}
});
test('an overdue tied poll receives a full runoff window and extends its deadline safely',async()=>{
 const {db}=await testDatabase();
 try {
  await db.exec(`insert into league_private.members(id,display_name) values(1,'Host');
   insert into league_private.rounds(id,title,phase,deadline,created_at,voting_started_at)
   values(1,'Late','topics',now()-interval '1 hour',now()-interval '49 hours',now()-interval '49 hours');
   insert into league_private.topics(round_id,user_id,title,normalized) values(1,1,'A','a'),(1,1,'B','b');
   select league_private.sync_rounds();select league_private.sync_rounds();`);
  const r=(await db.query("select *,extract(epoch from votes_close_at-voting_started_at) as duration from league_private.rounds")).rows[0];
  assert.equal(r.runoff_number,1);assert.equal(r.phase,'topics');assert.equal(Number(r.duration),86400);
  assert.equal(+r.deadline,+r.votes_close_at);
 } finally {await db.close();}
});
