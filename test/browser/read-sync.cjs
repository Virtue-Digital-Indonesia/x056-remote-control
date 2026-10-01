// Run fixture.ts first, then: node test/browser/read-sync.cjs [base URL]
// Read and unread are shared through the gateway (server/read-state.ts): the
// phone's reads clear the panel's bells and the panel's reads clear the phone.
// "The phone" here is plain API calls with the same token.
const assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8799';
const token = 'browser-fixture-token-0123456789';
const phone = (path, body) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

(async () => {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript((t) => { localStorage.setItem('x056_token', t); }, token);
    await page.route('**/control-room.js*', async (route) => {
      const response = await route.fetch();
      const body = await response.text();
      await route.fulfill({ response, body: body + '\n{const original=window.createControlRoom;window.createControlRoom=function(engine){window.__engine=engine;return original(engine);};}' });
    });
    await page.goto(base);
    await page.locator('.cr-task').first().waitFor();
    const target = await page.evaluate(() => {
      const s = window.__engine.state();
      for (const p of s.projects) for (const c of p.conversations || []) if (c.sessionId !== s.sessionId && !s.questions[c.sessionId]) return { projectId: p.id, sessionId: c.sessionId };
      throw Error('no off-screen conversation');
    });
    const key = target.projectId + '::' + target.sessionId;
    const bell = () => page.evaluate((k) => window.__engine.state().notifications[k] || null, key);
    const waitBell = (want) => page.waitForFunction(({ k, want }) => (window.__engine.state().notifications[k] || null) === want, { k: key, want }, { timeout: 8000 });

    // 1. The phone marks it unread: the web bell rings.
    await phone('/api/conversations/unread', target);
    await waitBell('unread');
    // 2. The phone reads it: the web bell clears.
    await phone('/api/conversations/read', target);
    await waitBell(null);
    // 3. The web marks it unread, then read: the gateway follows.
    await page.evaluate(({ projectId, sessionId }) => window.__engine.setConversationUnread(projectId, sessionId, true), target);
    await page.waitForTimeout(400);
    assert.equal((await phone('/api/conversations/read-state')).items[key].kind, 'unread', 'web mark-unread reaches the gateway');
    // 4. A reload with the browser's own memory wiped still shows the gateway's state.
    await page.evaluate(() => { localStorage.removeItem('x056_conv_seen'); localStorage.removeItem('x056_q_seen'); });
    await page.reload();
    await page.locator('.cr-task').first().waitFor();
    await waitBell('unread');
    await page.evaluate(({ projectId, sessionId }) => window.__engine.setConversationUnread(projectId, sessionId, false), target);
    await page.waitForTimeout(400);
    assert.equal((await phone('/api/conversations/read-state')).items[key].unread, false, 'web read reaches the gateway');
    assert.equal(await bell(), null);
    // 5. A real turn (the fixture's fake CLI) in an off-screen conversation
    //    rings on the web, and the phone's read clears it.
    await phone('/api/sessions/current/messages', { ...target, prompt: 'One more pass', requestId: 'read-sync-' + Date.now() + '-0001' });
    await page.waitForFunction((k) => !!window.__engine.state().notifications[k], key, { timeout: 15000 });
    assert.ok((await phone('/api/conversations/read-state')).items[key].unread, 'the turn raised unread on the gateway');
    await phone('/api/conversations/read', target);
    await waitBell(null);
    console.log('read-sync: ok');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
