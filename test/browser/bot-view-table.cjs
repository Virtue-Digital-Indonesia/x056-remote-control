// The server's shared rule fixture (test/fixtures/bot-view-table.json, the cases test/bot-view.test.ts proves against
// server/bot-view.ts) is replayed through the panel: each case's rows are served as the Bot chat's history, rendered
// by the real panel, and every row's DOM verdict (hidden or shown) must equal the fixture's `expected`.
// Run against the isolated browser fixture with Chat and Project spaces enabled:
//   X056_TEST_BROWSER=chromium|webkit node test/browser/bot-view-table.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'bot-view-table.json'), 'utf8'));

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const errors = [];
  let rowsChecked = 0;
  try {
    const admin = await browser.newContext();
    const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: 'Table Bot ' + randomUUID(), provider: 'claude' } });
    assert.ok(r.ok(), await r.text());
    const bot = await r.json(); await admin.close();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1600 } });
    await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
    let current = [];
    await context.route(/\/api\/sessions\/current\/stream/, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
    await context.route('**/api/bot', route => route.fulfill({ json: { enabled: true, projectId: bot.id, sessionId: bot.lastSessionId, url: '/chat/' + bot.id, briefAt: '07:30', tz: 'Asia/Jakarta', name: 'Bot', attention: null } }));
    await context.route(/\/api\/projects(\?|$)/, async route => { const response = await route.fetch(), data = await response.json(); for (const p of data.projects) if (p.id === bot.id) p.bot = true; await route.fulfill({ response, json: data }); });
    await context.route('**/api/questions', route => route.fulfill({ json: [] }));
    await context.route(/\/api\/conversations\/history-page\?/, route => new URL(route.request().url()).searchParams.get('projectId') !== bot.id ? route.continue() : route.fulfill({ json: { done: true, cursor: null, rows: current.map((row, i) => ({ ...row, ts: new Date(Date.now() - 86400000 + i * 1000).toISOString() })) } }));
    const page = await context.newPage();
    page.on('pageerror', e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); });
    for (const c of table.cases) {
      current = c.rows;
      await page.goto(base + '/chat/' + bot.id);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.waitForFunction(n => document.querySelectorAll('#chat>*').length >= n, c.rows.length, { timeout: 8000 });
      await page.waitForTimeout(250);
      const verdicts = await page.evaluate(() => [...document.querySelectorAll('#chat>*')].filter(e => !(e.matches('.sysline') && /^\d+ earlier messages$/.test(e.textContent.trim()))).map(e => getComputedStyle(e).display === 'none' ? 'hide' : 'show'));
      assert.deepEqual(verdicts, c.expected, 'case "' + c.name + '"');
      rowsChecked += c.rows.length;
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} bot-view-table: ${table.cases.length} cases, ${rowsChecked} rows agree with the server rule`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
