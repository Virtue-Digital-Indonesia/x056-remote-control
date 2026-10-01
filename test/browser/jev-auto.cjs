// Auto model/effort with a picker on: labels name the picker, and a send posts
// model '' / effort '' so the picker decides. Without a picker Auto still sends
// the house default. Start fixture.ts first (with X056_PROJECT_SPACES_ENABLED=1
// X056_CHAT_ENABLED=1). Every send is intercepted, so no turn runs and the real
// Jev API is never called.
const assert = require('node:assert/strict');
// #model / #effort are hidden behind the model · effort popover: pick through it.
const pickRun = async (page, kind, value) => {
  if (!(await page.locator('#runChip').isVisible())) await page.locator('#prompt').click();
  if (await page.locator('#runMenu').isHidden()) await page.locator('#runChip').click();
  await page.locator('#runMenu [data-run=' + kind + '][data-value="' + value + '"]').click();
  await page.keyboard.press('Escape');
};
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8861';
const TOKEN = 'browser-fixture-token-0123456789';
const TITLE = 'Review accessibility findings';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await browser.newContext();
  const auth = { Authorization: 'Bearer ' + TOKEN };
  const api = async (p) => (await req.request.get(base + p, { headers: auth })).json();
  const project = (await api('/api/projects')).projects.find((p) => p.name === 'Website refresh');
  const conv = project.conversations.find((c) => c.title === TITLE);
  const transcript = execSync(`find /tmp -path '*primary/projects/fixture/${conv.sessionId}.jsonl' | head -1`).toString().trim();
  const stateDir = path.join(transcript.split('/primary/')[0], 'state');
  // A fake key, so Jev is offered. Nothing here calls it.
  fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'fake' }));
  // Two Jev picks on Auto, as the journal records them: one made, one failed.
  const t0 = Date.now(), iso = (d) => new Date(t0 - d).toISOString();
  const jf = path.join(stateDir, 'conversation-journal', crypto.createHash('sha256').update(project.id + '\0' + conv.sessionId).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  const rows = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : [];
  rows.push({ role: 'advisor', messageId: 'decision:auto1', text: 'model -> haiku', ts: iso(40000), advisor: { helper: 'jev', decision: { baseModel: 'sonnet', model: 'haiku', effort: 'low', pickedModel: 'haiku', modelConfidence: 0.95, pickedEffort: 'low', effortConfidence: 0.98, auto: { model: true, effort: true }, notes: ['model -> haiku', 'effort -> low'], latencyMs: 310 } } });
  rows.push({ role: 'advisor', messageId: 'decision:auto2', text: 'no pick', ts: iso(30000), advisor: { helper: 'jev', decision: { baseModel: 'sonnet', auto: { model: true, effort: true }, error: 'timeout', notes: [] } } });
  fs.writeFileSync(jf, JSON.stringify(rows));
  const setHelpers = (h) => req.request.post(base + '/api/conversations/helpers', { headers: { ...auth, 'Content-Type': 'application/json' }, data: { projectId: project.id, sessionId: conv.sessionId, advisor: false, team: false, ...h } });

  const open = async (vp) => {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base); await page.waitForSelector('.cr-task');
    await page.locator('.cr-task').filter({ hasText: TITLE }).first().click();
    await page.waitForFunction(() => !document.getElementById('helperBtn').disabled);
    await page.locator('#prompt').click(); // the composer rests as one line; focus opens its controls
    const sent = [];
    await page.route('**/api/sessions/current/messages', (route) => { sent.push(route.request().postDataJSON()); return route.fulfill({ status: 400, json: { message: 'Fixture captured send' } }); });
    return { ctx, page, errors, sent };
  };
  const autoText = (page, id) => page.locator('#' + id + ' option[value=""]').textContent();
  const send = async (r, text) => {
    const n = r.sent.length;
    await r.page.locator('#prompt').fill(text);
    await r.page.locator('#prompt').press('Enter');
    for (let i = 0; i < 50 && r.sent.length === n; i++) await r.page.waitForTimeout(100);
    assert.equal(r.sent.length, n + 1, 'send reached the route');
    return r.sent[n];
  };

  // (a) No picker: the old Auto labels, and Auto sends the house default.
  const desk = { width: 1280, height: 800 };
  let r = await open(desk);
  let mo = await autoText(r.page, 'model'), eo = await autoText(r.page, 'effort');
  assert.ok(mo.startsWith('Auto'), 'model Auto label: ' + mo);
  assert.ok(!/picks/.test(mo), 'no picker named without a picker: ' + mo);
  assert.ok(!/picks/.test(eo), 'no picker named on effort without a picker: ' + eo);
  await pickRun(r.page, 'model', '');
  await pickRun(r.page, 'effort', '');
  let b = await send(r, 'No picker, auto');
  assert.equal(b.model, 'sonnet', 'no picker: Auto posts the house default');
  assert.equal('effort' in b, false, 'no picker: Auto effort not posted');

  // (b) Jev on through the helper menu: Auto names Jev and posts '' / ''.
  await r.page.locator('#helperBtn').click();
  await r.page.waitForFunction(() => !document.querySelector('#helperMenu [data-value=jev]').disabled);
  await r.page.locator('#helperMenu [data-value=jev]').click();
  await r.page.waitForFunction(() => !document.getElementById('helperMenu').hasAttribute('aria-busy'));
  await r.page.keyboard.press('Escape');
  assert.equal(await autoText(r.page, 'model'), 'Jev picks');
  assert.equal(await autoText(r.page, 'effort'), 'Jev picks');
  assert.equal(await r.page.locator('#model').inputValue(), '');
  // The model · effort popover names the picker on its Auto row and segment.
  await r.page.locator('#prompt').click(); await r.page.locator('#runChip').click();
  assert.equal(await r.page.locator('#runMenu [data-run=model][data-value=""] .hi-title').textContent(), 'Jev picks');
  assert.match(await r.page.locator('#runMenu [data-run=model][data-value=""] .hi-desc').textContent(), /Chosen per turn, starting from Sonnet/);
  assert.equal(await r.page.locator('#runMenu [data-run=effort][data-value=""]').textContent(), 'Jev');
  await r.page.waitForTimeout(300); await r.page.screenshot({ path: '/tmp/jev-auto-popover.png' });
  await r.page.keyboard.press('Escape');
  b = await send(r, 'Jev, auto');
  assert.equal(b.model, '', 'Jev on: Auto model posted as empty');
  assert.equal(b.effort, '', 'Jev on: Auto effort posted as empty');

  // (c) An explicit pick with Jev on still posts that model.
  await pickRun(r.page, 'model', 'opus');
  b = await send(r, 'Jev, opus');
  assert.equal(b.model, 'opus', 'explicit model kept with Jev on');
  await pickRun(r.page, 'model', '');

  // (d) Decision cards for picks made on Auto.
  const cards = r.page.locator('.advcard.decision');
  await cards.first().waitFor();
  const texts = await cards.allTextContents();
  const made = texts.find((t) => /Auto · its pick/.test(t)), failed = texts.find((t) => /No pick · Auto fallback/.test(t));
  assert.ok(made, 'made pick on Auto: ' + JSON.stringify(texts));
  assert.match(made, /haiku · Low/i, 'made pick shows what it ran on');
  assert.ok(failed, 'failed pick on Auto: ' + JSON.stringify(texts));
  assert.match(failed, /Sonnet/i, 'failed pick still shows the ran-on chip');

  // Switching the picker off restores the old labels.
  assert.deepEqual(r.errors, []);
  await r.ctx.close();
  await setHelpers({ router: '' });
  r = await open(desk);
  assert.equal(await autoText(r.page, 'model'), mo, 'model label back without a picker');
  assert.equal(await autoText(r.page, 'effort'), eo, 'effort label back without a picker');
  assert.deepEqual(r.errors, []);
  await r.ctx.close();

  // Layout with the longer label, desktop and phone.
  await setHelpers({ router: 'jev' });
  for (const [vp, shot] of [[desk, '/tmp/jev-auto-desktop.png'], [{ width: 390, height: 844 }, '/tmp/jev-auto-phone.png']]) {
    r = await open(vp);
    await r.page.waitForFunction(() => document.querySelector('#model option[value=""]').textContent === 'Jev picks');
    const boxes = await r.page.evaluate(() => ['runChip', 'helperBtn', 'prompt'].map((id) => { const e = document.getElementById(id), b = e.getBoundingClientRect(); return { id, left: b.left, right: b.right, top: b.top, bottom: b.bottom, scroll: e.scrollWidth, client: e.clientWidth }; }));
    for (const x of boxes) assert.ok(x.left >= 0 && x.right <= vp.width + 0.5, x.id + ' on screen at ' + vp.width + ': ' + JSON.stringify(x));
    console.log('layout ' + vp.width + ': ' + JSON.stringify(boxes));
    await r.page.screenshot({ path: shot });
    assert.deepEqual(r.errors, []);
    await r.ctx.close();
  }
  await browser.close();
  console.log('PASS jev auto: no picker keeps the old Auto labels and posts sonnet; Jev on relabels both Auto options and posts model/effort as empty; an explicit model still posts; Auto decision cards read "Auto · its pick" / "No pick · Auto fallback" with the ran-on chip; labels restore when the picker is off; composer on screen at 1280 and 390');
})().catch((e) => { console.error(e); process.exit(1); });
