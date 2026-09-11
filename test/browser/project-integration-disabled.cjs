const assert=require('node:assert/strict'),{chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8775',token='browser-fixture-token-0123456789';
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=async path=>{const r=await context.request.get(base+path,{headers:{Authorization:'Bearer '+token}});assert(r.ok(),await r.text());return r.json();};
 const projects=(await api('/api/projects')).projects,work=projects.find(p=>p.name==='Website refresh'),chat=projects.find(p=>p.name==='Retained disabled Chat'),sid=work.conversations[0].sessionId;
 await page.goto(base+'/work/'+work.id+'/'+sid);await page.locator('#prompt').waitFor();assert.equal(new URL(page.url()).pathname,'/work/'+work.id+'/'+sid);assert(await page.locator('#crSpacesTab').isHidden());
 await page.locator('#prompt').fill('Keep this Work draft while disabled');await page.reload();await page.locator('#prompt').waitFor();assert.equal(await page.locator('#prompt').inputValue(),'Keep this Work draft while disabled');
 await page.goto(base+'/work');await page.locator('#crPlannerTab').click();const row=page.locator('.planner-item[data-project="'+chat.id+'"]');await row.locator('[data-pause]').click();await page.locator('.rc-space-dialog textarea[name=text]').fill('Reviewed local conversation context');await page.locator('.rc-space-dialog button.cr-primary').click();await page.locator('.rc-space-dialog').waitFor({state:'detached'});
 const q=(await api('/api/queue'))[chat.id][0];assert.equal(q.contextReview,undefined);assert.equal(q.paused,false);assert.equal(q.text,'Reviewed local conversation context');
 await page.goto(base+'/chat/'+chat.id);await page.locator('#rcChatFiles').waitFor();assert.equal(new URL(page.url()).pathname,'/chat/'+chat.id);
 await page.goto(base+'/projects');await page.getByRole('heading',{name:'Page unavailable'}).waitFor();await page.getByRole('link',{name:'Open Work',exact:true}).click();await page.locator('#crScopeTitle').waitFor();
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 console.log('Feature-disabled browser: original Work links, drafts, Chat, reviewed retained queues and unavailable Project routes passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
