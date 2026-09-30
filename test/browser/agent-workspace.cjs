const assert=require('node:assert/strict'),fs=require('node:fs');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8769';
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.addInitScript(()=>{localStorage.setItem('x056_token','browser-fixture-token-0123456789');const Original=EventSource;window.EventSource=class extends Original{constructor(...args){super(...args);window.__testSource=this;}};});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 let projects;await page.route('**/api/projects',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch(),data=await response.json();const p=data.projects.find(p=>p.name==='Website refresh');for(let i=0;i<40;i++)p.conversations.push({sessionId:'virtual-'+i,title:'Background verification '+(i+1),provider:'claude'});projects=data.projects;await route.fulfill({response,json:data});});
 await page.goto(base);await page.locator('.cr-task').filter({hasText:'Build the new homepage'}).click();await page.locator('#prompt').waitFor();
 fs.mkdirSync('/tmp/x056-agent-workspace',{recursive:true});
 await page.setViewportSize({width:1440,height:1000});const first=projects.find(p=>p.name==='Website refresh'),other=projects.find(p=>p.name==='Research workspace'),selected=first.conversations.find(c=>c.title==='Build the new homepage').sessionId;
 const runs=first.conversations.filter(c=>c.sessionId!==selected).map(c=>({projectId:first.id,sessionId:c.sessionId})).concat(other.conversations.slice(0,1).map(c=>({projectId:other.id,sessionId:c.sessionId})));
 await page.evaluate(runs=>{for(const r of runs){window.__testSource.dispatchEvent(new MessageEvent('turn_state',{data:JSON.stringify({data:{...r,active:true}})}));window.__testSource.dispatchEvent(new MessageEvent('activity',{data:JSON.stringify({data:{...r,status:'start',toolUseId:'tool-'+r.sessionId,label:'Running: /bin/sh -lc python3 /tmp/internal-shell-command.py',isSubagent:false}})}));}},runs);
 await page.locator('#runningSummaryButton').waitFor();assert.equal(await page.locator('#otherRuns>button').count(),1);assert.equal(await page.locator('.orun').count(),0);assert.ok((await page.locator('#otherRuns').boundingBox()).height<40);assert.doesNotMatch(await page.locator('#otherRuns').innerText(),/internal-shell-command/);
 await page.screenshot({path:'/tmp/x056-agent-workspace/running-summary.png'});await page.locator('#runningSummaryButton').click();assert.equal(await page.locator('.running-group').count(),2);assert.equal(await page.locator('.running-conversation').count(),runs.length);assert.doesNotMatch(await page.locator('#runningGroups').innerText(),/internal-shell-command/);
 await page.screenshot({path:'/tmp/x056-agent-workspace/running-list.png'});await page.locator('#runningSearch').fill('Compare deployment');assert.equal(await page.locator('.running-conversation').count(),1);await page.locator('.running-conversation').click();await page.waitForFunction(()=>document.getElementById('projTitle').textContent==='Compare deployment options');assert.equal(await page.locator('#runningConversations').isVisible(),false);
 assert.deepEqual(errors,[]);await page.unrouteAll({behavior:'wait'});await browser.close();console.log('PASS: compact 43-conversation indicator, grouped search and exact cross-project navigation.');
})().catch(e=>{console.error(e);process.exit(1)});
