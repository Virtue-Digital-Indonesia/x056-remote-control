// Delegates: the orchestrator's hidden workers. One bar above the composer,
// report cards in the chat, a delegate's transcript in the terminal view, and
// a person messaging a delegate directly -- which runs a real (fake-CLI) turn.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); localStorage.removeItem('x056_terminal'); });
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = async (p) => (await ctx.request.get(base + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  const projects = await api('/api/projects');
  const project = projects.projects.find((p) => p.name === 'Website refresh');
  const conv = project.conversations.find((c) => c.title === 'Build the new homepage');
  const transcript = execSync(`find /tmp -path '*primary/projects/fixture/${conv.sessionId}.jsonl' 2>/dev/null | head -1`).toString().trim();
  const root = transcript.split('/primary/')[0], state = path.join(root, 'state');
  const now = Date.now(), iso = (ago) => new Date(now - ago).toISOString();

  // A roster: one delegate "working", one that reported and waits on a person.
  const backendSid = crypto.randomUUID(), reviewerSid = crypto.randomUUID();
  const report = { at: iso(30000), delegateId: 'd-reviewer', role: 'reviewer', turn: 1, status: 'completed', text: 'NEEDS HUMAN: staging credentials are missing.\n\nI need read access to the staging DWH to finish the review.', durationMs: 95000, gate: 'needs_human', gateConfidence: 0.93, gateBy: 'jev', woke: false };
  fs.mkdirSync(path.join(state, 'delegates'), { recursive: true });
  fs.writeFileSync(path.join(state, 'delegates', conv.sessionId + '.json'), JSON.stringify({ parentProjectId: project.id, parentSessionId: conv.sessionId, delegates: [
    { id: 'd-backend', role: 'backend', brief: 'Fix the flaky login test.', provider: 'claude', model: 'opus', projectId: project.id, cwd: root, sessionId: backendSid, status: 'working', createdAt: iso(60000), updatedAt: iso(60000), turns: 1, pending: [] },
    { id: 'd-reviewer', role: 'reviewer', brief: 'Review the DWH views.', provider: 'claude', model: 'fable', projectId: project.id, cwd: root, sessionId: reviewerSid, status: 'idle', createdAt: iso(90000), updatedAt: iso(30000), turns: 1, pending: [], lastReport: report },
  ] }));
  fs.writeFileSync(path.join(state, 'delegates', conv.sessionId + '.reports.jsonl'), JSON.stringify(report) + '\n');
  // The reviewer's own transcript, where the terminal view will find it.
  fs.writeFileSync(path.join(root, 'primary', 'projects', 'fixture', reviewerSid + '.jsonl'), [
    { type: 'user', timestamp: iso(120000), message: { role: 'user', content: 'Review the DWH views.' } },
    { type: 'assistant', timestamp: iso(100000), message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'psql -c "\\\\dv"' } }] } },
    { type: 'assistant', timestamp: iso(30000), message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: 'NEEDS HUMAN: staging credentials are missing.' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Its report card, as the conversation journal records it.
  const jf = path.join(state, 'conversation-journal', crypto.createHash('sha256').update(project.id + '\0' + conv.sessionId).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  const rows = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : [];
  rows.push({ role: 'advisor', messageId: 'delegate:d-reviewer@' + report.at, text: report.text, ts: report.at, advisor: { delegate: { delegateId: 'd-reviewer', role: 'reviewer', turn: 1, status: 'completed', gate: 'needs_human', gateConfidence: 0.93, gateBy: 'jev', durationMs: 95000, provider: 'claude', model: 'fable' } } });
  fs.writeFileSync(jf, JSON.stringify(rows));

  await page.goto(base); await page.waitForSelector('.cr-task');
  await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).first().click();
  await page.waitForSelector('#delegatesBar:not([hidden])', { timeout: 8000 });
  assert.match(await page.locator('#delegatesBar .dg-sum').textContent(), /1 working · 1 waiting on you/);
  // Nothing new in the sidebar: the delegates are not conversations.
  assert.equal(await page.locator('.cr-task').filter({ hasText: /backend|reviewer/ }).count(), 0);

  // The report card: who, the gate, the first line; the rest on demand.
  const card = page.locator('.advcard.delegate');
  await card.first().waitFor();
  assert.match(await card.first().textContent(), /reviewerClaude · FableNeeds youturn 1 · 2 minNEEDS HUMAN: staging credentials are missing\./);
  await card.first().locator('.dg-more summary').click();
  const full = await card.first().locator('.dg-body').textContent();
  assert.match(full, /read access to the staging DWH/);
  assert.doesNotMatch(full, /credentials are missing/, 'the first line is not repeated');

  // The bar opens to one row per delegate.
  await page.locator('#delegatesBar .dg-head').click();
  assert.equal(await page.locator('#delegatesBar .dg-row').count(), 2);
  assert.match(await page.locator('#delegatesBar .dg-row.needs').textContent(), /reviewerClaude · FableWaiting on youNEEDS HUMAN: staging credentials are missing\./);
  await page.screenshot({ path: '/tmp/x056-delegates-bar.png' });

  // A delegate's own transcript in the terminal view, and back.
  await page.locator('#delegatesBar .dg-row.needs button[title="Open its transcript"]').click();
  await page.waitForSelector('#term .tl.tool', { timeout: 6000 });
  assert.match(await page.locator('#termMeta').textContent(), /^Delegate reviewer · Claude transcript/);
  assert.match(await page.locator('#term .tl.tool').first().textContent(), /Bash\(psql/);
  assert.equal(await page.locator('#termBack').isVisible(), true);
  await page.screenshot({ path: '/tmp/x056-delegates-terminal.png' });
  await page.locator('#termBack').click();
  await page.waitForFunction(() => /^Claude transcript/.test(document.getElementById('termMeta').textContent));
  await page.locator('#chatTerminal').click();

  // A person messages the reviewer directly: a real turn on the fake CLI.
  await page.locator('#delegatesBar .dg-row.needs button[title="Message it directly"]').click();
  await page.locator('#delegatesBar .dg-say input').fill('Credentials are in the vault now; continue.');
  await page.locator('#delegatesBar .dg-say button').click();
  await page.waitForFunction(() => document.querySelectorAll('.advcard.delegate').length >= 2, null, { timeout: 20000 });
  const roster = await api(`/api/delegates?projectId=${project.id}&sessionId=${conv.sessionId}&id=d-reviewer`);
  assert.equal(roster.delegates[0].turns, 2);
  assert.equal(roster.delegates[0].status === 'idle' || roster.delegates[0].status === 'failed', true);
  // Still nothing in the sidebar.
  assert.equal((await api('/api/projects')).projects.flatMap((p) => p.conversations).some((c) => c.sessionId === reviewerSid), false);

  // Phones: the bar and its rows stay inside the screen.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(() => { localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); localStorage.removeItem('x056_terminal'); });
  const p2 = await phone.newPage();
  await p2.goto(base); await p2.waitForSelector('.cr-task');
  await p2.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).first().click();
  await p2.waitForSelector('#delegatesBar:not([hidden])', { timeout: 8000 });
  if (!(await p2.locator('#delegatesBar').evaluate((b) => b.classList.contains('open')))) await p2.locator('#delegatesBar .dg-head').click();
  const over = await p2.locator('#delegatesBar').evaluate((bar) => { const b = bar.getBoundingClientRect(); return b.right > window.innerWidth + 1 || [...bar.querySelectorAll('*')].some((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > b.right + 1; }); });
  assert.equal(over, false, 'the delegates bar overflows on a phone');
  await p2.screenshot({ path: '/tmp/x056-delegates-phone.png' });

  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS delegates: bar and rows, report cards, a delegate transcript in the terminal, a direct message runs a hidden turn, nothing in the sidebar');
})().catch((e) => { console.error(e); process.exit(1); });
