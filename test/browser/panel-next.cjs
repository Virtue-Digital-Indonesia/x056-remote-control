// Start fixture.ts with X056_TEST_MANY=1 and the design/panel-next assets first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright; try { playwright=require('playwright'); } catch { playwright=require('/usr/local/lib/node_modules/playwright'); }
const base=process.argv[2]||'http://127.0.0.1:8769';
const shots='/tmp/x056-panel-next-check';fs.mkdirSync(shots,{recursive:true});
(async()=>{
 const browser=await playwright.chromium.launch({headless:true,args:['--no-sandbox']});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>{if(location.protocol==='http:')localStorage.setItem('x056_token','browser-fixture-token-0123456789');});
 const errors=[], mutations=[];
 context.on('page',p=>{p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()==='POST')mutations.push({url:r.url(),body:r.postDataJSON()});});});
 const page=await context.newPage();
 const ready=async p=>{await p.goto(base);await p.waitForSelector('.cr-task');await p.waitForTimeout(500);};
 const api=async path=>(await context.request.get(base+path,{headers:{Authorization:'Bearer browser-fixture-token-0123456789'}})).json();
 const eventually=async fn=>{for(let i=0;i<100;i++){if(await fn())return;await page.waitForTimeout(100);}throw new Error('Condition did not become true');};
 const search=async value=>{await page.locator('#crSearch').fill(value);await page.waitForTimeout(150);};
 const open=async title=>{await search(title);await page.locator('.cr-task').filter({hasText:title}).click();await page.waitForFunction(()=>!document.getElementById('conversationSurface').hidden);await page.waitForTimeout(300);};
 const close=async()=>{await page.locator('#chatClose').click();};
 await ready(page);
 assert.match(await page.locator('#crScopeSubtitle').textContent(),/605 conversations across 32 projects/);
 assert.equal(await page.locator('.cr-task').count(),12,'only 10 recent conversations plus pending questions');
 assert.equal(await page.locator('.cr-project-link').count(),33);
 await page.screenshot({path:shots+'/projects-desktop.png'});
 await page.locator('#crShowMore').click();assert.equal(await page.locator('.cr-task').count(),22);
 await page.locator('#crProjectSearch').fill('Project 27');assert.equal(await page.locator('.cr-project-link').count(),2);
 const scope=await page.locator('.cr-project-link').filter({hasText:'Project 27'}).getAttribute('data-scope');
 await page.locator(`[data-scope="${scope}"]`).click();
 assert.match(await page.locator('#crScopeTitle').textContent(),/Project 27/);
 assert.equal(await page.locator('.cr-task').count(),10);
 assert.equal(await page.locator(`[data-scope="${scope}"] use[href="#i-folder"]`).count(),1);
 assert.equal(await page.locator('.cr-task .cr-state-dot').count(),10);
 await search('Conversation 03');assert.equal(await page.locator('.cr-task').count(),1);
 await page.reload();await page.waitForSelector('.cr-task');assert.match(await page.locator('#crScopeTitle').textContent(),/Project 27/);
 assert.equal(await page.locator(`[data-scope="${scope}"] use[href="#i-folder"]`).count(),1);

 // Starting from another project must keep a blank conversation after async snapshots settle.
 await page.locator('#crNew').click();await page.waitForTimeout(1000);
 assert.match(await page.locator('#chat').textContent(),/new conversation/);
 await page.locator('#prompt').fill('New conversation in the selected project');
 await page.locator('#sendBtn').click();
 await eventually(async()=>mutations.some(r=>r.url.endsWith('/api/sessions')&&r.body.projectId===scope));
 await page.waitForFunction(()=>document.getElementById('chat').textContent.includes('Fixture response received.'),null,{timeout:20000});
 await close();await page.locator('[data-scope=""]').click();await search('');

 // Dismiss from the overview, observe another tab, then reload both.
 const second=await context.newPage();await ready(second);
 await second.locator('.cr-task').filter({hasText:'Build the new homepage'}).click();
 await second.waitForSelector('.qcard.pending');
 const before=mutations.length;
 await page.locator('.cr-conversation-row').filter({hasText:'Build the new homepage'}).locator('[data-dismiss]').click();
 await eventually(async()=>(await api('/api/questions')).length===1);
 await second.waitForSelector('.qcard.pending',{state:'detached'});
 await open('Review accessibility findings');await page.waitForSelector('.qcard.pending');
 await page.locator('.qcard.pending .qdismiss').click();await page.waitForSelector('.qcard.pending',{state:'detached'});
 await eventually(async()=>(await api('/api/questions')).length===0);await close();
 assert.ok(mutations.slice(before).every(r=>!r.url.match(/\/api\/(sessions|queue|switch)/)),'dismiss sends no message or queue request');
 await page.reload();await page.waitForSelector('.cr-task');assert.equal(await page.locator('[data-dismiss]').count(),0);
 await second.reload();await second.waitForSelector('.cr-task');assert.equal(await second.locator('[data-dismiss]').count(),0);
 await second.close();

 // The composer distinguishes the current turn from the provider's next account.
 await open('Review accessibility findings');
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('primary'));
 await page.locator('#sendAccountChip').click();
 assert.equal(await page.locator('[data-send-next=chatgpt]').count(),0,'provider pools stay separate');
 await page.locator('[data-send-next=backup]').click();
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('backup'));
 assert.equal((await api('/api/accounts')).find(a=>a.nextUp&&a.provider==='claude').name,'backup');
 await page.locator('#sendAccountPicker [data-close]').click();
 await page.screenshot({path:shots+'/composer-account.png'});
 await page.locator('#prompt').fill('Check which account sends this turn');await page.locator('#sendBtn').click();
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('Running: Backup workspace'));
 const running=await api('/api/projects'),rp=running.projects.find(p=>p.runningSessionIds.length);
 const sid=rp.runningSessionIds[0];assert.equal(rp.runningAccounts[sid],'backup');
 await page.reload();await page.waitForSelector('.cr-task');
 await open('Review accessibility findings');
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('Running: Backup workspace'));
 await page.locator('#sendAccountChip').click();await page.locator('[data-send-next=primary]').click();
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('Next: Personal workspace'));
 assert.match(await page.locator('#sendAccountChip').textContent(),/Running: Backup workspace/);
 assert.equal((await api('/api/projects')).projects.find(p=>p.id===rp.id).runningAccounts[sid],'backup');
 await page.screenshot({path:shots+'/account-picker.png'});
 await page.locator('[data-switch-turn=primary]').click();
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('Running: Personal workspace'),null,{timeout:10000});
 await page.locator('#sendAccountPicker [data-close]').click();
 await page.waitForFunction(()=>document.getElementById('sendAccountChip').textContent.includes('Send with'),null,{timeout:20000});
 await close();await open('ChatGPT research notes');await page.locator('#sendAccountChip').click();
 assert.equal(await page.locator('[data-send-next=chatgpt]').count(),1);
 assert.equal(await page.locator('[data-send-next=primary]').count(),0);
 await page.keyboard.press('Escape');await close();await search('');

 for(const width of [320,390,768,1440]) {
  await page.setViewportSize({width,height:900});await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`board fits ${width}`);
  if(width<=850){
   assert.equal(await page.locator('#crProjectNav').evaluate(e=>e.inert),true);
   await page.locator('#crProjects').click();assert.equal(await page.locator('#crBoard').evaluate(e=>e.inert),true);
   await page.locator('#crProjectSearch').fill('Project 30');
   await page.waitForFunction(()=>Math.abs(document.getElementById('crProjectNav').getBoundingClientRect().x)<1);
   await page.screenshot({path:shots+`/projects-${width}.png`,animations:'disabled'});
   await page.locator('.cr-project-link').filter({hasText:'Project 30'}).click();assert.equal(await page.locator('#crBoard').evaluate(e=>e.inert),false);
   await page.locator('#crProjects').click();await page.locator('[data-scope=""]').click();
  }
  await open('Review accessibility findings');
  const rect=await page.locator('#sendAccountChip').boundingBox();assert.ok(rect&&rect.x>=0&&rect.x+rect.width<=width&&rect.y+rect.height<=900,`account selection fits ${width}`);
  await page.locator('#sendAccountChip').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:shots+`/account-picker-${width}.png`});await page.keyboard.press('Escape');await close();await search('');
 }
 await page.locator('#crProjectSearch').fill('');
 for(let i=0;i<3&&await page.locator('html').getAttribute('data-theme')!=='dark';i++)await page.locator('#crTheme').click();
 assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');await page.waitForTimeout(350);await page.screenshot({path:shots+'/projects-dark.png',animations:'disabled'});
 assert.deepEqual(errors,[]);await browser.close();
 console.log('PASS: 32 projects / 605 conversations, filtering, saved scope/colors, new conversation targeting, dismissal across tabs/reloads, send account identity, next-account choice, running switch, provider isolation, and responsive layouts.');
})().catch(e=>{console.error(e);process.exit(1);});
