const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8767';
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
 await context.request.post(base+'/api/accounts/routing',{headers:{Authorization:'Bearer browser-fixture-token-0123456789'},data:{provider:'claude',strategy:'sticky',order:['primary','backup']}});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
 await page.route('**/api/accounts',async route=>{const response=await route.fetch(),rows=await response.json();for(const a of rows){a.quota={fiveHour:{utilization:23,resetsAt:'2026-09-08T00:00:00Z'},sevenDay:{utilization:56,resetsAt:'2026-09-14T00:00:00Z'}};delete a.quotaError;}await route.fulfill({response,json:rows});});
 await page.goto(base);await page.waitForSelector('.cr-task');
 assert.equal(await page.locator('#crBoard #crProjectCosts').count(),0);
 await page.locator('#crAccountsTab').click();await page.waitForSelector('#crCostDetails');await page.waitForFunction(()=>document.getElementById('crProjectCosts').textContent.includes('recorded tokens'));
 await page.locator('#crCostDetails').click();await page.waitForSelector('#projectCostDetails[open]');await page.mouse.click(5,5);await page.waitForSelector('#projectCostDetails[open]',{state:'detached'});
 await page.locator('#crSettings').click();await page.locator('[data-settings=routing]').click();await page.waitForSelector('.routing-policy');
 const form=page.locator('.routing-policy[data-provider=claude]');await form.locator('[data-strategy]').selectOption('round-robin');await form.locator('[data-move="1"]').first().click();await form.locator('button.cr-primary').click();await page.waitForFunction(()=>document.querySelector('.routing-policy[data-provider=claude] [data-save-status]').textContent==='Routing saved');
 const policy=await (await context.request.get(base+'/api/accounts/routing',{headers:{Authorization:'Bearer browser-fixture-token-0123456789'}})).json();assert.deepEqual(policy.policies.claude,{strategy:'round-robin',order:['backup','primary']});
 await page.screenshot({path:'/tmp/x056-routing.png'});await page.keyboard.press('Escape');await page.waitForSelector('#displayPreferences[open]',{state:'detached'});
 await page.locator('#crBoardTab').click();const cards=await page.locator('.cr-task').evaluateAll(es=>es.map(e=>({project:e.dataset.project,session:e.dataset.session})));
 await page.locator('.cr-task').first().click();await page.locator('#prompt').fill('Keep this draft while refreshing.');
 let pulls=0;page.on('request',r=>{if(r.url().includes('/history-page?'))pulls++});await page.locator('#chatRefresh').click();await page.waitForFunction(()=>!document.getElementById('chatRefresh').disabled);assert(pulls>0);assert.equal(await page.locator('#prompt').inputValue(),'Keep this draft while refreshing.');
 await page.route('**/api/conversations/history-page?**',route=>route.fulfill({status:503,json:{message:'Unavailable'}}));await page.locator('#chatRefresh').click();await page.waitForFunction(()=>document.getElementById('crToast').textContent.includes('Could not refresh'));assert.equal(await page.locator('#prompt').inputValue(),'Keep this draft while refreshing.');await page.unroute('**/api/conversations/history-page?**');
 await page.locator('#sendAccountChip').click();await page.waitForSelector('#sendAccountPicker[open]');
 const layout=await page.locator('.account-pick-card').first().evaluate(e=>{const q=e.querySelector('.picker-quotas'),a=q.children[0].getBoundingClientRect(),b=q.children[1].getBoundingClientRect();return {height:e.getBoundingClientRect().height,first:a.y,second:b.y,width:a.width,next:b.x-a.x}});assert(layout.height<220,JSON.stringify(layout));assert(Math.abs(layout.first-layout.second)<2,JSON.stringify(layout));assert(layout.width>100);
 await page.screenshot({path:'/tmp/x056-picker.png'});await page.mouse.click(5,5);await page.waitForSelector('#sendAccountPicker[open]',{state:'detached'});
 await page.locator('#chatClose').click();await page.locator('.cr-task').nth(1).click();await page.locator('#stageToggle').hover();await page.waitForSelector('#stageShelf:not([hidden])');assert(await page.locator('.stage-conversation').count()>=2);
 await page.screenshot({path:'/tmp/x056-stage.png'});
 const first=cards[0];await page.locator(`.stage-conversation[data-session="${first.session}"]`).click();await page.waitForFunction(s=>document.getElementById('prompt').value===s,'Keep this draft while refreshing.');
 await page.locator('#stageToggle').click();await page.locator('.stage-dismiss').last().click();await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});await page.locator('#sendAccountChip').click();await page.waitForSelector('#sendAccountPicker[open]');
 assert(await page.locator('.account-pick-card').first().evaluate(e=>e.getBoundingClientRect().height<240));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:'/tmp/x056-picker-mobile.png'});
 await page.keyboard.press('Escape');await page.locator('#stageToggle').click();await page.screenshot({path:'/tmp/x056-stage-mobile.png'});
 assert.deepEqual(errors,[]);console.log('PASS dashboard location, routing persistence, picker geometry, dialog dismissal, refresh recovery, conversation switching and mobile layout');
 } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
