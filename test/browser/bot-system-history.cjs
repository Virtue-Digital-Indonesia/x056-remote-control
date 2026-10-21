// Bot chat hidden messages: which rows the Bot chat hides (botRowVisibility: digest, brief, advisor and
// AGENT turns, agent steers, system notices), owner messages (message_owner) kept inside agent turns live
// and after a reload with no duplicates, the "Morning brief" label, the Today toggle and its pill, the
// sender label on shown agent exchanges, the reset on leaving, and that the incremental pass agrees with
// a full one.
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
  [{ role: 'notice', text: 'Bot status: human-turn status', messageId: 'bot-notice:status-1' }, false],
  [{ role: 'user', text: 'Digest trigger fixture', sender: { kind: 'bot_event' } }, false],
  [{ role: 'assistant', text: 'Digest quiet reply' }, false],
  [{ role: 'action', text: 'Used mcp__x056__notify_user', detail: '{}' }, false],
  [{ role: 'notice', text: 'Bot needs you: digest urgent fixture', messageId: 'bot-notice:urgent-1', needsYou: true }, true],
  // A notice is classified by its bot-notice: id and urgent flag, never by its words (the Bot can be renamed).
  [{ role: 'notice', text: 'Jarvis needs you: renamed urgent fixture', messageId: 'bot-notice:urgent-2', needsYou: true }, true],
  [{ role: 'notice', text: 'Bot needs you: quiet by id fixture', messageId: 'bot-notice:quiet-2', needsYou: false }, false],
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
  // Agent turns (sender kinds conversation, mcp, delegate, automation): everything hidden except owner messages.
  [{ role: 'user', text: 'Delegate report fixture', sender: { kind: 'delegate', conversationTitle: 'Delegates' } }, false],
  [{ role: 'assistant', text: 'Delegate reply fixture' }, false],
  [{ role: 'user', text: 'Agent ping fixture', sender: { kind: 'conversation', conversationTitle: 'Build agent', messageId: 'agent-1' } }, false],
  [{ role: 'assistant', text: 'Agent reply fixture' }, false],
  [{ role: 'action', text: 'Used AgentTool fixture', detail: '{}' }, false],
  [{ role: 'assistant', ownerMessage: true, needsYou: false, text: 'Owner FYI inside agent turn', messageId: 'bot-owner:tool-fyi' }, true],
  [{ role: 'assistant', text: 'Agent tail reply fixture' }, false],
  [{ role: 'user', text: 'MCP ping fixture', sender: { kind: 'mcp' } }, false],
  [{ role: 'assistant', text: 'MCP reply fixture' }, false],
  [{ role: 'user', text: 'Scheduled ping fixture', sender: { kind: 'automation' } }, false],
  [{ role: 'assistant', text: 'Scheduled reply fixture' }, false],
  [{ role: 'assistant', ownerMessage: true, needsYou: true, text: 'Owner needs-you inside scheduled turn', messageId: 'bot-owner:tool-need' }, true],
  // A steer never starts a turn: an agent's hides itself, the owner's shows, and the owner's turn goes on.
  [{ role: 'user', text: 'Owner turn before steer' }, true],
  [{ role: 'assistant', text: 'Owner turn reply one' }, true],
  [{ role: 'user', text: 'Agent steer fixture', sender: { kind: 'conversation', conversationTitle: 'Build agent', messageId: 'steer-agent' }, steered: true }, false],
  [{ role: 'assistant', text: 'Owner turn reply after agent steer' }, true],
  [{ role: 'user', text: 'Owner steer fixture', steered: true }, true],
  [{ role: 'assistant', text: 'Owner turn reply after owner steer' }, true],
  [{ role: 'user', text: 'Advisor steer fixture', sender: { kind: 'advisor', messageId: 'adv-steer' }, steered: true }, false],
  [{ role: 'assistant', text: 'Owner turn reply after advisor steer' }, true],
  // A steer from an agent inside a hidden agent turn stays hidden with it, and does not reopen the turn.
  [{ role: 'user', text: 'Second agent ping fixture', sender: { kind: 'conversation', conversationTitle: 'Peer', messageId: 'agent-2' } }, false],
  [{ role: 'user', text: 'Second agent steer fixture', sender: { kind: 'conversation', conversationTitle: 'Peer', messageId: 'steer-2' }, steered: true }, false],
  [{ role: 'assistant', text: 'Second agent reply fixture' }, false],
  [{ role: 'user', text: 'Last human message' }, true],
  [{ role: 'assistant', text: 'Last human answer' }, true],
];
// + the history header sysline ("25 earlier messages"), a system line like any other.
const HIDDEN = ROWS.filter(([, shown]) => !shown).length + 1;
const OWNER_ROWS = ROWS.filter(([row]) => row.ownerMessage).map(([row]) => row);
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
      opacity: getComputedStyle(e).opacity, label: e.querySelector('.bot-brief-tag')?.textContent || '', tag: e.querySelector('.owner-tag')?.textContent || '',
    })));
    const open = async (page, path) => {
      if (page.url().startsWith(base)) await page.evaluate(p => window.rcWorkspace.navigate(p), path); else await page.goto(base + path);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.waitForTimeout(600);
    };
    const botPath = '/chat/' + bot.id;

    // 1. The rule itself, as a table (server/bot-view.ts is the shared spec; iOS filters on its botView).
    {
      const context = await setup({ viewport: { width: 1440, height: 1000 } }); await route(context);
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.getByText('Last human answer', { exact: true }).waitFor();
      const table = await page.evaluate(() => { const out = {}; for (const t of ['', 'bot_event', 'bot_brief', 'advisor', 'agent']) for (const r of ['keep', 'system', 'trigger', 'reply', 'tool', 'other', 'steer']) out[(t || 'human') + '/' + r] = window.rcChat.botRowVisibility(r, t); return out; });
      const expected = {
        'human/keep': 'show', 'human/system': 'hide', 'human/trigger': 'show', 'human/reply': 'show', 'human/tool': 'show', 'human/other': 'show',
        'bot_event/keep': 'show', 'bot_event/system': 'hide', 'bot_event/trigger': 'hide', 'bot_event/reply': 'hide', 'bot_event/tool': 'hide', 'bot_event/other': 'hide',
        'bot_brief/keep': 'show', 'bot_brief/system': 'hide', 'bot_brief/trigger': 'hide', 'bot_brief/reply': 'show', 'bot_brief/tool': 'hide', 'bot_brief/other': 'hide',
        'advisor/keep': 'show', 'advisor/system': 'hide', 'advisor/trigger': 'hide', 'advisor/reply': 'show', 'advisor/tool': 'show', 'advisor/other': 'show',
        'agent/keep': 'show', 'agent/system': 'hide', 'agent/trigger': 'hide', 'agent/reply': 'hide', 'agent/tool': 'hide', 'agent/other': 'hide',
        'human/steer': 'hide', 'bot_event/steer': 'hide', 'bot_brief/steer': 'hide', 'advisor/steer': 'hide', 'agent/steer': 'hide',
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
      const ownerState = state.filter(s => s.cls.includes('owner-message'));
      check('owner messages are Bot bubbles with a tag, shown inside hidden agent turns', ownerState.length === OWNER_ROWS.length && ownerState.every(s => !s.hidden) && ownerState.map(s => s.tag).join('|') === 'For you|Needs you', ownerState);
      check('a renamed-Bot urgent notice is kept and a quiet one with "needs you" in its words is hidden (by id, not text)', state.find(s => s.text.startsWith('Jarvis needs you')).hidden === false && state.find(s => s.text.startsWith('Bot needs you: quiet by id')).hidden === true);
      check('an agent steer hides itself only', state.find(s => s.text === 'Agent steer fixture').hidden && !state.find(s => s.text === 'Owner turn reply after agent steer').hidden && !state.find(s => s.text === 'Owner steer fixture').hidden);
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
        const fresh = text => { const f = find(text); if (!f) throw new Error('fixture row not found: ' + text); const e = f.cloneNode(true); e.classList.remove('bot-system-notice', 'bot-brief-reply', 'bot-agent-row'); e.querySelector('.bot-brief-tag')?.remove(); return e; };
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
      check(scheme + ': Today names the hidden count', await button.innerText() === `Show ${HIDDEN} hidden messages`, await button.innerText());
      const box = await button.evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, vw: innerWidth, vh: innerHeight }; });
      check(scheme + ': button is on screen and tall enough to tap', box.left >= 0 && box.right <= box.vw && box.top >= 0 && box.bottom <= box.vh && box.h >= 40, box);
      await button.tap();
      check(scheme + ': shown', await on() && !(await page.locator('#rcBotTodayPop').count()));
      check(scheme + ': every hidden row is back', await visibleHidden() === HIDDEN);
      check(scheme + ': shown rows are subdued', await page.locator('#chat>.bot-system-notice').first().evaluate(e => +getComputedStyle(e).opacity) < 0.8);
      const pill = page.locator('#rcBotSystemPill');
      check(scheme + ': pill visible', await pill.isVisible() && /Showing hidden messages/.test(await pill.innerText()));
      const geo = await page.evaluate(() => { const p = document.getElementById('rcBotSystemPill').getBoundingClientRect(), c = document.getElementById('composerBox').getBoundingClientRect(); return { pill: [p.top, p.bottom, p.left, p.right], composerTop: c.top, vw: innerWidth }; });
      check(scheme + ': pill sits above the composer, on screen', geo.pill[1] <= geo.composerTop + 0.5 && geo.pill[2] >= 0 && geo.pill[3] <= geo.vw, geo);
      if (process.env.X056_SHOTS) await page.screenshot({ path: `${process.env.X056_SHOTS}/${engine}-iphone-${scheme}-system-shown.png` });
      await page.locator('#rcBotToday').tap();
      check(scheme + ': Today offers Hide', await button.innerText() === 'Hide agent and system messages' && await button.getAttribute('aria-pressed') === 'true');
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
    // 7. Hidden rows shown in place: an agent exchange reads as one, its replies name who they answer.
    {
      const context = await setup({ viewport: { width: 1440, height: 1000 } }); await route(context);
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.getByText('Last human answer', { exact: true }).waitFor();
      await page.locator('#rcBotToday').click(); await page.locator('#rcBotSystemHistory').click();
      const rows = await page.evaluate(() => [...document.querySelectorAll('#chat>.bot-agent-row')].map(e => ({ text: (e._messageText ?? e.textContent).trim(), ex: e.querySelector(':scope>.role')?.dataset.exchange || '', after: e.matches('.msg.assistant') ? getComputedStyle(e.querySelector(':scope>.role'), '::after').content : '', op: +getComputedStyle(e).opacity })));
      const reply = rows.find(r => r.text === 'Agent reply fixture');
      check('shown agent reply names who it answers', reply && reply.ex === 'Build agent' && /replytoBuildagent/.test(reply.after.replace(/["'\s]+/g, '')), reply);
      check('shown agent rows are dimmed', rows.length >= 8 && rows.every(r => r.op < 0.8), rows.map(r => [r.text, r.op]));
      check('the owner message inside an agent turn is not dimmed or labelled as hidden', await page.evaluate(() => { const e = [...document.querySelectorAll('#chat>.owner-message')][0]; return !e.classList.contains('bot-agent-row') && +getComputedStyle(e).opacity === 1; }));
      check('the agent steer is labelled with its sender', (await page.locator('#chat>.msg.steered.bot-agent-row').first().locator('.message-sender strong').innerText()) === 'Build agent');
      if (process.env.X056_SHOTS) await page.screenshot({ path: `${process.env.X056_SHOTS}/${engine}-desktop-hidden-shown.png` });
      await context.close();
    }

    // 8. Live: an agent turn runs in the open Bot chat. Its message, the Bot's reply and its tools stay hidden;
    //    a message_owner tool call (or the bot_message event, whichever comes first) is the owner's bubble, once.
    {
      const context = await setup({ viewport: { width: 1440, height: 1000 } }); await route(context);
      await context.addInitScript(() => {
        class FakeSource { constructor(url) { this.url = url; this.l = {}; window.__es = this; setTimeout(() => this.onopen && this.onopen({}), 0); } addEventListener(k, f) { (this.l[k] = this.l[k] || []).push(f); } close() {} }
        window.EventSource = FakeSource;
        window.__emit = (kind, data) => (window.__es.l[kind] || []).forEach(f => f({ data: JSON.stringify({ data, ts: new Date().toISOString() }), lastEventId: '' }));
      });
      const page = await context.newPage(); page.on('pageerror', pageError);
      await open(page, botPath);
      await page.getByText('Last human answer', { exact: true }).waitFor();
      const ids = { projectId: bot.id, sessionId: bot.lastSessionId };
      const emit = (kind, data) => page.evaluate(([k, d]) => window.__emit(k, d), [kind, { ...ids, ...data }]);
      const visible = text => page.evaluate(t => { const e = [...document.querySelectorAll('#chat>*')].find(x => (x._messageText ?? x.textContent).trim() === t); return e ? getComputedStyle(e).display !== 'none' : null; }, text);
      const owners = text => page.evaluate(t => [...document.querySelectorAll('#chat>.owner-message')].filter(x => x._messageText === t).map(x => x.querySelector('.owner-tag').textContent), text);
      const toolRows = () => page.evaluate(() => [...document.querySelectorAll('#chat>.act')].filter(x => /message_owner/.test(x.textContent)).length);
      await page.waitForFunction(() => window.__es);
      // An agent's message starts a hidden turn.
      await emit('session_started', { messageId: 'live-agent-1', displayPrompt: 'Live agent ping', sender: { kind: 'conversation', conversationTitle: 'Live peer', messageId: 'live-agent-1' } });
      await emit('assistant_text', { text: 'Live reply to the agent' });
      await emit('activity', { status: 'start', label: 'Used LiveTool', tool: 'LiveTool', detail: '{}', toolUseId: 'toolu_read1' });
      check('live: the agent message, the reply to it and its tool are hidden', await visible('Live agent ping') === false && await visible('Live reply to the agent') === false && await visible('Used LiveTool') === false, [await visible('Live agent ping'), await visible('Live reply to the agent')]);
      // message_owner as a tool call: the owner's bubble, not a tool row.
      const call = { status: 'start', label: 'Used mcp__x056__message_owner', tool: 'mcp__x056__message_owner', toolUseId: 'toolu_owner1', detail: JSON.stringify({ text: 'Live FYI for you', needs_you: false }) };
      await emit('activity', call);
      check('live: message_owner renders a "For you" bubble inside the hidden turn', (await owners('Live FYI for you')).join() === 'For you' && await visible('Live FYI for you') === true);
      check('live: no tool row for message_owner', await toolRows() === 0);
      await emit('activity', call);
      // The bot_message event for the same message (a different id) is the same bubble.
      await emit('bot_message', { id: 'srv-1', text: 'Live FYI for you', at: new Date().toISOString() });
      check('live: a replay and the event for the same message add no second bubble', (await owners('Live FYI for you')).length === 1, await owners('Live FYI for you'));
      // The event first, the tool call after.
      await emit('bot_message', { id: 'srv-2', text: 'Event first message', at: new Date().toISOString() });
      await emit('activity', { ...call, toolUseId: 'toolu_owner2', detail: JSON.stringify({ text: 'Event first message' }) });
      check('live: event first, then the tool call: one bubble', (await owners('Event first message')).length === 1);
      await emit('activity', { ...call, toolUseId: 'toolu_owner3', detail: JSON.stringify({ text: 'Live decision for you', needs_you: true, options: ['A', 'B'] }) });
      check('live: needs_you is a "Needs you" bubble', (await owners('Live decision for you')).join() === 'Needs you');
      await emit('assistant_text', { text: 'More agent-turn commentary' });
      check('live: the turn stays hidden around the owner bubbles', await visible('More agent-turn commentary') === false);
      // The owner's own turn: a steer from an agent hides itself, the reply after it shows.
      await emit('session_started', { messageId: 'live-owner-1', displayPrompt: 'Live owner question' });
      await emit('steered', { messageId: 'live-steer-1', text: 'Live agent steer', sender: { kind: 'conversation', conversationTitle: 'Live peer', messageId: 'live-steer-1' } });
      await emit('assistant_text', { text: 'Live owner answer' });
      check('live: the owner turn shows; an agent steer inside it hides only itself', await visible('Live owner question') === true && await visible('Live agent steer') === false && await visible('Live owner answer') === true);
      // A reload of the history (leave and come back keeps the live rows and merges them with the stored ones).
      const history = ROWS.map(([row]) => row).concat([
        { role: 'user', text: 'Live agent ping', sender: { kind: 'conversation', conversationTitle: 'Live peer', messageId: 'live-agent-1' } },
        { role: 'assistant', ownerMessage: true, needsYou: false, text: 'Live FYI for you', messageId: 'bot-owner:toolu_owner1' },
        { role: 'assistant', ownerMessage: true, needsYou: false, text: 'Event first message', messageId: 'bot-owner:toolu_other' },
      ]);
      await context.unroute(/\/api\/conversations\/history-page\?/);
      await context.route(/\/api\/conversations\/history-page\?/, r => new URL(r.request().url()).searchParams.get('projectId') !== bot.id ? r.continue() : r.fulfill({ json: { done: true, cursor: null, rows: history.map((row, i) => ({ ...row, ts: new Date(t0 + i * 1000).toISOString() })) } }));
      await open(page, '/chat/' + other.id); await open(page, botPath);
      await page.getByText('Last human answer', { exact: true }).waitFor();
      check('reload: stored owner messages and live ones are one bubble each (by id, and by text when the ids differ)',
        (await owners('Live FYI for you')).length === 1 && (await owners('Event first message')).length === 1, [await owners('Live FYI for you'), await owners('Event first message')]);
      if (process.env.X056_SHOTS) await page.screenshot({ path: `${process.env.X056_SHOTS}/${engine}-desktop-live.png` });
      await context.close();
    }
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} bot-system-history: ${checks.length} checks`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
