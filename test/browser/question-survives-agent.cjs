// An open question survives agent messages (every conversation, not only the Bot's): a turn started by another
// conversation leaves the card up; a merged `question` batch re-renders the card with every question and keeps
// what the owner already chose or typed; question_answered clears it; only a human-origin session_started does too.
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

    // 4. A human-origin turn (no sender) answers it, too.
    await emitQuestion({ ...first, at: new Date(Date.now() + 1000).toISOString() });
    check('a new question shows again', await cards() === 1);
    await emit('session_started', { messageId: 'human-1', displayPrompt: 'My answer' });
    check('a session_started with no sender (the owner) clears it', await cards() === 0);
    assert.deepEqual(errors, []);
    console.log(`PASS ${engine} question-survives-agent: ${checks.length} checks`);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
