const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async () => {
  const browser=await chromium.launch({args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}}), errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      localStorage.setItem('x056_token','browser-fixture-token-0123456789');
      const Original=EventSource;
      window.EventSource=class extends Original {constructor(...args){super(...args);window.__source=this;}};
      window.__notices=[];window.__sub=null;
      window.Notification=class {static permission='granted';constructor(title,options){window.__notices.push({title,...options});}};
      navigator.serviceWorker.register=()=>Promise.resolve({pushManager:{getSubscription:()=>Promise.resolve(window.__sub)}});
    });
    await page.route('**/control-room.js*',async route=>{
      const response=await route.fetch();
      const body=await response.text();
      await route.fulfill({response,body:body+'\n{const original=window.createControlRoom;window.createControlRoom=function(engine){window.__engine=engine;return original(engine);};}'});
    });
    await page.goto(process.argv[2]||'http://127.0.0.1:8799');
    await page.locator('.cr-task').first().waitFor();
    const target=await page.evaluate(()=>{
      const state=window.__engine.state();
      for(const p of state.projects)for(const c of p.conversations||[])if(c.sessionId!==state.sessionId&&!state.questions[c.sessionId])return {projectId:p.id,sessionId:c.sessionId};
      throw Error('No off-screen conversation');
    });
    const key=target.projectId+'::'+target.sessionId;
    async function emit(kind,data){await page.evaluate(({kind,data})=>window.__source.dispatchEvent(new MessageEvent(kind,{data:JSON.stringify({data})})),{kind,data:{...target,...data}});}
    await emit('session_done',{status:'failed',reason:'Connection lost'});
    assert.equal(await page.evaluate(k=>window.__engine.state().notifications[k],key),'failed');
    await emit('session_done',{status:'stopped',reason:'Stopped by user.',notificationSuppressed:true});
    assert.ok(!await page.evaluate(k=>window.__engine.state().notifications[k],key),'Stop clears failed attention');
    await emit('conversation_settled',{status:'completed',notificationSuppressed:true});
    await page.waitForTimeout(100);
    assert.ok(!await page.evaluate(k=>window.__engine.state().notifications[k],key),'suppressed completion stays quiet');
    await emit('autopilot',{active:false,reason:'stopped',notificationId:'ap-stop'});
    assert.equal(await page.evaluate(()=>window.__notices.length),0);
    await emit('question',{question:'Review the change?',at:'2026-09-20T12:00:00Z',notificationId:'turn1'});
    await emit('question',{question:'Review the change?',at:'2026-09-20T12:00:00Z',notificationId:'turn1'});
    await page.waitForFunction(()=>window.__notices.length===1);
    await page.evaluate(()=>{window.__sub={endpoint:'https://fixture.invalid/subscription'};});
    await emit('question',{question:'Another question',at:'2026-09-20T12:01:00Z',notificationId:'turn2'});
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.__notices.length),1,'registered Web Push must not get an extra page alert');
    assert.deepEqual(errors,[]);
    console.log('PASS: stopped status, suppressed completion, autopilot-off, duplicate questions and push/page ownership');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
