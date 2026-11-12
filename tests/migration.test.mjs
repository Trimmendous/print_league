import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import {buildPages} from '../scripts/build-pages.mjs';
import {handle} from '../supabase/functions/league-api/handler.mjs';
const origin='https://trimmendous.github.io';
const apiBase='https://narfsxgtbvfvvxwdusss.supabase.co/functions/v1/league-api/';
test('Pages serves real UI with repository paths, CSP and only public files',async()=>{
 const dir=await mkdtemp(tmpdir()+'/league-build-');
 try {
  await buildPages(pathToFileURL(dir+'/'));
  const files=await readdir(dir,{recursive:true});
  assert(!files.some(f=>/data|\.py|\.env|\.vars|\.blend|app.html/.test(f)));
  for(const name of files.filter(f=>/\.(html|js|css|json|svg)$/.test(f))) {
   const content=await readFile(dir+'/'+name,'utf8');
   assert.doesNotMatch(content,/workers\.dev|[a-z0-9._%+-]+@gmail\.com/i);
   assert.doesNotMatch(content,/["']\/static\//);
  }
  const html=await readFile(dir+'/index.html','utf8');
  assert.match(html,/Small prints/);assert.match(html,/Content-Security-Policy/);
  assert(html.indexOf('/static/config.js')<html.indexOf('/static/api.js'));
  assert.match(html,/\/print_league\/static\/assets\/benchy.svg/);
  assert.match(await readFile(dir+'/404.html','utf8'),/href="\/print_league\/"/);
  assert.match(await readFile(dir+'/static/config.js','utf8'),/supabase.co\/functions\/v1\/league-api\//);
 } finally {await rm(dir,{recursive:true,force:true});}
});
test('build refuses unexpected API hosts and unsafe base paths',async()=>{
 await assert.rejects(buildPages(undefined,{apiBase:'https://example.workers.dev/'}));
 await assert.rejects(buildPages(undefined,{basePath:'/../'}));
});
test('Edge function allows exact Pages origin preflight but no credentialed cookies',async()=>{
 const response=await handle(new Request(apiBase+'state',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type,x-csrf-token'}}));
 assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Origin'),origin);
 assert.equal(response.headers.get('Access-Control-Allow-Credentials'),null);
 assert.equal(response.headers.get('Vary'),'Origin');
 for(const bad of ['https://evil.example','https://trimmendous.github.io.evil.example','null']) {
  assert.equal((await handle(new Request(apiBase+'health',{headers:{Origin:bad}}))).status,403);
 }
});
test('Edge private routes fail closed even with a forged bearer token',async()=>{
 const response=await handle(new Request(apiBase+'state',{headers:{Origin:origin,Authorization:'Bearer fake'}}));
 assert.equal(response.status,503);assert.equal(response.headers.get('Cache-Control'),'no-store');
 assert.equal((await (await handle(new Request(apiBase+'health'))).json()).authentication_ready,false);
});
async function adapter(config,fetch,sessionStorage) {
 const window={LEAGUE_CONFIG:config,sessionStorage};
 runInNewContext(await readFile('static/api.js','utf8'),{window,fetch});return window.leagueAPI;
}
test('local Flask adapter preserves cookies and CSRF headers',async()=>{
 let seen;
 const api=await adapter(undefined,async(path,options)=>{seen={path,options};return Response.json({});});
 await api.request('profile',{method:'POST',headers:{'X-CSRF-Token':'token'}});
 assert.equal(seen.path,'/api/profile');assert.equal(seen.options.credentials,'same-origin');
 assert.equal(seen.options.headers['X-CSRF-Token'],'token');
});
test('Pages transport omits cookies, uses a bearer session and clears it on logout',async()=>{
 const seen=[];
 const api=await adapter({apiBase},async(path,options)=>{seen.push({path,options});return Response.json(path.endsWith('/login')?{session_token:'a'.repeat(64)}:{});});
 await api.request('auth/login',{method:'POST'});await api.request('state');
 assert.equal(seen[1].path,apiBase+'state');assert.equal(seen[1].options.credentials,'omit');
 assert.equal(seen[1].options.headers.Authorization,'Bearer '+'a'.repeat(64));assert.equal(seen[1].options.redirect,'error');
 await api.request('auth/logout',{method:'POST'});await api.request('state');assert.equal(seen[3].options.headers.Authorization,undefined);
 await assert.rejects(api.request('../other'),/Invalid API path/);
});
test('API adapter surfaces server errors and clears expired sessions',async()=>{
 let options;
 const api=await adapter({apiBase},async(p,o)=>{options=o;return Response.json({error:'Sign in again'},{status:401});});
 api.setSession('b'.repeat(64));await assert.rejects(api.request('state'),/Sign in again/);
 await assert.rejects(api.request('state'));assert.equal(options.headers.Authorization,undefined);
});

test('tab sessions survive reload, rotate, clear on logout or revocation, and tolerate blocked storage',async()=>{
 const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 const a='a'.repeat(64),b='b'.repeat(64);let seen;
 const transport=async(path,options)=>{seen=options;return Response.json({});};
 let api=await adapter({apiBase},transport,storage);api.setSession(a);assert.equal(values.size,1);
 api=await adapter({apiBase},transport,storage);await api.request('state');assert.equal(seen.headers.Authorization,'Bearer '+a);
 api.setSession(b);api=await adapter({apiBase},transport,storage);await api.request('state');assert.equal(seen.headers.Authorization,'Bearer '+b);
 const other=await adapter({apiBase:apiBase+'other/'},transport,storage);await other.request('state');assert.equal(seen.headers.Authorization,undefined);
 await api.request('auth/logout',{method:'POST'});assert.equal(values.size,0);
 api=await adapter({apiBase},transport,storage);await api.request('state');assert.equal(seen.headers.Authorization,undefined);
 api.setSession(a);api=await adapter({apiBase},async()=>Response.json({error:'Expired'},{status:401}),storage);await assert.rejects(api.request('state'),/Expired/);assert.equal(values.size,0);
 const blocked={getItem(){throw Error('Blocked');},setItem(){throw Error('Blocked');},removeItem(){throw Error('Blocked');}};
 api=await adapter({apiBase},transport,blocked);api.setSession(a);await api.request('state');assert.equal(seen.headers.Authorization,'Bearer '+a);
});
