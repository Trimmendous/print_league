import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';

const groupURL=(site,hash)=>new URL(hash,site).href;
const shoppingEvents={
 opened:'Shopping spree opened',
 closed:'Shopping list closed',
 cancelled:'Shopping spree cancelled',
 expired:'Shopping deadline reached. Adding is closed'
};

export function groupReply(notification,group,site) {
 if(notification.method!=='receive')return null;
 const data=(notification.params?.result||notification.params)?.envelope?.dataMessage;
 if(data?.groupInfo?.groupId!==group)return null;
 switch(data.message?.trim().toLowerCase()){
  case '!league':return 'Print League\n'+site.href;
  case '!shopping':return 'Start or join a filament shopping spree\n'+groupURL(site,'#shopping');
  default:return null;
 }
}

export async function deliverShoppingUpdates(api,send,site,sent) {
 const events=await api();
 for(const id of sent)if(!events.some(event=>event.id===id))sent.delete(id);
 for(const event of events) {
  if(!sent.has(event.id)) {
   const title=String(event.title).replace(/\s+/g,' ');
   await send(`${shoppingEvents[event.event]} · ${title}\n${groupURL(site,'#shopping/'+event.spree_id)}`);
   sent.add(event.id);
  }
  await api(event.id);
  sent.delete(event.id);
 }
}

function signalClient(account,onMessage) {
 const env={...process.env};
 delete env.LEAGUE_SIGNAL_TOKEN;
 const child=spawn('signal-cli',['-a',account,'jsonRpc','--ignore-attachments'],{env,stdio:['pipe','pipe','inherit']});
 const lines=createInterface({input:child.stdout});
 let sequence=0,closed=false;
 const pending=new Map();
 function stop(){
  closed=true;
  for(const wait of pending.values())wait.reject(Error('Signal connection closed.'));
 }
 child.on('exit',stop);
 child.on('error',stop);
 child.stdin.on('error',stop);
 lines.on('line',line=>{
  let reply;
  try {reply=JSON.parse(line);}catch{return;}
  const waiter=pending.get(reply.id);
  if(waiter){
   if(reply.error)waiter.reject(Error('signal-cli rejected the send request.'));
   else if(!reply.result?.timestamp)waiter.reject(Error('signal-cli did not confirm the send request.'));
   else waiter.resolve();
  } else if(reply.method==='receive')onMessage(reply);
 });
 return {
  get closed(){return closed;},
  close:()=>child.kill(),
  send(groupId,message) {
   if(closed)return Promise.reject(Error('Signal connection closed.'));
   const id=++sequence;
   let timer;
   return new Promise((resolve,reject)=>{
    pending.set(id,{resolve,reject});
    timer=setTimeout(()=>reject(Error('signal-cli send timed out.')),30000);
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method:'send',params:{groupId,message}})+'\n');
   }).finally(()=>{clearTimeout(timer);pending.delete(id);});
  }
 };
}

async function main() {
 const {LEAGUE_SIGNAL_TOKEN:token,LEAGUE_API_URL,LEAGUE_SITE_URL,SIGNAL_ACCOUNT:account,SIGNAL_GROUP_ID:group}=process.env;
 if(!/^[a-f0-9]{64}$/.test(token||'')||!account||!/^[A-Za-z0-9+/]{20,}={0,2}$/.test(group||''))throw Error('Set LEAGUE_SIGNAL_TOKEN, SIGNAL_ACCOUNT and SIGNAL_GROUP_ID.');
 const endpoint=new URL('signal/shopping',LEAGUE_API_URL),site=new URL(LEAGUE_SITE_URL);
 if([endpoint,site].some(url=>url.protocol!=='https:'||url.username||url.password))throw Error('Set HTTPS URLs for the league API and site.');
 const shutdown=new AbortController(),sent=new Set();
 let lastReply=0;
 const client=signalClient(account,event=>{
  const message=groupReply(event,group,site);
  if(!message||Date.now()-lastReply<3000)return;
  lastReply=Date.now();
  client.send(group,message).catch(error=>console.error(error.message));
 });
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{shutdown.abort();client.close();});
 async function api(id) {
  const ack=id!==undefined;
  const response=await fetch(endpoint,{
   redirect:'error',method:ack?'POST':'GET',
   headers:{Authorization:'Bearer '+token,...(ack?{'Content-Type':'application/json'}:{})},
   body:ack?JSON.stringify({id}):undefined,
   signal:AbortSignal.any([shutdown.signal,AbortSignal.timeout(15000)])
  });
  if(!response.ok)throw Error(`Shopping API returned ${response.status}.`);
  return response.json();
 }
 while(!shutdown.signal.aborted&&!client.closed) {
  try {await deliverShoppingUpdates(api,message=>client.send(group,message),site,sent);}
  catch(error){if(!shutdown.signal.aborted)console.error(error.message);}
  await sleep(15000,null,{signal:shutdown.signal}).catch(()=>{});
 }
 if(!shutdown.signal.aborted)throw Error('signal-cli exited. Check the linked account and restart the bridge.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 main().catch(error=>{console.error(error.message);process.exitCode=1;});
}
