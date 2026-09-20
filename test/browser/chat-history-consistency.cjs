const assert=require('node:assert/strict');
const {chromium}=require('/usr/local/lib/node_modules/playwright');
const base=process.argv[2]||'http://127.0.0.1:8798';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('Use a local fixture');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{localStorage.setItem('x056_token','browser-fixture-token-0123456789');const Original=EventSource;window.EventSource=class extends Original{constructor(...args){super(...args);window.__source=this;}};});
 let release,entered,delay=false;let rows=Array.from({length:80},(_,i)=>({role:i%2?'assistant':'user',text:i%2?'Message '+i+'\n\n'+Array.from({length:12},(_,j)=>'- **Check '+j+'**: Review the result and its supporting evidence.').join('\n'):'User prompt '+i,ts:new Date(Date.now()-100000+i*1000).toISOString()}));
 rows.push({role:'error',text:'Provider disconnected',ts:new Date().toISOString()});
 rows.push({role:'user',text:'Image from history',ts:new Date().toISOString(),attachments:[{name:'Screenshot.png',type:'image/png',url:'/api/conversations/upload-image?upload=fixture&name=Screenshot.png'}]});
 await page.route('**/api/conversations/history-page?**',async route=>{if(delay){entered?.();await new Promise(r=>release=r);}await route.fulfill({json:{rows,cursor:0,done:true}});});
 await page.route('**/api/conversations/upload-image?**',route=>route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=','base64')}));
 await page.goto(base+'/home');
 const card=page.locator('.cr-task').filter({hasText:'Update the component library'}).first();await card.waitFor();
 const target=await card.evaluate(e=>({projectId:e.dataset.project,sessionId:e.dataset.session}));
 const client=await page.context().newCDPSession(page);await client.send('Performance.enable');
 const metrics=async()=>Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
 const before=await metrics();await card.click();await page.locator('#chat .banner.err').filter({hasText:'Provider disconnected'}).waitFor();
 const im=page.locator('#chat img.att');await im.scrollIntoViewIfNeeded();await page.waitForFunction(()=>document.querySelector('#chat img.att')?.naturalWidth>0);
 const after=await metrics();assert(after.LayoutCount-before.LayoutCount<45,'History forced too many layouts: '+(after.LayoutCount-before.LayoutCount));
 const emit=(kind,data)=>page.evaluate(({kind,data})=>window.__source.dispatchEvent(new MessageEvent(kind,{lastEventId:String(Date.now()),data:JSON.stringify({data})})),{kind,data:{...target,...data}});
 const waiting=new Promise(r=>entered=r);delay=true;
 // Use the actual manual refresh control, with a slow history response.
 await page.locator('#chatRefresh').click({noWaitAfter:true});await waiting;
 await emit('session_started',{messageId:'queued-human',displayPrompt:'Queued human message',resume:true});
 release();await page.waitForTimeout(400);
 assert.equal(await page.locator('#chat [data-message-source-id="queued-human"]').count(),1);
 await emit('session_started',{messageId:'queued-human',displayPrompt:'Queued human message',resume:true});
 assert.equal(await page.locator('#chat [data-message-source-id="queued-human"]').count(),1);
 await emit('session_started',{messageId:'another-human',displayPrompt:'Queued human message',resume:true});
 assert.equal(await page.locator('#chat .msg.user').filter({hasText:'Queued human message'}).count(),2,'two equal prompts with separate IDs are separate messages');
 for(const width of [390,780,1000,390]){
   await page.setViewportSize({width,height:844});
   if(width<=850){await page.locator('#menuBtn').click();await page.locator('#workspaceNavClose').waitFor();assert(!(await page.locator('#crProjectNav').evaluate(e=>e.inert)));await page.keyboard.press('Escape');assert(!(await page.locator('#conversationSurface').evaluate(e=>e.inert)));assert(await page.locator('#menuBtn').evaluate(e=>e===document.activeElement));}
   else assert(!(await page.locator('#crProjectNav').evaluate(e=>e.inert)));
 }
 assert.deepEqual(errors,[]);console.log('PASS history batching, error replay, lazy historical images, live queued echo race, mobile/tablet drawer; layouts='+Math.round(after.LayoutCount-before.LayoutCount));
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
