// Run with PLAYWRIGHT_MODULE=/path/to/playwright node tests/mobile-browser.cjs
// Uses isolated fixtures; never changes the real league database.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const state={csrf:'fixture',server_now:Date.now()/1000,user:{id:1,name:'a-very-long-admin-username-for-mobile',display_name:'Mobile organizer',admin:1,has_password:true},users:[{id:1,name:'a-very-long-admin-username-for-mobile',display_name:'Mobile organizer'}],rounds:[{id:1,title:'A competition with a longer title to check wrapping',phase:'printing',topic:'Small boats with big personalities',deadline:new Date(Date.now()+86400000).toISOString(),printing_started_at:Date.now()/1000-86400},{id:2,title:'Sample completed competition',phase:'completed',topic:'Trophies',deadline:'2026-11-01T12:00:00Z'}],participants:[{round_id:1,user_id:1,status:'in'},{round_id:2,user_id:1,status:'in'}],entries:[{id:1,round_id:2,user_id:1,title:'A wonderfully detailed printed trophy'}],winners:[{round_id:2,entry_id:1,category:'Best print'}],topics:[],votes:[],print_links:[{id:1,round_id:2,user_id:1,title:'10th Anniversary Benchy Trophy',url:'https://makerworld.com/en/models/1312719',preview_image:'/static/assets/example-benchy-trophy.webp'}],feature_ideas:[{id:1,title:'A mobile friendly feature idea',description:'Room for all of our ideas.',stage:'ideas',user_id:1}],releases:[{version:'0.0.0',title:'Initial Build',voyage:'Maiden voyage',summary:'Getting our sealegs.',changes:['Responsive navigation and forms.']}]};
state.shopping={sprees:[{id:1,title:'A crew filament order',vendor:'bambu',creator_id:1,target:4,status:'open'}],items:[],unread:[]};
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://league.test/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/api/state')return route.fulfill({json:state});
  if(pathname==='/api/shopping/1/add'){
   state.shopping.items.push({...route.request().postDataJSON(),id:1,spree_id:1,user_id:1,quantity:1});
   return route.fulfill({json:{ok:true}});
  }
  const file=pathname==='/'?'static/index.html':pathname.startsWith('/static/')?pathname.slice(1):'static/404.html';
  const types={'.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.html':'text/html'};
  await route.fulfill({status:file==='static/404.html'?404:200,contentType:types[path.extname(file)],body:fs.readFileSync(path.join(root,file))});
 });
 for(const width of [320,375,390,480,600,768,1024,1440]){
  await page.setViewportSize({width,height:850});
  for(const theme of ['light','dark']){
   await page.addInitScript(value=>localStorage.setItem('print-league-theme',value),theme);
   for(const hash of ['','#winners','#help','#profile','#changelog','#credits','#shopping','#shopping/1']){
    await page.goto('http://league.test/'+hash);await page.locator('#app> *').first().waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Overflow ${width} ${theme} ${hash}`);
    const gap=await page.locator('.header-right').evaluate(el=>parseFloat(getComputedStyle(el).columnGap));
    assert.ok(gap>=18,`Account spacing ${width}`);
    await page.locator('#settings summary').click();
    const menu=await page.locator('#settings nav').boundingBox();
    assert.ok(menu.x>=0 && menu.x+menu.width<=width+1,`Settings outside viewport ${width}`);
    await page.keyboard.press('Escape');
    if(hash==='#profile'&&width<=700){
     assert.ok(await page.locator('input[name="password"]').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16),'Input text too small');
    }
   }
  }
 }
 await page.setViewportSize({width:375,height:850});
 await page.goto('http://league.test/');
 await page.getByRole('link',{name:/v0[.]0[.]0/}).click();
 await page.getByRole('heading',{name:'Changelog'}).waitFor();
 await page.getByRole('link',{name:'Help',exact:true}).click();
 await page.getByRole('heading',{name:'Help',exact:true}).waitFor();
 await page.locator('#settings summary').click();
 await page.locator('#settings').getByRole('link',{name:'Credits'}).click();
 await page.getByRole('heading',{name:'Credits',exact:true}).waitFor();
 await page.locator('#tab-shopping').click();
 await page.getByRole('link',{name:'A crew filament order'}).click();
 await page.getByText('Add filament',{exact:true}).click();
 await page.getByLabel('Choose a filament').selectOption({label:'PLA Basic'});
 assert.equal(await page.getByLabel('Filament name').inputValue(),'PLA Basic');
 assert.match(await page.getByLabel('Product link').inputValue(),/\/products\/pla-basic-filament$/);
 await page.getByLabel('Variant',{exact:true}).fill('Jade White refill');
 await page.getByRole('button',{name:'Add to the list'}).click();
 await page.getByRole('link',{name:'PLA Basic · Jade White refill'}).waitFor();
 state.user=null;
 await page.setViewportSize({width:320,height:650});await page.goto('http://league.test/');
 await page.locator('form[data-path="auth/login"]').waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Signed-out overflow');
 await page.goto('http://league.test/missing');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'404 overflow');
 assert.deepEqual(errors,[]);
 console.log('Passed 128 signed-in viewport/theme/page combinations, header navigation, filament selection, signed-out and 404 at 320px.');
 await browser.close();
})().catch(error=>{console.error(error);process.exitCode=1});
