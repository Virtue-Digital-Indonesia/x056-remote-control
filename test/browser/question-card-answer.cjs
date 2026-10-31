// The panel's question card answers a question itself, and keeps typed answers on the item they were typed for.
//  1. A single question with no options has its own answer box ("Your answer" + "Send answer"); the answer goes
//     out with answersQuestionAt and the card closes. Empty input sends nothing; Enter in the box sends.
//  2. A single question WITH options takes a free answer through the same box and closes.
//  3. A batch draft is keyed by the item's id: it survives a remainder (item 1 closed by id, indices shift) and an
//     edit (item 2 reworded, the option it had picked removed): after a reload each typed answer is still on its
//     own item and the removed pick is gone. An old index-array draft in localStorage is read without a crash.
// Screenshots go to /tmp/qa-shots/ (single-free-1440-light, single-options-390-light, single-options-1440-dark).
// Run against the isolated browser fixture with Chat and Project spaces enabled:
//   X056_CHAT_ENABLED=1 X056_PROJECT_SPACES_ENABLED=1 X056_TEST_PORT=<port> node --import tsx test/browser/fixture.ts
//   node test/browser/question-card-answer.cjs http://127.0.0.1:<port>
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:4393';
const token = 'browser-fixture-token-0123456789';
const shots = process.env.X056_QA_SHOTS || '/tmp/qa-shots';
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);

(async () => {
  const browser = await playwright.chromium.launch({ args: ['--no-sandbox'] });
  const checks = [], errors = [];
  const check = (name, ok, detail) => { assert.ok(ok, name + (detail === undefined ? '' : ': ' + JSON.stringify(detail))); checks.push(name); };
  fs.mkdirSync(shots, { recursive: true });
  const H = { Authorization: 'Bearer ' + token };
  try {
    const admin = await browser.newContext();
    const post = async (path, data) => { const r = await admin.request.post(base + path, { headers: H, data }); const body = await r.json().catch(() => null); assert.ok(r.ok(), path + ' ' + r.status() + ' ' + JSON.stringify(body)); return body; };
    const tag = randomUUID().slice(0, 6);
    const chat = async (name) => { const c = await post('/api/chats', { requestId: randomUUID(), name: name + ' ' + tag, provider: 'claude' }); return { projectId: c.id, sessionId: c.lastSessionId }; };
    const ask = (ids, questions) => post('/api/questions/ask', { from: ids.sessionId, ...ids, questions });
    const open = async (ids, opts = {}) => {
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: opts.width || 1440, height: opts.height || 900 } });
      await context.addInitScript(([t, theme]) => { if (location.protocol === 'http:') { localStorage.setItem('x056_token', t); localStorage.setItem('x056_theme', theme); } }, [token, opts.theme || 'light']);
      const page = await context.newPage();
      page.on('pageerror', e => { if (!/ResizeObserver loop completed/.test(e.message)) errors.push(e.message); });
      const posts = []; page.on('request', r => { if (r.method() === 'POST' && /\/api\/sessions\/current\/messages/.test(r.url())) posts.push(JSON.parse(r.postData() || '{}')); });
      page.posts = posts;
      await page.goto(base + '/chat/' + ids.projectId);
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .qcard.pending').waitFor();
      await page.waitForTimeout(400);
      return { context, page };
    };
    const serverOpen = async (ids) => (await (await admin.request.get(base + '/api/questions', { headers: H })).json()).filter(q => q.sessionId === ids.sessionId);

    // 1. Single question, no options.
    {
      const ids = await chat('Free text');
      await ask(ids, [{ question: 'What should the release be called?' }]);
      const { context, page } = await open(ids);
      const card = page.locator('#chat .qcard.pending');
      const input = card.locator('input.qcustom');
      check('no hint text any more', !/message box below/.test(await card.innerText()));
      check('the card has its own answer box and a Send answer button', await input.count() === 1 && await card.locator('button[type=submit]', { hasText: 'Send answer' }).count() === 1);
      check('placeholder "Your answer"', await input.getAttribute('placeholder') === 'Your answer');
      check('aria-label names the question', await input.getAttribute('aria-label') === 'Your answer: What should the release be called?');
      await page.screenshot({ path: shots + '/single-free-1440-light.png' });
      const before = page.posts.length;
      await card.locator('button[type=submit]').click();
      await page.waitForTimeout(400);
      check('an empty answer sends nothing', page.posts.length === before && await page.locator('#chat .qcard.pending').count() === 1);
      const at = (await serverOpen(ids))[0].at;
      await input.fill('Call it Harbour');
      await input.press('Enter');
      await page.waitForFunction(() => !document.querySelector('#chat .qcard.pending'), null, { timeout: 15000 });
      const sent = page.posts.find(p => p.prompt === 'Call it Harbour');
      check('Enter sent the answer carrying answersQuestionAt', sent && sent.answersQuestionAt === at && sent.sessionId === ids.sessionId, { sent, at });
      check('the card is gone', await page.locator('#chat .qcard.pending').count() === 0);
      await page.waitForTimeout(500);
      check('the server closed the card too', (await serverOpen(ids)).length === 0, await serverOpen(ids));
      check('the answer shows once', await page.locator('#chat .msg.user').filter({ hasText: 'Call it Harbour' }).count() === 1);
      await context.close();
    }

    // 2. Single question with options: the buttons stay, the box takes a free answer.
    {
      const ids = await chat('Options and free text');
      await ask(ids, [{ question: 'Deploy the release tonight?', options: ['Yes, tonight', 'Wait for Monday'] }]);
      let { context, page } = await open(ids, { width: 390, height: 800 });
      let card = page.locator('#chat .qcard.pending');
      check('both option buttons are still there', await card.locator('button.qopt').count() === 2);
      check('placeholder "Or write your own answer"', await card.locator('input.qcustom').getAttribute('placeholder') === 'Or write your own answer');
      check('real buttons: Send answer is a <button>', await card.locator('button[type=submit]').evaluate(b => b.tagName === 'BUTTON'));
      check('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
      await page.screenshot({ path: shots + '/single-options-390-light.png' });
      await context.close();
      ({ context, page } = await open(ids, { theme: 'dark' }));
      card = page.locator('#chat .qcard.pending');
      await page.screenshot({ path: shots + '/single-options-1440-dark.png' });
      const at = (await serverOpen(ids))[0].at;
      await card.locator('input.qcustom').fill('Tomorrow morning instead');
      await card.locator('button[type=submit]').click();
      await page.waitForFunction(() => !document.querySelector('#chat .qcard.pending'), null, { timeout: 15000 });
      const sent = page.posts.find(p => p.prompt === 'Tomorrow morning instead');
      check('the free answer carries answersQuestionAt', sent && sent.answersQuestionAt === at, sent);
      await page.waitForTimeout(500);
      check('the server closed the card', (await serverOpen(ids)).length === 0);
      await context.close();
    }

    // 3. Batch drafts follow the item id through a remainder and an edit.
    {
      const ids = await chat('Batch drafts');
      const asked = await ask(ids, [
        { question: 'Which colour should the header use?', options: ['Red', 'Blue'] },
        { question: 'Which size should the logo be?', options: ['Small', 'Large'] },
        { question: 'Who signs off the change?' },
      ]);
      const [q1, q2, q3] = asked.questions;
      check('the items carry 8-hex ids', [q1, q2, q3].every(q => /^[0-9a-f]{8}$/.test(q.id)), asked.questions);
      let { context, page } = await open(ids);
      const group = (n) => page.locator('#chat .qcard.pending fieldset').nth(n);
      await group(0).locator('label', { hasText: 'Blue' }).click();
      await group(1).locator('label', { hasText: 'Large' }).click();
      await group(2).locator('input.qcustom').fill('Dewi from legal');
      const draftKey = 'x056_question_draft_' + ids.sessionId + '_' + asked.at;
      const stored = JSON.parse(await page.evaluate(k => localStorage.getItem(k), draftKey));
      check('the draft is keyed by item id', stored.v === 2 && stored.items['id:' + q1.id]?.v === 'Blue' && stored.items['id:' + q3.id]?.v === 'Dewi from legal', stored);

      // Remainder: item 1 closed by id (an agent dismisses it), the live card re-renders with two items.
      await post('/api/questions/close', { from: ids.sessionId, ...ids, at: asked.at, ids: [q1.id], action: 'dismiss', reason: 'Decided elsewhere' });
      await page.waitForFunction(() => document.querySelectorAll('#chat .qcard.pending fieldset').length === 2, null, { timeout: 8000 });
      const afterRemainder = await page.evaluate(() => [...document.querySelectorAll('#chat .qcard.pending fieldset')].map(g => ({ q: g.querySelector('legend').textContent, pick: g.querySelector(':checked')?.value || '', text: g.querySelector('.qcustom').value })));
      check('live: after the remainder each answer is on its own item', afterRemainder[0].pick === 'Large' && afterRemainder[0].text === '' && afterRemainder[1].text === 'Dewi from legal', afterRemainder);
      // Edit: item 2 reworded, the option it had picked (Large) removed.
      await post('/api/questions/edit', { from: ids.sessionId, ...ids, at: asked.at, id: q2.id, question: 'How big should the logo be on mobile?', options: ['Small', 'Medium'], reason: 'Mobile only' });
      await page.waitForFunction(() => /mobile/.test(document.querySelector('#chat .qcard.pending')?.innerText || ''), null, { timeout: 8000 });
      const afterEdit = await page.evaluate(() => [...document.querySelectorAll('#chat .qcard.pending fieldset')].map(g => ({ q: g.querySelector('legend').textContent, pick: g.querySelector(':checked')?.value || '', text: g.querySelector('.qcustom').value })));
      check('live: the removed pick is dropped, the other answer stays', afterEdit.length === 2 && afterEdit[0].pick === '' && afterEdit[0].text === '' && afterEdit[1].text === 'Dewi from legal', afterEdit);
      await page.reload();
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .qcard.pending').waitFor();
      await page.waitForTimeout(400);
      const reloadedEdit = await page.evaluate(() => [...document.querySelectorAll('#chat .qcard.pending fieldset')].map(g => ({ pick: g.querySelector(':checked')?.value || '', text: g.querySelector('.qcustom').value })));
      check('after a reload the removed pick stays dropped and the other answer is on its item', reloadedEdit.length === 2 && reloadedEdit[0].pick === '' && reloadedEdit[1].text === 'Dewi from legal', reloadedEdit);
      // Type a second answer on the reworded item (keeps its id) and reload: nothing is on the wrong item.
      await group(0).locator('label', { hasText: 'Medium' }).click();
      await page.reload();
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .qcard.pending').waitFor();
      await page.waitForTimeout(400);
      const reloaded = await page.evaluate(() => [...document.querySelectorAll('#chat .qcard.pending fieldset')].map(g => ({ q: g.querySelector('legend').textContent, pick: g.querySelector(':checked')?.value || '', text: g.querySelector('.qcustom').value })));
      check('after a reload the reworded item keeps its pick and the other its text', reloaded.length === 2 && reloaded[0].q === '1. How big should the logo be on mobile?' && reloaded[0].pick === 'Medium' && reloaded[1].text === 'Dewi from legal' && reloaded[1].pick === '', reloaded);
      const storedAfter = JSON.parse(await page.evaluate(k => localStorage.getItem(k), draftKey));
      check('the saved draft no longer holds the closed item', !('id:' + q1.id in storedAfter.items) && storedAfter.items['id:' + q2.id]?.v === 'Medium', storedAfter);

      // An old index-array draft is read (it lines up with the two items) and does not crash.
      await page.evaluate(([k]) => localStorage.setItem(k, JSON.stringify(['Small', 'Ravi'])), [draftKey]);
      await page.reload();
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .qcard.pending').waitFor();
      await page.waitForTimeout(400);
      const legacy = await page.evaluate(() => [...document.querySelectorAll('#chat .qcard.pending fieldset')].map(g => ({ pick: g.querySelector(':checked')?.value || '', text: g.querySelector('.qcustom').value })));
      check('an old index-array draft maps onto items of the same count', legacy[0].pick === 'Small' && legacy[1].text === 'Ravi', legacy);
      await page.evaluate(([k]) => localStorage.setItem(k, JSON.stringify(['only one'])), [draftKey]);
      await page.reload();
      await page.waitForFunction(() => window.rcWorkspace?.ready());
      await page.locator('#chat .qcard.pending').waitFor();
      check('an old draft that no longer lines up is ignored', await page.locator('#chat .qcard.pending fieldset').count() === 2 && await page.locator('#chat .qcard.pending :checked').count() === 0);
      await context.close();
    }
    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
  }
  console.log('PASS ' + checks.length + ' checks:\n - ' + checks.join('\n - '));
})().catch((e) => { console.error(e); process.exit(1); });
