// Focus alone never opens the quiet pill. Opening a conversation puts the caret
// in #prompt; the composer must keep its one-line size through that and through
// the next clicks (chat, header, a header menu, the box itself), or every click
// is an expand/collapse flicker. Typing opens it, an empty box folds on blur,
// and the caption opens it without typing.
// Start fixture.ts first (X056_PROJECT_SPACES_ENABLED=1 X056_CHAT_ENABLED=1), then:
//   node test/browser/composer-quiet-focus.cjs http://127.0.0.1:<port>
// Screenshots land in /tmp/composer-*.png.
const assert = require('node:assert/strict');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await playwright.request.newContext();
  const r = await req.fetch(base + '/api/projects', { headers: { Authorization: 'Bearer ' + TOKEN } });
  const { projects } = await r.json();
  const work = projects.find((p) => p.kind !== 'chat' && p.conversations?.length);
  const conv = work.conversations[0];
  const url = base + '/work/' + encodeURIComponent(work.id) + '/' + encodeURIComponent(conv.sessionId);

  const open = async (viewport, extra) => {
    const ctx = await browser.newContext({ viewport, ...(extra || {}) });
    await ctx.addInitScript((t) => {
      localStorage.setItem('x056_token', t); localStorage.setItem('x056_theme', 'dark');
      // Record every height change of .composer and every data-qp-open flip from
      // the moment they exist: a transient expand-then-collapse between two
      // samples would leave before/after equal and slip past a plain compare.
      window.__qpLog = [];
      const watch = () => {
        const box = document.querySelector('.composer'), wrap = document.querySelector('.composer-wrap');
        if (!box || !wrap) return false;
        new ResizeObserver(() => window.__qpLog.push({ t: performance.now(), kind: 'height', h: box.getBoundingClientRect().height })).observe(box);
        new MutationObserver(() => window.__qpLog.push({ t: performance.now(), kind: 'open', open: wrap.hasAttribute('data-qp-open') })).observe(wrap, { attributes: true, attributeFilter: ['data-qp-open'] });
        return true;
      };
      if (!watch()) { const mo = new MutationObserver(() => { if (watch()) mo.disconnect(); }); document.addEventListener('DOMContentLoaded', () => { if (!watch()) mo.observe(document.documentElement, { childList: true, subtree: true }); }); }
    }, TOKEN);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator('#prompt').waitFor();
    await page.waitForFunction(() => !document.getElementById('helperBtn').disabled);
    return { ctx, page, errors };
  };
  const height = (page) => page.locator('.composer').evaluate((e) => e.getBoundingClientRect().height);
  const isOpen = (page) => page.evaluate(() => document.querySelector('.composer-wrap').hasAttribute('data-qp-open'));
  const mark = (page) => page.evaluate(() => window.__qpLog.length);
  const since = (page, n) => page.evaluate((i) => window.__qpLog.slice(i), n);
  const settle = (page) => page.waitForTimeout(250);

  // ---- desktop: open a conversation, the caret is in the box, nothing moves ----
  let { ctx, page, errors } = await open({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'prompt', null, { timeout: 10000 });
  await settle(page);
  const opens = (await since(page, 0)).filter((e) => e.kind === 'open' && e.open);
  assert.deepEqual(opens, [], 'the auto-focus on open never opened the pill');
  assert.equal(await isOpen(page), false, 'focused and empty: still the quiet line');
  const rest = await height(page);
  assert.ok(rest < 60, 'one line at rest: ' + rest);
  assert.equal(await page.locator('#composerPlusBtn').isHidden(), true, '+ stays hidden while focused');
  assert.equal(await page.locator('#runChip').isHidden(), true, 'model chip stays hidden while focused');
  await page.screenshot({ path: '/tmp/composer-rest-focused-1440.png' });

  // Clicks elsewhere: chat, header, a header menu, then back into the box.
  const steps = [
    ['chat', async () => { await page.locator('#chat').click({ position: { x: 5, y: 5 } }); }],
    ['header', async () => {
      // An empty spot of the header bar (its title opens Rename).
      const pt = await page.evaluate(() => {
        const bar = document.querySelector('.focus-main > .topbar'), r = bar.getBoundingClientRect();
        for (let x = r.right - 4; x > r.left; x -= 6) for (const y of [r.top + 4, r.top + r.height / 2]) if (document.elementFromPoint(x, y) === bar) return { x, y };
        return null;
      });
      assert.ok(pt, 'an empty spot on the header');
      await page.mouse.click(pt.x, pt.y);
    }],
    ['header menu', async () => { await page.locator('#moreBtn').click(); await settle(page); await page.keyboard.press('Escape'); }],
    ['box', async () => { await page.locator('#prompt').click(); }],
  ];
  const measured = { rest };
  for (const [name, act] of steps) {
    const n = await mark(page);
    await act(); await settle(page);
    const log = await since(page, n);
    assert.deepEqual(log, [], 'no height change or open flip on a click on the ' + name + ': ' + JSON.stringify(log));
    measured[name] = await height(page);
    assert.equal(measured[name], rest, 'height after a click on the ' + name);
    if (name === 'chat') await page.screenshot({ path: '/tmp/composer-after-chat-click-1440.png' });
  }
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt', 'a click into the box puts the caret there');

  // Typing opens it at once.
  await page.keyboard.type('a');
  assert.equal(await isOpen(page), true, 'one letter opens the pill');
  measured.typed = await height(page);
  assert.ok(measured.typed > rest + 10, 'it grew: ' + measured.typed + ' vs ' + rest);
  for (const id of ['#composerPlusBtn', '#helperBtn', '#runChip']) assert.equal(await page.locator(id).isVisible(), true, id + ' visible once typing');
  await page.keyboard.type(' quick note');
  await settle(page);
  await page.screenshot({ path: '/tmp/composer-typed-1440.png' });

  // Emptied while focused: stays open (no fold under the caret); blur folds it.
  await page.locator('#prompt').fill('');
  assert.equal(await isOpen(page), true, 'emptied but focused: still open');
  await page.locator('#chat').click({ position: { x: 5, y: 5 } }); await settle(page);
  assert.equal(await isOpen(page), false, 'empty and blurred: folds');
  measured.folded = await height(page);
  assert.equal(measured.folded, rest, 'back to the resting height');

  // A programmatic write (template, reference, draft restore) opens it too.
  await page.evaluate(() => { document.getElementById('prompt').value = 'from a template'; });
  assert.equal(await isOpen(page), true, 'a programmatic value write opens it');
  await page.evaluate(() => { document.getElementById('prompt').value = ''; });
  await settle(page);
  assert.equal(await isOpen(page), false, 'and emptying it unfocused folds it');

  // The caption reaches the hidden controls without typing.
  assert.equal(await page.locator('#composerCaption').isVisible(), true, 'caption visible at rest');
  await page.locator('#composerCaption').click();
  assert.equal(await isOpen(page), true, 'the caption opens the pill');
  assert.equal(await page.locator('#runMenu').isVisible(), true, 'on the model · effort popover');
  await page.keyboard.press('Escape');
  assert.equal(await isOpen(page), true, 'Escape keeps the pill open');
  assert.equal(await page.locator('#composerPlusBtn').isVisible(), true, '+ reachable without typing');
  measured.caption = await height(page);
  assert.equal(await page.evaluate(() => document.getElementById('prompt').value), '', 'the text is untouched');
  await page.locator('#chat').click({ position: { x: 5, y: 5 } }); await settle(page);
  assert.equal(await isOpen(page), false, 'folds again on blur');

  // ⌥M still opens the model popover (and the pill) from the resting box.
  await page.locator('#prompt').click();
  await page.keyboard.press('Alt+KeyM');
  await page.locator('#runMenu').waitFor({ state: 'visible' });
  assert.equal(await isOpen(page), true, 'Alt+M opens the pill on the model popover');
  await page.keyboard.press('Escape');
  await page.locator('#chat').click({ position: { x: 5, y: 5 } }); await settle(page);

  // Send: the box is cleared while focus stays in it. The pill folds with the
  // send, not on the next click (that would be the same flicker, after every message).
  await page.locator('#prompt').click();
  await page.keyboard.type('Sent from the quiet focus test');
  assert.equal(await isOpen(page), true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('prompt').value === '');
  await settle(page);
  assert.equal(await isOpen(page), false, 'sending folds the pill');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt', 'the caret stays in the box after a send');
  measured.afterSend = await height(page);
  assert.equal(measured.afterSend, rest, 'back to the resting height after a send');
  const ns = await mark(page);
  await page.locator('#chat').click({ position: { x: 5, y: 5 } }); await settle(page);
  assert.deepEqual(await since(page, ns), [], 'the first click after a send changes nothing');
  // Let the fixture's turn finish: the caption hides while a turn runs.
  await page.waitForFunction(() => !document.querySelector('.composer-wrap').hasAttribute('data-qp-run'), null, { timeout: 30000 });
  assert.deepEqual(errors, []);
  await ctx.close();

  // ---- phone: a tap into the box keeps the quiet line ----
  ({ ctx, page, errors } = await open({ width: 390, height: 844 }, { hasTouch: true, isMobile: true }));
  await settle(page);
  const phoneRest = await height(page);
  await page.screenshot({ path: '/tmp/composer-rest-390.png' });
  const n = await mark(page);
  await page.locator('#prompt').tap(); await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'prompt', 'tap focuses the box');
  assert.deepEqual(await since(page, n), [], 'tap into the box: no height change, no open');
  assert.equal(await page.locator('#composerCaption').isVisible(), true, 'caption visible on a phone');
  await page.keyboard.type('a');
  assert.equal(await isOpen(page), true, 'typing opens it on a phone');
  measured.phoneRest = phoneRest; measured.phoneTyped = await height(page);
  assert.deepEqual(errors, []);
  await ctx.close();

  await browser.close();
  console.log('heights', JSON.stringify(measured));
  console.log('PASS composer quiet focus: auto-focus and clicks on the chat, header, a header menu and the box keep the one-line height (no resize, no open flip), typing or a value write opens it, empty + blur folds it, the caption and Alt+M open it without typing, phone tap stays quiet');
})().catch((e) => { console.error(e); process.exit(1); });
