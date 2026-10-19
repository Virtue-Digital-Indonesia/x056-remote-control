// Bot chat system history: which rows the Bot chat hides (botRowVisibility), the
// "Morning brief" label, the Today toggle and its pill, the reset on leaving, and
// that the incremental pass agrees with a full one.
// Run against the isolated browser fixture with Chat and Project spaces enabled:
//   X056_TEST_BROWSER=chromium|webkit node test/browser/bot-system-history.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

// [row, shown in the default view]. Each turn starts at a user row.
const t0 = Date.now() - 2 * 86400000;
const ROWS = [
  [{ role: 'assistant', text: 'Row before any user message' }, true],
  [{ role: 'user', text: 'Hello Bot, a human turn' }, true],
  [{ role: 'assistant', text: 'Human reply with tools' }, true],
  [{ role: 'action', text: 'Used Read', detail: '{}' }, true],
  [{ role: 'assistant', text: 'Human final answer' }, true],
  [{ role: 'assistant', text: 'Not sent yet (relay checkpoint): human-turn checkpoint' }, false],
  [{ role: 'notice', text: 'Bot status: human-turn status' }, false],
  [{ role: 'user', text: 'Digest trigger fixture', sender: { kind: 'bot_event' } }, false],
  [{ role: 'assistant', text: 'Digest quiet reply' }, false],
  [{ role: 'action', text: 'Used mcp__x056__notify_user', detail: '{}' }, false],
  [{ role: 'notice', text: 'Bot needs you: digest urgent fixture' }, true],
  [{ role: 'error', text: 'digest error fixture' }, true],
  [{ role: 'user', text: 'Brief trigger fixture', sender: { kind: 'bot_brief' } }, false],
  [{ role: 'assistant', text: 'Brief commentary fixture' }, false], // commentary before the brief's tools: hidden (rule 4)
  [{ role: 'action', text: 'Used Bash', detail: '{}' }, false],
  [{ role: 'action', text: 'Used Grep', detail: '{}' }, false],
  [{ role: 'assistant', text: 'Brief final fixture' }, true],
  [{ role: 'notice', text: 'Compacted divider fixture' }, false],
  [{ role: 'user', text: 'Advisor trigger fixture', sender: { kind: 'advisor', messageId: 'adv-1' } }, false],
  [{ role: 'assistant', text: 'Advisor reply fixture' }, true],
  [{ role: 'action', text: 'Used Glob', detail: '{}' }, true],
  [{ role: 'user', text: 'Delegate report fixture', sender: { kind: 'delegate', conversationTitle: 'Delegates' } }, true],
  [{ role: 'assistant', text: 'Delegate reply fixture' }, true],
  [{ role: 'user', text: 'Last human message' }, true],
  [{ role: 'assistant', text: 'Last human answer' }, true],
];
// + the history header sysline ("25 earlier messages"), a system line like any other.
const HIDDEN = ROWS.filter(([, shown]) => !shown).length + 1;
const key = row => (row.text.split(':')[0] === 'digest error fixture' ? 'error: ' : '') + row.text;

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const checks = [], errors = [];
  // WebKit reports a benign "ResizeObserver loop completed with undelivered notifications"
  // (the pristine checkout does too); every other page error fails the test.
  const pageError = e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); };
  const check = (name, ok, detail) => { assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks.push(name); };
  try {
    const phone = playwright.devices['iPhone 13'];
    const setup = async options => {
      const context = await browser.newContext({ serviceWorkers: 'block', ...options });
      await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
      return context;
    };
    const admin = await setup({});
    const api = async data => { const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data }); assert.ok(r.ok(), await r.text()); return r.json(); };
    const bot = await api({ requestId: randomUUID(), name: 'History Bot ' + randomUUID(), provider: 'claude' });
    const other = await api({ requestId: randomUUID(), name: 'Ordinary ' + randomUUID(), provider: 'claude' });
    await admin.close();
    const route = async (context, rows = ROWS.map(([row]) => row)) => {
      await context.route(/\/api\/sessions\/current\/stream/, r => r.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
      await context.route('**/api/bot', r => r.fulfill({ json: { enabled: true, projectId: bot.id, sessionId: bot.lastSessionId, url: '/chat/' + bot.id, briefAt: '07:30', tz: 'Asia/Jakarta' } }));
      await context.route(/\/api\/projects(\?|$)/, async r => { const response = await r.fetch(), data = await response.json(); for (const p of data.projects) if (p.id === bot.id) p.bot = true; await r.fulfill({ response, json: data }); });
      await context.route('**/api/questions', r => r.fulfill({ json: [{ projectId: bot.id, sessionId: bot.lastSessionId, question: 'Question card fixture', options: ['Yes'], at: new Date().toISOString() }] }));
      await context.route(/\/api\/conversations\/history-page\?/, r => {
        if (new URL(r.request().url()).searchParams.get('projectId') !== bot.id) return r.continue();
        return r.fulfill({ json: { done: true, cursor: null, rows: rows.map((row, i) => ({ ...row, ts: new Date(t0 + i * 1000).toISOString() })) } });
      });
    };
    const rowsState = page => page.evaluate(() => [...document.querySelectorAll('#chat>*')].map(e => ({
      text: (e._messageText ?? e.textContent).trim(), cls: e.className, hidden: getComputedStyle(e).display === 'none',
      opacity: getComputedStyle(e).opacity, label: e.querySelector('.bot-brief-tag')?.textContent || '',
    })));
    const open = async (page, path) => {
      if (page.url().startsWith(base)) await page.evaluate(p => window.rcWorkspace.navigate(p), path); else await page.goto(base + path);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.waitForTimeout(600);
    };
    const botPath = '/chat/' + bot.id;

    // 1. The rule itself, as a table (the iOS app mirrors it).
    {
      const context = await setup({ viewport: { width: 1440, height: 1000 } }); await route(context);
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.getByText('Last human answer', { exact: true }).waitFor();
      const table = await page.evaluate(() => { const out = {}; for (const t of ['', 'bot_event', 'bot_brief', 'advisor']) for (const r of ['keep', 'system', 'trigger', 'reply', 'tool', 'other']) out[(t || 'human') + '/' + r] = window.rcChat.botRowVisibility(r, t); return out; });
      const expected = {
        'human/keep': 'show', 'human/system': 'hide', 'human/trigger': 'show', 'human/reply': 'show', 'human/tool': 'show', 'human/other': 'show',
        'bot_event/keep': 'show', 'bot_event/system': 'hide', 'bot_event/trigger': 'hide', 'bot_event/reply': 'hide', 'bot_event/tool': 'hide', 'bot_event/other': 'hide',
        'bot_brief/keep': 'show', 'bot_brief/system': 'hide', 'bot_brief/trigger': 'hide', 'bot_brief/reply': 'show', 'bot_brief/tool': 'hide', 'bot_brief/other': 'hide',
        'advisor/keep': 'show', 'advisor/system': 'hide', 'advisor/trigger': 'hide', 'advisor/reply': 'show', 'advisor/tool': 'show', 'advisor/other': 'show',
      };
      assert.deepEqual(table, expected); checks.push('botRowVisibility table');
      check('an earlier reply in a brief turn is hidden', await page.evaluate(() => window.rcChat.botRowVisibility('reply', 'bot_brief', false)) === 'hide');

      // 2. The default view applies it row by row.
      await page.locator('#chat .qcard').first().waitFor();
      const state = await rowsState(page);
      for (const [row, shown] of ROWS) {
        const found = state.find(s => s.text.startsWith(key(row)) || s.text.includes(row.text));
        check('row present: ' + row.text, !!found, state.map(s => s.text.slice(0, 30)));
        check((shown ? 'shown: ' : 'hidden: ') + row.text, found.hidden === !shown, found);
      }
      check('history header sysline hidden', state.some(s => s.cls === 'sysline bot-system-notice' && /^\d+ earlier messages$/.test(s.text) && s.hidden), state[0]);
      check('question card shown', state.some(s => s.cls.includes('qcard') && !s.hidden));
      check('hidden count', state.filter(s => s.hidden).length === HIDDEN, state.filter(s => s.hidden).map(s => s.text.slice(0, 30)));
      const labelled = state.filter(s => s.label);
      check('only the brief turn\'s last reply (the brief) is labelled', labelled.length === 1 && labelled[0].text === 'Brief final fixture' && labelled[0].label === 'Morning brief', labelled);
      // The labelled brief keeps a footer copy/time row, clear of its label.
      const briefLayout = () => page.evaluate(() => {
        const labelled = document.querySelector('#chat>.bot-brief-reply'), meta = labelled.querySelector('.mmeta').getBoundingClientRect(), tag = labelled.querySelector('.bot-brief-tag').getBoundingClientRect();
        const overlap = Math.max(0, Math.min(meta.right, tag.right) - Math.max(meta.left, tag.left)) * Math.max(0, Math.min(meta.bottom, tag.bottom) - Math.max(meta.top, tag.top));
        return { labelMeta: getComputedStyle(labelled.querySelector('.mmeta')).position, overlap };
      });
      let layout = await briefLayout();
      check('brief: footer meta, label clear of it', layout.labelMeta === 'static' && layout.overlap === 0, layout);

      // 3. Incremental passes agree with a full pass: append a digest turn, a human turn, a
      //    brief turn row by row the way live events arrive, then prepend an older row.
      const hiddenNow = () => page.evaluate(() => [...document.querySelectorAll('#chat>:not(.qcard)')].map(e => e.classList.contains('bot-system-notice') ? 'H' : e.classList.contains('bot-brief-reply') ? 'B' : '.').join(''));
      await page.evaluate(async () => {
        const chat = document.getElementById('chat'), rows = [...chat.children];
        const find = text => text === 'ACT' ? rows.find(e => e.matches('.act')) : rows.find(e => e._messageText === text || e.textContent.trim() === text);
        const fresh = text => { const f = find(text); if (!f) throw new Error('fixture row not found: ' + text); const e = f.cloneNode(true); e.classList.remove('bot-system-notice', 'bot-brief-reply'); e.querySelector('.bot-brief-tag')?.remove(); return e; };
        const tick = () => new Promise(r => setTimeout(r, 0));
        for (const text of ['Digest trigger fixture', 'Digest quiet reply', 'ACT', 'Last human message', 'Human final answer', 'Brief trigger fixture', 'Brief final fixture', 'ACT', 'Brief commentary fixture']) { chat.appendChild(fresh(text)); await tick(); }
      });
      const incremental = await hiddenNow();
      await page.evaluate(() => document.dispatchEvent(new Event('x056-history')));
      check('incremental pass equals a full pass', incremental === await hiddenNow(), incremental);
      // digest trigger, reply, tool | human message, reply | brief trigger, earlier reply (demoted), tool, last reply (labelled)
      check('appended rows classified', incremental.endsWith('HHH..HHHB'), incremental.slice(-12));
      await page.evaluate(async () => { const chat = document.getElementById('chat'); const e = [...chat.children].find(x => x._messageText === 'Brief trigger fixture').cloneNode(true); e.classList.remove('bot-system-notice'); chat.prepend(e); await new Promise(r => setTimeout(r, 0)); });
      const prepended = await hiddenNow();
      await page.evaluate(() => document.dispatchEvent(new Event('x056-history')));
      check('prepended row re-walks everything', prepended === await hiddenNow() && prepended.startsWith('HH'), prepended.slice(0, 6));
      await context.close();
    }

    // 4. The toggle on a touch phone: Today > Show N hidden system messages, the pill, Hide, reset.
    for (const scheme of ['light', 'dark']) {
      const context = await setup({ ...phone, colorScheme: scheme }); await route(context);
      if (scheme === 'dark') await context.addInitScript(() => localStorage.setItem('x056_theme', 'dark'));
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.getByText('Last human answer', { exact: true }).waitFor();
      const on = () => page.evaluate(() => document.body.classList.contains('rc-bot-system-history'));
      const visibleHidden = () => page.evaluate(() => [...document.querySelectorAll('#chat>.bot-system-notice')].filter(e => getComputedStyle(e).display !== 'none').length);
      await page.locator('#rcBotToday').tap();
      const button = page.locator('#rcBotSystemHistory');
      await button.waitFor();
      check(scheme + ': Today names the hidden count', await button.innerText() === `Show ${HIDDEN} hidden system messages`, await button.innerText());
      const box = await button.evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, vw: innerWidth, vh: innerHeight }; });
      check(scheme + ': button is on screen and tall enough to tap', box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh && box.h >= 40, box);
      await button.tap();
      check(scheme + ': shown', await on() && !(await page.locator('#rcBotTodayPop').count()));
      check(scheme + ': every hidden row is back', await visibleHidden() === HIDDEN);
      check(scheme + ': shown rows are subdued', await page.locator('#chat>.bot-system-notice').first().evaluate(e => +getComputedStyle(e).opacity) < 0.8);
      const pill = page.locator('#rcBotSystemPill');
      check(scheme + ': pill visible', await pill.isVisible() && /Showing system messages/.test(await pill.innerText()));
      const geo = await page.evaluate(() => { const p = document.getElementById('rcBotSystemPill').getBoundingClientRect(), c = document.getElementById('composerBox').getBoundingClientRect(); return { pill: [p.top, p.bottom, p.left, p.right], composerTop: c.top, vw: innerWidth }; });
      check(scheme + ': pill sits above the composer, on screen', geo.pill[1] <= geo.composerTop + 0.5 && geo.pill[2] >= 0 && geo.pill[3] <= geo.vw, geo);
      if (process.env.X056_SHOTS) await page.screenshot({ path: `${process.env.X056_SHOTS}/${engine}-iphone-${scheme}-system-shown.png` });
      await page.locator('#rcBotToday').tap();
      check(scheme + ': Today offers Hide', await button.innerText() === 'Hide system messages' && await button.getAttribute('aria-pressed') === 'true');
      await button.tap();
      check(scheme + ': hidden again', !(await on()) && await visibleHidden() === 0 && !(await pill.isVisible()));
      await page.locator('#rcBotToday').tap(); await button.tap();
      await page.locator('#rcBotSystemHide').tap();
      check(scheme + ': pill Hide hides', !(await on()) && await visibleHidden() === 0);
      check(scheme + ': focus returns to Today', await page.evaluate(() => document.activeElement?.id) === 'rcBotToday');
      // Reset: Home and back, another chat and back.
      for (const away of ['/home', '/chat/' + other.id]) {
        await page.locator('#rcBotToday').tap(); await button.tap();
        check(scheme + ': shown before leaving to ' + away, await on());
        await open(page, away);
        check(scheme + ': reset on ' + away, !(await on()) && !(await pill.isVisible()));
        await open(page, botPath);
        await page.getByText('Last human answer', { exact: true }).waitFor();
        check(scheme + ': still hidden after coming back from ' + away, !(await on()) && await visibleHidden() === 0 && !(await pill.isVisible()));
      }
      await context.close();
    }
    // 5. A Bot whose only turns are digests: nothing visible, so the welcome hero shows
    //    instead of a blank page, and gives way while system messages are shown.
    {
      const context = await setup({ viewport: { width: 1440, height: 1000 } });
      await route(context, [ROWS[7][0], ROWS[8][0], ROWS[9][0], { role: 'notice', text: 'Bot status: quiet' }]);
      await context.route('**/api/questions', r => r.fulfill({ json: [] }));
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.locator('#rcBotHero').waitFor({ state: 'visible', timeout: 5000 });
      check('only system rows: hero shown', await page.evaluate(() => document.body.classList.contains('rc-bot-empty') && document.querySelectorAll('#chat>*').length > 0));
      await page.locator('#rcBotToday').click(); await page.locator('#rcBotSystemHistory').click();
      check('only system rows: showing them removes the hero', await page.locator('#rcBotHero').isHidden() && await page.getByText('Digest quiet reply', { exact: true }).isVisible());
      await page.locator('#rcBotSystemHide').click();
      check('only system rows: hiding them brings the hero back', await page.locator('#rcBotHero').isVisible());
      await context.close();
    }
    // 6. Phone header with a "needs you" chip: "Bot · Idle" is never covered or cut, nothing
    //    overflows, the chat bar's Bot button stays active, and the chip opens Today.
    for (const width of [320, 390, 430]) {
      const context = await setup({ ...phone, viewport: { width, height: 844 } }); await route(context);
      await context.route('**/api/bot/overview*', r => r.fulfill({ json: { needsYou: [{ kind: 'question', title: 'Needs fixture', text: 'Which weighting?' }], running: [], delegates: [], scheduled: [] } }));
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.locator('#rcBotNeeds').waitFor({ state: 'visible' });
      const h = await page.evaluate(() => {
        const box = s => document.querySelector(s)?.getBoundingClientRect();
        const name = document.querySelector('#rcBotHead .rcb-name'), badge = name.querySelector('.rc-bot-badge'), status = document.getElementById('rcBotStatus');
        const n = box('#rcBotHead .rcb-name'), a = box('#rcBotHead .rcb-actions'), bar = document.querySelector('.focus-main>.topbar');
        return { clipped: badge.scrollWidth > badge.clientWidth + 0.5 || status.scrollWidth > status.clientWidth + 0.5, gap: Math.round(a.left - n.right),
          overflow: bar.scrollWidth > bar.clientWidth + 1, active: document.getElementById('workspaceChatBot')?.getAttribute('aria-current') };
      });
      check(width + 'px header: name and status whole, clear of the actions, no overflow, Bot button active', !h.clipped && h.gap >= 0 && !h.overflow && h.active === 'page', h);
      await page.locator('#rcBotNeeds').click();
      check(width + 'px header: the needs chip opens Today', await page.locator('#rcBotTodayPop').isVisible());
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} bot-system-history: ${checks.length} checks`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
