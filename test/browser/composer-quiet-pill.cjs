// The quiet pill: the composer rests as one line and opens into the full pill
// (+ menu, helpers, model·effort chip) on focus, text, files or an open menu.
// Start fixture.ts first (X056_PROJECT_SPACES_ENABLED=1 X056_CHAT_ENABLED=1), then:
//   node test/browser/composer-quiet-pill.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const TOKEN = 'browser-fixture-token-0123456789';
const shots = '/tmp/x056-composer-quiet-pill'; fs.mkdirSync(shots, { recursive: true });

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await playwright.request.newContext();
  const api = async (path, body) => {
    const r = await req.fetch(base + '/api/' + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + TOKEN }, data: body });
    assert.ok(r.ok(), path + ': ' + await r.text()); return r.json();
  };
  const { projects } = await api('projects');
  const work = projects.find((p) => p.kind !== 'chat' && p.conversations?.length);
  const conv = work.conversations[0];
  const workUrl = base + '/work/' + encodeURIComponent(work.id) + '/' + encodeURIComponent(conv.sessionId);

  const open = async (vp, theme = 'dark', url = workUrl, extra) => {
    const ctx = await browser.newContext({ viewport: vp, ...(extra || {}) });
    await ctx.addInitScript(([t, th]) => {
      localStorage.setItem('x056_token', t); localStorage.setItem('x056_theme', th);
      // Keep a handle on the live stream so a test can say "a turn is running".
      const Original = EventSource; window.EventSource = class extends Original { constructor(...a) { super(...a); window.__source = this; } };
    }, [TOKEN, theme]);
    // Four Claude accounts at four usage levels (+ one never checked), so the
    // account popover shows every meter colour. Codex reports fractions.
    await ctx.route('**/api/accounts', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch(), list = await res.json(), later = Math.floor(Date.now() / 1000) + 7200;
      const q = (five, seven) => ({ fiveHour: { utilization: five, resetsAt: new Date(Date.now() + 3600e3).toISOString() }, sevenDay: { utilization: seven, resetsAt: new Date(Date.now() + 86400e3).toISOString() } });
      const primary = list.find((a) => a.name === 'primary');
      if (primary) primary.quota = q(34, 12);
      const clone = (name, email, quota, state) => ({ ...primary, name, displayName: name, label: '', email, quota, quotaError: undefined, quotaStale: false, state: state || { kind: 'ok' }, nextUp: false });
      if (primary) list.push(clone('mid', 'mid@example.test', q(20, 64)), clone('high', 'high@example.test', q(91, 40)), clone('fresh', 'fresh@example.test', undefined));
      const backup = list.find((a) => a.name === 'backup');
      if (backup) { backup.quota = q(100, 70); backup.state = { kind: 'limited', until: later }; }
      route.fulfill({ response: res, json: list });
    });
    // A ChatGPT catalog (the fixture account has none): one model with its own
    // description and X-high, one without either.
    await ctx.route('**/api/models', (route) => route.fulfill({ json: { codex: [
      { slug: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Catalog text: strongest for long multi-step work', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
      { slug: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    ] } }));
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.locator('#prompt').waitFor();
    await page.waitForFunction(() => !document.getElementById('helperBtn').disabled);
    return { ctx, page, errors };
  };
  const isOpen = (page) => page.evaluate(() => document.querySelector('.composer-wrap').hasAttribute('data-qp-open'));
  const blur = async (page) => { await page.locator('#chat').click({ position: { x: 5, y: 5 } }); await page.waitForTimeout(60); };
  const running = (page, active) => page.evaluate(([pid, sid, a]) => window.__source.dispatchEvent(new MessageEvent('turn_state', { data: JSON.stringify({ data: { projectId: pid, sessionId: sid, active: a } }) })), [work.id, conv.sessionId, active]);
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  // ---- rest and open, desktop ----
  let r = await open({ width: 1440, height: 900 });
  let { page } = r;
  await page.evaluate(() => { document.getElementById('prompt').value = ''; document.getElementById('prompt').dispatchEvent(new Event('input')); document.activeElement?.blur(); });
  await blur(page);
  assert.equal(await isOpen(page), false, 'rests as one line');
  assert.equal(await page.locator('#runChip').isHidden(), true, 'model · effort chip hidden at rest');
  assert.equal(await page.locator('#composerPlusBtn').isHidden(), true, '+ hidden at rest');
  assert.equal(await page.locator('#sendBtn').isVisible(), true, 'send visible at rest');
  assert.match(await page.locator('#composerCaption').textContent(), / · /, 'caption names model · effort');
  assert.equal(await page.locator('#composerHint').evaluate((e) => e.getBoundingClientRect().height <= 1), true, 'hint visually hidden');
  const rest = await page.locator('.composer').boundingBox(), sendRest = await page.locator('#sendBtn').boundingBox();
  assert.ok(rest.height < 60, 'one line at rest: ' + rest.height);
  // The composer keeps its cap and centring.
  const dims = await page.locator('.composer').evaluate((e) => { const b = e.getBoundingClientRect(), p = e.parentElement, pr = p.getBoundingClientRect(), s = getComputedStyle(p); return { left: b.left - pr.left - parseFloat(s.paddingLeft), right: pr.right - b.right - parseFloat(s.paddingRight), width: b.width, available: p.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) }; });
  assert.ok(Math.abs(dims.width - Math.min(780, dims.available)) < 2 && Math.abs(dims.left - dims.right) < 2, JSON.stringify(dims));
  await page.screenshot({ path: shots + '/rest-dark-1440.png' });

  await page.locator('#prompt').click();
  assert.equal(await isOpen(page), true, 'focus opens the pill');
  for (const id of ['#composerPlusBtn', '#helperBtn', '#runChip']) assert.equal(await page.locator(id).isVisible(), true, id + ' visible when open');
  const sendOpen = await page.locator('#sendBtn').boundingBox();
  assert.ok(Math.abs(sendOpen.x - sendRest.x) < 1 && Math.abs(sendOpen.y - sendRest.y) < 1, 'send does not move between rest and open');
  // One chip opens the model · effort popover; the native selects stay hidden as the source of truth.
  assert.equal(await page.locator('#composerRunChip select#model').count(), 1);
  assert.equal(await page.locator('#model').isHidden(), true, 'native model select hidden');
  await page.locator('#runChip').click();
  assert.equal(await page.locator('#runMenu').isVisible(), true, 'model popover opens');
  const options = await page.locator('#model option').evaluateAll((os) => os.map((o) => o.value));
  const rows = await page.locator('#runMenu [data-run=model]').evaluateAll((bs) => bs.map((b) => b.dataset.value));
  assert.deepEqual(rows, options, 'one row per #model option, in order');
  assert.match(await page.locator('#runMenu [data-run=model][data-value=opus] .hi-desc').textContent(), /\w/, 'known models carry a description');
  assert.equal(await page.locator('#runMenu [data-run=model][data-value=""] .hi-title').textContent(), 'Auto');
  const effortSegs = await page.locator('#runMenu .cp-seg [data-run=effort]').evaluateAll((bs) => bs.map((b) => b.dataset.value));
  assert.deepEqual(effortSegs, await page.locator('#effort option').evaluateAll((os) => os.map((o) => o.value)), 'one segment per #effort option');
  assert.ok(effortSegs.includes('ultracode'), 'Ultracode on Claude');
  await page.locator('#runMenu [data-run=model][data-value=opus]').click();
  assert.equal(await page.locator('#model').inputValue(), 'opus', 'a row sets #model');
  assert.equal(await page.locator('#runMenu [data-run=model][data-value=opus]').getAttribute('aria-checked'), 'true');
  await page.locator('#runMenu [data-run=effort][data-value=high]').click();
  assert.equal(await page.locator('#effort').inputValue(), 'high', 'a segment sets #effort');
  assert.equal(await page.locator('#runMenu [data-run=effort][data-value=high]').getAttribute('aria-checked'), 'true');
  assert.equal(await isOpen(page), true, 'still open after two selections');
  assert.match(await page.locator('#runChipLabel').textContent(), /Opus 5\.5 · High/);
  // Keyboard: arrows walk the rows, Left/Right move the effort, Escape returns to the chip.
  await page.locator('#runMenu [data-run=model][data-value=opus]').focus();
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.value), 'sonnet', 'ArrowDown moves to the next model');
  await page.locator('#runMenu [data-run=effort][data-value=high]').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#effort').inputValue(), 'medium', 'ArrowLeft picks the previous effort');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#effort').inputValue(), 'high');
  await page.waitForTimeout(300); await page.screenshot({ path: shots + '/pop-model-dark-1440.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#runMenu').isHidden(), true, 'Escape closes the model popover');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'runChip', 'focus returns to the chip');
  assert.equal(await isOpen(page), true, 'the pill stays open');
  await page.locator('#runChip').click(); await blur(page);
  assert.equal(await page.locator('#runMenu').isHidden(), true, 'outside click closes the model popover');

  // The account popover: one row per Claude account, a meter coloured by level.
  await page.locator('#prompt').click();
  await page.locator('#sendAccountChip').click();
  assert.equal(await page.locator('#sendAccountPicker').isVisible(), true, 'account popover opens');
  assert.equal(await isOpen(page), true, 'the account popover keeps the pill open');
  assert.equal(await page.locator('#sendAccountPicker [data-send-next=chatgpt]').count(), 0, 'provider pools stay separate');
  const levels = await page.locator('#sendAccountPicker [data-send-next]').evaluateAll((bs) => Object.fromEntries(bs.map((b) => [b.dataset.sendNext, { level: b.querySelector('.acct-usage').dataset.level, text: b.textContent.replace(/\s+/g, ' ').trim(), disabled: b.disabled }])));
  assert.equal(levels.primary.level, 'ok'); assert.match(levels.primary.text, /34% of the 5-hour limit used/);
  assert.equal(levels.mid.level, 'mid'); assert.match(levels.mid.text, /64% of the weekly limit used/);
  assert.equal(levels.high.level, 'high'); assert.match(levels.high.text, /91%/);
  assert.equal(levels.backup.level, 'limit'); assert.match(levels.backup.text, /Limit reached · resets/); assert.equal(levels.backup.disabled, true);
  assert.equal(levels.fresh.level, 'unknown'); assert.match(levels.fresh.text, /Usage not checked/);
  const colour = (sel) => page.locator(sel).evaluate((e) => getComputedStyle(e).color);
  assert.notEqual(await colour('[data-send-next=primary] .acct-pct'), await colour('[data-send-next=high] .acct-pct'), 'levels differ in colour');
  assert.equal(await page.locator('#sendAccountChip .acct-dot').getAttribute('data-level'), 'ok', 'the chip carries the level dot');
  assert.match(await page.locator('#sendAccountPicker').textContent(), /fails over to the next one/);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.sendNext), 'mid', 'ArrowDown moves between accounts');
  await page.waitForTimeout(300); await page.screenshot({ path: shots + '/pop-account-dark-1440.png' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sendAccountPicker').isHidden(), true, 'Escape closes the account popover');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sendAccountChip', 'focus returns to the account chip');
  await page.locator('#sendAccountChip').click(); await blur(page);
  assert.equal(await page.locator('#sendAccountPicker').isHidden(), true, 'outside click closes it');
  await page.locator('#prompt').click();
  await page.locator('#helperBtn').click();
  await page.waitForTimeout(300); await page.screenshot({ path: shots + '/pop-helpers-dark-1440.png' });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: shots + '/open-dark-1440.png' });

  // Empty and focus gone: folds. Text keeps it open after focus leaves.
  await blur(page);
  assert.equal(await isOpen(page), false, 'empty and unfocused folds back');
  assert.match(await page.locator('#composerCaption').textContent(), /Opus 5\.5 · High/);
  await page.locator('#composerCaption').click();
  assert.equal(await isOpen(page), true, 'the caption opens the pill');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.run), 'model', 'and lands on the model list');
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('A draft that stays');
  await blur(page);
  assert.equal(await isOpen(page), true, 'text keeps it open');

  // A saved draft opens it on load.
  await page.waitForTimeout(100); await page.reload(); await page.locator('#prompt').waitFor();
  await page.waitForFunction(() => document.getElementById('prompt').value === 'A draft that stays');
  assert.equal(await isOpen(page), true, 'a saved draft does not start collapsed');
  await page.locator('#prompt').fill(''); await blur(page);
  assert.equal(await isOpen(page), false);

  // Files keep it open; at rest the pill shows a paperclip count.
  await page.locator('#file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('quiet pill') });
  await page.locator('#attachRow .chip').waitFor();
  await blur(page);
  assert.equal(await isOpen(page), true, 'an attachment keeps it open');
  assert.equal(await page.locator('#attachRow .chip').isVisible(), true);
  await page.locator('#attachRow .chip button').click();
  await blur(page);
  assert.equal(await isOpen(page), false, 'removing the file lets it fold');

  // + menu: attach, template (Alt+T), and no reference outside a chat.
  await page.locator('#prompt').click();
  await page.locator('#composerPlusBtn').click();
  assert.equal(await page.locator('#composerPlusMenu').isVisible(), true);
  assert.equal(await page.locator('#attachBtn').isVisible(), true);
  assert.equal(await page.locator('#tplBtn').isVisible(), true);
  assert.equal(await page.locator('#composerRefItem').isHidden(), true, 'reference is chat-only');
  const menu = await page.locator('#composerPlusMenu').boundingBox();
  assert.ok(menu.y >= 0 && menu.x >= 0 && menu.x + menu.width <= 1440, 'menu on screen');
  await blur(page);
  assert.equal(await page.locator('#composerPlusMenu').isHidden(), true, 'outside click closes the + menu');
  await page.locator('#prompt').click(); await page.locator('#composerPlusBtn').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#attachBtn').click();
  await (await chooser).setFiles({ name: 'picked.txt', mimeType: 'text/plain', buffer: Buffer.from('picked') });
  await page.locator('#attachRow .chip').filter({ hasText: 'picked.txt' }).waitFor();
  await page.locator('#attachRow .chip button').click();
  await page.locator('#prompt').click(); await page.locator('#composerPlusBtn').click();
  await page.locator('#tplBtn').click();
  await page.locator('#tplPop').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await blur(page);

  // ---- a running turn: Stop when empty, Steer + Queue with text ----
  await running(page, true);
  await page.waitForFunction(() => document.querySelector('.composer-wrap').hasAttribute('data-qp-run'));
  assert.equal(await isOpen(page), false, 'rests while running');
  assert.equal(await page.locator('#composerStopBtn').isVisible(), true, 'send is Stop when empty');
  assert.equal(await page.locator('#sendBtn').isHidden(), true);
  assert.equal(await page.locator('#steerBtn').isHidden(), true);
  assert.equal(await page.locator('#busy .spin').isVisible(), true, 'status on the quiet line');
  const stop = await page.locator('#composerStopBtn').boundingBox();
  assert.ok(Math.abs(stop.x - sendRest.x) < 1 && Math.abs(stop.y - sendRest.y) < 1, 'Stop takes send\'s place ' + JSON.stringify([stop, sendRest]));
  await page.screenshot({ path: shots + '/running-dark-1440.png' });
  await page.locator('#prompt').fill('also check the footer');
  assert.equal(await page.locator('#steerBtn').isVisible(), true, 'Steer with text while running');
  assert.equal(await page.locator('#sendBtn').isVisible(), true, 'Queue with text while running');
  assert.equal(await page.locator('#composerStopBtn').isHidden(), true);
  assert.match(await page.locator('#sendBtn').getAttribute('title'), /Queue/);
  assert.equal(await page.locator('#busy .stopbtn').isVisible(), true, 'Stop stays reachable on the status line');
  await page.screenshot({ path: shots + '/running-text-dark-1440.png' });
  await page.locator('#prompt').fill('');
  assert.equal(await page.locator('#composerStopBtn').isVisible(), true, 'cleared: Stop again');
  let stopped = false;
  await page.route('**/api/sessions/current/stop', (route) => { stopped = true; return route.fulfill({ json: { ok: true } }); });
  await page.locator('#composerStopBtn').click();
  await page.waitForFunction(() => true); assert.equal(stopped, true, 'Stop calls the same stop as #busy');
  await running(page, false);
  await page.waitForFunction(() => !document.querySelector('.composer-wrap').hasAttribute('data-qp-run'));
  assert.equal(await page.locator('#sendBtn').isVisible(), true);

  // The delivery dot shares the quiet line with the account, centred on it.
  await page.route('**/api/sessions/current/messages', (route) => route.fulfill({ status: 400, json: { message: 'Fixture captured send' } }));
  await page.locator('#prompt').fill('Not delivered on purpose');
  await page.locator('#prompt').press('Enter');
  await page.waitForFunction(() => document.querySelector('#deliveryStrip').textContent.includes('Not sent'));
  await blur(page);
  const footer = await page.locator('.composer-footer').boundingBox(), chipBox = await page.locator('#sendAccountChip').boundingBox(), deliv = await page.locator('#deliveryStrip').boundingBox();
  assert.ok(footer.height < 55, 'footer is one line: ' + footer.height);
  assert.ok(Math.abs(chipBox.y + chipBox.height / 2 - (deliv.y + deliv.height / 2)) < 10, 'account and delivery on one line');
  assert.equal(await page.locator('#deliveryStrip button').isVisible(), true);
  await page.screenshot({ path: shots + '/delivery-dark-1440.png' });
  await page.locator('#deliveryStrip button').click();
  await page.locator('.delivery-item').first().waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(r.errors, []);
  await r.ctx.close();

  // ---- light theme, and phones ----
  for (const [vp, theme, mobile] of [[{ width: 1440, height: 900 }, 'light', false], [{ width: 1024, height: 800 }, 'dark', false], [{ width: 768, height: 900 }, 'dark', false], [{ width: 390, height: 844 }, 'dark', true], [{ width: 390, height: 844 }, 'light', true], [{ width: 320, height: 640 }, 'dark', true]]) {
    r = await open(vp, theme, workUrl, mobile ? { hasTouch: true, isMobile: true } : undefined); page = r.page;
    await page.evaluate(() => { const p = document.getElementById('prompt'); p.value = ''; p.dispatchEvent(new Event('input')); p.blur(); });
    await blur(page);
    const tag = theme + '-' + vp.width;
    assert.equal(await isOpen(page), false);
    assert.equal(await noOverflow(page), true, 'no overflow at rest ' + tag);
    const f = await page.locator('.composer-footer').boundingBox(), chip = await page.locator('#sendAccountChip').boundingBox();
    assert.ok(f.height < 55, 'footer one line ' + tag);
    assert.ok(chip.x + chip.width <= vp.width, 'account chip on screen ' + tag);
    await page.screenshot({ path: shots + '/rest-' + tag + '.png' });
    await page.locator('#prompt').click();
    assert.equal(await isOpen(page), true);
    assert.equal(await noOverflow(page), true, 'no overflow open ' + tag);
    for (const id of ['#composerPlusBtn', '#helperBtn', '#runChip', '#sendBtn']) {
      const b = await page.locator(id).boundingBox();
      assert.ok(b && b.x >= 0 && b.x + b.width <= vp.width + 0.5, id + ' on screen ' + tag + ' ' + JSON.stringify(b));
    }
    if (vp.width < 720) assert.equal(await page.locator('#prompt').evaluate((e) => getComputedStyle(e).fontSize), '16px', 'no iOS zoom on focus');
    await page.screenshot({ path: shots + '/open-' + tag + '.png' });
    await page.locator('#helperBtn').click();
    const hm = await page.locator('#helperMenu').boundingBox();
    assert.ok(hm && hm.y >= 0 && hm.x >= 0 && hm.x + hm.width <= vp.width && hm.height > 150, 'helper menu on screen ' + tag);
    await page.waitForTimeout(300); await page.screenshot({ path: shots + '/pop-helpers-' + tag + '.png' });
    await page.keyboard.press('Escape');
    assert.equal(await isOpen(page), true, 'Escape from the helpers keeps the pill open');
    for (const [chip, pop, name] of [['#runChip', '#runMenu', 'model'], ['#sendAccountChip', '#sendAccountPicker', 'account']]) {
      await page.locator(chip).click();
      await page.waitForTimeout(300); // let the open animation settle before measuring
      const pb = await page.locator(pop).boundingBox();
      assert.ok(pb && pb.y >= 0 && pb.x >= 0 && pb.x + pb.width <= vp.width + 0.5 && pb.y + pb.height <= vp.height + 0.5, name + ' popover on screen ' + tag + ' ' + JSON.stringify(pb));
      assert.equal(await isOpen(page), true, name + ' popover keeps the pill open ' + tag);
      assert.equal(await noOverflow(page), true, 'no overflow with the ' + name + ' popover ' + tag);
      await page.screenshot({ path: shots + '/pop-' + name + '-' + tag + '.png' });
      await page.keyboard.press('Escape');
      assert.equal(await page.locator(pop).isHidden(), true, name + ' popover closes ' + tag);
    }
    await page.locator('#prompt').fill('Queue this');
    await running(page, true);
    await page.locator('#steerBtn').waitFor();
    assert.equal(await noOverflow(page), true, 'no overflow running with text ' + tag);
    const steerB = await page.locator('#steerBtn').boundingBox(), sendB = await page.locator('#sendBtn').boundingBox();
    assert.ok(steerB.x >= 0 && sendB.x + sendB.width <= vp.width, 'steer + queue on screen ' + tag);
    await page.screenshot({ path: shots + '/running-text-' + tag + '.png' });
    await page.locator('#prompt').fill(''); await blur(page);
    await page.screenshot({ path: shots + '/running-' + tag + '.png' });
    await running(page, false);
    assert.deepEqual(r.errors, []);
    await r.ctx.close();
  }

  // ---- chat mode: the + menu offers a conversation reference ----
  const chat = await api('chats', { requestId: require('node:crypto').randomUUID(), name: 'Quiet pill chat', provider: 'claude' });
  r = await open({ width: 1440, height: 900 }, 'dark', base + '/chat/' + encodeURIComponent(chat.id)); page = r.page;
  await page.waitForSelector('body.rc-chat-active');
  await page.locator('#prompt').click(); await page.locator('#composerPlusBtn').click();
  assert.equal(await page.locator('#composerRefItem').isVisible(), true, 'reference offered in a chat');
  await page.screenshot({ path: shots + '/chat-open-dark-1440.png' });
  await page.locator('#composerRefItem').click();
  await page.locator('.rc-reference-picker').waitFor();
  await page.keyboard.press('Escape');
  await blur(page);
  await page.screenshot({ path: shots + '/chat-rest-dark-1440.png' });
  assert.deepEqual(r.errors, []);
  await r.ctx.close();

  // ---- ChatGPT: rows from the catalog, and a model pick refills the effort in place ----
  const codexChat = await api('chats', { requestId: require('node:crypto').randomUUID(), name: 'Quiet pill ChatGPT', provider: 'codex' });
  r = await open({ width: 1440, height: 900 }, 'dark', base + '/chat/' + encodeURIComponent(codexChat.id)); page = r.page;
  await page.waitForSelector('body.rc-chat-active');
  await page.waitForFunction(() => document.querySelector('#model option[value="gpt-6-astra"]'));
  await page.locator('#prompt').click(); await page.locator('#runChip').click();
  assert.deepEqual(await page.locator('#runMenu [data-run=model]').evaluateAll((bs) => bs.map((b) => b.dataset.value)), ['', 'gpt-6-astra', 'gpt-5.6-terra']);
  assert.match(await page.locator('#runMenu .helper-head').first().textContent(), /catalog/);
  assert.equal(await page.locator('#runMenu [data-run=model][data-value="gpt-6-astra"] .hi-desc').textContent(), 'Catalog text: strongest for long multi-step work', 'the catalog description wins');
  await page.locator('#runMenu [data-run=model][data-value="gpt-6-astra"]').click();
  assert.equal(await page.locator('#runMenu [data-run=effort][data-value=ultracode]').count(), 0, 'no Ultracode on ChatGPT');
  await page.locator('#runMenu [data-run=effort][data-value=xhigh]').click();
  assert.equal(await page.locator('#effort').inputValue(), 'xhigh');
  await page.waitForTimeout(300); await page.screenshot({ path: shots + '/pop-model-codex-dark-1440.png' });
  await page.locator('#runMenu [data-run=model][data-value="gpt-5.6-terra"]').click();
  assert.deepEqual(await page.locator('#runMenu [data-run=effort]').evaluateAll((bs) => bs.map((b) => b.dataset.value)), await page.locator('#effort option').evaluateAll((os) => os.map((o) => o.value)), 'segments follow the refilled #effort');
  assert.equal(await page.locator('#runMenu [data-run=effort][data-value=xhigh]').count(), 0, 'Terra has no X-high');
  assert.equal(await page.locator('#runMenu').isVisible(), true, 'the popover stays open through the refill');
  assert.equal(await page.evaluate(() => document.getElementById('runMenu').contains(document.activeElement)), true, 'focus stays inside');
  await page.keyboard.press('Escape');
  assert.deepEqual(r.errors, []);
  await r.ctx.close();

  await browser.close();
  console.log('PASS quiet pill: rests as one line, opens on focus/text/files/draft/menu, folds only when empty and unfocused, send never moves, Stop when empty and Steer+Queue with text while running, + menu attach/template/reference, one chip opening the model · effort popover (rows from #model, segments from #effort), the account popover with level-coloured meters, desktop and phone in dark and light with no overflow');
})().catch((e) => { console.error(e); process.exit(1); });
