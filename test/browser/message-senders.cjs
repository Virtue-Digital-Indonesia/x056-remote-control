const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:8795';
(async () => {
  const browser = await chromium.launch({args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(() => {
      localStorage.setItem('x056_token','browser-fixture-token-0123456789');
      const Original=EventSource;
      window.EventSource=class extends Original {constructor(...args){super(...args);window.__source=this;}};
    });
    const page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    const sender={kind:'conversation',messageId:'sender-test',sessionId:'source',projectId:'source-project',conversationTitle:'Accessibility review',projectName:'Website refresh'};
    const rows=[
      {role:'user',text:'Please check the new landing page.'},
      {role:'user',text:'The accessibility review is ready. Keyboard navigation and contrast checks passed.',sender},
      {role:'assistant',text:'I will incorporate those findings.'},
      {role:'user',text:'Run the daily status check.',sender:{kind:'automation',messageId:'scheduled'}},
      {role:'user',text:'Continue the remaining work.',sender:{kind:'autopilot',messageId:'autopilot'}},
    ].map(row=>({...row,ts:new Date().toISOString()}));
    let target;
    await page.route('**/api/conversations/history-page?*', async route => {
      const params=new URL(route.request().url()).searchParams;
      target={projectId:params.get('projectId'),sessionId:params.get('sessionId')};
      await route.fulfill({json:{rows,cursor:0,done:true}});
    });
    await page.goto(base);
    await page.locator('.cr-task').filter({hasText:'Update the component library'}).click();
    await page.locator('#chat .message-sender').first().waitFor();
    assert.equal(await page.locator('#chat .msg.user:not(.from-sender) .role').textContent(),'you');
    assert.equal(await page.locator('#chat .message-sender strong').first().textContent(),sender.conversationTitle);
    assert.equal(await page.locator('#chat .message-sender small').first().textContent(),sender.projectName);
    assert.equal(await page.locator('#chat .message-sender').count(),3);
    const event={...target,sender,displayPrompt:rows[1].text,resume:true};
    await page.evaluate(data => {for(let i=0;i<2;i++) window.__source.dispatchEvent(new MessageEvent('session_started',{data:JSON.stringify({data})}));},event);
    assert.equal(await page.locator('[data-message-source-id="sender-test"]').count(),1,'replayed live event cannot duplicate history');
    await page.evaluate(data=>window.__source.dispatchEvent(new MessageEvent('session_started',{data:JSON.stringify({data})})),{...event,sender:{...sender,messageId:'live-new',conversationTitle:'Reviewer <img src=x onerror=alert(1)>'},displayPrompt:'A new message while you are reading.'});
    assert.equal(await page.locator('[data-message-source-id="live-new"]').count(),1);
    assert.equal(await page.locator('[data-message-source-id="live-new"] img').count(),0);
    assert.match(await page.locator('[data-message-source-id="live-new"] strong').textContent(),/<img/);
    for(const theme of ['dark','light']) {
      await page.emulateMedia({colorScheme:theme});
      await page.waitForTimeout(200);
      await page.screenshot({path:'/tmp/message-senders-'+theme+'.png'});
    }
    await page.setViewportSize({width:390,height:844});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert(await page.locator('#chat .message-sender').first().evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.screenshot({path:'/tmp/message-senders-mobile.png'});
    await page.reload();
    await page.locator('.cr-task').filter({hasText:'Update the component library'}).click();
    await page.locator('#chat [data-message-source-id="sender-test"]').waitFor();
    assert.equal(await page.locator('#chat .message-sender').count(),3);
    assert.deepEqual(errors,[]);
    console.log('PASS sender labels, human label, automation/autopilot, live delivery and replay deduplication, refresh, escaped names and mobile fit');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
