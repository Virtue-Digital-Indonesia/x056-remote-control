// Advisor cards in the chat, and the helper menu. Start fixture.ts first (with
// X056_PROJECT_SPACES_ENABLED=1 X056_CHAT_ENABLED=1 to match production).
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await browser.newContext();
  const api = async (p) => (await req.request.get(base + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const project = (await api('/api/projects')).projects.find((p) => p.name === 'Website refresh');
  const conv = project.conversations.find((c) => c.title === 'Build the new homepage');
  const transcript = execSync(`find /tmp -path '*primary/projects/fixture/${conv.sessionId}.jsonl' | head -1`).toString().trim();
  const state = path.join(transcript.split('/primary/')[0], 'state');
  const t0 = Date.now(), iso = (d) => new Date(t0 - d).toISOString();
  // Claude's advisor, as the transcript records it (advice encrypted).
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: iso(50000), message: { role: 'assistant', model: 'claude-sonnet-5', content: [
    { type: 'server_tool_use', id: 's1', name: 'advisor', input: {} }, { type: 'advisor_tool_result', tool_use_id: 's1', content: { type: 'advisor_redacted_result', encrypted_content: 'x' } }] } }) + '\n');
  // The gateway-built ChatGPT advisor, as the conversation journal records it.
  const jf = path.join(state, 'conversation-journal', crypto.createHash('sha256').update(project.id + '\0' + conv.sessionId).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  const rows = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : [];
  rows.push({ role: 'advisor', messageId: 'advisor:a1', text: '', ts: iso(45000), advisor: { model: 'gpt-6-astra', trigger: 'stuck', verdict: 'adjust', advice: 'Read the stack trace before restarting anything.', delivered: 'steered', latencyMs: 8985 } });
  rows.push({ role: 'advisor', messageId: 'advisor:a2', text: '', ts: iso(30000), advisor: { model: 'gpt-6-astra', trigger: 'done', verdict: 'looks_good', advice: 'Covered by the snapshot test.', delivered: 'none', latencyMs: 6100 } });
  fs.writeFileSync(jf, JSON.stringify(rows));

  for (const vp of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base); await page.waitForSelector('.cr-task');
    await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).first().click();
    await page.waitForSelector('.advcard');
    const compact = page.locator('.advcard.compact');
    assert.equal(await compact.count(), 1);
    assert.match(await compact.textContent(), /Advisor.*Reviewed this step/);
    const full = page.locator('.advcard:not(.compact)');
    assert.equal(await full.count(), 2);
    assert.match(await full.nth(0).textContent(), /AdvisorAstraLooked at the repeated failure · 9 sAdjustRead the stack trace before restarting anything\.Steered into the running turn/);
    assert.equal(await full.nth(0).locator('.advverdict.warn').count(), 1);
    assert.equal(await full.nth(1).locator('.advverdict.ok').textContent(), 'Looks good');
    // Nothing in a card runs past its edge.
    for (const card of await page.locator('.advcard').all()) {
      const over = await card.evaluate((c) => [...c.querySelectorAll('*')].some((e) => { const r = e.getBoundingClientRect(), b = c.getBoundingClientRect(); return r.width && (r.right > b.right + 1 || r.left < b.left - 1); }));
      assert.equal(over, false, 'card content overflows at ' + vp.width + 'px');
    }
    // The helper menu opens fully on screen, works from the keyboard, and closes on Escape.
    await page.locator('#helperBtn').click();
    const box = await page.locator('#helperMenu').boundingBox();
    assert.ok(box && box.y >= 0 && box.x >= 0 && box.x + box.width <= vp.width && box.height > 150, 'menu fully visible');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#helperMenu').isHidden(), true);
    if (vp.width < 600) {
      // Phones: one header row, the terminal lives in the conversation menu.
      assert.equal(await page.locator('#chatTerminal').isVisible(), false);
      const tops = await page.evaluate(() => [...document.querySelector('#conversationSurface .topbar').children].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().top)));
      assert.ok(Math.max(...tops) - Math.min(...tops) < 12, 'header on one row');
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  await browser.close();
  console.log('PASS advisor cards render from history on desktop and phone without overflow; helper menu opens on screen, keyboard and Escape work; phone header stays one row');
})().catch((e) => { console.error(e); process.exit(1); });
