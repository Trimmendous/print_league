import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase} from './helpers/database.mjs';
import {createHandler} from '../supabase/functions/league-api/handler.mjs';
import {digest} from '../supabase/functions/_shared/passwords.mjs';
import {deliverShoppingUpdates,groupReply} from '../tools/signal-bot.mjs';

test('stage edits and shopping sprees through the hosted API',async()=>{
 const {db,rpc,scheduleRPC,shoppingRPC}=await testDatabase();
 const admin='a'.repeat(64),member='b'.repeat(64),other='c'.repeat(64),bot='d'.repeat(64);
 const handle=createHandler({rpc,scheduleRPC,shoppingRPC,signalToken:bot});
 const request=async(path,token,body,status=200)=>{
  const response=await handle(new Request('https://league.test/league-api/'+path,{
   method:body===undefined?'GET':'POST',
   headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body)
  }));
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  return data;
 };
 const date=hours=>new Date(Date.now()+hours*3600000).toISOString();
 try {
  await db.exec("insert into league_private.members(id,display_name,admin) values(1,'Host',true),(2,'Maker',false),(3,'Guest',false)");
  for(const [index,token] of [admin,member,other].entries()){
   await db.query("insert into league_private.sessions(token_hash,member_id,csrf_hash,expires_at) values($1,$2,$1,now()+interval '1 day')",[await digest(token),index+1]);
  }
  for(const role of ['anon','authenticated']){
   const {rows:[access]}=await db.query(`select has_function_privilege($1,'public.league_schedule(text,jsonb,text)','execute') as schedule,
    has_function_privilege($1,'public.league_shopping(text,jsonb,text)','execute') as shopping`,[role]);
   assert.deepEqual(access,{schedule:false,shopping:false});
  }

  await request('rounds',admin,{title:'Small boats',prevote:true,deadline:date(3)});
  const schedule={phase:'submissions',ballot:0,vote_opens_at:date(1),votes_close_at:date(2),deadline:date(4)};
  await request('rounds/1/schedule',member,schedule,403);
  await request('rounds/1/schedule',admin,{...schedule,votes_close_at:date(.5)},400);
  await request('rounds/1/schedule',admin,schedule);
  let round=(await request('state',member)).rounds[0];
  assert.equal(+new Date(schedule.vote_opens_at),round.vote_opens_at*1000);
  await request('rounds/1/topic',member,{title:'Boats'});
  await request('rounds/1/open-voting',admin,{});
  await request('rounds/1/schedule',admin,schedule,409);
  const votingEnd=date(.9);
  await request('rounds/1/schedule',admin,{phase:'topics',ballot:0,votes_close_at:votingEnd,deadline:date(3)});
  round=(await request('state',member)).rounds[0];
  assert.equal(round.votes_close_at*1000,+new Date(votingEnd));
  await request('rounds/1/close-poll',admin,{});
  const printingEnd=date(.5);
  await request('rounds/1/schedule',admin,{phase:'printing',ballot:0,deadline:printingEnd});
  round=(await request('state',member)).rounds[0];
  assert.equal(+new Date(round.deadline),+new Date(printingEnd));
  await request('rounds/1/advance',admin,{});
  const judgingEnd=date(5);
  await request('rounds/1/schedule',admin,{phase:'judging',ballot:0,judging_ends_at:judgingEnd});
  assert.equal(+new Date((await request('state',member)).rounds[0].judging_ends_at),+new Date(judgingEnd));

  const details={title:'Crew spool run',vendor:'bambu',target:4};
  const pick={product:'PLA Basic · Jade White · Refill',quantity:4,url:'https://us.store.bambulab.com/products/pla-basic-filament?variant=123'};
  await request('shopping',null,details,401);
  const {id}=await request('shopping',member,details);
  const route='shopping/'+id+'/';
  await request(route+'deadline',other,{deadline:date(2)},403);
  await request(route+'deadline',member,{deadline:date(-1)},400);
  await request(route+'deadline',member,{deadline:date(2)});
  await request(route+'add',other,{...pick,url:'https://shop.polymaker.com/products/panchroma-pla'},400);
  await request(route+'add',other,{...pick,url:'https://us.store.bambulab.com.evil.test/products/pla'},400);
  await request(route+'add',other,{...pick,quantity:'1.5'},400);
  await request(route+'add',other,pick);
  const shopping=(await request('state',member)).shopping;
  assert.deepEqual(shopping.items.map(item=>[item.product,item.quantity,item.url]),[[pick.product,4,pick.url]]);
  await request(route+'remove',member,{item_id:shopping.items[0].id},404);
  await request(route+'close',admin,{},403);
  await request(route+'close',member,{});
  await request(route+'add',member,pick,409);
  assert.deepEqual((await request('state',member)).shopping.unread,[]);
  assert.deepEqual((await request('state',other)).shopping.unread,[id]);
  await request(route+'read',other,{});
  assert.deepEqual((await request('state',other)).shopping.unread,[]);

  const cancelled=(await request('shopping',member,details)).id;
  await request(`shopping/${cancelled}/add`,other,pick);
  await request(`shopping/${cancelled}/cancel`,member,{});
  assert.deepEqual((await request('state',other)).shopping.unread,[cancelled]);
  const expiring=(await request('shopping',member,details)).id;
  await request(`shopping/${expiring}/add`,other,pick);
  await db.query("update league_private.shopping_sprees set deadline=now()-interval '1 minute' where id=$1",[expiring]);
  await request('signal/shopping',member,undefined,403);
  const updates=await request('signal/shopping',bot);
  assert.deepEqual(updates.map(update=>update.event),['opened','closed','opened','cancelled','opened','expired']);
  assert.deepEqual((await request('state',other)).shopping.unread,[expiring,cancelled]);
  await request('signal/shopping',bot,{id:updates[0].id});
  assert.deepEqual(await request('signal/shopping',bot),updates.slice(1));
 } finally {await db.close();}
});

test('Signal replies only in the configured group and retries an acknowledgement without repeating a send',async()=>{
 const site=new URL('https://league.test/print_league/');
 const notification={method:'receive',params:{envelope:{dataMessage:{message:' !SHOPPING ',groupInfo:{groupId:'crew'}}}}};
 assert.match(groupReply(notification,'crew',site),/print_league\/#shopping/);
 assert.equal(groupReply(notification,'elsewhere',site),null);
 const sent=new Set(),messages=[];
 const event={id:1,spree_id:12,title:'Summer spools',event:'closed'};
 const send=message=>messages.push(message);
 let attempts=0;
 const api=async id=>{
  if(id===undefined)return [event];
  if(attempts++===0)throw Error('Temporary outage');
 };
 await assert.rejects(deliverShoppingUpdates(api,send,site,sent),/Temporary outage/);
 await deliverShoppingUpdates(api,send,site,sent);
 assert.deepEqual(messages,['Shopping list closed · Summer spools\nhttps://league.test/print_league/#shopping/12']);
});
