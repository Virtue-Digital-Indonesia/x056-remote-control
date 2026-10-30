// Agents edit and dismiss question cards over the question tools (docs/question-tools-contract.md),
// against the REAL fixture gateway (real routes, events and journal):
//  - only the asker edits its card (POST /api/questions/edit; another conversation gets 403 edit_own_only); the
//    edit re-renders the card's text, raises no push, no unread and no notice the owner is pushed, and shows a line;
//  - a dismiss from another conversation (POST /api/questions/close) goes through the ordinary send: in approval
//    mode nothing closes until the operator approves; then the card goes live and ONE line shows
//    "Question dismissed by <title>: <reason>", even inside a hidden agent turn (a 'keep' row);
//  - after a reload the line is still there, from history only (the event stream is cut for the reload);
//  - `by` stays the string 'agent' on the events, the agent itself rides in `byAgent`.
// Screenshots go to /tmp/qtool-shots/: shot A, an open card an agent just edited (edit-1440-light.png,
// edit-390-light.png, edit-1440-dark.png); shot B, after a cross-chat dismiss (dismiss-1440-light.png, dismiss-390-light.png).
// Prints the bell count right before and right after ONE agent edit (asserted equal) and what the bell counts.
// Run against the isolated browser fixture with Chat and Project spaces enabled:
//   X056_CHAT_ENABLED=1 X056_PROJECT_SPACES_ENABLED=1 X056_TEST_PORT=<port> node --import tsx test/browser/fixture.ts
//   X056_TEST_BROWSER=chromium|webkit node test/browser/question-agent-action.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const playwright = require('/usr/local/lib/node_modules/playwright');
const base = process.argv[2] || 'http://127.0.0.1:4393';
const engine = process.env.X056_TEST_BROWSER || 'chromium';
const token = 'browser-fixture-token-0123456789';
const shots = process.env.X056_QTOOL_SHOTS || '/tmp/qtool-shots';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

(async () => {
  const browser = await playwright[engine].launch(engine === 'chromium' ? { args: ['--no-sandbox'] } : {});
  const checks = [], errors = [];
  const check = (name, ok, detail) => { assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks.push(name); };
  fs.mkdirSync(shots, { recursive: true });
  const H = { Authorization: 'Bearer ' + token };
  try {
    const admin = await browser.newContext();
    const api = async (path, data) => { const r = await admin.request.post(base + path, { headers: H, data }); const body = await r.json().catch(() => null); assert.ok(r.ok(), path + ' ' + r.status() + ' ' + JSON.stringify(body)); return body; };
    const tag = randomUUID().slice(0, 6);
    const target = await api('/api/chats', { requestId: randomUUID(), name: 'Release plan ' + tag, provider: 'claude' });
    const obscura = await api('/api/chats', { requestId: randomUUID(), name: 'Obscura chat ' + tag, provider: 'claude' });
    const helper = await api('/api/chats', { requestId: randomUUID(), name: 'Helper ' + tag, provider: 'claude' });
    const ids = { projectId: target.id, sessionId: target.lastSessionId };
    const readState = async () => ((await (await admin.request.get(base + '/api/conversations/read-state', { headers: H })).json()).items || {})[ids.projectId + '::' + ids.sessionId] || {};
    const ask = () => api('/api/questions/ask', { from: ids.sessionId, ...ids, questions: [{ question: 'Deploy the release tonight?', options: ['Yes, tonight', 'Wait for Monday'] }] });

    // The history around the card: the owner's turn, then a turn ANOTHER conversation started (hidden by the owner
    // view). Everything the gateway journals comes after it, so the agent-action line sits inside the hidden agent turn.
    const t0 = Date.now() - 10 * 60000, iso = m => new Date(t0 + m * 60000).toISOString();
    const seeded = [
      { role: 'user', text: 'Plan the release for this week.', ts: iso(0) },
      { role: 'assistant', text: 'The release is ready. I asked whether to deploy tonight.', ts: iso(1) },
      { role: 'user', text: 'Is the release question still open?', ts: iso(2), sender: { kind: 'conversation', messageId: 'agent-qa-' + tag, sessionId: obscura.lastSessionId, conversationTitle: 'Obscura chat ' + tag, projectName: 'Obscura' } },
      { role: 'assistant', text: 'It is; I will let the owner know.', ts: iso(3) },
    ];

    const open = async (opts = {}) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: opts.width || 1440, height: opts.height || 900 } });
      await context.addInitScript(([t, theme]) => { localStorage.setItem('x056_token', t); localStorage.setItem('x056_theme', theme); }, [token, opts.theme || 'light']);
      // Count every desktop notification the panel would show, and record the question events as the panel got them.
      await context.addInitScript(() => {
        window.__notifications = 0;
        function N() { window.__notifications++; } N.permission = 'granted'; N.requestPermission = () => Promise.resolve('granted');
        window.Notification = N;
        window.__events = [];
        const Real = window.EventSource;
        if (Real) window.EventSource = class extends Real {
          addEventListener(kind, f, o) {
            if (/^question/.test(kind)) super.addEventListener(kind, e => { try { window.__events.push({ kind, data: JSON.parse(e.data).data }); } catch {} }, o);
            return super.addEventListener(kind, f, o);
          }
        };
      });
      if (opts.noStream) await context.route(/\/api\/sessions\/current\/stream/, route => route.fulfill({ headers: { 'Content-Type': 'text/event-stream' }, body: ': fixture heartbeat\n\n' }));
      await context.route(/\/api\/conversations\/history-page\?/, async route => {
        if (new URL(route.request().url()).searchParams.get('projectId') !== ids.projectId) return route.continue();
        const response = await route.fetch(), data = await response.json();
        await route.fulfill({ response, json: { ...data, rows: [...seeded, ...(data.rows || [])] } });
      });
      const page = await context.newPage();
      page.on('pageerror', e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); });
      await page.goto(base + '/chat/' + ids.projectId);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .msg.assistant').first().waitFor();
      await page.waitForTimeout(500);
      return { context, page };
    };
    const lines = page => page.evaluate(() => [...document.querySelectorAll('#chat .notice[data-question-action]')].map(e => ({ text: e.textContent.trim(), shown: getComputedStyle(e).display !== 'none' })));
    const cards = page => page.locator('#chat .qcard.pending').count();
    const settle = (page, ms = 400) => page.waitForTimeout(ms);
    // The dismissal message the asker is sent runs a (fixture) turn; let it end so the shot is not mid-spinner.
    const idle = page => page.waitForFunction(() => !document.querySelector('#busy .spin'), null, { timeout: 15000 }).catch(() => {});
    // The line sits directly above the open card: before it in DOM order, nothing visible in between.
    const lineAboveCard = (page, text) => page.evaluate(t => {
      const line = [...document.querySelectorAll('#chat .notice[data-question-action]')].find(e => e.textContent.trim() === t), card = document.querySelector('#chat .qcard.pending');
      if (!line || !card) return { ok: false, line: !!line, card: !!card };
      const before = !!(line.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING);
      const between = []; for (let n = line.nextElementSibling; n && n !== card; n = n.nextElementSibling) if (getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().height > 0) between.push(n.className);
      return { ok: before && line.parentNode === card.parentNode && between.length === 0, before, between };
    }, text);
    // Top-bar bell, and the sidebar bell of this conversation when the sidebar shows its row.
    const bell = page => page.evaluate(sid => ({ top: document.getElementById('crNotifications')?.dataset.unread || '0', sidebar: (() => { const b = document.querySelector('.conv[data-sid="' + sid + '"] .nbell'); return b ? (b.hidden ? 'off' : b.className) : 'no row'; })() }), ids.sessionId);
    // What the bell counts: the notification menu's entries (opened, read, closed again).
    const bellEntries = async page => {
      await page.click('#crNotifications');
      const d = page.locator('dialog.rc-notification-dialog'); await d.waitFor();
      const entries = await d.evaluate(el => [...el.querySelectorAll('.rc-notification-item')].map(i => i.className.replace('rc-notification-item ', '') + ' | ' + i.querySelector('strong').textContent + ' | ' + i.querySelector('.rc-notification-body').textContent.replace(/\s+/g, ' ').slice(0, 80)));
      await page.keyboard.press('Escape'); await d.waitFor({ state: 'detached' }); await page.evaluate(() => document.activeElement?.blur()); await page.mouse.move(5, 600);
      return entries;
    };
    const pendingQuestions = async () => (await (await admin.request.get(base + '/api/questions', { headers: H })).json()).map(q => q.sessionId === ids.sessionId ? 'this chat: ' + q.question : q.sessionId);

    // 1. An open card, seen live.
    const asked = await ask();
    check('ask_user opened a card', asked.status === 'open' && asked.questions.length === 1, asked);
    let { context, page } = await open();
    await page.locator('#chat .qcard.pending').waitFor();
    check('the card shows', await cards(page) === 1 && /Deploy the release tonight\?/.test(await page.locator('#chat .qcard.pending').innerText()));
    check('the agent turn is hidden behind one button', await page.locator('#chat>.ov-btn').count() === 1 && await page.evaluate(() => [...document.querySelectorAll('#chat>.msg')].filter(e => getComputedStyle(e).display === 'none').length) === 2);

    // 2. ONE agent edit (shot A): the card re-renders with the new text, no push, no unread, the bell does not move,
    //    and the line sits directly above the card.
    const beforeEdit = await readState();
    const notesBefore = await page.evaluate(() => window.__notifications);
    const foreign = await admin.request.post(base + '/api/questions/edit', { headers: H, data: { from: helper.lastSessionId, ...ids, at: asked.at, id: asked.questions[0].id, question: 'Hijack?', reason: 'r' } });
    check('another conversation cannot edit the card: 403 edit_own_only', foreign.status() === 403 && (await foreign.json()).error === 'edit_own_only');
    await settle(page);
    const bellBefore = await bell(page);
    const edited = await api('/api/questions/edit', { from: ids.sessionId, ...ids, at: asked.at, id: asked.questions[0].id, question: 'Deploy the release on Monday instead?', options: ['Yes, Monday', 'No, hold it'], reason: 'Tonight is a change freeze' });
    check('the edit kept at and the id', edited.at === asked.at && edited.questions[0].id === asked.questions[0].id, edited);
    await page.locator('#chat .qcard.pending', { hasText: 'Monday instead' }).waitFor({ timeout: 5000 });
    const editLine = 'Question edited by Release plan ' + tag + ': Tonight is a change freeze';
    await page.waitForFunction(t => [...document.querySelectorAll('#chat .notice[data-question-action]')].some(e => e.textContent.trim() === t), editLine, { timeout: 5000 });
    await settle(page, 800);
    const bellAfter = await bell(page);
    console.log(`bell before edit: ${bellBefore.top}, after edit: ${bellAfter.top} (sidebar bell of this chat: ${bellBefore.sidebar} -> ${bellAfter.sidebar})`);
    check('the top-bar bell and the sidebar bell do not move for the edit', JSON.stringify(bellBefore) === JSON.stringify(bellAfter), { bellBefore, bellAfter });
    check('the edited card re-renders with the new text and options, still one card', await cards(page) === 1 && !/tonight\?/.test(await page.locator('#chat .qcard.pending').innerText()) && /Yes, Monday/.test(await page.locator('#chat .qcard.pending').innerText()));
    check('the edit line shows, once, inside the hidden agent turn', JSON.stringify(await lines(page)) === JSON.stringify([{ text: editLine, shown: true }]), await lines(page));
    check('live: the edit line sits directly above the card', (await lineAboveCard(page, editLine)).ok, await lineAboveCard(page, editLine));
    // The stream replays the gateway's whole buffer (earlier runs included): keep this conversation's events.
    const mine = async () => (await page.evaluate(() => window.__events)).filter(e => e.data && e.data.projectId === ids.projectId && e.data.sessionId === ids.sessionId);
    const events = await mine();
    const editEvent = events.find(e => e.kind === 'question' && e.data.edited);
    const editAction = events.find(e => e.kind === 'question_agent_action' && e.data.action === 'edited');
    check('the edit event: by stays the string "agent", byAgent names the asker', editEvent && editEvent.data.by === 'agent' && editEvent.data.byAgent?.title === 'Release plan ' + tag && editEvent.data.byAgent?.sessionId === ids.sessionId, editEvent);
    // screenSuppressed is the push gate (server/push.ts) and the panel's notify() gate; the tier stays the question's own.
    check('the edit event is quiet: remainder + screenSuppressed (no push, no pop-up)', editEvent.data.remainder === true && editEvent.data.notice?.screenSuppressed === true, editEvent.data.notice);
    check('the edit line event is quiet and carries by/byAgent', editAction && editAction.data.by === 'agent' && editAction.data.byAgent?.title === 'Release plan ' + tag && editAction.data.notice?.tier === 'quiet', editAction);
    check('no desktop notification for the edit', await page.evaluate(() => window.__notifications) === notesBefore);
    const afterEdit = await readState();
    check('no unread raised by the edit', !afterEdit.unread && (afterEdit.noticeAt || 0) === (beforeEdit.noticeAt || 0), { beforeEdit, afterEdit });
    await page.screenshot({ path: shots + '/edit-1440-light.png' });
    console.log('bell entries in shot A (card open): ' + JSON.stringify(await bellEntries(page)) + '; pending questions: ' + JSON.stringify(await pendingQuestions()));

    // Shot A on fresh loads (phone width, dark): the line comes from history, the card from /api/questions; same
    // order as live, and the same bell count as the live page right after the edit.
    for (const [file, opts] of [['edit-390-light.png', { width: 390, height: 844 }], ['edit-1440-dark.png', { width: 1440, height: 900, theme: 'dark' }]]) {
      const v = await open(opts);
      await v.page.locator('#chat .qcard.pending', { hasText: 'Monday instead' }).waitFor({ timeout: 5000 });
      await v.page.waitForFunction(() => document.querySelectorAll('#chat .notice[data-question-action]').length >= 1, null, { timeout: 8000 });
      await settle(v.page, 600);
      check(file + ': one edit line, shown', JSON.stringify(await lines(v.page)) === JSON.stringify([{ text: editLine, shown: true }]), await lines(v.page));
      check(file + ': after reload the edit line sits directly above the card', (await lineAboveCard(v.page, editLine)).ok, await lineAboveCard(v.page, editLine));
      const b = await bell(v.page);
      console.log(`${file}: bell ${b.top}`);
      check(file + ': the bell matches the live count right after the edit', b.top === bellAfter.top, { fresh: b, live: bellAfter });
      await v.page.screenshot({ path: shots + '/' + file });
      await v.context.close();
    }

    // 3. A dismiss from the Obscura chat goes through the ordinary send (approval mode): nothing closes until the
    //    operator approves; then the card goes, one line shows live, and the asker is sent one message (shot B).
    await api('/api/settings/mcp-send-mode', { mode: 'approval' });
    const dismissed = await api('/api/questions/close', { from: obscura.lastSessionId, ...ids, at: asked.at, action: 'dismiss', reason: 'Answered in the Obscura chat' });
    check('the cross dismiss waits for approval', dismissed.mode === 'approval' && dismissed.status === 'pending_approval' && !!dismissed.approvalId, dismissed);
    await settle(page);
    check('before approve the card is still open', await cards(page) === 1);
    const approved = await api('/api/mcp/approvals/decide', { id: dismissed.approvalId, approve: true });
    check('on approve the card closed at delivery', approved.status === 'approved' && approved.cardClosed === true && /Your open question was dismissed by Obscura chat/.test(approved.message), approved);
    const dismissLine = 'Question dismissed by Obscura chat ' + tag + ': Answered in the Obscura chat';
    await page.waitForFunction(t => [...document.querySelectorAll('#chat .notice[data-question-action]')].some(e => e.textContent.trim() === t), dismissLine, { timeout: 5000 });
    await settle(page, 800);
    check('the card disappears', await cards(page) === 0);
    const live = await lines(page);
    check('live after the dismiss: the edit line and ONE dismiss line, both shown', JSON.stringify(live) === JSON.stringify([{ text: editLine, shown: true }, { text: dismissLine, shown: true }]), live);
    const dismissEvent = (await mine()).find(e => e.kind === 'question_dismissed');
    check('question_dismissed: by "agent", byAgent the Obscura chat', dismissEvent && dismissEvent.data.by === 'agent' && dismissEvent.data.byAgent?.title === 'Obscura chat ' + tag, dismissEvent);
    check('no desktop notification for the dismiss', await page.evaluate(() => window.__notifications) === notesBefore);
    await idle(page); await settle(page);
    await page.screenshot({ path: shots + '/dismiss-1440-light.png' });
    console.log(`bell after dismiss: ${(await bell(page)).top}; entries: ` + JSON.stringify(await bellEntries(page)) + '; pending questions: ' + JSON.stringify(await pendingQuestions()));
    await context.close();

    // 4. Reload with the event stream cut: only history can bring the lines back (shot B at phone width).
    ({ context, page } = await open({ noStream: true, width: 390, height: 844 }));
    await page.waitForFunction(n => document.querySelectorAll('#chat .notice[data-question-action]').length >= n, 2, { timeout: 8000 });
    await settle(page, 600);
    const reloaded = await lines(page);
    check('after a reload both lines are back from history, once each, shown', JSON.stringify(reloaded) === JSON.stringify([{ text: editLine, shown: true }, { text: dismissLine, shown: true }]), reloaded);
    check('after a reload no card', await cards(page) === 0);
    // The seeded agent turn and the dismissal message the asker was sent (an agent turn too) both stay hidden.
    const rowsAfter = await page.evaluate(() => [...document.querySelectorAll('#chat>.msg')].map(e => ({ text: e.textContent, shown: getComputedStyle(e).display !== 'none' })));
    const dismissMsg = rowsAfter.filter(r => /Your open question was dismissed by Obscura chat/.test(r.text) && /Deploy the release on Monday instead\?/.test(r.text));
    check('after a reload the asker holds ONE dismissal message naming the question, hidden as an agent turn', dismissMsg.length === 1 && !dismissMsg[0].shown, dismissMsg);
    check('after a reload both agent turns are still hidden behind their buttons', await page.locator('#chat>.ov-btn').count() === 2 && rowsAfter.slice(2).every(r => !r.shown), rowsAfter.map(r => r.shown));
    await idle(page);
    await page.screenshot({ path: shots + '/dismiss-390-light.png' });
    await context.close();
    await admin.close();
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} question-agent-action: ${checks.length} checks; screenshots in ${shots}`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
