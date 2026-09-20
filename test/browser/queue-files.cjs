const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
(async()=>{
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const context=await browser.newContext(),page=await context.newPage(),errors=[];
  const base=process.argv[2]||'http://127.0.0.1:8799',token='browser-fixture-token-0123456789';
  await context.addInitScript(t=>{localStorage.setItem('x056_token',t);const Original=EventSource;window.EventSource=class extends Original{constructor(...args){super(...args);window.__source=this;}};},token);
  page.on('pageerror',e=>errors.push(e.message));
  const api=async(path,body)=>{const r=await context.request.fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token},data:body});assert.ok(r.ok(),await r.text());return r.json();};
  const chat=await api('chats',{requestId:crypto.randomUUID(),name:'Queued file browser test',provider:'claude'});
  const {projects}=await api('projects'),work=projects.find(p=>p.kind!=='chat'&&p.conversations?.length);
  for(const item of (await api('queue'))[work.id]||[])await api('queue/remove',{projectId:work.id,id:item.id});
  await page.goto(base+'/activity/queue');
  await page.locator('#plannerAdd').waitFor();
  for(const target of [{id:chat.id,sid:chat.lastSessionId,chat:true},{id:work.id,sid:work.conversations[0].sessionId,chat:false}]){
   await page.locator('#plannerAdd').click();
   const d=page.locator('dialog[open]');
   await d.locator('[name=conversation]').selectOption(target.id+'::'+target.sid);
   await d.locator('[name=files]').setInputFiles([{name:'queue-notes.txt',mimeType:'text/plain',buffer:Buffer.from('Queued file contents')},{name:'remove-me.txt',mimeType:'text/plain',buffer:Buffer.from('Remove this')}]);
   await d.getByRole('button',{name:'Remove remove-me.txt',exact:true}).click();
   await d.locator('[name=paused]').check();
   await d.getByRole('button',{name:'Add to queue',exact:true}).click();
   await d.waitFor({state:'detached'});
   const row=page.locator('.planner-item[data-project="'+target.id+'"]');
   await row.getByText(/1 file attached/).waitFor();
   const queued=(await api('queue'))[target.id].at(-1);
   assert.equal(queued.text,'Use the attached files.');
   if(target.chat)assert.equal(queued.fileRefs.length,1);else assert.match(queued.attachmentPrompt,/queue-notes.txt/);
   await row.getByRole('button',{name:'Edit',exact:true}).click();
   await page.locator('dialog[open] [name=prompt]').fill('Updated instructions');
   await page.locator('dialog[open]').getByRole('button',{name:'Save changes',exact:true}).click();
   await page.locator('dialog[open]').waitFor({state:'detached'});
   await page.reload();await page.locator('#plannerAdd').waitFor();
   await page.locator('.planner-item[data-project="'+target.id+'"] small').filter({hasText:'1 file attached'}).waitFor();
   const saved=(await api('queue'))[target.id].at(-1);
   assert.equal(saved.text,'Updated instructions');
   if(target.chat)assert.deepEqual(saved.fileRefs,queued.fileRefs);else assert.equal(saved.attachmentPrompt,queued.attachmentPrompt);
  }
  await page.goto(base+'/work/'+work.id+'/'+work.conversations[0].sessionId);
  await page.locator('#prompt').waitFor();
  await page.evaluate(target=>window.__source.dispatchEvent(new MessageEvent('turn_state',{data:JSON.stringify({data:{...target,active:true}})})),{projectId:work.id,sessionId:work.conversations[0].sessionId});
  await page.locator('#file').setInputFiles({name:'composer.txt',mimeType:'text/plain',buffer:Buffer.from('Composer queued file')});
  await page.locator('#attachRow .chip').waitFor();
  await page.locator('#prompt').fill('Keep this text with the file');
  let sent;
  await page.route('**/api/queue',async route=>{if(route.request().method()!=='POST')return route.continue();sent=route.request().postDataJSON();await route.fulfill({json:{queued:true,id:'fixture-queue',sessionId:sent.sessionId,status:'queued'}});});
  const delivered=page.waitForResponse(r=>r.url().endsWith('/api/queue')&&r.request().method()==='POST');
  await page.locator('#steerBtn').click();
  await delivered;
  await page.waitForFunction(()=>!document.querySelector('#prompt').value&&!document.querySelector('#attachRow .chip'));
  assert.equal(sent.prompt,'Keep this text with the file');assert.equal(sent.attachments[0].name,'composer.txt');
  assert.deepEqual(errors,[]);console.log('PASS: Chat and Work file-only queue, remove selected file, text edits, file indicators and reload persistence');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
