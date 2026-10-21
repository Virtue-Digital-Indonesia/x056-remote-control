// Screenshots of the Bot owner view for review (not an assertion test beyond "the page rendered"):
// the clean Bot chat (owner turn, an owner FYI bubble, a Needs-you bubble and card, agent turns hidden), the same chat
// with the hidden messages shown, and the rename field with the renamed header and sidebar.
//   X056_SHOTS=/tmp/bot-owner X056_TEST_BROWSER=chromium|webkit node test/browser/bot-owner-shots.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
const shots = process.env.X056_SHOTS || '/tmp/bot-owner';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

const t0 = Date.now() - 3 * 3600000;
const ROWS = [
  { role: 'user', text: "What's running right now?" },
  { role: 'assistant', text: 'Two things are running: the **OCR benchmark** (about 12 minutes left) and the nightly docs build. Nothing is blocked.' },
  { role: 'user', text: 'Build finished: 142 tests pass, 0 failed.', sender: { kind: 'conversation', conversationTitle: 'Build agent', projectName: 'x056', messageId: 'a1' } },
  { role: 'assistant', text: 'Thanks, noted. I will pass this on.' },
  { role: 'action', text: 'Used mcp__x056__read_conversation', detail: '{}' },
  { role: 'assistant', ownerMessage: true, needsYou: false, text: 'The build you asked about finished: **142 tests pass**, nothing failed.', messageId: 'bot-owner:t1' },
  { role: 'assistant', text: 'Done. Anything else from the build agent?' },
  { role: 'user', text: 'Nightly backup finished', sender: { kind: 'automation', messageId: 'a2' } },
  { role: 'assistant', text: 'Backup ok, 4.2 GB. Nothing to report.' },
  { role: 'user', text: 'Release candidate is ready to deploy', sender: { kind: 'mcp', messageId: 'a3' } },
  { role: 'assistant', text: 'This needs a decision from the owner.' },
  { role: 'assistant', ownerMessage: true, needsYou: true, text: 'The release candidate is ready. **Deploy it now, or wait for tomorrow morning?**', messageId: 'bot-owner:t2' },
  { role: 'user', text: 'Wait until tomorrow, please.' },
  { role: 'assistant', text: 'Understood. I will hold the release and remind you in the morning brief.' },
];

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  try {
    const admin = await browser.newContext();
    const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: 'Shots Bot ' + randomUUID(), provider: 'claude' } });
    assert.ok(r.ok(), await r.text());
    const bot = await r.json(); await admin.close();
    const make = async options => {
      const context = await browser.newContext({ serviceWorkers: 'block', ...options });
      await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
      // The owner already answered the question in text ("Wait until tomorrow, please."), so nothing is pending.
      const server = { name: 'Bot', attention: { needsMe: 0, fyi: false } };
      await context.route(/\/api\/sessions\/current\/stream/, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
      await context.route('**/api/bot', async route => { if (route.request().method() === 'POST') { const b = route.request().postDataJSON(); if (b.name) server.name = b.name; } await route.fulfill({ json: { enabled: true, projectId: bot.id, sessionId: bot.lastSessionId, url: '/chat/' + bot.id, briefAt: '07:30', tz: 'Asia/Jakarta', name: server.name, attention: server.attention } }); });
      await context.route(/\/api\/projects(\?|$)/, async route => { const response = await route.fetch(), data = await response.json(); for (const p of data.projects) if (p.id === bot.id) { p.bot = true; p.botName = server.name; p.botAttention = server.attention; } await route.fulfill({ response, json: data }); });
      await context.route('**/api/questions', route => route.fulfill({ json: [] }));
      await context.route('**/api/bot/overview*', route => route.fulfill({ json: { needsYou: [], running: [], delegates: [], scheduled: [] } }));
      await context.route(/\/api\/conversations\/history-page\?/, route => new URL(route.request().url()).searchParams.get('projectId') !== bot.id ? route.continue() : route.fulfill({ json: { done: true, cursor: null, rows: ROWS.map((row, i) => ({ ...row, ts: new Date(t0 + i * 600000).toISOString() })) } }));
      return { context, server };
    };
    const open = async (page, path) => { await page.goto(base + path); await page.waitForFunction(() => window.rcWorkspace?.ready()); await page.getByText('Understood. I will hold the release', { exact: false }).waitFor(); await page.waitForTimeout(700); };
    const suffix = '-' + engine;
    for (const [label, options] of [['desktop', { viewport: { width: 1440, height: 1700 } }], ['phone', { ...playwright.devices['iPhone 13'] }]]) {
      const { context } = await make(options);
      const page = await context.newPage();
      await open(page, '/chat/' + bot.id);
      // Phones show one screen: scroll back so the owner bubbles are in view.
      await page.screenshot({ path: `${shots}/clean-chat-${label}${suffix}.png` });
      await page.locator('#rcBotToday:visible, #rcBotNeeds:visible').first().click(); await page.locator('#rcBotSystemHistory').click();
      await page.waitForTimeout(400);
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${shots}/hidden-shown-${label}${suffix}.png` });
      await context.close();
    }
    {
      const { context } = await make({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await open(page, '/chat/' + bot.id);
      await page.locator('#rcBotSettings').click();
      const dlg = page.locator('dialog.rc-bot-settings[open]');
      await dlg.getByLabel('Name', { exact: true }).fill('Jarvis');
      await page.screenshot({ path: `${shots}/rename-settings-desktop${suffix}.png` });
      await dlg.getByRole('button', { name: 'Save' }).click();
      await page.waitForFunction(() => !document.querySelector('dialog.rc-bot-settings[open]'), null, { timeout: 5000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/renamed-header-sidebar-desktop${suffix}.png` });
      await context.close();
    }
    console.log('shots written to ' + shots);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
