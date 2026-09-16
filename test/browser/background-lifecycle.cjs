const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:1440,height:1000}});
    await context.addInitScript(() => {
      localStorage.setItem('x056_token','browser-fixture-token-0123456789');
      const Original = EventSource;
      window.EventSource = class extends Original { constructor(...args) { super(...args); window.__source = this; } };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(process.argv[2] || 'http://127.0.0.1:8798');
    const card = page.locator('.cr-task').filter({hasText:'Update the component library'});
    await card.waitFor();
    const target = await card.evaluate(el => ({projectId:el.dataset.project, sessionId:el.dataset.session}));
    const row = page.locator('[data-row="'+target.sessionId+'"]');
    const emit = (kind, values) => page.evaluate(({kind,data}) => window.__source.dispatchEvent(new MessageEvent(kind, {lastEventId:String(Date.now()),data:JSON.stringify({data})})), {kind,data:{...target,...values}});
    await emit('background_state', {active:true, parentActive:false, agents:2, tasks:0});
    await page.waitForFunction(sid => document.querySelector('[data-row="'+sid+'"]')?.classList.contains('background'), target.sessionId);
    await emit('session_done', {status:'completed', completionPending:true});
    assert.equal(await row.locator('.cr-unread-dot').count(),0,'intermediate turn must not set unread');
    await emit('background_state', {active:true, parentActive:true, agents:1, tasks:0});
    assert.equal(await row.locator('.cr-unread-dot').count(),0,'child finishing while parent works is not completion');
    await emit('background_state', {active:false, parentActive:false, agents:0, tasks:0});
    await page.waitForFunction(sid => !document.querySelector('[data-row="'+sid+'"]')?.classList.contains('background'), target.sessionId);
    await emit('conversation_settled', {status:'completed', completionPending:false});
    await row.locator('.cr-unread-dot').waitFor();
    assert.deepEqual(errors,[]);
    console.log('PASS: live background clearing and deferred conversation unread notification');
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode=1;});
