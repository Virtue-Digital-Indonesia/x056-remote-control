// The owner-view rule for NORMAL (non-Bot) conversations. The server's shared fixture (test/fixtures/owner-view-table.json)
// is replayed through the panel: each case's rows are served as a chat's history, rendered by the real panel, and every
// row's DOM verdict (hidden or shown) must equal the fixture's `expected`. The inline "N hidden messages" buttons and the
// "N earlier messages" line are not rows.
//   X056_TEST_BROWSER=chromium|webkit node test/browser/owner-view-table.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'), path = require('node:path');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'owner-view-table.json'), 'utf8'));

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const errors = [];
  let rowsChecked = 0;
  try {
    const admin = await browser.newContext();
    const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: 'Table chat ' + randomUUID(), provider: 'claude' } });
    assert.ok(r.ok(), await r.text());
    const chat = await r.json(); await admin.close();
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 1600 } });
    await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
    let current = [];
    const serve = rows => rows.map((row, i) => {
      const out = { ...row, ts: new Date(Date.now() - 86400000 + i * 1000).toISOString() };
      if (out.sender && out.sender.sessionId === '$SELF') out.sender = { ...out.sender, sessionId: chat.lastSessionId };
      delete out.expected;
      return out;
    });
    await context.route(/\/api\/sessions\/current\/stream/, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
    await context.route('**/api/questions', route => route.fulfill({ json: [] }));
    await context.route(/\/api\/conversations\/history-page\?/, route => new URL(route.request().url()).searchParams.get('projectId') !== chat.id ? route.continue() : route.fulfill({ json: { done: true, cursor: null, rows: serve(current) } }));
    const page = await context.newPage();
    page.on('pageerror', e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); });
    for (const c of table.cases) {
      current = c.rows;
      await page.goto(base + '/chat/' + chat.id);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.waitForFunction(n => document.querySelectorAll('#chat>:not(.ov-btn):not(.older-bar)').length >= n, c.rows.length, { timeout: 8000 });
      await page.waitForTimeout(250);
      const verdicts = await page.evaluate(() => [...document.querySelectorAll('#chat>*')].filter(e => !e.matches('.ov-btn,.older-bar') && !(e.matches('.sysline') && /^\d+ earlier messages$/.test(e.textContent.trim()))).map(e => getComputedStyle(e).display === 'none' ? 'hide' : 'show'));
      assert.deepEqual(verdicts, c.expected, 'case "' + c.name + '"');
      // One real button before each run of hidden rows, none when nothing is hidden, none that is itself hidden.
      const runs = await page.evaluate(() => { let n = 0, inRun = false; for (const e of document.querySelectorAll('#chat>:not(.ov-btn):not(.older-bar)')) { const h = getComputedStyle(e).display === 'none'; if (h && !inRun) n++; inRun = h; } return { runs: n, buttons: [...document.querySelectorAll('#chat>.ov-btn')].filter(b => getComputedStyle(b).display !== 'none' && b.tagName === 'BUTTON').length }; });
      assert.equal(runs.buttons, runs.runs, 'case "' + c.name + '": one button per hidden run');
      rowsChecked += c.rows.length;
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} owner-view-table: ${table.cases.length} cases, ${rowsChecked} rows agree with the server rule`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
