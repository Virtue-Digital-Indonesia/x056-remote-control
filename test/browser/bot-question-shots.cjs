// Review screenshots (not an assertion test beyond the card staying up): the Bot chat with a pending
// "Needs you" question, then another conversation's message arrives and its turn runs. The card must
// still be there, in the default view and with the hidden agent exchange shown.
//   X056_SHOTS=/tmp/bot-owner X056_TEST_BROWSER=chromium|webkit node test/browser/bot-question-shots.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
const shots = process.env.X056_SHOTS || '/tmp/bot-owner';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  try {
    const admin = await browser.newContext();
    const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: 'Bot', provider: 'claude' } });
    assert.ok(r.ok(), await r.text());
    const bot = await r.json();
    await admin.close();
    const ids = { projectId: bot.id, sessionId: bot.lastSessionId };
    const t = s => new Date(Date.now() - s * 1000).toISOString();
    const question = { ...ids, question: 'The release candidate is ready. Deploy it now, or wait for tomorrow morning?', options: ['Deploy now', 'Wait until tomorrow'], at: t(300) };
    const rows = [
      { role: 'user', text: 'Is the release candidate ready?', ts: t(420), botView: 'show' },
      { role: 'assistant', text: 'Checking with Valid Deployment.', ts: t(400), botView: 'show' },
      { role: 'assistant', ownerMessage: true, needsYou: true, messageId: 'bot-owner:shot-1', text: 'The release candidate is ready. **Deploy it now, or wait for tomorrow morning?**', ts: t(300), botView: 'show' },
    ];
    const suffix = engine === 'webkit' ? '-webkit' : '';
    for (const [label, options] of [['desktop-1440', { viewport: { width: 1440, height: 900 } }], ['desktop-1920', { viewport: { width: 1920, height: 1080 } }], ['phone', { ...playwright.devices['iPhone 13'] }]]) {
      const context = await browser.newContext({ serviceWorkers: 'block', ...options });
      await context.addInitScript(tok => localStorage.setItem('x056_token', tok), token);
      await context.addInitScript(() => {
        class FakeSource { constructor(url) { this.url = url; this.l = {}; window.__es = this; setTimeout(() => this.onopen && this.onopen({}), 0); } addEventListener(k, f) { (this.l[k] = this.l[k] || []).push(f); } close() {} }
        window.EventSource = FakeSource;
        window.__emit = (kind, data) => (window.__es.l[kind] || []).forEach(f => f({ data: JSON.stringify({ data, ts: new Date().toISOString() }), lastEventId: '' }));
      });
      await context.route('**/api/bot', route => route.fulfill({ json: { enabled: true, name: 'Bot', ...ids, url: '/chat/' + bot.id, briefAt: '07:30', tz: 'Asia/Jakarta', attention: { needsMe: 1, fyi: false } } }));
      await context.route('**/api/bot/overview*', route => route.fulfill({ json: { needsYou: [{ kind: 'question', title: 'Bot', text: question.question }], running: [], delegates: [], scheduled: [] } }));
      await context.route(/\/api\/projects(\?|$)/, async route => { const response = await route.fetch(), data = await response.json(); for (const p of data.projects) if (p.id === bot.id) { p.bot = true; p.botName = 'Bot'; p.botAttention = { needsMe: 1, fyi: false }; } await route.fulfill({ response, json: data }); });
      await context.route('**/api/questions', route => route.fulfill({ json: [question] }));
      await context.route(/\/api\/conversations\/history-page\?/, route => new URL(route.request().url()).searchParams.get('projectId') === bot.id ? route.fulfill({ json: { done: true, cursor: null, rows } }) : route.continue());
      const page = await context.newPage();
      await page.goto(base + '/chat/' + bot.id);
      await page.waitForFunction(() => window.rcWorkspace?.ready() && window.__es);
      await page.locator('#chat .qcard.pending').waitFor();
      await page.waitForTimeout(600);
      const emit = (kind, data) => page.evaluate(([k, d]) => window.__emit(k, d), [kind, { ...ids, ...data }]);
      // Another conversation's message arrives and the Bot answers it (an agent turn).
      await emit('session_started', { messageId: 'agent-shot-1', displayPrompt: 'Valid Deployment: CI is green on the release branch; nothing else needed from you.', sender: { kind: 'conversation', conversationTitle: 'Valid Deployment', projectName: 'obscura', messageId: 'agent-shot-1' } });
      await emit('assistant_text', { text: 'Noted, thanks. I will hold the release until Efran decides.' });
      await emit('session_done', { status: 'completed', origin: 'relay' });
      await page.waitForTimeout(800);
      assert.equal(await page.locator('#chat .qcard.pending').count(), 1, 'the question card survived the agent turn');
      await page.screenshot({ path: `${shots}/question-survives-${label}${suffix}.png` });
      await page.locator('#rcBotToday:visible, #rcBotNeeds:visible').first().click();
      await page.locator('#rcBotSystemHistory').click();
      await page.waitForTimeout(500);
      await page.evaluate(() => document.querySelectorAll('.scroll').forEach(e => { e.scrollTop = e.scrollHeight; }));
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#chat .qcard.pending').count(), 1);
      assert.ok(await page.getByText('Valid Deployment: CI is green', { exact: false }).isVisible(), 'the agent message is shown when hidden messages are on');
      await page.screenshot({ path: `${shots}/question-survives-shown-${label}${suffix}.png` });
      await context.close();
    }
    console.log('question shots written to ' + shots);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
