// The model/effort picker's lean (Low / Medium / High) in the helper menu.
// Start fixture.ts first (with X056_PROJECT_SPACES_ENABLED=1 X056_CHAT_ENABLED=1).
// Never sends a chat message: a turn would call the real Jev API.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8860';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await browser.newContext();
  const api = async (p) => (await req.request.get(base + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const project = (await api('/api/projects')).projects.find((p) => p.name === 'Website refresh');
  const conv = project.conversations.find((c) => c.title === 'Build the new homepage');
  const transcript = execSync(`find /tmp -path '*primary/projects/fixture/${conv.sessionId}.jsonl' | head -1`).toString().trim();
  const stateDir = path.join(transcript.split('/primary/')[0], 'state');
  // A fake key, so Jev is offered. Nothing here calls it.
  fs.mkdirSync(path.join(stateDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'fake' }));
  const helpersNow = async () => ((await api('/api/projects')).projects.find((p) => p.id === project.id).conversations.find((c) => c.sessionId === conv.sessionId).helpers) || {};

  const open = async (ctx) => {
    await ctx.addInitScript(() => localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'));
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base); await page.waitForSelector('.cr-task');
    await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).first().click();
    await page.waitForFunction(() => !document.getElementById('helperBtn').disabled);
    await page.locator('#prompt').click(); // the composer rests as one line; focus opens its controls
    await page.locator('#helperBtn').click();
    await page.waitForFunction(() => !document.querySelector('#helperMenu [data-value=jev]').disabled);
    return { page, errors };
  };
  const onScreen = async (page, vp) => {
    await page.waitForTimeout(300); // phones open it as a sheet that slides up
    const box = await page.locator('#helperMenu').boundingBox();
    assert.ok(box && box.y >= 0 && box.x >= 0 && box.x + box.width <= vp.width && box.y + box.height <= vp.height, 'menu fully visible at ' + vp.width);
    const lean = await page.locator('#helperLean').boundingBox();
    assert.ok(lean && lean.y >= box.y && lean.y + lean.height <= box.y + box.height + 0.5, 'lean row inside the menu');
  };
  const saved = (page) => page.waitForFunction(() => !document.getElementById('helperMenu').hasAttribute('aria-busy'));

  // Desktop: the whole flow.
  const desk = { width: 1280, height: 900 };
  const ctx = await browser.newContext({ viewport: desk });
  const { page, errors } = await open(ctx);
  const lean = page.locator('#helperLean');
  assert.equal(await lean.isHidden(), true, 'no lean with "Your choice"');
  await page.locator('#helperMenu [data-value=jev]').click(); await saved(page);
  assert.equal(await lean.isVisible(), true, 'lean shown once Jev is on');
  assert.equal(await page.locator('#helperLean [data-lean=medium]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#helperLeanCap').textContent(), 'Balanced between cost and result.');
  assert.equal(await page.locator('#helperLabel').textContent(), 'Jev');
  // Keyboard: Right from Medium moves to High and saves it.
  await page.locator('#helperLean [data-lean=medium]').focus();
  await page.keyboard.press('ArrowRight'); await saved(page);
  assert.equal(await page.locator('#helperLean [data-lean=high]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.lean), 'high');
  assert.equal(await page.locator('#helperLeanCap').textContent(), 'Errs toward the best result.');
  assert.equal((await helpersNow()).lean, 'high');
  assert.equal(await page.locator('#helperLabel').textContent(), 'Jev · High');
  assert.equal(await page.locator('#helperMenu').isVisible(), true, 'arrow keys did not close the menu');
  await onScreen(page, desk);
  await page.screenshot({ path: '/tmp/x056-jev-lean-desktop.png' });
  // Toggling another helper posts the full set: the lean survives.
  await page.locator('#helperMenu [data-kind=advisor]').click(); await saved(page);
  const h1 = await helpersNow();
  assert.equal(h1.advisor, true); assert.equal(h1.router, 'jev'); assert.equal(h1.lean, 'high', 'lean kept across an Advisor toggle');
  assert.equal(await page.locator('#helperLabel').textContent(), 'Advisor · Jev · High');
  // Up/Down still walk the menu from the lean control.
  await page.locator('#helperLean [data-lean=high]').focus();
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'jev', 'ArrowUp from the lean goes to the last router item');
  // Back to Medium by click: lean cleared.
  await page.locator('#helperLean [data-lean=medium]').click(); await saved(page);
  assert.equal('lean' in (await helpersNow()), false, 'medium clears the lean');
  assert.equal(await page.locator('#helperLabel').textContent(), 'Advisor · Jev');
  // Low, then "Your choice" hides the row; Escape closes the menu from the lean control.
  await page.locator('#helperLean [data-lean=low]').click(); await saved(page);
  assert.equal(await page.locator('#helperLabel').textContent(), 'Advisor · Jev · Low');
  assert.equal(await page.locator('#helperLeanCap').textContent(), 'Errs toward cheaper models and lower effort.');
  await page.locator('#helperLean [data-lean=low]').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#helperMenu').isHidden(), true, 'Escape closes the menu');
  await page.locator('#helperBtn').click();
  await page.locator('#helperMenu [data-kind=router][data-value=""]').click(); await saved(page);
  assert.equal(await lean.isHidden(), true, 'lean hidden again with "Your choice"');
  assert.equal(await page.locator('#helperLabel').textContent(), 'Advisor');
  assert.deepEqual(errors, []);
  await ctx.close();

  // Set Jev + High for the phone and dark screenshots.
  await req.request.post(base + '/api/conversations/helpers', { headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, data: { projectId: project.id, sessionId: conv.sessionId, advisor: false, team: false, router: 'jev', lean: 'high' } });
  assert.equal((await helpersNow()).lean, 'high');
  const phone = { width: 390, height: 844 };
  for (const [vp, scheme, shot] of [[phone, 'light', '/tmp/x056-jev-lean-phone.png'], [desk, 'dark', '/tmp/x056-jev-lean-dark.png']]) {
    const c = await browser.newContext({ viewport: vp, colorScheme: scheme });
    const r = await open(c);
    assert.equal(await r.page.locator('#helperLean').isVisible(), true);
    assert.equal(await r.page.locator('#helperLabel').textContent(), 'Jev · High');
    await onScreen(r.page, vp);
    await r.page.screenshot({ path: shot });
    assert.deepEqual(r.errors, []);
    await c.close();
  }
  await browser.close();
  console.log('PASS jev lean: row only with a picker, Low/Medium/High save by click and arrow keys, lean survives an Advisor toggle, medium clears it, pill shows the lean, menu on screen at 1280 and 390, Escape closes');
})().catch((e) => { console.error(e); process.exit(1); });
