const assert=require('node:assert/strict'),{chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8767';
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('x056_token','browser-fixture-token-0123456789'));
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message);});
 const old=new Date(Date.now()-3*86400000).toISOString();
 await page.route('**/api/conversations/history-page?*',async route=>{const response=await route.fetch(),data=await response.json();data.rows=data.rows.map((r,i)=>({...r,ts:i===data.rows.length-1?new Date().toISOString():old}));await route.fulfill({response,json:data});});
 await page.goto(base);await page.waitForSelector('.cr-task time[datetime]');
 const rows=await (await context.request.get(base+'/api/projects',{headers:{Authorization:'Bearer browser-fixture-token-0123456789'}})).json();const project=rows.projects.find(p=>p.name==='Website refresh'),c=project.conversations.find(c=>c.title==='Review accessibility findings');
 assert(c.lastMessageAt<c.createdAt,'fixture was created after its transcript messages');
 assert.equal(await page.locator(`.cr-task[data-session="${c.sessionId}"] time`).getAttribute('datetime'),new Date(c.lastMessageAt).toISOString());
 const row=page.locator(`.cr-task[data-session="${c.sessionId}"]`);await row.click({button:'right'});await page.screenshot({path:'/tmp/x056-conversation-menu.png'});await page.getByRole('menuitem',{name:'Rename conversation',exact:true}).click();
 await page.locator('dialog[open] .m-in').fill('Renamed from row');await page.getByRole('button',{name:'Rename',exact:true}).click();await page.waitForSelector('.cr-task:has-text("Renamed from row")');
 await page.locator('.cr-task').filter({hasText:'Renamed from row'}).click();await page.waitForSelector('#chat .mmeta');
 assert.match(await page.locator('#chat .mmeta').first().textContent(),/ · /,'older messages show a date and time');await page.screenshot({path:'/tmp/x056-conversation-dates.png'});
 assert(!((await page.locator('#chat .mmeta').last().textContent()).includes(' · ')),'today keeps compact time');
 await page.locator('#projTitle').click();await page.locator('dialog[open] .m-in').fill('Review accessibility findings');await page.getByRole('button',{name:'Rename',exact:true}).click();await page.waitForFunction(()=>document.getElementById('projTitle').textContent==='Review accessibility findings');
 await page.locator('#chatClose').click();
 // Every filter has the same comfortable spacing when empty, including search.
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});await page.locator('#crSearch').fill('no matching conversation xyz');
  for(const filter of ['all','question','active','unread']){
   await page.locator(`[data-filter="${filter}"]`).click();await page.waitForSelector('#crLanes>.cr-empty');
   const spacing=await page.locator('#crLanes>.cr-empty').evaluate(e=>({gap:e.getBoundingClientRect().top-document.querySelector('#crBoard .cr-tools').getBoundingClientRect().bottom,padding:parseFloat(getComputedStyle(e).paddingTop)}));
   assert(spacing.gap>=20&&spacing.padding>=24,JSON.stringify({width,filter,...spacing}));if(filter==='active')await page.screenshot({path:`/tmp/x056-empty-${width}.png`});
  }
 }
 await page.setViewportSize({width:1440,height:1000});await page.locator('#crSearch').fill('');await page.locator('[data-filter=all]').click();
 const research=page.locator('.cr-project-link').filter({hasText:'Research workspace'});await research.click({button:'right'});await page.getByRole('menuitem',{name:'Dismiss project',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('#crProjectLinks').textContent.includes('Research workspace'));
 await page.reload();await page.waitForSelector('.cr-task');assert.equal(await research.count(),0,'project dismissal persists');
 await page.locator('#crDismissedProjects').click();await research.waitFor();await research.click({button:'right'});await page.getByRole('menuitem',{name:'Restore project',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.cr-project-link.dismissed'));
 await page.locator('#stageToggle').click();await page.waitForSelector('#stagePinPicker[open]');
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});const geometry=await page.locator('#stagePinSearch').evaluate(e=>({border:getComputedStyle(e).borderWidth,width:e.getBoundingClientRect().width,label:e.parentElement.getBoundingClientRect().width}));
  assert.equal(geometry.border,'0px');assert(geometry.width>geometry.label*.7,JSON.stringify(geometry));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`/tmp/x056-pin-search-${width}.png`});
 }
 await page.setViewportSize({width:1440,height:1000});await page.locator('#stagePinSearch').fill('Review');await page.locator('[data-pin-choice]').first().check();await page.keyboard.press('Escape');await page.locator('#stageToggle').hover();await page.locator('.stage-conversation').first().click({button:'right'});assert(await page.getByRole('menuitem',{name:'Rename conversation',exact:true}).isVisible());await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);console.log('PASS transcript recency, dated old messages, row and bubble context menus, title rename, project dismissal/restore and all empty filters plus pin search on desktop/mobile');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});
