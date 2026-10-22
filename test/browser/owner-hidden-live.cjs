// Owner view in a NORMAL conversation, live: an agent turn (another conversation's message) stays hidden behind one
// inline button unless it is marked for the owner (session_done {forOwner}, owner_view); an owner turn shows; a question
// card stays up; Show reveals everything dimmed and labelled with a pill, Hide restores, switching conversations resets;
// a history reload does not duplicate the hidden live rows; the RESOLVED / FOR_OWNER markers are never visible; the Bot
// chat keeps its own mode. Events are driven through a fake EventSource.
//   X056_TEST_BROWSER=chromium|webkit node test/browser/owner-hidden-live.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const checks = [], errors = [];
  const check = (name, ok, detail) => { assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks.push(name); };
  try {
    const admin = await browser.newContext();
    const make = async name => { const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: name + ' ' + randomUUID(), provider: 'claude' } }); assert.ok(r.ok(), await r.text()); return r.json(); };
    const chat = await make('Owner live'), other = await make('Other chat'), bot = await make('Bot live');
    await admin.close();
    const ids = { projectId: chat.id, sessionId: chat.lastSessionId };
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
    await context.addInitScript(() => {
      class FakeSource { constructor(url) { this.url = url; this.l = {}; window.__es = this; setTimeout(() => this.onopen && this.onopen({}), 0); } addEventListener(k, f) { (this.l[k] = this.l[k] || []).push(f); } close() {} }
      window.EventSource = FakeSource;
      window.__emit = (kind, data) => (window.__es.l[kind] || []).forEach(f => f({ data: JSON.stringify({ data, ts: new Date().toISOString() }), lastEventId: '' }));
    });
    const ts = s => new Date(Date.now() - s * 1000).toISOString();
    let served = [{ role: 'user', text: 'Start the release', ts: ts(900) }, { role: 'assistant', text: 'Release started.', ts: ts(890) }];
    let questions = [], hold = null;
    await context.route('**/api/questions', route => route.fulfill({ json: questions }));
    await context.route('**/api/bot', route => route.fulfill({ json: { enabled: true, projectId: bot.id, sessionId: bot.lastSessionId, url: '/chat/' + bot.id, briefAt: '07:30', tz: 'Asia/Jakarta', name: 'Bot', attention: null } }));
    await context.route(/\/api\/projects(\?|$)/, async route => { const response = await route.fetch(), data = await response.json(); for (const p of data.projects) if (p.id === bot.id) p.bot = true; await route.fulfill({ response, json: data }); });
    await context.route(/\/api\/conversations\/history-page\?/, async route => {
      const pid = new URL(route.request().url()).searchParams.get('projectId');
      if (pid === bot.id) return route.fulfill({ json: { done: true, cursor: null, rows: [{ role: 'user', text: 'hi', ts: ts(60) }, { role: 'assistant', text: 'hello', ts: ts(50) }] } });
      if (pid === other.id) return route.fulfill({ json: { done: true, cursor: null, rows: [{ role: 'user', text: 'other hello', ts: ts(60) }, { role: 'assistant', text: 'other reply', ts: ts(50) }] } });
      if (hold) await hold;
      return route.fulfill({ json: { done: true, cursor: null, rows: served } });
    });
    const page = await context.newPage();
    page.on('pageerror', e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); });
    await page.goto(base + '/chat/' + chat.id);
    await page.waitForFunction(() => window.rcWorkspace?.ready() && window.__es);
    await page.locator('#chat .msg.assistant').first().waitFor();
    const emit = (kind, data) => page.evaluate(([k, d]) => window.__emit(k, d), [kind, { ...ids, ...data }]);
    const settle = () => page.waitForTimeout(120);
    const visible = () => page.evaluate(() => [...document.querySelectorAll('#chat>*')].filter(e => getComputedStyle(e).display !== 'none' && !e.matches('.ov-btn,.older-bar') && !(e.matches('.sysline') && /earlier messages|no messages/.test(e.textContent))).map(e => (e._messageText || e.textContent).trim().slice(0, 40)));
    const buttons = () => page.evaluate(() => [...document.querySelectorAll('#chat>.ov-btn')].filter(b => getComputedStyle(b).display !== 'none').map(b => ({ tag: b.tagName, text: b.textContent.trim(), label: b.getAttribute('aria-label') })));
    const chatText = () => page.evaluate(() => document.getElementById('chat').innerText);
    const agent = (n, extra = {}) => ({ kind: 'conversation', conversationTitle: 'Valid Deployment', projectName: 'obscura', messageId: 'agent-' + n, sessionId: 'peer-session-' + n, ...extra });

    check('an owner conversation starts with nothing hidden', (await buttons()).length === 0 && (await visible()).length === 2);

    // 1. An agent turn stays hidden: one real button, "N hidden messages from <sender>".
    await emit('session_started', { messageId: 'agent-1', displayPrompt: 'Is the deploy green?', sender: agent(1) });
    await emit('assistant_text', { text: 'Yes, it is green. No action needed, no reply needed.' });
    await emit('session_done', { status: 'completed', triggerMessageId: 'agent-1', ownerHidden: true });
    await settle();
    let b = await buttons();
    check('the hidden agent turn is not visible', (await visible()).join('|') === 'Start the release|Release started.', await visible());
    check('one real button says how many and from whom', b.length === 1 && b[0].tag === 'BUTTON' && b[0].text === '2 hidden messages from Valid Deployment' && /^Show 2 hidden messages from Valid Deployment$/.test(b[0].label), b);
    check('the hidden text is nowhere on screen', !/green|Is the deploy/.test(await chatText()));

    // 2. A turn marked for the owner shows whole once done; the marker never shows.
    await emit('session_started', { messageId: 'agent-2', displayPrompt: 'Deploy finished, please review', sender: agent(2) });
    await emit('assistant_text', { text: 'The release is out.\n<<<FOR_OWNER>>>' });
    await settle();
    check('while it runs an unmarked agent turn is hidden', !(await visible()).some(t => /release is out/.test(t)));
    await emit('session_done', { status: 'completed', triggerMessageId: 'agent-2', forOwner: true });
    await settle();
    const v2 = await visible();
    check('a turn marked forOwner shows whole', v2.some(t => /Deploy finished/.test(t)) && v2.some(t => /The release is out/.test(t)), v2);
    check('the FOR_OWNER marker is never visible', !/FOR_OWNER/.test(await chatText()));
    check('the earlier hidden turn is still behind its one button', (await buttons()).length === 1);

    // 3. owner_view marks a finished hidden turn.
    await emit('session_started', { messageId: 'agent-3', displayPrompt: 'Late news from the pipeline', sender: agent(3) });
    await emit('assistant_text', { text: 'Pipeline found a regression.' });
    await emit('session_done', { status: 'completed', triggerMessageId: 'agent-3', ownerHidden: true });
    await settle();
    check('the third agent turn is hidden', !(await visible()).some(t => /Late news/.test(t)));
    check('two runs have two buttons', (await buttons()).length === 2);
    await emit('owner_view', { messageId: 'agent-3', shown: true, reason: 'ask' });
    await settle();
    check('owner_view shows a finished hidden turn', (await visible()).some(t => /Late news/.test(t)) && (await visible()).some(t => /regression/.test(t)));
    check('and its button goes with it', (await buttons()).length === 1);

    // 4. An owner turn shows; its reply too.
    await emit('session_started', { messageId: 'own-1', displayPrompt: 'thanks, what about staging?' });
    await emit('assistant_text', { text: 'Staging is fine.\n<<<RESOLVED>>>' });
    await emit('session_done', { status: 'completed' });
    await settle();
    const v4 = await visible();
    check('an owner turn shows', v4.some(t => /what about staging/.test(t)) && v4.some(t => /Staging is fine/.test(t)));
    check('the RESOLVED marker is never visible', !/RESOLVED/.test(await chatText()));

    // 5. A question card created during an agent turn stays visible.
    await emit('session_started', { messageId: 'agent-4', displayPrompt: 'Another peer note', sender: agent(4) });
    await emit('assistant_text', { text: 'Peer thinks aloud.' });
    const q = { question: 'Ship it to production?', options: ['Ship', 'Wait'], at: new Date().toISOString() };
    questions = [{ ...ids, ...q }];
    await emit('question', q);
    await settle();
    check('the question card is visible in a hidden agent turn', await page.locator('#chat .qcard.pending').isVisible());
    check('and the agent turn around it is hidden', !(await visible()).some(t => /Peer thinks aloud|Another peer note/.test(t)));
    await emit('session_done', { status: 'completed', triggerMessageId: 'agent-4', ownerHidden: true });
    await settle();
    check('the card survives the turn ending', await page.locator('#chat .qcard.pending').isVisible());
    questions = [];
    await emit('question_answered', {});
    await settle();

    // 6. Show reveals dimmed + labelled + pill; Hide restores.
    const hiddenCount = await page.evaluate(() => document.querySelectorAll('#chat>.ov-hidden').length);
    const before = await visible();
    check('the pill is not there before Show', !(await page.locator('#rcOwnerPill').isVisible()));
    const first = page.locator('#chat>.ov-btn').first();
    await first.focus(); await page.keyboard.press('Enter');
    await settle();
    check('Show reveals every hidden row', await page.evaluate(() => [...document.querySelectorAll('#chat>.ov-hidden')].every(e => getComputedStyle(e).display !== 'none')) && hiddenCount > 0);
    check('the inline buttons are gone while shown', (await buttons()).length === 0);
    check('revealed rows are dimmed', await page.evaluate(() => [...document.querySelectorAll('#chat>.ov-hidden')].every(e => +getComputedStyle(e).opacity < 1)));
    check('the pill says so', /Showing hidden messages\s*·\s*Hide/.test((await page.locator('#rcOwnerPill').innerText()).replace(/\s+/g, ' ')));
    const label = await page.evaluate(() => { const r = document.querySelector('#chat>.msg.assistant.ov-hidden>.role'); return r ? getComputedStyle(r, '::after').content : ''; });
    check('a hidden agent reply is labelled "reply to <sender>"', /reply to Valid Deployment/.test(label), label);
    check('the FOR_OWNER and RESOLVED markers stay hidden while shown', !/FOR_OWNER|RESOLVED/.test(await chatText()));
    await page.locator('#rcOwnerHide').click();
    await settle();
    check('Hide restores the default view', JSON.stringify(await visible()) === JSON.stringify(before) && !(await page.locator('#rcOwnerPill').isVisible()) && (await buttons()).length === hiddenRunsOf(before));
    check('focus returns to an inline button', await page.evaluate(() => document.activeElement?.classList.contains('ov-btn')));
    function hiddenRunsOf() { return 2; }

    // 7. A history reload while hidden live rows exist does not duplicate rows.
    served = [
      { role: 'user', text: 'Start the release', ts: ts(900) }, { role: 'assistant', text: 'Release started.', ts: ts(890) },
      { role: 'user', text: 'Is the deploy green?', ts: ts(800), messageId: 'agent-1', sender: agent(1), ownerView: 'hide' },
      { role: 'assistant', text: 'Yes, it is green. No action needed, no reply needed.', ts: ts(795), ownerView: 'hide' },
      { role: 'user', text: 'Deploy finished, please review', ts: ts(700), messageId: 'agent-2', sender: agent(2), forOwner: true },
      { role: 'assistant', text: 'The release is out.', ts: ts(695) },
    ];
    served.push(
      { role: 'user', text: 'Live peer ping', ts: ts(30), messageId: 'agent-5', sender: agent(5), ownerView: 'hide' },
      { role: 'assistant', text: 'Live peer answer.', ts: ts(25), ownerView: 'hide' });
    // The reload is in flight (held) while the live turn's rows arrive; the reply then carries the same rows.
    let release; hold = new Promise(r => { release = r; });
    await page.evaluate(() => document.getElementById('chatRefresh')?.click());
    await settle();
    await emit('session_started', { messageId: 'agent-5', displayPrompt: 'Live peer ping', sender: agent(5) });
    await emit('assistant_text', { text: 'Live peer answer.' });
    await settle();
    release(); hold = null;
    await page.waitForFunction(() => /Release started/.test(document.getElementById('chat').innerText) && document.querySelectorAll('#chat>.msg').length >= 6, null, { timeout: 8000 });
    await settle();
    const after = await page.evaluate(() => [...document.querySelectorAll('#chat>.msg')].map(e => (e._messageText || '').trim()));
    const dupes = after.filter((t, i) => after.indexOf(t) !== i);
    check('reloading history while hidden live rows exist does not duplicate rows', dupes.length === 0 && after.filter(t => t === 'Live peer answer.').length === 1 && after.filter(t => t === 'Live peer ping').length === 1, { dupes, after });
    check('the hidden live rows are still hidden after the reload', !(await visible()).some(t => /Live peer/.test(t)) && (await buttons()).length >= 1 && (await buttons()).every(x => x.tag === 'BUTTON'));
    check('the marked turn from history shows, the others sit behind buttons', (await visible()).some(t => /The release is out/.test(t)) && !(await visible()).some(t => /deploy green/.test(t)) && (await buttons()).length === 2, await buttons());

    // 8. Switching conversations resets Show.
    await page.locator('#chat>.ov-btn').first().click();
    await settle();
    check('Show is on', await page.evaluate(() => document.body.classList.contains('rc-ov-show')));
    await page.goto(base + '/chat/' + other.id);
    await page.waitForFunction(() => window.rcWorkspace?.ready() && window.__es);
    await page.locator('#chat .msg.assistant').first().waitFor();
    check('another conversation starts hidden again', await page.evaluate(() => !document.body.classList.contains('rc-ov-show')) && !(await page.locator('#rcOwnerPill').isVisible()));
    // In-app switch (no reload): Show here, then go back to the first chat through the list.
    await page.evaluate(([o]) => window.__emit('session_started', { projectId: o.projectId, sessionId: o.sessionId, messageId: 'agent-9', displayPrompt: 'peer to other', sender: { kind: 'mcp', messageId: 'agent-9', conversationTitle: 'Tool caller' } }), [{ projectId: other.id, sessionId: other.lastSessionId }]);
    await page.evaluate(([o]) => window.__emit('assistant_text', { projectId: o.projectId, sessionId: o.sessionId, text: 'tool answer' }), [{ projectId: other.id, sessionId: other.lastSessionId }]);
    await settle();
    await page.locator('#chat>.ov-btn').first().click(); await settle();
    check('Show is on in the second chat', await page.evaluate(() => document.body.classList.contains('rc-ov-show')));
    await page.evaluate(id => document.querySelector('a[data-chat-link][data-chat="' + id + '"]')?.click(), chat.id);
    await page.waitForFunction(t => /Start the release/.test(document.getElementById('chat').innerText), null, { timeout: 8000 });
    await settle();
    check('switching conversations in the app resets Show', await page.evaluate(() => !document.body.classList.contains('rc-ov-show')) && (await buttons()).length >= 1);

    // 9. The Bot chat keeps its own mode.
    await page.goto(base + '/chat/' + bot.id);
    await page.waitForFunction(() => window.rcWorkspace?.ready() && window.__es);
    await page.locator('#chat .msg.assistant').first().waitFor();
    const botIds = { projectId: bot.id, sessionId: bot.lastSessionId };
    await page.evaluate(([i, s]) => window.__emit('session_started', { ...i, messageId: 'agent-b1', displayPrompt: 'peer to bot', sender: s }), [botIds, agent(7)]);
    await page.evaluate(([i]) => window.__emit('assistant_text', { ...i, text: 'bot reply to peer' }), [botIds]);
    await settle();
    const botState = await page.evaluate(() => ({ bot: document.body.classList.contains('rc-bot-chat'), ov: document.querySelectorAll('#chat>.ov-btn,#chat>.ov-hidden').length, hidden: [...document.querySelectorAll('#chat>.bot-system-notice')].length, pill: getComputedStyle(document.getElementById('rcOwnerPill')).display }));
    check('the Bot chat keeps its own mode and gets no owner-view furniture', botState.bot && botState.ov === 0 && botState.hidden >= 2 && botState.pill === 'none', botState);

    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} owner-hidden-live: ${checks.length} checks`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
