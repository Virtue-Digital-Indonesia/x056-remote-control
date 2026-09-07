// Run with the isolated fixture and design/panel-release assets.
const assert=require('node:assert/strict');
let playwright;try{playwright=require('playwright');}catch{playwright=require('/usr/local/lib/node_modules/playwright');}
const base=process.argv[2]||'http://127.0.0.1:8767';
(async()=>{
 const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),errors=[];
 await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 const headers={Authorization:'Bearer browser-fixture-token-0123456789'};
 const api=async path=>(await context.request.get(base+path,{headers})).json();
 const post=async(path,data)=>context.request.post(base+path,{headers,data});
 const before=await api('/api/accounts');
 await page.route('**/api/accounts',async route=>{const response=await route.fetch(),rows=await response.json();for(const a of rows){a.quota=a.provider==='codex'?{windows:[{label:'5-hour',utilization:.37,resetsAt:1800000000},{label:'1-day',utilization:.09}]}:{fiveHour:{utilization:23,resetsAt:'2026-09-08T00:00:00Z'},sevenDay:{utilization:56,resetsAt:'2026-09-14T00:00:00Z'},weeklyScoped:[{label:'Sonnet',utilization:81},{label:'Opus',utilization:62}]};delete a.quotaError;}await route.fulfill({response,json:rows});});
 await page.goto(base);await page.waitForSelector('.cr-task');await page.locator('#crAccountsTab').click();await page.waitForSelector('.activity-svg');
 assert.equal(await page.locator('select#accountProvider').count(),0);assert.equal(await page.locator('.model-donut svg').count(),1);
 await page.locator('#accountMetric [data-value=tokens]').click();assert.match(await page.locator('.activity-svg').getAttribute('aria-label'),/tokens/);
 await page.locator('[data-day]').last().focus();assert.match(await page.locator('#accountChartCaption').textContent(),/tokens/);
 // Names round-trip through the real registry and leave routing keys unchanged.
 await page.locator('[data-manage=primary]').first().click();await page.locator('#accountLabel').fill('Daily workspace');await page.locator('#accountNameForm button').click();await page.waitForFunction(()=>document.getElementById('accountNameStatus').textContent==='Account name saved.');
 assert.equal((await api('/api/accounts')).find(a=>a.name==='primary').label,'Daily workspace');
 assert.equal((await api('/api/accounts')).find(a=>a.provider==='claude'&&a.nextUp).name,before.find(a=>a.provider==='claude'&&a.nextUp).name);
 await page.locator('#accountDetail [data-close]').click();await page.reload();await page.waitForSelector('.cr-task');await page.locator('#crAccountsTab').click();await page.waitForSelector('.cr-account-row');assert.match(await page.locator('[data-manage=primary]').first().textContent(),/Daily workspace/);
 for(const data of [{name:'primary'},{name:'primary',label:3},{name:'primary',label:'x'.repeat(81)},{name:'missing',label:'Unknown'}])assert.equal((await post('/api/accounts/label',data)).status(),400);
 assert.equal((await context.request.post(base+'/api/accounts/label',{data:{name:'primary',label:'Unauthenticated'}})).status(),401);
 // Unknown and model-specific limits retain their identity, without moving the two main columns.
 await page.locator('#accountProvider [data-value=codex]').click();await page.waitForFunction(()=>document.querySelectorAll('.cr-account-row').length===1);
 assert.match(await page.locator('.cr-account-row').textContent(),/37%/);assert.match(await page.locator('.cr-account-row').textContent(),/1-day/);assert.match(await page.locator('.cr-account-row').textContent(),/Not reported/);
 // Honest empty state; successful zero-token reporting remains distinguishable from no reports.
 await page.route('**/api/accounts/analytics?**',route=>route.fulfill({json:{since:new Date().toISOString(),scope:'Fixture history',dates:['2026-09-07'],rows:[]}}));
 await page.locator('#accountRefresh').click();await page.waitForFunction(()=>document.querySelector('#accountChart .chart-empty'));
 assert.equal(await page.locator('.activity-svg').count(),0);assert.equal(await page.locator('.model-donut').count(),0);assert.match(await page.locator('#accountModels').textContent(),/No token reports yet/);
 await page.unroute('**/api/accounts/analytics?**');
 // Settings keep existing content intact and native prompt dialogs sit above Settings.
 await page.locator('#crSettings').click();await page.locator('[data-theme-choice=dark]').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 await page.locator('[data-theme-choice=system]').click();await page.emulateMedia({colorScheme:'light'});assert.equal(await page.locator('html').getAttribute('data-theme'),null);
 await page.emulateMedia({colorScheme:'dark'});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
 assert.equal(await page.locator('[data-theme-choice=system] use').getAttribute('href'),'#i-auto');assert.equal(await page.locator('#i-auto rect').count(),1);
 await page.locator('#settingsNotify').click();await page.getByRole('menuitem',{name:/Unread conversations/}).click();assert.equal(await page.locator('#displayPreferences').isVisible(),false);
 await page.locator('#crSettings').click();await page.locator('#settingsShortcuts').click();await page.waitForSelector('dialog.modern-prompt[open]');await page.keyboard.press('Escape');assert.equal(await page.locator('#displayPreferences').isVisible(),true);
 await page.locator('[data-settings=models]').click();await page.waitForSelector('[data-model=opus]');await page.locator('[data-model=opus]').selectOption('high');await page.locator('#modelDefaultsForm button').click();await page.waitForFunction(()=>document.getElementById('modelDefaultStatus').textContent==='Model defaults saved.');assert.equal((await api('/api/settings')).modelEffort.opus,'high');
 await page.locator('#defaultProvider [data-value=codex]').click();assert.match(await page.locator('#settingsBody').textContent(),/ChatGPT/);
 await page.locator('[data-settings=connections]').click();await page.waitForSelector('#pluginsPop');await page.locator('#connectionType [data-value=mcp]').click();await page.waitForSelector('#mcpSrvPop');await page.locator('#mcpFName').fill('draft-server');
 await page.locator('[data-settings=security]').click();await page.waitForSelector('#passkeyAddBtn');await page.locator('[data-settings=general]').click();await page.locator('[data-close-settings]').click();
 await page.locator('#crAutomationsTab').click();assert.equal(await page.locator('#cronPop').isVisible(),true);assert.equal(await page.locator('#utilityDialog').isVisible(),false);
 // Picker limits, disabled states, and preservation of the actual unsent draft.
 await page.locator('#crBoardTab').click();await page.locator('[data-filter=all]').click();await page.locator('.cr-task').first().click();await page.locator('#prompt').fill('Keep this actual unsent draft.');await page.locator('#sendAccountChip').click();
 assert.equal(await page.locator('input[name=send-account]').count(),2);assert.match(await page.locator('#sendAccountPicker').textContent(),/23%/);assert.match(await page.locator('#sendAccountPicker').textContent(),/56%/);
 assert.equal(await page.locator('input[value=backup]').isDisabled(),true);
 await page.route('**/api/accounts/active',route=>route.fulfill({status:409,json:{message:'Fixture selection failure'}}));await page.locator('[data-send-next]').click();await page.waitForFunction(()=>document.getElementById('pickerError').textContent.includes('Fixture selection failure'));
 assert.equal(await page.locator('input[value=backup]').isDisabled(),true);await page.unroute('**/api/accounts/active');
 await page.locator('[data-close]').click();assert.equal(await page.locator('#prompt').inputValue(),'Keep this actual unsent draft.');
 // Rename prompt is a real, keyboard-operable dialog above the conversation.
 await page.locator('#moreBtn').click();await page.getByRole('menuitem',{name:'Rename conversation',exact:true}).click();await page.waitForSelector('dialog.modern-prompt[open]');await page.keyboard.press('Escape');assert.equal(await page.locator('#conversationSurface').isVisible(),true);
 await page.locator('#chatClose').click();
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:900});
  if(width<=850)await page.locator('#crProjects').click();await page.locator('#crAccountsTab').click();await page.waitForSelector('.cr-account-row');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('#crSettings').click();assert.equal(await page.locator('#displayPreferences').evaluate(e=>e.scrollWidth<=e.clientWidth),true);await page.locator('[data-close-settings]').click();
 }
 await post('/api/accounts/label',{name:'primary',label:''});
 assert.deepEqual(errors,[]);await browser.close();console.log('PASS: real account nicknames and validation, limits, empty charts, theme, settings, prompts, picker errors, and responsive layouts.');
})().catch(e=>{console.error(e);process.exit(1)});
