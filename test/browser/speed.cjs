const assert = require('node:assert/strict');
const { chromium } = require('/usr/local/lib/node_modules/playwright');
// Run against a fixture started with X056_TEST_CODEX_TIERS=1.
const base = process.argv[2] || 'http://127.0.0.1:8795';
const shots = process.env.X056_SHOTS; // optional dir for screenshots
const pick = async (page, kind, value) => {
  if (!(await page.locator('#runChip').isVisible())) await page.locator('#prompt').click();
  if (await page.locator('#runMenu').isHidden()) await page.locator('#runChip').click();
  await page.locator('#runMenu [data-run=' + kind + '][data-value="' + value + '"]').click();
};
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    for (const [theme, width, height] of [['dark', 1440, 1000], ['light', 1440, 1000], ['dark', 390, 844], ['light', 390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      await context.addInitScript((t) => { localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); localStorage.setItem('x056_theme', t); }, theme);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const headers = { Authorization: 'Bearer browser-fixture-token-0123456789' };
      const { projects } = await (await context.request.get(base + '/api/projects', { headers })).json();
      const research = projects.find((p) => p.name === 'Research workspace');
      const gpt = research.conversations.find((c) => c.title === 'Speed ChatGPT chat');
      const claude = projects.find((p) => p.name === 'Website refresh').conversations[0];
      const open = async (pid, c) => {
        await page.goto(base + '/work/' + pid + '/' + c.sessionId);
        await page.locator('#prompt').waitFor(); await page.locator('#prompt').click();
      };
      const saved = (sid) => page.waitForFunction(async ({ pid, sid }) => {
        const d = await (await fetch('/api/projects', { headers: { Authorization: 'Bearer ' + localStorage.getItem('x056_token') } })).json();
        return d.projects.find((p) => p.id === pid).conversations.find((c) => c.sessionId === sid).speed;
      }, { pid: research.id, sid });
      await open(research.id, gpt);
      await pick(page, 'model', 'gpt-6.1-sol');
      assert.equal(await page.locator('#runMenu [data-run=speed]').count(), 3, 'Off / Fast / Ultrafast on 6.1-Sol');
      assert.equal(await page.locator('#speed').inputValue(), 'off', 'new conversations start Off');
      await pick(page, 'speed', 'ultrafast');
      assert.equal(await page.waitForFunction(() => document.querySelector('#speedCaption').textContent.includes('latency-sensitive')).then(() => true), true);
      assert.match(await page.locator('#speedCaption').textContent(), /accounts chatgpt/);
      if (shots) await page.screenshot({ path: shots + '/speed-' + theme + '-' + width + '.png' });
      assert.equal(await saved(gpt.sessionId).then((h) => h.jsonValue()), 'ultrafast');
      // Fast shows its caption; Terra has no Ultrafast, so the choice steps down to Fast.
      await pick(page, 'speed', 'fast');
      assert.match(await page.locator('#speedCaption').textContent(), /2x speed/);
      await pick(page, 'speed', 'ultrafast');
      await pick(page, 'model', 'gpt-5.6-terra');
      assert.equal(await page.locator('#runMenu [data-run=speed]').count(), 2, 'Terra has no Ultrafast');
      assert.equal(await page.locator('#speed').inputValue(), 'fast', 'stepped down to Fast');
      await page.keyboard.press('Escape');
      assert.match(await page.locator('#composerCaption').textContent(), /Fast$/);
      assert.match(await page.locator('#runChipLabel').textContent(), /Fast$/);
      await pick(page, 'model', 'gpt-6-astra'); await pick(page, 'speed', 'ultrafast');
      await page.keyboard.press('Escape');
      assert.match(await page.locator('#composerCaption').textContent(), /Ultrafast$/);
      // Persists across reload.
      await open(research.id, gpt);
      assert.equal(await page.locator('#speed').inputValue(), 'ultrafast');
      assert.match(await page.locator('#runChipLabel').textContent(), /Ultrafast$/);
      // The send carries it (approval mode names it).
      const r = await context.request.post(base + '/api/conversations/send', { headers, data: { projectId: research.id, sessionId: gpt.sessionId, prompt: 'speed check' } });
      const { approvalId } = await r.json(); assert.ok(approvalId);
      const approval = (await (await context.request.get(base + '/api/mcp/approvals', { headers })).json()).find((a) => a.id === approvalId);
      assert.equal(approval.speed, 'ultrafast');
      await context.request.post(base + '/api/mcp/approvals/decide', { headers, data: { id: approvalId, approve: false } });
      // Off again.
      await pick(page, 'speed', 'off'); await page.keyboard.press('Escape');
      await page.waitForFunction(async ({ pid, sid }) => {
        const d = await (await fetch('/api/projects', { headers: { Authorization: 'Bearer ' + localStorage.getItem('x056_token') } })).json();
        return !d.projects.find((p) => p.id === pid).conversations.find((c) => c.sessionId === sid).speed;
      }, { pid: research.id, sid: gpt.sessionId });
      // A Claude conversation shows no Speed row.
      await open(projects[0].id, claude);
      if (await page.locator('#runMenu').isHidden()) await page.locator('#runChip').click();
      assert.equal(await page.locator('#runMenu [data-run=speed]').count(), 0);
      assert.doesNotMatch(await page.locator('#composerCaption').textContent(), /Fast|Ultrafast/);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('PASS: Speed row on ChatGPT only, Ultrafast limited to models that offer it, step-down, caption, persistence, approval carries it.');
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exitCode = 1; });
