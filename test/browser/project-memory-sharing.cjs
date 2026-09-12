const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8774',token='browser-fixture-token-0123456789';
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(t=>localStorage.setItem('x056_token',t),token);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const api=async(path,data)=>{const r=await context.request[data?'post':'get'](base+path,{headers:{Authorization:'Bearer '+token},...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();};
 await api('/api/memory/settings',{crossProject:true});
 const id=Date.now(),a=await api('/api/project-spaces',{requestId:'memory-space-'+id,name:'Proposal memory '+id}),b=await api('/api/project-spaces',{requestId:'memory-other-'+id,name:'Research memory '+id});
 const chat=await api('/api/chats',{requestId:'memory-chat-'+id,spaceId:a.id,name:'Memory review '+id,provider:'claude'}),sid=chat.lastSessionId;
 const note=await api('/api/memory/entry',{entry:{title:'External document requirement '+id,content:'Retain DOCX originals and their editable tables.',scope:'space',spaceId:b.id,status:'confirmed',pinned:true}});
 await page.goto(base+'/projects/'+a.id+'/memory');await page.locator('#rcProjectBrief').waitFor();assert.equal(await page.locator('#memoryProject').inputValue(),a.id);
 assert(await page.locator('#memoryProject').isDisabled());await page.locator('#crProjectLinks a[href="/projects/'+b.id+'/chat"]').click();await page.locator('.rc-space-tabs a[href$="/memory"]').click();await page.waitForURL(base+'/projects/'+b.id+'/memory');await page.locator('[data-memory-open="'+note.id+'"]').click();await page.locator('[data-memory-share]').click();await page.locator('dialog[open] select[name=recipient]').selectOption(a.id);await page.locator('dialog[open]').last().getByRole('button',{name:'Share',exact:true}).click();await page.locator('[data-revoke]').waitFor();
 assert((await api('/api/memory/context?'+new URLSearchParams({projectId:chat.id,sessionId:sid}))).items.some(e=>e.id===note.id));
 await page.locator('[data-revoke]').click();await page.locator('[data-revoke]').waitFor({state:'detached'});assert(!(await api('/api/memory/context?'+new URLSearchParams({projectId:chat.id,sessionId:sid}))).items.some(e=>e.id===note.id));
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');
 await api('/api/memory/settings',{crossProject:false});await page.goto(base+'/chat/'+chat.id);await page.locator('#rcChatFiles').waitFor();
 // Open the existing conversation memory surface through its context bar.
 await page.locator('#moreBtn').click();await page.getByRole('menuitem',{name:'Memory'}).click();await page.locator('[data-turn-references]').click();await page.locator('[data-query]').fill('External document requirement '+id);await page.locator('[data-results] [data-use]').first().waitFor();await page.locator('[data-read]').check();await page.locator('[data-cross]').check();await page.locator('[data-results] [data-use]').first().click();await page.locator('[data-remove="'+note.id+'"]').waitFor();
 const requestId=await page.evaluate(({pid,sid})=>localStorage.getItem('x056_memory_draft_'+pid+'::'+sid),{pid:chat.id,sid});assert(requestId);
 const selected=await api('/api/memory/context?'+new URLSearchParams({projectId:chat.id,sessionId:sid,requestId}));assert(selected.items.some(e=>e.id===note.id));assert.equal((await api('/api/memory/settings')).crossProject,false);
 await page.setViewportSize({width:390,height:844});assert(await page.locator('dialog[open]').last().evaluate(e=>e.scrollWidth<=e.clientWidth+1));await page.screenshot({path:'/tmp/project-memory-sharing-mobile.png'});
 await page.keyboard.press('Escape');await page.keyboard.press('Escape');await page.reload();await page.locator('#rcChatFiles').waitFor();assert.equal(await page.evaluate(({pid,sid})=>localStorage.getItem('x056_memory_draft_'+pid+'::'+sid),{pid:chat.id,sid}),requestId);
 await page.locator('#prompt').fill('Use the selected document requirement.');await page.locator('#sendBtn').click();
 await page.waitForFunction(({pid,sid,requestId})=>localStorage.getItem('x056_memory_draft_'+pid+'::'+sid)!==requestId,{pid:chat.id,sid,requestId});
 await page.waitForTimeout(1700);const history=await api('/api/memory/activity?'+new URLSearchParams({projectId:chat.id,sessionId:sid}));assert(history.some(h=>h.requestId===requestId&&h.items.some(e=>e.id===note.id)));
 assert.deepEqual(errors,[]);console.log('Project memory browser: typed owners, share/revoke, selected turn exception, draft refresh, message binding and mobile passed.');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
