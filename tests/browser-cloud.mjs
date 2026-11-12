// Optional: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/browser-cloud.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {testDatabase} from './helpers/database.mjs';
import {createHandler} from '../supabase/functions/league-api/handler.mjs';
import {digest,token} from '../supabase/functions/_shared/passwords.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {db,rpc}=await testDatabase();const handle=createHandler({rpc});
const browser=await chromium.launch({headless:true});
try {
 const invite=token();await db.query("insert into league_private.invites(token_hash,expires_at,grants_admin) values($1,now()+interval '1 day',true)",[await digest(invite)]);
 const page=await browser.newPage({viewport:{width:390,height:844}});const errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://trimmendous.github.io/**',async route=>{
  const rel=new URL(route.request().url()).pathname.replace(/^\/print_league\//,'')||'index.html';
  const types={js:'text/javascript',css:'text/css',html:'text/html',svg:'image/svg+xml',png:'image/png',webp:'image/webp'};
  try {await route.fulfill({body:await readFile('dist/'+rel),contentType:types[rel.split('.').pop()]});}catch{await route.fulfill({status:404,body:'Missing'});}
 });
 await page.route('https://narfsxgtbvfvvxwdusss.supabase.co/**',async route=>{
  const r=route.request();const response=await handle(new Request(r.url(),{method:r.method(),headers:r.headers(),body:r.method()==='POST'?r.postData():undefined}));
  await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
 });
 await page.goto('https://trimmendous.github.io/print_league/');
 await page.getByText('Have an invitation? Join the fleet').click();
 const signup=page.locator('form[data-path="auth/register"]');
 await signup.locator('[name=name]').fill('BrowserCaptain');await signup.locator('[name=password]').fill('browser-test-password');await signup.locator('[name=invite]').fill(invite);await signup.getByRole('button',{name:'Create account',exact:true}).click();
 await page.getByRole('heading',{name:'On the workbench'}).waitFor();
 await page.goto('https://trimmendous.github.io/print_league/#profile');
 await page.getByRole('heading',{name:'Account recovery',exact:true}).waitFor();
 const recovery=page.locator('form[data-path="profile/recovery-codes"]');await recovery.locator('[name=current_password]').fill('browser-test-password');await recovery.getByRole('button',{name:'Generate recovery codes'}).click();
 await page.locator('#recovery-codes:not([hidden])').waitFor();
 const code=(await page.locator('#recovery-codes').textContent()).split('\n')[0];assert.equal(code.length,64);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('#settings summary').click();await page.getByRole('button',{name:'Sign out'}).click();
 await page.getByText('Recover your account',{exact:true}).click();
 const reset=page.locator('form[data-path="auth/recover"]');
 await reset.locator('[name=name]').fill('BrowserCaptain');await reset.locator('[name=recovery_code]').fill(code);await reset.locator('[name=password]').fill('replacement-password');await reset.locator('[name=confirm_password]').fill('replacement-password');await reset.getByRole('button',{name:'Reset password'}).click();
 await page.getByRole('heading',{name:'On the workbench'}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('Cloud browser flow passed: signup → profile → recovery codes → logout → password recovery on phone layout.');
} finally {await browser.close();await db.close();}
