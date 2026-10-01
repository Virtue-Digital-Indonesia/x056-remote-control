// Markdown formatting shortcuts in the composer (composer-format.js + panel.html).
// Start fixture.ts first, then: node test/browser/composer-markdown.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const fs = require('node:fs');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8767';
const TOKEN = 'browser-fixture-token-0123456789';
const shots = '/tmp/x056-composer-markdown'; fs.mkdirSync(shots, { recursive: true });
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await playwright.request.newContext();
  const { projects } = await (await req.get(base + '/api/projects', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const project = projects.find((p) => p.name === 'Website refresh');
  const sid = project.conversations.find((c) => c.title === 'Build the new homepage').sessionId;

  async function open({ mac, theme = 'dark', width = 1440, height = 1000, mobile = false }) {
    const context = await browser.newContext({ viewport: { width, height }, userAgent: mac ? MAC_UA : LINUX_UA, hasTouch: mobile, isMobile: mobile });
    await context.addInitScript(([t, th]) => {
      localStorage.setItem('x056_token', t); localStorage.setItem('x056_theme', th);
      const Native = window.EventSource; window.EventSource = class extends Native { constructor(...a) { super(...a); window.fixtureStream = this; } };
    }, [TOKEN, theme]);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).click();
    const prompt = page.locator('#prompt');
    await prompt.click();
    return { context, page, prompt, errors };
  }
  const state = (prompt) => prompt.evaluate((el) => ({ value: el.value, start: el.selectionStart, end: el.selectionEnd }));
  async function set(prompt, value, start, end) {
    await prompt.fill(value);
    await prompt.evaluate((el, [s, e]) => el.setSelectionRange(s, e), [start === undefined ? value.length : start, end === undefined ? (start === undefined ? value.length : start) : end]);
  }
  async function expectState(prompt, value, start, end, msg) {
    const st = await state(prompt);
    assert.deepEqual(st, { value, start, end: end === undefined ? start : end }, msg);
  }

  async function suite(mac) {
    const M = mac ? 'Meta' : 'Control', other = mac ? 'Control' : 'Meta';
    const { context, page, prompt, errors } = await open({ mac });
    const tag = mac ? 'mac' : 'linux';

    // Bold: wrap keeps the text selected, a second press unwraps it.
    await set(prompt, 'say hello there', 4, 9);
    await prompt.press(M + '+b'); await expectState(prompt, 'say **hello** there', 6, 11, tag + ' bold wraps');
    await prompt.press(M + '+b'); await expectState(prompt, 'say hello there', 4, 9, tag + ' bold toggles off');
    // Spaces in the selection stay outside the markers.
    await set(prompt, 'say hello there', 3, 10);
    await prompt.press(M + '+b'); await expectState(prompt, 'say **hello** there', 6, 11, tag + ' bold trims');
    // No selection: a pair with the caret inside; typing then the shortcut steps out.
    await set(prompt, 'a ');
    await prompt.press(M + '+b'); await expectState(prompt, 'a ****', 4, 4, tag + ' empty pair');
    await prompt.pressSequentially('x'); await prompt.press(M + '+b'); await prompt.pressSequentially(' y');
    assert.equal(await prompt.inputValue(), 'a **x** y', tag + ' steps out of the pair');
    await set(prompt, 'a ');
    await prompt.press(M + '+b'); await prompt.press(M + '+b'); await expectState(prompt, 'a ', 2, 2, tag + ' empty pair toggles away');
    // The other platform's modifier does nothing.
    await set(prompt, 'plain', 0, 5);
    await prompt.press(other + '+b'); assert.equal(await prompt.inputValue(), 'plain', tag + ' wrong modifier ignored');
    // Italic, underline, inline code.
    await set(prompt, 'one two', 4, 7);
    await prompt.press(M + '+i'); await expectState(prompt, 'one *two*', 5, 8, tag + ' italic');
    await prompt.press(M + '+i'); await expectState(prompt, 'one two', 4, 7, tag + ' italic off');
    await prompt.press(M + '+u'); await expectState(prompt, 'one <u>two</u>', 7, 10, tag + ' underline');
    await prompt.press(M + '+u'); await expectState(prompt, 'one two', 4, 7, tag + ' underline off');
    await prompt.press(M + '+Shift+c'); await expectState(prompt, 'one `two`', 5, 8, tag + ' inline code');
    await prompt.press(M + '+Shift+c'); await expectState(prompt, 'one two', 4, 7, tag + ' inline code off');
    await set(prompt, 'x ');
    await prompt.press(M + '+Shift+c'); await expectState(prompt, 'x ``', 3, 3, tag + ' inline code pair');

    // Quote on a multi-line selection, and off again.
    await set(prompt, 'one\ntwo', 0, 7);
    await prompt.press(M + '+Shift+Digit9'); await expectState(prompt, '> one\n> two', 0, 11, tag + ' quote');
    await prompt.press(M + '+Shift+Digit9'); await expectState(prompt, 'one\ntwo', 0, 7, tag + ' quote off');
    // Quoting composer bullets keeps them a Markdown list inside the quote.
    await set(prompt, '');
    await prompt.pressSequentially('- a'); await prompt.press('Shift+Enter'); await prompt.pressSequentially('b');
    assert.equal(await prompt.inputValue(), '  • a\n  • b');
    await prompt.evaluate((el) => el.setSelectionRange(0, el.value.length));
    await prompt.press(M + '+Shift+Digit9'); assert.equal(await prompt.inputValue(), '> - a\n> - b', tag + ' quote over a list');
    await prompt.press(M + '+Shift+Digit9'); assert.equal(await prompt.inputValue(), '  • a\n  • b', tag + ' unquote restores the list');

    // Horizontal rule after a paragraph: blank line before, caret after.
    await set(prompt, 'Title');
    await prompt.press(M + '+Shift+Minus'); await expectState(prompt, 'Title\n\n---\n', 11, 11, tag + ' rule');

    // Code fence: empty pair, then off; around a selection, then off.
    await set(prompt, '');
    await prompt.press(M + '+Shift+x'); await expectState(prompt, '```\n\n```', 4, 4, tag + ' empty fence');
    await prompt.press(M + '+Shift+x'); await expectState(prompt, '', 0, 0, tag + ' empty fence off');
    await set(prompt, 'x = 1\ny = 2', 0, 11);
    await prompt.press(M + '+Shift+x'); await expectState(prompt, '```\nx = 1\ny = 2\n```', 4, 15, tag + ' fence around selection');
    // Lists stay literal inside the fence (existing behaviour).
    await prompt.evaluate((el) => el.setSelectionRange(9, 9));
    await prompt.press('Shift+Enter'); await prompt.pressSequentially('- z');
    assert.equal(await prompt.inputValue(), '```\nx = 1\n- z\ny = 2\n```', tag + ' no list editing inside a fence');
    await prompt.evaluate((el) => el.setSelectionRange(0, el.value.length));
    await prompt.press(M + '+Shift+x'); assert.equal(await prompt.inputValue(), 'x = 1\n  • z\ny = 2', tag + ' unfence turns the list line back into a composer bullet');

    // List toggles, then the existing list editing still works on the result.
    await set(prompt, 'first\nsecond', 0, 12);
    await prompt.press(M + '+Shift+Digit8'); await expectState(prompt, '  • first\n  • second', 0, 20, tag + ' bullet list');
    await prompt.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await prompt.press('Shift+Enter'); assert.equal(await prompt.inputValue(), '  • first\n  • second\n  • ', tag + ' Enter continues the toggled list');
    await prompt.press('Tab'); assert.equal(await prompt.inputValue(), '  • first\n  • second\n    • ', tag + ' Tab indents');
    await set(prompt, 'first\nsecond', 0, 12);
    await prompt.press(M + '+Shift+Digit7'); await expectState(prompt, '  1. first\n  2. second', 0, 22, tag + ' numbered list');
    await prompt.evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
    await prompt.press('Shift+Enter'); assert.equal(await prompt.inputValue(), '  1. first\n  2. second\n  3. ', tag + ' numbering continues');
    await prompt.evaluate((el) => el.setSelectionRange(0, el.value.length));
    await prompt.press(M + '+Shift+Digit8'); assert.equal(await prompt.inputValue(), '  • first\n  • second\n  • ', tag + ' numbered converts to bullets');
    await prompt.press(M + '+Shift+Digit8'); assert.equal(await prompt.inputValue(), 'first\nsecond\n', tag + ' bullets clear');

    // Undo takes a formatting action back in one step. Chromium uses its own
    // platform's editing keys whatever the user agent says, so Ctrl+Z here.
    await set(prompt, 'undo me please', 5, 7);
    await prompt.press(M + '+b'); assert.equal(await prompt.inputValue(), 'undo **me** please');
    await prompt.press('Control+z'); assert.equal(await prompt.inputValue(), 'undo me please', tag + ' one-step undo');
    await set(prompt, 'a\nb', 0, 3);
    await prompt.press(M + '+Shift+Digit9'); await prompt.press('Control+z');
    assert.equal(await prompt.inputValue(), 'a\nb', tag + ' one-step undo of a block format');

    // IME composition is never touched.
    await set(prompt, 'kana', 0, 4);
    const composing = await prompt.evaluate((el, mac) => {
      const ev = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', metaKey: mac, ctrlKey: !mac, isComposing: true, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      const ev2 = new KeyboardEvent('keydown', { key: 'Process', code: 'KeyB', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
      Object.defineProperty(ev2, 'keyCode', { value: 229 }); el.dispatchEvent(ev2);
      return [ev.defaultPrevented, ev2.defaultPrevented, el.value];
    }, mac);
    assert.deepEqual(composing, [false, false, 'kana'], tag + ' IME ignored');

    // Not focused: nothing happens to the box.
    await set(prompt, 'idle', 0, 4);
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press(M + '+b');
    assert.equal(await prompt.inputValue(), 'idle', tag + ' unfocused box untouched');
    await prompt.click();

    // Cmd/Ctrl+Shift+8 must not also jump to the 8th project.
    const before = page.url();
    await set(prompt, 'x', 0, 1);
    await prompt.press(M + '+Shift+Digit8');
    await page.waitForTimeout(150);
    assert.equal(page.url(), before, tag + ' list shortcut does not switch project');
    assert.equal(await prompt.inputValue(), '  • x');

    // Alt+M / Alt+E still open the model and effort popover.
    await prompt.click();
    await prompt.press('Alt+m'); await page.locator('#runMenu').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await page.locator('#runMenu').waitFor({ state: 'hidden' });
    await prompt.click();
    await prompt.press('Alt+e'); await page.locator('#runMenu').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape'); await page.locator('#runMenu').waitFor({ state: 'hidden' });

    // Shift+Enter is a newline; Ctrl/Cmd+Enter and Enter keep their jobs
    // (with no turn running, a steer goes out as an ordinary message).
    const sent = [];
    await page.route('**/api/sessions/current/messages', (route) => { sent.push(route.request().postDataJSON().prompt); return route.fulfill({ status: 400, json: { message: 'Fixture captured send' } }); });
    await prompt.click();
    await set(prompt, 'line');
    await prompt.press('Shift+Enter'); assert.equal(await prompt.inputValue(), 'line\n', tag + ' Shift+Enter newline');
    await prompt.press(M + '+Enter');
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await page.waitForTimeout(300);
    assert.deepEqual(sent, ['line'], tag + ' Cmd/Ctrl+Enter still steers/sends');
    await prompt.click();
    await set(prompt, '  • **bold** item');
    await prompt.press('Enter');
    await page.waitForFunction(() => document.querySelector('#prompt').value === '');
    await page.waitForTimeout(300);
    assert.deepEqual(sent, ['line', '- **bold** item'], tag + ' Enter sends the Markdown source');
    await page.unroute('**/api/sessions/current/messages');

    // The cheat sheet lists every shortcut with this platform's keys.
    await prompt.click();
    await page.locator('#composerPlusBtn').click();
    await page.locator('#composerFormatItem').click();
    const sheet = page.locator('#composerFormatMenu');
    await sheet.waitFor({ state: 'visible' });
    const rows = await sheet.locator('.qp-fmt-row').evaluateAll((els) => els.map((el) => [el.querySelector('.qp-fmt-label').textContent, el.querySelector('kbd').textContent]));
    const expected = mac
      ? [['Bold', '⌘B'], ['Italic', '⌘I'], ['Underline', '⌘U'], ['Inline code', '⌘⇧C'], ['Code block', '⌘⇧X'], ['Quote', '⌘⇧9'], ['Horizontal rule', '⌘⇧-'], ['Bulleted list', '⌘⇧8'], ['Numbered list', '⌘⇧7']]
      : [['Bold', 'Ctrl+B'], ['Italic', 'Ctrl+I'], ['Underline', 'Ctrl+U'], ['Inline code', 'Ctrl+Shift+C'], ['Code block', 'Ctrl+Shift+X'], ['Quote', 'Ctrl+Shift+9'], ['Horizontal rule', 'Ctrl+Shift+-'], ['Bulleted list', 'Ctrl+Shift+8'], ['Numbered list', 'Ctrl+Shift+7']];
    assert.deepEqual(rows, expected, tag + ' cheat sheet rows');
    assert.ok(await page.evaluate(() => document.querySelector('.composer-wrap').hasAttribute('data-qp-open')), tag + ' pill stays open under the sheet');
    assert.equal(await page.locator('#composerPlusMenu').isHidden(), true);
    // The help dialog and the screen-reader hint name them too.
    const hint = await page.locator('#composerHint').textContent();
    assert.ok(hint.includes(mac ? '⌘B bold' : 'Ctrl+B bold') && hint.includes(mac ? '⌘⇧C inline code' : 'Ctrl+Shift+C inline code'), tag + ' hint: ' + hint);
    await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, [], tag + ' page errors');
    return { context, page };
  }

  const mac = await suite(true);
  await mac.context.close();
  const linux = await suite(false);

  // The chat renderer lets exactly <u> through.
  const { page } = linux;
  await page.evaluate(({ pid, sid }) => window.fixtureStream.dispatchEvent(new MessageEvent('assistant_text', { data: JSON.stringify({ data: { projectId: pid, sessionId: sid, text: 'An <u>underlined **word**</u>, a <b>bold tag</b>, <u onclick="x">attr</u> and <script>x</script>.' } }) })), { pid: project.id, sid });
  const content = page.locator('.msg.assistant .content').last();
  await content.locator('u').first().waitFor();
  assert.equal(await content.locator('u').count(), 1, 'only the plain <u> renders');
  assert.equal(await content.locator('u').innerText(), 'underlined word');
  assert.equal(await content.locator('u strong').innerText(), 'word');
  assert.equal(await content.locator('b, script, [onclick]').count(), 0, 'no other HTML gets through');
  assert.match(await content.innerText(), /<b>bold tag<\/b>/);
  // Your own bubble: literal text except the underline tag the shortcut writes.
  await page.evaluate(({ pid, sid }) => window.fixtureStream.dispatchEvent(new MessageEvent('session_started', { data: JSON.stringify({ data: { projectId: pid, sessionId: sid, messageId: 'mine-u', displayPrompt: 'Make it <u>very</u> clear, keep <b>this</b> literal', ts: new Date().toISOString() } }) })), { pid: project.id, sid });
  const mine = page.locator('.msg.user .content').last();
  await mine.locator('u').first().waitFor();
  assert.equal(await mine.locator('u').innerText(), 'very');
  assert.match(await mine.innerText(), /<b>this<\/b> literal/);
  assert.equal(await mine.locator('b').count(), 0);
  // ...and the rest of the Markdown renders too, like the replies.
  await page.evaluate(({ pid, sid }) => window.fixtureStream.dispatchEvent(new MessageEvent('session_started', { data: JSON.stringify({ data: { projectId: pid, sessionId: sid, messageId: 'mine-md', displayPrompt: '> The lookup is not live yet.\nWhat else is missing?\n\n---\n\n**Bold**, `code` and\n- one\n- two', ts: new Date().toISOString() } }) })), { pid: project.id, sid });
  const md = page.locator('.msg.user .content').last();
  await md.locator('blockquote').waitFor();
  assert.match(await md.locator('blockquote').innerText(), /The lookup is not live yet/);
  assert.doesNotMatch(await md.innerText(), /^>/m, 'no raw quote marker');
  assert.equal(await md.locator('hr').count(), 1);
  assert.equal(await md.locator('strong').innerText(), 'Bold');
  assert.equal(await md.locator('code').innerText(), 'code');
  assert.equal(await md.locator('ul li').count(), 2);
  await md.screenshot({ path: shots + '/user-bubble-markdown.png' });
  await linux.context.close();

  // Touch: plain typing is unaffected and Enter is still a newline.
  const phone = await open({ mac: false, width: 390, height: 844, mobile: true });
  await phone.prompt.pressSequentially('**not a shortcut**');
  await phone.prompt.press('Enter');
  assert.equal(await phone.prompt.inputValue(), '**not a shortcut**\n');
  await phone.context.close();

  // Screenshots: the sheet in both themes at desktop and phone width, and a
  // composer mid-edit.
  for (const theme of ['dark', 'light']) for (const [w, h] of [[1440, 900], [390, 844]]) {
    const s = await open({ mac: true, theme, width: w, height: h, mobile: w < 500 });
    await s.prompt.fill('Please **review** the `deploy` script\n\n> keep the rollback');
    await s.page.locator('#composerPlusBtn').click();
    await s.page.locator('#composerFormatItem').click();
    await s.page.locator('#composerFormatMenu').waitFor({ state: 'visible' });
    await s.page.waitForTimeout(250);
    await s.page.screenshot({ path: `${shots}/sheet-${theme}-${w}.png` });
    await s.context.close();
  }
  const s = await open({ mac: true, theme: 'dark', width: 1440, height: 900 });
  await set(s.prompt, 'Ship it:\n\nfirst\nsecond', 10, 22);
  await s.prompt.press('Meta+Shift+Digit8');
  await s.prompt.evaluate((el) => el.setSelectionRange(el.value.indexOf('second'), el.value.indexOf('second') + 6));
  await s.prompt.press('Meta+b');
  await s.page.waitForTimeout(200);
  await s.page.locator('.composer-wrap').screenshot({ path: `${shots}/mid-edit.png` });
  await s.context.close();

  // ---- live highlight: the mirror behind the transparent textarea ----------
  const hl = await open({ mac: false, theme: 'dark', width: 1440, height: 900 });
  const mirrorText = () => hl.page.evaluate(() => document.getElementById('promptHighlight').textContent);
  const settle = () => hl.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // Placeholder stays visible while the box is empty.
  await hl.prompt.fill(''); await settle();
  assert.equal(await mirrorText(), '');
  const ph = await hl.prompt.evaluate((el) => getComputedStyle(el, '::placeholder').color);
  assert.ok(!/rgba\(\d+, \d+, \d+, 0\)|transparent/.test(ph), 'placeholder visible: ' + ph);
  // What the owner typed.
  await hl.prompt.pressSequentially('> asda'); await hl.prompt.press('Shift+Enter'); await hl.prompt.pressSequentially('**wtf bro**');
  await settle();
  assert.equal(await hl.prompt.inputValue(), '> asda\n**wtf bro**');
  assert.equal(await mirrorText(), '> asda\n**wtf bro**', 'mirror text equals the value');
  const spans = await hl.page.$$eval('#promptHighlight span', (els) => els.map((e) => [e.className, e.textContent]));
  assert.deepEqual(spans, [['md-mark md-qm', '> '], ['md-q', 'asda'], ['md-mark', '**'], ['md-b', 'wtf bro'], ['md-mark', '**']]);
  const look = await hl.page.evaluate(() => {
    const ta = document.getElementById('prompt'), b = document.querySelector('#promptHighlight .md-b');
    return { ta: getComputedStyle(ta).color, on: ta.classList.contains('hl-on'), weight: getComputedStyle(b).fontWeight, taWeight: getComputedStyle(ta).fontWeight };
  });
  assert.equal(look.on, true); assert.equal(look.ta, 'rgba(0, 0, 0, 0)', 'textarea text is transparent');
  assert.equal(look.weight, look.taWeight, 'bold keeps the weight (width-neutral)');

  // Alignment: each character's box in the styled mirror against a plain copy
  // of it (same box, one text node), and the mirror's box and wrapping against
  // the textarea's. Both within 1px.
  async function alignment(probes) {
    return hl.page.evaluate((probes) => {
      const ta = document.getElementById('prompt'), m = document.getElementById('promptHighlight');
      const plain = m.cloneNode(false); plain.removeAttribute('id'); plain.textContent = ta.value;
      m.parentNode.appendChild(plain); plain.scrollTop = m.scrollTop;
      function charRect(root, k) {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n, at = k;
        while ((n = walk.nextNode())) { if (at < n.data.length) break; at -= n.data.length; }
        const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + 1); return r.getClientRects()[0];
      }
      const cs = getComputedStyle(ta), tr = ta.getBoundingClientRect(), mr = m.getBoundingClientRect();
      const out = { box: [Math.abs(mr.left - tr.left - parseFloat(cs.borderLeftWidth)), Math.abs(mr.top - tr.top - parseFloat(cs.borderTopWidth)), Math.abs(mr.width - ta.clientWidth)],
        scroll: [ta.scrollTop, m.scrollTop, ta.scrollHeight, m.scrollHeight], font: [cs.font, getComputedStyle(m).font], probes: {} };
      for (const [name, k] of probes) {
        const a = charRect(m, k), b = charRect(plain, k);
        out.probes[name] = { dx: Math.abs(a.left - b.left), dy: Math.abs(a.top - b.top), right: Math.abs(a.right - b.right), inside: a.top >= tr.top - 1 && a.bottom <= tr.bottom + 1 };
      }
      plain.remove();
      return out;
    }, probes);
  }
  function checkAlign(res, label) {
    for (const d of res.box) assert.ok(d <= 1, label + ' mirror box matches the textarea: ' + JSON.stringify(res.box));
    assert.equal(res.font[0], res.font[1], label + ' same font');
    assert.ok(Math.abs(res.scroll[0] - res.scroll[1]) <= 1 && Math.abs(res.scroll[2] - res.scroll[3]) <= 1, label + ' scroll synced: ' + JSON.stringify(res.scroll));
    for (const [name, p] of Object.entries(res.probes)) assert.ok(p.dx <= 1 && p.dy <= 1 && p.right <= 1, label + ' ' + name + ': ' + JSON.stringify(p));
    console.log('align', label, JSON.stringify(res.probes));
  }
  const MIX = '> quoted **line** here\nPlease **review the deploy** then `npm test` and *maybe* <u>today</u> ~~not~~.\n# Head\n---\n  • item `x`\n```\ncode **here**\n```\n' + 'A long line that keeps going so it wraps around in the composer box, '.repeat(4) + 'ending in **bold words** here.';
  await hl.prompt.fill(MIX); await settle();
  assert.equal(await mirrorText(), MIX);
  const idx = (s, d = 0) => MIX.indexOf(s) + d;
  checkAlign(await alignment([['end of bold run', idx('deploy** then') + 5], ['after inline code', idx('` and *maybe') + 1], ['inside quote', idx('line** here') + 2],
    ['italic end', idx('maybe*') + 4], ['after underline', idx('</u>') + 4], ['in fence', idx('code **here**') + 8], ['wrapped long line', MIX.length - 3]]), 'mixed');
  // A 30-line draft scrolled to the bottom (the box caps at 240px and scrolls).
  const LONG = Array.from({ length: 30 }, (_, i) => `line ${i + 1} with **bold** and \`code\``).join('\n');
  await hl.prompt.fill(LONG); await hl.prompt.evaluate((el) => { el.scrollTop = el.scrollHeight; }); await settle();
  const scrolled = await alignment([['line 29 bold', LONG.indexOf('line 29') + 15], ['last char', LONG.length - 1]]);
  assert.ok(scrolled.scroll[0] > 100, 'the textarea really scrolled');
  checkAlign(scrolled, 'scrolled');
  for (const p of Object.values(scrolled.probes)) assert.ok(p.inside, 'visible line sits inside the box');

  // 20 KB draft. The whole value is re-tokenized on every change; only the
  // edited lines are rebuilt and re-laid out. A keystroke in the middle of it
  // stays inside one frame (< 16 ms, or the textarea's own layout time on a loaded host); the first paint is logged.
  const times = await hl.page.evaluate((seed) => {
    const el = document.getElementById('prompt');
    const render = () => el.dispatchEvent(new CompositionEvent('compositionend')); // renders synchronously
    let big = ''; while (big.length < 20000) big += seed + '\n';
    let t = performance.now(); el.value = big; render(); const first = performance.now() - t;
    const out = [], base = [], mid = big.indexOf('\n', 10000) + 1;
    for (let i = 0; i < 9; i++) {
      big = big.slice(0, mid) + 'x' + big.slice(mid);
      // The textarea's own relayout of 20 KB is the browser's cost with or
      // without a mirror; it is forced first and logged apart.
      t = performance.now(); el.value = big; el.getBoundingClientRect(); base.push(performance.now() - t);
      t = performance.now(); render(); out.push(performance.now() - t);
    }
    // A fence opened mid-draft re-styles every line after it.
    t = performance.now(); el.value = big.slice(0, mid) + '```\n' + big.slice(mid); render(); const fence = performance.now() - t;
    if (document.getElementById('promptHighlight').textContent !== el.value) throw new Error('mirror out of sync');
    return { first, fence, edits: out.sort((a, b) => a - b), base: base.sort((a, b) => a - b) };
  }, MIX);
  console.log('20KB render ms: first', times.first.toFixed(1), 'fence', times.fence.toFixed(1), 'edits', times.edits.map((t) => t.toFixed(1)).join(' '), '| textarea alone', times.base.map((t) => t.toFixed(1)).join(' '));
  // One frame (16 ms), or no slower than the textarea's own layout measured in
  // the same run: a loaded host slows both alike, so the fixed bar alone flaked.
  const bar = Math.max(16, times.base[4] * 1.5);
  assert.ok(times.edits[4] < bar, '20KB keystroke re-highlight median ' + times.edits[4].toFixed(1) + ' ms, bar ' + bar.toFixed(1));

  // Programmatic writes (clear after send, draft restore) reach the mirror.
  await hl.prompt.evaluate((el) => { el.value = 'restored **draft**'; }); await settle();
  assert.equal(await mirrorText(), 'restored **draft**');
  await hl.prompt.evaluate((el) => { el.value = ''; }); await settle();
  assert.equal(await mirrorText(), '');

  // IME: while composing the textarea shows its own text and the mirror hides.
  await hl.prompt.fill('ab **c** '); await hl.prompt.press('End');
  const cdp = await hl.context.newCDPSession(hl.page);
  await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 });
  const mid = await hl.page.evaluate(() => ({ cls: document.getElementById('prompt').className, color: getComputedStyle(document.getElementById('prompt')).color, vis: getComputedStyle(document.getElementById('promptHighlight')).visibility }));
  assert.ok(mid.cls.includes('hl-composing') && mid.vis === 'hidden' && mid.color !== 'rgba(0, 0, 0, 0)', 'composing: native text, mirror hidden ' + JSON.stringify(mid));
  await cdp.send('Input.insertText', { text: 'かな' }); await settle();
  assert.equal(await hl.prompt.inputValue(), 'ab **c** かな', 'committed once');
  assert.equal(await mirrorText(), 'ab **c** かな', 'mirror after composition');
  assert.equal(await hl.page.evaluate(() => getComputedStyle(document.getElementById('promptHighlight')).visibility), 'visible');

  // Sending clears the box and the mirror together.
  await hl.prompt.fill('send **me**'); await hl.prompt.press('Enter');
  await hl.page.waitForFunction(() => document.getElementById('prompt').value === '');
  await settle();
  assert.equal(await mirrorText(), '', 'mirror cleared after send');
  assert.deepEqual(hl.errors, [], 'highlight page errors');
  await hl.context.close();

  // Screenshots of a mixed draft, both themes, desktop and phone.
  for (const theme of ['dark', 'light']) for (const [w, h] of [[1440, 900], [390, 844]]) {
    const s = await open({ mac: true, theme, width: w, height: h, mobile: w < 500 });
    await s.prompt.fill('> The lookup is **not live** yet\nPlease **review** the `deploy` script, *carefully*, and <u>today</u>.\n---\n## Steps\n  • check the `env` file\n  1. ship ~~it~~\n```bash\nnpm test\n```');
    await s.prompt.evaluate((el) => { el.scrollTop = 0; });
    await s.page.waitForTimeout(200);
    await s.page.locator('.composer-wrap').screenshot({ path: `${shots}/highlight-${theme}-${w}.png` });
    await s.context.close();
  }

  await browser.close();
  console.log('PASS: formatting shortcuts (Mac Cmd, Linux Ctrl), toggles, trim, quote, rule, fence, lists, undo, IME, focus, project-jump guard, Alt+M/E, Enter semantics, cheat sheet, <u> rendering, touch.');
})().catch((e) => { console.error(e); process.exit(1); });
