const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8767';
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addInitScript(()=>{localStorage.setItem('x056_token','browser-fixture-token-0123456789');localStorage.setItem('x056_stage_mode','recent');});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  let runningId;
  await page.route('**/api/projects',async route=>{
   if(route.request().method()!=='GET')return route.continue();
   const response=await route.fetch(),data=await response.json(),p=data.projects.find(p=>p.name==='Research workspace');
   runningId=p.conversations[0].sessionId;p.running=true;p.runningSessionIds=[runningId];p.runningAccounts={[runningId]:'primary'};
   await route.fulfill({response,json:data});
  });
  await page.goto(base);await page.waitForSelector('.cr-task');
  assert.equal(await page.locator('#stageCount').textContent(),'1','unopened conversations never fill recent mode');
  await page.locator('#stageToggle').hover();
  await page.locator('.stage-conversation').first().hover();await page.locator('.stage-unpin').first().click();
  assert.equal(await page.locator('#stageItems .stage-conversation').count(),0,'running conversation can be dismissed directly');
  await page.reload();await page.waitForSelector('.cr-task');
  assert.equal(await page.locator('#stageItems .stage-conversation').count(),0,'dismissed running conversation stays dismissed after reload');
  await page.locator('.cr-task').filter({hasText:'Review accessibility findings'}).click();await page.waitForSelector('#chatClose');
  await page.waitForFunction(()=>document.querySelectorAll('#stageItems .stage-conversation').length===1);
  assert.match(await page.locator('.stage-conversation').getAttribute('aria-label'),/Review accessibility/);
  await page.locator('#chatClose').click();await page.locator('#stageToggle').hover();await page.locator('.stage-conversation').first().hover();await page.locator('.stage-unpin').first().click();
  assert.equal(await page.locator('#stageItems .stage-conversation').count(),0,'opened conversation can be dismissed directly');
  await page.locator('.toast-undo').click();assert.equal(await page.locator('#stageItems .stage-conversation').count(),1,'Undo restores the recent conversation');
  await page.locator('.cr-task').filter({hasText:'Compare deployment options'}).click();await page.waitForSelector('#chatClose');
  await page.waitForFunction(()=>document.querySelectorAll('#stageItems .stage-conversation').length===2);
  await page.locator('#chatClose').click();
  await page.reload();await page.waitForSelector('.cr-task');
  assert.equal(await page.locator('#stageItems .stage-conversation').count(),2,'only opened and running chats survive reload');
  assert.deepEqual(errors,[]);
  console.log('PASS recent mode excludes unopened history; dock dismissal persists for running and opened chats; Undo and reopening restore access');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
