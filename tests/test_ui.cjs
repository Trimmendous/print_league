const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function ui() {
  const elements = new Map();
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, {innerHTML:'',hidden:false,open:false,textContent:'',addEventListener(){},focus(){},setAttribute(){}});
    return elements.get(selector);
  };
  const context = vm.createContext({
    document:{querySelector:element,querySelectorAll:()=>[],addEventListener(){}},window:{addEventListener(){}},location:{hash:''},
    fetch:()=>new Promise(()=>{}),setTimeout,clearTimeout,setInterval:()=>0,FormData,console,
  });
  vm.runInContext(fs.readFileSync('static/api.js','utf8'),context);
  vm.runInContext(fs.readFileSync('static/app.js','utf8'),context);
  vm.runInContext(`s={csrf:'test',user:{id:1,name:'captain',display_name:'<Captain>',has_password:true,admin:0},users:[{id:1,name:'captain',display_name:'<Captain>'},{id:2,name:'mate'}],rounds:[{id:1,phase:'completed'},{id:2,phase:'judging'}],entries:[{id:1,round_id:1,user_id:1},{id:2,round_id:2,user_id:1},{id:3,round_id:1,user_id:2}],winners:[{round_id:1,entry_id:1},{round_id:2,entry_id:2},{round_id:1,entry_id:3}],topics:[],votes:[],participants:[]};`,context);
  return {context,element,run:code=>vm.runInContext(code,context)};
}
test('trophy tallies include only this member’s completed category wins',()=>{
  const {run}=ui();
  assert.equal(run('winsFor(1).length'),1);
  assert.match(run('tally(1)'),/aria-label="1 win"/);
  assert.equal((run('tally(1)').match(/tally-mark/g)||[]).length,1);
});
test('profile escapes display names and exposes the correct credential form',()=>{
  const {run,element}=ui();
  run("location.hash='#profile';render()");
  assert.equal(element('#intro').hidden,true);
  assert.match(element('#app').innerHTML,/&lt;Captain&gt;/);
  assert.match(element('#app').innerHTML,/name="current_password"/);
  run('s.user.has_password=false;render()');
  assert.doesNotMatch(element('#app').innerHTML,/name="current_password"/);
  assert.match(element('#app').innerHTML,/Add username & password/);
});
test('signed-out profile links still require sign-in and an invite for registration',()=>{
  const {run,element}=ui();
  run("s.user=null;location.hash='#profile';render()");
  assert.equal(element('#settings').hidden,true);
  assert.match(element('#app').innerHTML,/data-path="auth\/login"/);
  assert.match(element('#app').innerHTML,/name="invite"[^>]*required/);
});
test('Home and Winners separate active and completed competitions',()=>{
 const {run,element}=ui();
 run("s.rounds[0].title='Archive voyage';s.rounds[1].title='Active voyage';render()");
 assert.match(element('#app').innerHTML,/Active voyage/);
 assert.doesNotMatch(element('#app').innerHTML,/Archive voyage/);
 assert.equal(element('#intro').hidden,true);
 run("location.hash='#winners';render()");
 assert.match(element('#app').innerHTML,/Archive voyage/);
 assert.doesNotMatch(element('#app').innerHTML,/Active voyage/);
});
test('collection has owner deletion but no voting, and voting freezes collected topics',()=>{
 const {run}=ui();
 run("s.topics=[{id:4,round_id:3,title:'Boats',user_id:1},{id:5,round_id:3,title:'Bridges',user_id:2}];s.votes=[]");
 const collecting=run("round({id:3,title:'Round',phase:'submissions',has_prevote:1,deadline:'2027-01-01T12:00:00Z'})");
 assert.doesNotMatch(collecting,/data-path="rounds\/3\/vote"/);
 assert.equal((collecting.match(/data-path="rounds\/3\/delete-topic"/g)||[]).length,1);
 const voting=run("round({id:3,title:'Round',phase:'topics',has_prevote:1,deadline:'2027-01-01T12:00:00Z'})");
 assert.match(voting,/data-path="rounds\/3\/vote"/);
 assert.doesNotMatch(voting,/data-path="rounds\/3\/(topic|delete-topic)"/);
});
test('winning topic and voyage countdown appear during printing',()=>{
 const {run}=ui();
 const html=run("round({id:3,title:'Round',topic:'Tiny boats',phase:'printing',printing_started_at:1000,deadline:'2027-01-01T12:00:00Z'})");
 assert.match(html,/THE CREW’S WINNING TOPIC/);
 assert.match(html,/Tiny boats/);
 assert.match(html,/class="tide-progress"/);
 assert.match(html,/data-start="1000000"/);
});
test('feature board renders sea-themed stages and escaped member ideas',()=>{
 const {run,element}=ui();
 run("s.feature_ideas=[{id:1,title:'<New idea>',description:'A better fleet',stage:'ideas',user_id:1}];location.hash='#features';render()");
 const html=element('#app').innerHTML;
 assert.match(html,/On the horizon/);assert.match(html,/Under way/);assert.match(html,/At the dock/);
 assert.match(html,/&lt;New idea&gt;/);
 assert.doesNotMatch(html,/features\/1\/move/);
 run('s.user.admin=1;render()');assert.match(element('#app').innerHTML,/features\/1\/move/);
});
test('release header and log use the same initial version',()=>{
 const {run,element}=ui();
 run("s.releases=[{version:'0.0.0',title:'Initial Build',voyage:'Maiden voyage',summary:'Setting sail.'}];location.hash='#changelog';render()");
 assert.equal(element('#brand-version').textContent,'v0.0.0 · Maiden voyage');
 assert.match(element('#app').innerHTML,/Initial Build/);
 assert.match(element('#app').innerHTML,/v0.0.0/);
});
test('print sharing is shown only for completed, awarded rounds and participants',()=>{
 const {run}=ui();
 assert.match(run("printLinks({id:1,phase:'completed'},{status:'in'})"),/Share a link to your print/);
 assert.doesNotMatch(run("printLinks({id:1,phase:'completed'},{status:'out'})"),/Share a link to your print/);
 assert.equal(run("printLinks({id:1,phase:'judging'},{status:'in'})"),'');
 assert.doesNotMatch(run("printLinks({id:99,phase:'completed'},{status:'in'})"),/Share a link to your print/);
});
test('judging keeps the voyage and Benchy tracks elapsed time through the finish',()=>{
 const {run,context}=ui();
 const html=run("round({id:3,title:'Test',topic:'Dummy',phase:'judging',printing_started_at:1,deadline:'2027-01-01T12:00:00Z'})");
 assert.match(html,/class="voyage"/);
 assert.match(html,/class="voyage-boat"/);
 const clock={},boat={style:{}},bar={setAttribute(){}},classes={};
 const voyage={dataset:{start:'1000',end:'11000'},classList:{toggle:(k,v)=>classes[k]=v},querySelector:s=>s==='progress'?bar:s==='.voyage-boat'?boat:clock};
 context.document.querySelectorAll=s=>s==='.voyage'?[voyage]:[];
 for(const [now,percent] of [[0,0],[6000,50],[11000,100],[12000,100]]){
  run(`Date.now=()=>${now};tickClocks()`);
  assert.equal(bar.value,percent);assert.equal(boat.style.left,`${percent}%`);
  assert.equal(classes['voyage-finished'],now>=11000);
 }
 assert.equal(clock.textContent,'Finish reached · competition deadline');
});
test('print preview cards escape metadata and preserve owner controls',()=>{
 const {run}=ui();
 run(`s.print_links=[{id:8,round_id:1,user_id:1,title:'<Boat>',url:'https://printables.com/model/8',preview_image:'https://media.printables.com/boat.webp'}]`);
 const html=run("printLinks({id:1,phase:'completed'},{status:'in'})");
 assert.match(html,/&lt;Boat&gt;/);assert.doesNotMatch(html,/<Boat>/);
 assert.match(html,/src="https:\/\/media.printables.com\/boat.webp"/);
 assert.match(html,/print-links\/8\/delete/);
 run('s.print_links[0].user_id=2');
 assert.doesNotMatch(run("printLinks({id:1,phase:'completed'},{status:'in'})"),/print-links\/8\/delete/);
});
test('completed entries are link-only and supplied preview images render immediately',()=>{
 const {run}=ui();
 run("s.entries[0].title='Boat';s.entries[0].filename='old.stl';s.print_links=[{id:9,round_id:1,user_id:1,title:'Trophy',url:'https://makerworld.com/en/models/1312719',preview_image:'https://makerworld.bblmw.com/photo.webp'}]");
 const html=run("round({id:1,title:'Finished',phase:'completed',deadline:'2026-11-01T12:00:00Z'})");
 assert.doesNotMatch(html,/type="file"|entries\/1\/file|Share project files/);
 assert.match(html,/src="https:\/\/makerworld.bblmw.com\/photo.webp"/);
});
test('cards with and without artwork make no metadata API request',async()=>{
 const {run,context}=ui();let requests=0;
 context.fetch=()=>{requests++;throw Error('Must not fetch');};
 context.document.querySelectorAll=()=>[{dataset:{printCard:'9'}}];
 run("s.print_links=[{id:9,preview_image:'/static/assets/example-benchy-trophy.webp'}]");
 run("printCard({id:9,url:'https://makerworld.com/model/9',title:'Boat',user_id:1});location.hash='#winners';render()");assert.equal(requests,0);
});
test('username sits beside settings as plain text and clears on sign-out',()=>{
 const {run,element}=ui();
 run('render()');
 assert.equal(element('#header-username').textContent,'captain');
 assert.equal(element('#header-username').hidden,false);
 assert.doesNotMatch(element('#app').innerHTML,/<a class="text-link" href="#profile">/);
 run('s.user=null;render()');
 assert.equal(element('#header-username').textContent,'');
 assert.equal(element('#header-username').hidden,true);
});
test('each poll phase uses its own Benchy clock and members can vote for multiple topics',()=>{
 const {run}=ui();
 let html=run("round({id:3,title:'Poll',phase:'submissions',has_prevote:true,created_at:1000,vote_opens_at:2000,votes_close_at:3000,deadline:'2027-01-01T12:00:00Z'})");
 assert.match(html,/data-start="1000000" data-end="2000000"/);assert.match(html,/1 · Topic collection/);assert.match(html,/rounds\/3\/topic/);assert.doesNotMatch(html,/delete-competition/);
 run('s.topics=[{id:1,round_id:3,user_id:1,title:"First"},{id:2,round_id:3,user_id:1,title:"Second"}];s.votes=[{round_id:3,topic_id:1,user_id:1}]');
 html=run("round({id:3,title:'Poll',phase:'topics',voter_count:2,has_prevote:true,created_at:1000,vote_opens_at:2000,voting_started_at:2100,votes_close_at:3000,deadline:'2027-01-01T12:00:00Z'})");
 assert.match(html,/2 people have voted at least once/);assert.doesNotMatch(html,/\d+ votes/);
 assert.match(html,/data-start="2100000" data-end="3000000"/);assert.match(html,/Vote for as many topics/);assert.match(html,/<button disabled aria-label="Already voted/);assert.match(html,/<button >Vote/);assert.doesNotMatch(html,/data-path="rounds\/3\/topic"/);
 run('s.user.admin=true');assert.match(run("round({id:3,title:'Done',phase:'completed',deadline:'2027-01-01T12:00:00Z'})"),/delete-competition/);
});
