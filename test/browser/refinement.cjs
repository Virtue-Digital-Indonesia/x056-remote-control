// Run fixture.ts first, then: node test/browser/control-room.cjs [base URL]
const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright; try { playwright=require('playwright'); } catch { playwright=require('/usr/local/lib/node_modules/playwright'); }
const { chromium } = playwright;
const base = process.argv[2] || 'http://127.0.0.1:8767';
const shotDir = '/tmp/x056-refinement-check'; fs.mkdirSync(shotDir,{recursive:true});
(async () => {
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
 await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
 const page=await context.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/accounts',async route=>{
  const response=await route.fetch();const rows=await response.json();
  for(const a of rows) { a.quota=a.provider==='codex'?{windows:[{label:'Weekly',utilization:.5,resetsAt:'2026-09-14T00:00:00Z'}]}:{fiveHour:{utilization:1,resetsAt:'2026-09-08T00:00:00Z'},sevenDay:{utilization:54,resetsAt:'2026-09-14T00:00:00Z'}};delete a.quotaError; }
  await route.fulfill({response,json:rows});
 });
 const wait=()=>page.waitForTimeout(350);
 const openCard=async title=>{await page.locator('.cr-task').filter({hasText:title}).click();await page.waitForFunction(()=>!document.getElementById('conversationSurface').hidden);await wait();};
 const close=async()=>{await page.locator('#chatClose').click();await wait();};
 const nav=async id=>{if(await page.locator('#'+id).evaluate(e=>e.getBoundingClientRect().x<0))await page.locator('#crProjects').click();await page.locator('#'+id).click();};
 const mode=()=>page.locator('body').getAttribute('data-chat-mode');
 const settings=async(open,max)=>{await page.locator('#crSettings').click();await page.locator(`#displayPreferences input[name=open][value=${open}]`).check();await page.locator(`#displayPreferences input[name=maximize][value=${max}]`).check();await page.locator('[data-close-settings]').click();};
 await page.goto(base);await page.waitForSelector('.cr-task');await page.waitForTimeout(1200);
 assert.equal(await mode(),'closed');assert.equal(await page.locator('.cr-task').count(),4);
 await page.screenshot({path:shotDir+'/board-desktop.png'});
 await openCard('Update the component library');await page.waitForSelector('#chat .msg');
 assert.equal(await mode(),'side');
 await page.locator('#prompt').fill('Keep this unsent draft.');await page.locator('#model').selectOption('opus');await page.locator('#effort').selectOption('high');
 await page.locator('#file').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('test attachment')});
 await page.locator('.scroll').evaluate(e=>e.scrollTop=650);await wait();
 await page.locator('#chatMax').click();await wait();assert.equal(await mode(),'page');
 assert.equal(await page.locator('#focusNav').isVisible(),true);
 assert.equal(await page.locator('#prompt').inputValue(),'Keep this unsent draft.');
 assert.equal(await page.locator('#model').inputValue(),'opus');
 await page.screenshot({path:shotDir+'/focus-desktop.png'});
 await page.locator('#focusSettings').click();await page.locator('input[name=maximize][value=modal]').check();await page.locator('[data-close-settings]').click();await wait();
 assert.equal(await mode(),'modal');assert.equal(await page.locator('#focusNav').isVisible(),false);
 assert.equal(await page.locator('#chatActivity').isVisible(),true);
 await page.screenshot({path:shotDir+'/modal-desktop.png'});
 await page.locator('#moreBtn').click();assert.equal(await page.locator('#controlMenu button').count(),5);assert.equal(await page.getByRole('menuitem',{name:'Pin conversation',exact:true}).isVisible(),true);await page.keyboard.press('Escape');assert.equal(await mode(),'modal');
 await page.locator('#chatMax').click();await page.locator('.scroll').evaluate(e=>e.scrollTop=750);await wait();await close();
 await openCard('Review accessibility findings');await page.locator('#prompt').fill('Separate draft.');await close();
 await openCard('Update the component library');await page.waitForTimeout(900);
 assert.equal(await page.locator('#prompt').inputValue(),'Keep this unsent draft.');assert.equal(await page.locator('#model').inputValue(),'opus');assert.equal(await page.locator('#effort').inputValue(),'high');
 assert.match(await page.locator('#attachRow').textContent(),/notes.txt/);
 assert.ok(Math.abs(await page.locator('.scroll').evaluate(e=>e.scrollTop)-750)<10,'reading position survives conversation switch');
 await close();
 for(const open of ['side','max']) for(const max of ['page','modal']) {
  await settings(open,max);await page.reload();await page.waitForSelector('.cr-task');await openCard('Update the component library');assert.equal(await mode(),open==='side'?'side':max);await close();
 }
 await settings('max','modal');
 for(const width of [320,390,768,1440]) {
  await page.setViewportSize({width,height:900});await openCard('Update the component library');await wait();
  assert.equal(await page.locator('#focusNav').isVisible(),false);
  const r=await page.locator('#sendBtn').boundingBox();assert.equal(r.width,r.height,`send is circular at ${width}`);assert.ok(r&&r.x>=0&&r.x+r.width<=width&&r.y+r.height<=900,`send visible at ${width}`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no horizontal overflow at ${width}`);
  await page.screenshot({path:shotDir+`/modal-${width}.png`});await close();
  await nav('crAccountsTab');await page.waitForFunction(()=>document.getElementById('accountExport')&&!document.getElementById('accountExport').disabled);await wait();
  assert.equal(await page.locator('.cr-account-row').count(),3);assert.match(await page.locator('.cr-account-row').filter({hasText:'primary@example.test'}).textContent(),/1%/);assert.match(await page.locator('.cr-account-row').filter({hasText:'ChatGPT'}).textContent(),/50%/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`accounts no overflow at ${width}`);
  await page.screenshot({path:shotDir+`/accounts-${width}.png`,fullPage:true});await nav('crBoardTab');
 }
 await nav('crAccountsTab');await page.waitForFunction(()=>!document.getElementById('accountExport').disabled);
 await page.locator('#accountProvider [data-value=claude]').click();await page.waitForFunction(()=>!document.getElementById('accountExport').disabled);assert.equal(await page.locator('.cr-account-row').count(),2);
 await page.locator('#accountDays [data-value="30"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-day]').length===30);assert.equal(await page.locator('[data-day]').count(),30);
 await page.locator('[data-manage=primary]').first().click();await page.locator('[data-pause]').click();await page.waitForSelector('#accountDetail',{state:'detached'});await page.waitForTimeout(600);
 assert.match(await page.locator('.cr-account-row').filter({hasText:'primary@example.test'}).textContent(),/Paused/);
 await page.locator('[data-manage=primary]').first().click();await page.locator('[data-pause]').click();await page.waitForSelector('#accountDetail',{state:'detached'});
 await page.locator('#manageRouting').click();let policyForm=page.locator('.routing-policy[data-provider=claude]');await policyForm.locator('[data-strategy]').selectOption('wait');await policyForm.locator('.cr-primary').click();await page.waitForFunction(()=>document.querySelector('.routing-policy[data-provider=claude] [data-save-status]').textContent==='Routing saved');await page.reload();await page.waitForSelector('.cr-task');await nav('crAccountsTab');await page.locator('#manageRouting').click();await page.waitForSelector('.routing-policy');policyForm=page.locator('.routing-policy[data-provider=claude]');assert.equal(await policyForm.locator('[data-strategy]').inputValue(),'wait');await policyForm.locator('[data-strategy]').selectOption('sticky');await policyForm.locator('.cr-primary').click();await page.waitForFunction(()=>document.querySelector('.routing-policy[data-provider=claude] [data-save-status]').textContent==='Routing saved');await page.locator('[data-close-settings]').click();
 const download=page.waitForEvent('download');await page.locator('#accountExport').click();const file=await download;const path=await file.path();assert.match(fs.readFileSync(path,'utf8'),/account,provider,model/);
 await page.locator('#accountAdd').click();assert.equal(await page.locator('#addAcctPop').isVisible(),true);await page.keyboard.press('Escape');
 await nav('crBoardTab');await settings('side','page');await openCard('Review accessibility findings');
 await page.locator('#prompt').fill('Fixture send from the integrated panel.');await page.locator('#sendBtn').click();await page.waitForFunction(()=>document.getElementById('chat').textContent.includes('Fixture response received.'),null,{timeout:15000});
 assert.equal(await page.locator('#prompt').inputValue(),'');
 await close();await nav('crAccountsTab');await page.waitForFunction(()=>!document.getElementById('accountExport').disabled);
 await page.route('**/api/accounts/analytics?**',route=>route.fulfill({status:503,json:{message:'Temporary fixture outage'}}));
 await page.locator('#accountRefresh').click();await page.waitForFunction(()=>document.getElementById('accountStatus').textContent.includes('Temporary fixture outage'));assert.equal(await page.locator('#accountExport').isDisabled(),true);assert.equal(await page.locator('.cr-account-row').count(),3);
 assert.deepEqual(errors,[]);
 await browser.close();console.log('PASS: modes, persistence, conversation state, responsive layout, account analytics/routing, onboarding, and real HTTP/SSE send.');
})().catch(e=>{console.error(e);process.exit(1)});
