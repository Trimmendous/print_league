// Optional browser integration using isolated data, including administrator deletion.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {testDatabase} from './helpers/database.mjs';
import {createHandler} from '../supabase/functions/league-api/handler.mjs';
import {token,digest} from '../supabase/functions/_shared/passwords.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const f=await testDatabase(),handle=createHandler(f),browser=await chromium.launch({headless:true});
const origin='https://trimmendous.github.io',base='https://narfsxgtbvfvvxwdusss.supabase.co/functions/v1/league-api/';
async function api(path,body,session){const r=await handle(new Request(base+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Authorization:'Bearer '+session}:{})},body:body===undefined?undefined:JSON.stringify(body)}));const out=await r.json();assert.equal(r.status,200,JSON.stringify(out));return out;}
try{
 let admin;
 for(const [name,isAdmin] of [['captain',true],['maker',false]]){const invite=token();await f.db.query("insert into league_private.invites(token_hash,expires_at,grants_admin) values($1,now()+interval '1 day',$2)",[await digest(invite),isAdmin]);const out=await api('auth/register',{name,password:'abcdef',confirm_password:'abcdef',invite});if(isAdmin)admin=out.session_token;}
 await api('rounds',{title:'Phase test',prevote:true,deadline:new Date(Date.now()+86400000).toISOString(),vote_opens_at:new Date(Date.now()+3600000).toISOString(),votes_close_at:new Date(Date.now()+7200000).toISOString()},admin);
 await api('rounds',{title:'Keep this round',deadline:new Date(Date.now()+86400000).toISOString()},admin);
 const rid=(await api('state',undefined,admin)).rounds[0].id;
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route(origin+'/**',async route=>{const path=new URL(route.request().url()).pathname.replace(/^\/print_league\//,'')||'index.html';const types={html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',webp:'image/webp'};try{await route.fulfill({body:await readFile('dist/'+path),contentType:types[path.split('.').pop()]});}catch{await route.fulfill({status:404,body:'Missing'});}});
 await page.route('https://narfsxgtbvfvvxwdusss.supabase.co/**',async route=>{const req=route.request(),r=await handle(new Request(req.url(),{method:req.method(),headers:req.headers(),body:req.method()==='POST'?req.postData():undefined}));await route.fulfill({status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()});});
 await page.goto(origin+'/print_league/');
 async function login(name){const form=page.locator('[data-path="auth/login"]');await form.locator('[name=name]').fill(name);await form.locator('[name=password]').fill('abcdef');await form.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'On the workbench'}).waitFor();}
 await login('maker');const round=page.locator('.round-card').filter({has:page.getByRole('heading',{name:'Phase test',exact:true})});
 await round.getByText('1 · Topic collection',{exact:true}).waitFor();
 for(const title of ['Tiny boat','Big boat']){await round.getByRole('textbox',{name:'Suggest a topic'}).fill(title);await round.getByRole('button',{name:'Add topic',exact:true}).click();await round.getByText(title,{exact:true}).waitFor();}
 assert.equal(await round.getByRole('button',{name:'Delete competition',exact:true}).count(),0);
 await api(`rounds/${rid}/open-voting`,{},admin);await page.evaluate(()=>load());await round.getByText('2 · Topic voting',{exact:true}).waitFor();
 assert.equal(await round.getByRole('textbox',{name:'Suggest a topic'}).count(),0);
 await round.getByRole('button',{name:'Vote',exact:true}).first().click();await round.getByRole('button',{name:'Already voted for this topic'}).waitFor();
 await round.getByRole('button',{name:'Vote',exact:true}).click();await round.getByRole('button',{name:'Already voted for this topic'}).nth(1).waitFor();assert.equal(await round.getByRole('button',{name:'Already voted for this topic'}).count(),2);
 assert.equal((await api('state',undefined,admin)).rounds.find(r=>r.id===rid).voter_count,1);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('#settings summary').click();await page.getByRole('button',{name:'Sign out'}).click();await login('captain');
 await round.getByRole('button',{name:'Close poll now'}).click();await round.getByRole('button',{name:'Confirm winning topic'}).click();await round.getByText('The voyage to the finish',{exact:true}).waitFor();
 const before=(await api('state',undefined,admin)).rounds.length;
 page.once('dialog',d=>d.dismiss());await round.getByRole('button',{name:'Delete competition',exact:true}).click();assert.equal((await api('state',undefined,admin)).rounds.length,before);
 page.once('dialog',d=>{assert.match(d.message(),/Phase test/);return d.accept();});await round.getByRole('button',{name:'Delete competition',exact:true}).click();await round.waitFor({state:'detached'});
 assert.equal((await api('state',undefined,admin)).rounds.length,before-1);assert.deepEqual(errors,[]);
 console.log('Poll browser checks passed: member suggestions, frozen ballot, multiple votes, phase timers, and confirmed admin deletion.');
}finally{await browser.close();await f.db.close();}
