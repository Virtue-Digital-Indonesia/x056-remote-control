const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
 const page=await context.newPage(),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.message));
 let claudeFail=true,codexDone=false,codexFail=true,lateStart=false,releaseStart;
 await page.route('**/api/accounts/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(!/\/login\/|\/codex\/register/.test(path))return route.continue();
  calls.push({path,body:route.request().postDataJSON()});
  if(path.endsWith('/cancel'))return route.fulfill({json:{ok:true}});
  if(path.endsWith('/codex/login/start')){
   if(lateStart)await new Promise(resolve=>releaseStart=resolve);
   return route.fulfill({json:{loginId:'codex-fixture',url:'https://example.test/device',code:'ABCD-1234'}});
  }
  if(path.endsWith('/codex/login/status'))return route.fulfill(codexFail?{status:400,json:{message:'Device authorization expired'}}:{json:{done:codexDone,account:{name:'test',displayName:'New ChatGPT account'}}});
  if(path.endsWith('/login/start'))return route.fulfill(claudeFail?{status:400,json:{message:'Could not start Claude sign-in'}}:{json:{loginId:'claude-fixture',url:'https://example.test/authorize'}});
  if(path.endsWith('/login/submit'))return route.fulfill({json:{name:'new',displayName:'New Claude account'}});
  if(path.endsWith('/codex/register'))return route.fulfill({json:{name:'registered',displayName:'Imported account'}});
 });
 await page.goto(process.argv[2]||'http://127.0.0.1:8795');
 await page.getByRole('button',{name:'Dashboard',exact:true}).click();
 const open=async()=>{await page.locator('#accountAdd').click();await page.locator('#addProviderChatGPT').waitFor();};
 await open();
 assert.equal(await page.locator('#addCodexPanel').isVisible(),true);
 await page.locator('#addProviderClaude').click();await page.locator('#addAcctStart').click();
 await page.getByRole('alert').filter({hasText:'Could not start Claude sign-in'}).waitFor();
 assert.equal(await page.locator('#addAcctStart').isEnabled(),true);
 claudeFail=false;await page.locator('#addAcctStart').click();await page.locator('#addAcctCode').waitFor();
 await page.locator('#addAcctFinish').click();assert.match(await page.locator('#addAcctErr').textContent(),/Paste/);
 await page.locator('#addAcctCode').fill('fixture-code');await page.locator('#addAcctCode').press('Enter');
 await page.locator('#utilityDialog').waitFor({state:'hidden'});
 assert(calls.some(x=>x.path.endsWith('/login/submit')&&x.body.code==='fixture-code'));
 await open();await page.locator('#addCodexSignin').click();await page.locator('#addCodexCode').waitFor();
 assert.equal(await page.locator('#addCodexCode').textContent(),'ABCD-1234');
 await page.locator('#addCodexErr').filter({hasText:'Device authorization expired'}).waitFor();
 await page.keyboard.press('Escape');await page.locator('#utilityDialog').waitFor({state:'hidden'});
 await page.waitForTimeout(100);assert(calls.some(x=>x.path.endsWith('/codex/login/cancel')));
 await open();codexFail=false;codexDone=true;await page.locator('#addCodexSignin').click();await page.locator('#utilityDialog').waitFor({state:'hidden'});
 await open();await page.locator('#addProviderClaude').click();await page.locator('#addAcctStart').click();await page.locator('#addAcctCode').waitFor();
 await page.mouse.click(5,5);await page.locator('#utilityDialog').waitFor({state:'hidden'});
 await page.waitForTimeout(150);assert(calls.some(x=>x.path.endsWith('/accounts/login/cancel')));
 // Closing while start is in flight must cancel the returned login and never reopen UI.
 await open();lateStart=true;await page.locator('#addCodexSignin').click();
 await page.waitForTimeout(100);await page.keyboard.press('Escape');releaseStart();await page.waitForTimeout(200);lateStart=false;
 assert.equal(await page.locator('#utilityDialog').isVisible(),false);
 assert(calls.filter(x=>x.path.endsWith('/codex/login/cancel')).length>=2);
 await open();
 for(const theme of ['dark','light']){
  await page.emulateMedia({colorScheme:theme});await page.waitForTimeout(400);
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:844});
   assert(await page.locator('#utilityDialog').evaluate(e=>e.scrollWidth<=e.clientWidth));
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:`/tmp/account-onboarding-${theme}-${width}.png`});
  }
 }
 await page.locator('.codex-adv summary').click();await page.locator('#addCodexHome').fill('/fixture/codex');await page.locator('#addCodexBtn').click();await page.locator('#utilityDialog').waitFor({state:'hidden'});
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'Control room',exact:true}).click();
 await page.locator('.cr-task').filter({hasText:'Update the component library'}).click();
 await page.locator('#sendAccountChip').click();await page.locator('[data-add-account]').click();
 assert.equal(await page.locator('#addProviderClaude').isVisible(),true);
 await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);
 console.log('PASS provider selection, Claude error/retry/code submission, ChatGPT code/poll/error/success, dismissal cancellation including in-flight start, registration, dark/light desktop/mobile');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
