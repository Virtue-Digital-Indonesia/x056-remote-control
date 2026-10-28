// An open question survives agent messages (every conversation, not only the Bot's): a turn started by another
// conversation leaves the card up; a merged `question` batch re-renders the card with every question and keeps
// what the owner already chose or typed; question_answered clears it; no session_started does, the owner's own
// included (a message that is not an answer leaves it open). A partly answered batch is re-sent as a `question`
// with the same `at`: the card shows what is left, in either order against the answer's HTTP response, and
// stays dismissable. The card's own answer carries answersQuestionAt.
// The <<<RESOLVED>>> marker is never shown. Events are driven through a fake EventSource.
// Run against the isolated browser fixture:
//   X056_TEST_BROWSER=chromium|webkit node test/browser/question-survives-agent.cjs http://127.0.0.1:<port>
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
    const r = await admin.request.post(base + '/api/chats', { headers: { Authorization: 'Bearer ' + token }, data: { requestId: randomUUID(), name: 'Question chat ' + randomUUID(), provider: 'claude' } });
    assert.ok(r.ok(), await r.text());
    const chat = await r.json();
    await admin.close();

    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await context.addInitScript(t => localStorage.setItem('x056_token', t), token);
    await context.addInitScript(() => {
      class FakeSource { constructor(url) { this.url = url; this.l = {}; window.__es = this; setTimeout(() => this.onopen && this.onopen({}), 0); } addEventListener(k, f) { (this.l[k] = this.l[k] || []).push(f); } close() {} }
      window.EventSource = FakeSource;
      window.__emit = (kind, data) => (window.__es.l[kind] || []).forEach(f => f({ data: JSON.stringify({ data, ts: new Date().toISOString() }), lastEventId: '' }));
    });
    const at1 = new Date(Date.now() - 60000).toISOString(), at2 = new Date().toISOString();
    const ids = { projectId: chat.id, sessionId: chat.lastSessionId };
    const first = { ...ids, question: 'Which file?', options: ['a.ts', 'b.ts'], at: at1 };
    // What the server holds (a rehydrate after a reconnect must agree with the events the test sends).
    let served = first;
    await context.route('**/api/questions', route => route.fulfill({ json: served ? [served] : [] }));
    await context.route(/\/api\/conversations\/history-page\?/, route => route.fulfill({ json: { done: true, cursor: null, rows: [{ role: 'user', text: 'Start', ts: new Date(Date.now() - 90000).toISOString() }, { role: 'assistant', text: 'Which file?', ts: new Date(Date.now() - 80000).toISOString() }] } }));
    const page = await context.newPage();
    page.on('pageerror', e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); });
    await page.goto(base + '/chat/' + chat.id);
    await page.waitForFunction(() => window.rcWorkspace?.ready() && window.__es);
    const card = page.locator('#chat .qcard.pending');
    await card.waitFor(); await page.waitForTimeout(600);
    const emit = (kind, data) => page.evaluate(([k, d]) => window.__emit(k, d), [kind, { ...ids, ...data }]);
    const cards = () => page.locator('#chat .qcard.pending').count();
    check('the question card is shown', await cards() === 1 && /Which file\?/.test(await card.innerText()));

    // 1. An agent's message starts a turn: the card stays. Its reply never shows the marker.
    await emit('session_started', { messageId: 'agent-1', displayPrompt: 'Peer asks something', sender: { kind: 'conversation', conversationTitle: 'Peer', messageId: 'agent-1' } });
    await emit('assistant_text', { text: 'That does not settle it.' });
    await emit('session_done', { status: 'completed' });
    check('an agent turn (sender conversation) leaves the card up', await cards() === 1);
    await emit('assistant_text', { text: 'Settled: use b.ts.\n<<<RESOLVED>>>' });
    const reply = await page.evaluate(() => [...document.querySelectorAll('#chat>.msg.assistant')].map(e => e._messageText).find(t => /Settled/.test(t)));
    const shown = await page.evaluate(() => document.getElementById('chat').innerText);
    check('<<<RESOLVED>>> is stripped from the displayed reply', reply === 'Settled: use b.ts.' && !/RESOLVED/.test(shown), [reply]);
    for (const kind of ['mcp', 'automation', 'delegate', 'advisor', 'recap']) {
      await emit('session_started', { messageId: kind + '-1', displayPrompt: kind + ' message', sender: { kind, messageId: kind + '-1' } });
    }
    check('no non-human sender kind clears it', await cards() === 1);

    // 2. A merged batch: both questions show; nothing already chosen is lost when it grows.
    const q = (question, options) => ({ question, options });
    const emitQuestion = async data => { served = { ...ids, ...data }; await emit('question', data); await page.waitForTimeout(300); /* let the card settle, as a person would */ };
    await emitQuestion({ ...first, questions: [q('Which file?', ['a.ts', 'b.ts']), q('Which env?', ['dev', 'prod'])] });
    check('the merged event shows both questions in one card', await cards() === 1 && await page.locator('#chat .qcard.pending fieldset').count() === 2, await page.locator('#chat .qcard.pending').innerText());
    const pick = page.locator('#chat .qcard.pending fieldset').nth(0).getByLabel('b.ts');
    for (let i = 0; i < 5 && !(await pick.isChecked()); i++) { await pick.click(); await page.waitForTimeout(300); } // WebKit can need a moment before a radio reads as checked
    check('the first answer is chosen', await pick.isChecked());
    await page.locator('#chat .qcard.pending fieldset').nth(1).locator('.qcustom').fill('staging');
    await emitQuestion({ ...first, at: at2, questions: [q('Which file?', ['a.ts', 'b.ts']), q('Which env?', ['dev', 'prod']), q('Run the tests?', ['yes', 'no'])] });
    const state = await page.evaluate(() => [...document.querySelectorAll('#chat .qcard.pending fieldset')].map(g => ({ q: g.querySelector('legend').textContent, checked: g.querySelector(':checked')?.value || '', custom: g.querySelector('.qcustom').value })));
    check('a batch that grows keeps the chosen option and the typed answer', state.length === 3 && state[0].checked === 'b.ts' && state[1].custom === 'staging' && state[2].checked === '' && state[2].custom === '', state);
    // The same batch arriving again with the same at (a replay) does not reset it either.
    await emitQuestion({ ...first, at: at2, questions: [q('Which file?', ['a.ts', 'b.ts']), q('Which env?', ['dev', 'prod']), q('Run the tests?', ['yes', 'no'])] });
    check('a replay leaves the answers alone', await page.locator('#chat .qcard.pending fieldset').nth(0).getByLabel('b.ts').isChecked() && await cards() === 1);
    // A batch of the same `at` that gains a question still re-renders (the at alone is not the identity).
    await emitQuestion({ ...first, at: at2, questions: [q('Which file?', ['a.ts', 'b.ts']), q('Which env?', ['dev', 'prod']), q('Run the tests?', ['yes', 'no']), q('Deploy?', ['no'])] });
    check('same at, one more question: four fieldsets, answers kept', await page.locator('#chat .qcard.pending fieldset').count() === 4 && await page.locator('#chat .qcard.pending fieldset').nth(0).getByLabel('b.ts').isChecked());

    // 3. question_answered clears it.
    served = null; await emit('question_answered', { by: 'resolved' });
    check('question_answered clears the card', await cards() === 0);

    // 4. The owner's own free-text turn (no sender) leaves it open: the server says when it closes.
    await emitQuestion({ ...first, at: new Date(Date.now() + 1000).toISOString() });
    check('a new question shows again', await cards() === 1);
    await emit('session_started', { messageId: 'human-1', displayPrompt: 'Change the footer email first' });
    await emit('session_done', { status: 'completed' });
    check('an owner message that is not an answer leaves the card visible', await cards() === 1 && /Which file\?/.test(await card.innerText()));

    // 5. A partly answered batch: the card's answer carries answersQuestionAt, and the remainder re-renders
    //    the card in either order against the HTTP response, still dismissable (pendingQ kept).
    const sends = [], dismissals = [];
    let beforeResponse = null; // a `question` / `question_answered` the server emits before it answers the POST
    await context.route('**/api/sessions/current/messages', async route => {
      sends.push(JSON.parse(route.request().postData() || '{}'));
      if (beforeResponse) { await page.evaluate(([k, d]) => window.__emit(k, d), beforeResponse); beforeResponse = null; }
      await route.fulfill({ json: { sessionId: ids.sessionId } });
    });
    await context.route('**/api/questions/dismiss', async route => { dismissals.push(JSON.parse(route.request().postData() || '{}')); served = null; await route.fulfill({ json: { dismissed: true } }); });
    const two = [q('Which file?', ['a.ts', 'b.ts']), q('Which env?', ['dev', 'prod'])];
    const answerBoth = async () => {
      await page.locator('#chat .qcard.pending fieldset').nth(0).locator('.qcustom').fill('b.ts');
      await page.locator('#chat .qcard.pending fieldset').nth(1).locator('.qcustom').fill('prod');
      await page.locator('#chat .qcard.pending .qbatch button[type=submit]').click();
      await page.waitForTimeout(400);
    };
    const remainder = at => ({ ...ids, question: 'Which env?', options: ['dev', 'prod'], at, remainder: true });
    // a) response first, then the remainder
    const at3 = new Date(Date.now() + 2000).toISOString();
    await emitQuestion({ ...first, at: at3, questions: two });
    await answerBoth();
    check('the card answer carries answersQuestionAt', sends.length === 1 && sends[0].answersQuestionAt === at3, sends);
    served = remainder(at3); await emit('question', remainder(at3)); await page.waitForTimeout(300);
    check('response first: the remainder shows as the pending card', await cards() === 1 && /Which env\?/.test(await card.innerText()) && !/Which file\?/.test(await card.innerText()));
    await page.locator('#chat .qcard.pending .qdismiss').click(); await page.waitForTimeout(300);
    check('response first: the remainder is still dismissable (same at)', dismissals.length === 1 && dismissals[0].at === at3 && await cards() === 0, dismissals);
    // b) the remainder first (emitted while the POST is in flight), then the response
    const at4 = new Date(Date.now() + 3000).toISOString();
    await emitQuestion({ ...first, at: at4, questions: two });
    served = remainder(at4); beforeResponse = ['question', remainder(at4)];
    await answerBoth();
    check('remainder first: the remainder shows as the pending card', await cards() === 1 && /Which env\?/.test(await card.innerText()) && !/Which file\?/.test(await card.innerText()));
    await page.locator('#chat .qcard.pending .qdismiss').click(); await page.waitForTimeout(300);
    check('remainder first: the remainder is still dismissable (the response did not drop it)', dismissals.length === 2 && dismissals[1].at === at4 && await cards() === 0, dismissals);
    // c) fully answered: question_answered before the response clears it, nothing left pending
    const at5 = new Date(Date.now() + 4000).toISOString();
    await emitQuestion({ ...first, at: at5, questions: two });
    served = null; beforeResponse = ['question_answered', { ...ids, at: at5, by: 'turn' }];
    await answerBoth();
    check('fully answered: question_answered clears the card', await cards() === 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} question-survives-agent: ${checks.length} checks`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
