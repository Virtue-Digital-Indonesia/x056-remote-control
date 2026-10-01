// The agent tree, docked beside the chat (chat and composer stay usable), per
// turn, with each node's own history; "Expand" puts the console view over the
// whole conversation (chat AND composer hidden, exclusive with the terminal).
// Start fixture.ts first (with X056_PROJECT_SPACES_ENABLED=1 X056_CHAT_ENABLED=1).
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8870';
const TOKEN = 'browser-fixture-token-0123456789';
const SHOTS = '/tmp/x056-agent-tree';

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const req = await browser.newContext();
  const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
  const api = async (p) => (await req.request.get(base + p, { headers: H })).json();
  const projects = (await api('/api/projects')).projects;
  const project = projects.find((p) => p.name === 'Website refresh');
  const conv = project.conversations.find((c) => c.title === 'Build the new homepage');
  const other = projects.flatMap((p) => p.conversations.map((c) => ({ p, c }))).find((x) => x.c.title === 'Review accessibility findings');
  const codexConv = projects.flatMap((p) => p.conversations.map((c) => ({ p, c }))).find((x) => x.c.title === 'Update the component library');
  assert.ok(conv && other && codexConv, 'fixture conversations not found');
  const sid = conv.sessionId;
  const transcript = execSync(`find /tmp -path '*primary/projects/fixture/${sid}.jsonl' 2>/dev/null | head -1`).toString().trim();
  assert.ok(transcript, 'fixture transcript not found');
  const root = transcript.split('/primary/')[0], state = path.join(root, 'state');
  const now = Date.now(), iso = (ago) => new Date(now - ago).toISOString();

  // Helpers: advisor + team + Jev (Jev needs a key; a fake one is enough to enable it).
  fs.mkdirSync(path.join(state, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(state, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'fake' }), { mode: 0o600 });
  const set = await req.request.post(base + '/api/conversations/helpers', { headers: H, data: { projectId: project.id, sessionId: sid, advisor: true, team: true, router: 'jev' } });
  assert.equal(set.status(), 200, 'helpers POST: ' + (await set.text()));

  // The turn began 2 minutes ago (the journal's last user row).
  const jf = path.join(state, 'conversation-journal', crypto.createHash('sha256').update(project.id + '\0' + sid).digest('hex') + '.json');
  fs.mkdirSync(path.dirname(jf), { recursive: true });
  const rows = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : [];
  rows.push({ role: 'user', messageId: 'u-tree', text: 'Fix the login flow.', ts: iso(120000) });
  fs.writeFileSync(jf, JSON.stringify(rows));

  // Three forks this turn, one in turn 13, and one report gate (the gate is NOT a fork).
  fs.mkdirSync(path.join(state, 'jev', 'forks'), { recursive: true });
  fs.writeFileSync(path.join(state, 'jev', 'forks', sid + '.jsonl'), [
    { at: iso(100000), sessionId: sid, backend: 'jev', question: 'which file', options: ['src/auth.ts', 'README.md'], choice: 'src/auth.ts', confidence: 0.79, verdict: 'sharp', latencyMs: 280 },
    { at: iso(90000), sessionId: sid, backend: 'jev', question: 'which tool should find every caller of the session refresh helper before we change its signature, given that ripgrep only returns line numbers and the code graph indexes committed main rather than the working tree, and the helper is re-exported from three barrel files plus two test utilities that also shadow the name', options: ['grep', 'codegraph'], choice: 'grep', confidence: 0.48, verdict: 'split', latencyMs: 300 },
    { at: iso(80000), sessionId: sid, backend: 'jev', question: 'retry or stop', options: ['retry', 'stop'], choice: 'stop', confidence: 0.53, verdict: 'split', latencyMs: 250 },
    { at: iso(3600000 - 60000), sessionId: sid, backend: 'jev', question: 'which adapter', options: ['perubahan', 'pendirian'], choice: 'perubahan', confidence: 0.81, verdict: 'sharp', latencyMs: 270 },
    { at: iso(40000), sessionId: sid, backend: 'jev', question: 'report gate · backend', options: ['done', 'needs_orchestrator', 'needs_human', 'blocked'], choice: 'done', confidence: 0.91, verdict: 'sharp', latencyMs: 310 },
  ].map((f) => JSON.stringify(f)).join('\n') + '\n');

  // Claude's advisor: two calls, no checkpoints to light.
  fs.mkdirSync(path.join(state, 'advisor'), { recursive: true });
  fs.writeFileSync(path.join(state, 'advisor', sid + '.claude.jsonl'), [
    { at: iso(70000), model: 'opus', status: 'reviewed' }, { at: iso(20000), model: 'opus', status: 'reviewed' },
  ].map((c) => JSON.stringify(c)).join('\n') + '\n');

  // Delegates: one working, one that reported and waits on a person.
  const reviewerSid = crypto.randomUUID();
  const report = { at: iso(30000), delegateId: 'd-reviewer', role: 'reviewer', turn: 1, status: 'completed', text: 'NEEDS HUMAN: **staging credentials** are missing.\n\n- first item\n- second item with `inline_code`\n', durationMs: 95000, gate: 'needs_human', gateConfidence: 0.93, gateBy: 'jev', woke: false };
  fs.mkdirSync(path.join(state, 'delegates'), { recursive: true });
  fs.writeFileSync(path.join(state, 'delegates', sid + '.json'), JSON.stringify({ parentProjectId: project.id, parentSessionId: sid, delegates: [
    { id: 'd-backend', role: 'backend', brief: 'Fix the flaky login test.', provider: 'claude', model: 'opus', projectId: project.id, cwd: root, sessionId: crypto.randomUUID(), status: 'working', createdAt: iso(60000), updatedAt: iso(60000), turns: 1, pending: [] },
    { id: 'd-reviewer', role: 'reviewer', brief: 'Review the DWH views.', provider: 'claude', model: 'fable', projectId: project.id, cwd: root, sessionId: reviewerSid, status: 'idle', createdAt: iso(90000), updatedAt: iso(30000), turns: 1, pending: [], lastReport: report },
  ] }));
  fs.writeFileSync(path.join(state, 'delegates', sid + '.reports.jsonl'), JSON.stringify(report) + '\n');
  fs.writeFileSync(path.join(root, 'primary', 'projects', 'fixture', reviewerSid + '.jsonl'), [
    { type: 'user', timestamp: iso(120000), message: { role: 'user', content: 'Review the DWH views.' } },
    { type: 'assistant', timestamp: iso(100000), message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'psql -c "\\\\dv"' } }] } },
    { type: 'assistant', timestamp: iso(90000), message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'text', text: '## Findings\n\nThe views look **fine**; see `dwh.v_sales`.\n\n- one\n- two' }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  // The tree reads exactly this from the server: 4 forks, 1 gate.
  const t = await api(`/api/conversations/agent-tree?projectId=${project.id}&sessionId=${sid}`);
  assert.equal(t.forks.total, 4); assert.equal(t.gates.length, 1);

  // Three turns (injected until the server sends them): now, 1 h ago, 3 h ago.
  const TURNS = [
    { n: 12, messageId: 'u-12', startedAt: iso(3 * 3600000), endedAt: iso(3 * 3600000 - 600000), prompt: 'Map the deed rules in the native service.', running: false },
    { n: 13, messageId: 'u-13', startedAt: iso(3600000), endedAt: iso(3600000 - 600000), prompt: 'Add PAD coverage checks with tests.', running: false },
    { n: 14, messageId: 'u-tree', startedAt: iso(120000), endedAt: null, prompt: 'Fix the login flow.', running: true },
  ];
  // Workers: this turn's, in every status, one nested by parentAgentId; plus earlier turns'.
  const subagents = [
    { agentId: 'w1', agentType: 'worker', description: 'Edit auth.ts and run tests', status: 'done', spawnDepth: 1, startedAt: now - 100000, endedAt: now - 50000, usage: { input: 2000, output: 9000, cacheRead: 0, cacheWrite: 0 }, cost: { usd: 0.12, unpriced: [] }, brief: 'Edit auth.ts so the session cookie is refreshed.', result: 'Refreshed the cookie; 3 tests pass.' },
    { agentId: 'e1', agentType: 'explorer', description: 'Map the login flow', status: 'running', spawnDepth: 1, startedAt: now - 95000 },
    { agentId: 'g1', agentType: 'general-purpose', description: 'Check the <img src=x onerror=alert(1)> docs', status: 'failed', spawnDepth: 1, startedAt: now - 90000, endedAt: now - 60000 },
    { agentId: 'x1', agentType: 'explorer', description: 'Read the OAuth callback', status: 'ended', spawnDepth: 1, startedAt: now - 88000, endedAt: now - 40000 },
    { agentId: 's1', agentType: 'researcher', description: 'Look up cookie flags', status: 'stopped', spawnDepth: 1, startedAt: now - 86000, endedAt: now - 45000 },
    { agentId: 'n1', agentType: 'explorer', description: 'Find the session cookie', status: 'done', spawnDepth: 2, parentAgentId: 'w1', startedAt: now - 80000, endedAt: now - 75000 },
    { agentId: 'old13', agentType: 'worker', description: 'Add PAD coverage checks', status: 'done', spawnDepth: 1, startedAt: now - 3590000, endedAt: now - 3400000 },
    { agentId: 'old13b', agentType: 'explorer', description: 'Map the adapter entry points', status: 'stopped', spawnDepth: 1, startedAt: now - 3595000, endedAt: now - 3500000 },
    { agentId: 'old12', agentType: 'explorer', description: 'Find the deed rules', status: 'ended', spawnDepth: 1, startedAt: now - 3 * 3600000 + 5000, endedAt: now - 3 * 3600000 + 60000 },
  ];
  const runs = [{ runId: 'audit', name: 'cutover-audit-sweep', description: 'Verify the cutover.', phases: [{ title: 'Audit' }, { title: 'Verify' }], started: 3, finished: 1, startedAt: now - 70000, updatedAt: now - 5000, live: true }];
  const runAgents = [
    { agentId: 'wa1', agentType: 'general-purpose', spawnDepth: 1, brief: 'Audit the deployment logs', done: true, failed: false, status: 'done', bytes: 900, updatedAt: now - 30000 },
    { agentId: 'wa2', agentType: 'general-purpose', spawnDepth: 1, brief: 'Verify the health checks', done: false, status: 'running', bytes: 400, updatedAt: now - 2000 },
    { agentId: 'wa3', agentType: 'general-purpose', spawnDepth: 1, brief: 'Check the rollback path', done: true, failed: true, status: 'failed', bytes: 300, updatedAt: now - 20000 },
  ];
  const codexTree = { provider: 'codex', helpers: { advisor: true, team: true }, turnStartedAt: iso(120000),
    main: { model: 'gpt-6-sol', effort: 'high', running: false, background: false, lastTurn: null },
    advisor: { on: true, kind: 'gateway', model: 'gpt-6-astra', checkpoints: true, calls: [
      { at: iso(100000), trigger: 'plan', verdict: 'proceed', delivered: 'none' }, { at: iso(30000), trigger: 'done', verdict: 'concern', delivered: 'queued', advice: 'Add a test for the expired cookie.' }] },
    team: { effort: 'medium', roles: ['explorer', 'worker', 'default'] }, forks: { total: 0, sharp: 0, split: 0, recent: [] }, gates: [], picks: [], delegates: [] };
  const codexChildren = [{ agentId: 'child', agentType: 'codex-subagent', description: 'Astra review agent', status: 'running', startedAt: now - 30000, bytes: 1000 }];
  let withTurns = true, historyCalls = [], runCalls = [];

  // Detail column: nothing clipped in the stats grid / header; shots for worker, delegate and Jev.
  async function detailShots(page, theme, w) {
    for (const [key, name] of [['sub:w1', 'worker'], ['dg:d-reviewer', 'delegate'], ['jev', 'jev']]) {
      await page.locator('#agentPane').evaluate(() => {});
      const back = page.locator('#agentPaneHistory button[aria-label="Back to the tree"]');
      if (await back.count() && await back.isVisible()) await back.click();
      await row(page, key).click();
      await page.locator('#agentPaneHistBody').waitFor();
      await page.waitForTimeout(500);
      const clipped = await page.evaluate(() => [...document.querySelectorAll('#agentPaneHistory .ap-stats dd, #agentPaneHistory .ap-hn, #agentPaneHistory .ap-hmeta')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
      assert.deepEqual(clipped, [], 'clipped detail values for ' + name);
      await page.screenshot({ path: SHOTS + '/detail-' + name + '-' + theme + '-' + w + '.png' });
    }
  }
  async function newPage(vp, theme) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: theme });
    await ctx.addInitScript((th) => { localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); localStorage.setItem('x056_theme', th); if (!sessionStorage.getItem('at-init')) { sessionStorage.setItem('at-init', '1'); localStorage.removeItem('x056_terminal'); localStorage.removeItem('x056_agent_tree'); localStorage.removeItem('x056_agent_pane_w'); } }, theme);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.route('**/api/conversations/subagents?**', (r) => { const s = new URL(r.request().url()).searchParams.get('sessionId'); r.fulfill({ json: { subagents: s === sid ? subagents : s === codexConv.c.sessionId ? codexChildren : [], self: null } }); });
    await page.route('**/api/conversations/workflows?**', (r) => {
      const u = new URL(r.request().url()), s = u.searchParams.get('sessionId'), id = u.searchParams.get('runId');
      if (id) runCalls.push(id);
      r.fulfill({ json: s !== sid ? { runs: [] } : id ? { runs, agents: runAgents } : { runs } });
    });
    await page.route('**/api/conversations/subagent-history?**', (r) => { const u = new URL(r.request().url()); historyCalls.push(u.searchParams.get('agentId')); r.fulfill({ json: { rows: [{ role: 'user', text: 'Edit auth.ts so the session cookie is refreshed.' }, { role: 'assistant', text: 'Edited auth.ts for ' + u.searchParams.get('agentId') + '.' }], done: true, cursor: 0 } }); });
    await page.route('**/api/conversations/workflow-history?**', (r) => r.fulfill({ json: { rows: [{ role: 'assistant', text: 'Health checks pass.' }], done: true, cursor: 0 } }));
    await page.route('**/api/conversations/agent-tree?**', async (r) => {
      const s = new URL(r.request().url()).searchParams.get('sessionId');
      if (s === codexConv.c.sessionId) return r.fulfill({ json: codexTree });
      const res = await r.fetch(); const j = await res.json();
      if (s === sid) { if (withTurns) j.turns = TURNS; else delete j.turns; } // injected, or absent (the fallback)
      if (s === sid && j.team) j.team = Object.assign({}, j.team, { model: 'sonnet', effort: 'high', pickedBy: 'jev', confidence: 0.72 });
      return r.fulfill({ response: res, json: j });
    });
    await page.goto(base); await page.waitForSelector('.cr-task');
    return { ctx, page, errors };
  }
  const openConv = async (page, title) => { await page.locator('.cr-task').filter({ hasText: title }).first().click(); await page.waitForTimeout(700); };
  const pane = (page) => page.locator('#agentPane');
  const row = (page, key) => page.locator(`#agentPane .ap-row[data-key="${key}"]`);
  const rect = (page, sel) => page.locator(sel).first().evaluate((e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; });
  const statusOf = (page, key) => row(page, key).locator('> .ap-tx .ap-st').first().getAttribute('data-status');

  // ---- desktop, dark: the docked pane ----
  {
    const { ctx, page, errors } = await newPage({ width: 1440, height: 900 }, 'dark');
    await openConv(page, 'Build the new homepage');
    await page.locator('#chatAgentTree').click();
    await row(page, 'sub:w1').waitFor();
    // Docked to the RIGHT; the chat and the composer stay visible and usable.
    assert.equal(await page.locator('#chatAgentTree').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('main .scroll').isVisible(), true, 'the chat stays');
    assert.equal(await page.locator('.composer-wrap').isVisible(), true, 'the composer stays');
    const chat = await rect(page, '.focus-main'), p = await rect(page, '#agentPane');
    assert.ok(p.left >= chat.right - 1 && Math.abs(p.width - 420) < 2, 'pane beside the chat at 420px: ' + JSON.stringify({ chat, p }));
    await page.locator('#prompt').fill('still typing');
    assert.equal(await page.locator('#prompt').inputValue(), 'still typing');
    await page.locator('#prompt').fill('');

    // Per turn: the stepper names the turn; only this turn's nodes.
    assert.equal(await page.locator('#agentPaneTurn').textContent(), 'Turn 14 · now');
    assert.equal(await row(page, 'sub:old13').count(), 0, 'earlier turn workers are not in this turn');
    // Truthful status: every value, none of the others read as done.
    assert.equal(await statusOf(page, 'sub:e1'), 'run');
    assert.equal(await statusOf(page, 'sub:w1'), 'done');
    assert.equal(await statusOf(page, 'sub:x1'), 'ended');
    assert.equal(await statusOf(page, 'sub:s1'), 'stopped');
    assert.equal(await statusOf(page, 'sub:g1'), 'failed');
    assert.equal(await row(page, 'sub:x1').locator('.ap-st').first().textContent(), 'Ended · no result');
    for (const k of ['sub:x1', 'sub:s1', 'sub:g1', 'sub:e1']) assert.notEqual(await row(page, k).locator('.ap-st-t').first().textContent(), 'Done', k + ' must not read as done');
    // Working first: running, done, ended, stopped, failed.
    const order = await page.locator('#agentPane .ap-row[data-key="team"] + .ap-ul > .ap-li > .ap-row').evaluateAll((l) => l.map((e) => e.dataset.key));
    assert.deepEqual(order, ['sub:e1', 'sub:w1', 'sub:x1', 'sub:s1', 'sub:g1']);
    // Nested by parentAgentId; guide lines are borders, not characters.
    assert.equal(await page.locator('#agentPane .ap-row[data-key="sub:w1"] + .ap-ul .ap-row[data-key="sub:n1"]').count(), 1, 'child under its spawner');
    assert.equal(await page.locator('#agentPane .ap-ul .ap-ul > .ap-li').first().evaluate((e) => getComputedStyle(e, '::before').borderLeftStyle), 'solid');
    assert.equal(await pane(page).locator('img').count(), 0, 'text is never parsed as HTML');
    // Team header: model · effort; helpers; delegates with gate pills; forks expand.
    assert.match(await row(page, 'team').textContent(), /Agent team/);
    assert.match(await row(page, 'team').locator('.ap-brief').textContent(), /Sonnet · high/);
    assert.equal(await row(page, 'team').locator('.ap-pick').textContent(), 'Jev 72%', 'the per-turn team pick');
    assert.equal(await row(page, 'advisor').count(), 1);
    assert.match(await row(page, 'dg:d-reviewer').textContent(), /Needs you/);
    assert.equal(await statusOf(page, 'dg:d-backend'), 'run');
    assert.equal(await row(page, 'jev').getAttribute('aria-expanded'), 'false');
    await row(page, 'jev').locator('.ap-chev').click();
    assert.equal(await page.locator('#agentPane .ap-row[data-kind="fork"]').count(), 3, "this turn's three forks, the gate excluded");
    await page.screenshot({ path: SHOTS + '/pane-desktop-dark.png' });

    // The workflow run expands to its agents (fetched on demand).
    await row(page, 'wf:audit').locator('.ap-chev').click();
    await row(page, 'wfa:audit:wa2').waitFor();
    assert.ok(runCalls.includes('audit'));
    const wfOrder = await page.locator('#agentPane .ap-row[data-key="wf:audit"] + .ap-ul > .ap-li > .ap-row').evaluateAll((l) => l.map((e) => e.dataset.status));
    assert.deepEqual(wfOrder, ['run', 'done', 'failed']);

    // A subagent opens its own history in a second column; the pane widens.
    await row(page, 'sub:w1').click();
    await page.locator('#agentPaneHistBody .msg').filter({ hasText: 'Edited auth.ts for w1.' }).waitFor();
    assert.ok(Math.abs((await rect(page, '#agentPane')).width - 760) < 2, 'pane widens to 760');
    assert.equal(await row(page, 'sub:w1').getAttribute('aria-selected'), 'true');
    await page.locator('#agentPaneHistory [role=tab][data-tab=brief]').click();
    assert.match(await page.locator('#agentPaneHistBody').textContent(), /session cookie is refreshed/);
    await page.locator('#agentPaneHistory [role=tab][data-tab=result]').click();
    assert.match(await page.locator('#agentPaneHistBody').textContent(), /3 tests pass/);
    await page.screenshot({ path: SHOTS + '/pane-history-dark.png' });
    // An ended worker's Result says why there is none.
    await row(page, 'sub:x1').click();
    await page.locator('#agentPaneHistory [role=tab][data-tab=result]').click();
    assert.match(await page.locator('#agentPaneHistBody').textContent(), /Ended without a result/);
    // A workflow agent reads its own transcript.
    await row(page, 'wfa:audit:wa2').click();
    await page.locator('#agentPaneHistBody').filter({ hasText: 'Health checks pass.' }).waitFor();
    // A delegate: its report, its transcript, a message box; Stop only while it works.
    await row(page, 'dg:d-reviewer').click();
    await page.locator('#agentPaneHistory .ap-report').filter({ hasText: 'staging credentials' }).waitFor();
    await page.locator('#agentPaneHistBody .msg.assistant').first().waitFor();
    await page.locator('#agentPaneHistBody .act').first().waitFor();
    // Markdown renders as elements, not raw asterisks; the time shows once per message.
    assert.equal(await page.locator('#agentPaneHistory .ap-report strong').count(), 1);
    assert.equal(await page.locator('#agentPaneHistory .ap-report li').count(), 2);
    assert.equal(await page.locator('#agentPaneHistory .ap-report code').count(), 1);
    assert.doesNotMatch(await page.locator('#agentPaneHistory .ap-report').textContent(), /\*\*/);
    assert.equal(await page.locator('#agentPaneHistBody .msg.assistant h4').count(), 1);
    assert.equal(await page.locator('#agentPaneHistBody .msg.assistant strong').count(), 1);
    assert.equal(await page.locator('#agentPaneHistBody .ap-r').count(), 0, 'no per-line timestamp rows');
    assert.equal(await page.locator('#agentPaneHistBody .msg .mmeta').count(), await page.locator('#agentPaneHistBody .msg').count());
    await page.screenshot({ path: SHOTS + '/detail-delegate-dark-1440.png' });
    assert.equal(await page.locator('#agentPaneHistory .ap-send input').count(), 1);
    assert.equal(await page.locator('#agentPaneHistory .ap-send button').filter({ hasText: 'Stop' }).isDisabled(), true);
    // The advisor on Claude: calls, and why there is no advice to read.
    await row(page, 'advisor').click();
    assert.match(await page.locator('#agentPaneHistBody').textContent(), /advice comes back encrypted/);
    assert.equal(await page.locator('#agentPaneHistBody .ap-card').count(), 2);
    // Jev: its forks, the gate not among them.
    await row(page, 'jev').click();
    await page.locator('#agentPaneHistBody .ap-card').filter({ hasText: 'which file' }).waitFor();
    {
      const q = page.locator('#agentPaneHistBody .ap-card').filter({ hasText: 'which tool should' }).locator('.ap-clamp');
      const h0 = (await q.boundingBox()).height;
      const more = page.locator('#agentPaneHistBody .ap-card').filter({ hasText: 'which tool should' }).locator('.ap-more');
      await more.waitFor({ state: 'visible' });
      await more.click();
      assert.ok((await q.boundingBox()).height > h0 + 5, 'a long fork question expands');
      await more.click();
      assert.ok(Math.abs((await q.boundingBox()).height - h0) < 2, 'and clamps again');
    }
    await page.screenshot({ path: SHOTS + '/detail-jev-dark-1440.png' });
    assert.equal(await page.locator('#agentPaneHistBody .ap-card').filter({ hasText: 'report gate' }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#agentPaneHistory').isVisible(), false, 'Escape closes the history');
    await row(page, 'main').click();
    assert.match(await page.locator('#agentPaneHistory .ap-stats').nth(1).textContent(), /Conversation cost.*Agents9Running1Agent tokens11k/);
    assert.equal(await page.locator('#agentPaneHistory button').filter({ hasText: 'Project cost breakdown' }).count(), 1);
    await page.keyboard.press('Escape');

    // Keyboard: arrows move, right/left expand and collapse, Enter opens.
    await row(page, 'main').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'advisor');
    await row(page, 'team').focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await row(page, 'team').getAttribute('aria-expanded'), 'false');
    await page.keyboard.press('ArrowRight');
    assert.equal(await row(page, 'team').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'sub:e1');
    await page.keyboard.press('Enter');
    await page.locator('#agentPaneHistBody .msg').filter({ hasText: 'for e1.' }).waitFor();
    await page.keyboard.press('Escape');

    // Earlier turns: expands in place, grouped by turn, and folds again.
    const fold = row(page, 'earlier');
    assert.match(await fold.textContent(), /Earlier turns/);
    await fold.click();
    assert.equal(await row(page, 'turn:13').count(), 1);
    assert.match(await row(page, 'turn:13').textContent(), /Turn 13.*Add PAD coverage checks with tests/);
    await row(page, 'turn:13').click();
    assert.equal(await row(page, 'e:sub:old13').count(), 1);
    assert.equal(await row(page, 'e:sub:old13b').locator('.ap-st').first().getAttribute('data-status'), 'stopped');
    await page.screenshot({ path: SHOTS + '/pane-earlier-dark.png' });
    await fold.click();
    assert.equal(await row(page, 'turn:13').count(), 0, 'folds again');

    // The stepper: Turn 13 shows only that turn's workers; "Back to now" returns.
    await page.locator('#agentPane .ap-turn button[aria-label="Previous turn"]').click();
    assert.match(await page.locator('#agentPaneTurn').textContent(), /^Turn 13 · /);
    assert.equal(await row(page, 'sub:old13').count(), 1);
    assert.equal(await row(page, 'sub:w1').count(), 0);
    assert.equal(await row(page, 'wf:audit').count(), 0, 'the run belongs to turn 14');
    if (await row(page, 'jev').getAttribute('aria-expanded') !== 'true') await row(page, 'jev').locator('.ap-chev').click();
    assert.deepEqual(await page.locator('#agentPane .ap-row[data-kind="fork"] b').evaluateAll((l) => l.map((e) => e.textContent)), ['which adapter'], "turn 13's fork only");
    assert.match(await page.locator('#agentPane .ap-tnote').textContent(), /Only the work of that turn is shown/);
    await page.locator('#agentPane .ap-tnote button').click();
    assert.equal(await page.locator('#agentPaneTurn').textContent(), 'Turn 14 · now');

    // Resizable from the left edge, clamped and remembered.
    const g = await rect(page, '#agentPane .ap-grip');
    await page.mouse.move(g.left + 4, 400); await page.mouse.down(); await page.mouse.move(g.left - 400, 400); await page.mouse.up();
    assert.ok(Math.abs((await rect(page, '#agentPane')).width - 560) < 2, 'clamped at 560');
    assert.equal(await page.evaluate(() => localStorage.getItem('x056_agent_pane_w')), '560');

    // The pane may sit beside the terminal view.
    await page.locator('#chatTerminal').click();
    await page.waitForSelector('#term .term-head');
    assert.equal(await pane(page).isVisible(), true, 'pane and terminal coexist');

    // Expand: the console view over the WHOLE conversation, chat and composer hidden;
    // exclusive with the terminal.
    await page.locator('#agentPaneExpand').click();
    await page.waitForSelector('#atree .at-card');
    assert.equal(await page.locator('#term').isVisible(), false, 'expanding closes the terminal');
    assert.equal(await page.locator('main .scroll').isVisible(), false);
    assert.equal(await page.locator('.composer-wrap').isVisible(), false, 'the composer is hidden too');
    assert.equal(await pane(page).isVisible(), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('x056_agent_tree')), 'expanded');
    assert.match(await page.locator('#atreeTitle').textContent(), /WORKS · OPUS ON CALL/);
    assert.equal((await page.locator('#atreeForkCount b').textContent()).trim(), '3', "this turn's forks only");
    assert.equal(await page.locator('#atree .at-fork').filter({ hasText: 'which adapter' }).count(), 0);
    assert.doesNotMatch(await page.locator('#atree .at-log').textContent(), /which adapter/);
    assert.equal(await page.locator('#atree .at-card-status[data-status=ended]').first().textContent(), '⊘ ended · no result');
    const cardOrder = await page.locator('#atree .at-cards > .at-card').evaluateAll((l) => l.map((e) => e.className.replace('at-card ', '')));
    assert.deepEqual(cardOrder, ['running', 'done', 'ended', 'stopped', 'failed']);
    assert.equal(await page.locator('#atree .at-cards > .at-card.done .at-kids .at-card').count(), 1, 'nested child in its spawner');
    assert.equal(await page.locator('#atree img').count(), 0);
    // The earlier fold expands in place, grouped by turn, and folds again.
    assert.equal(await page.locator('#atreeEarlier').textContent(), '▸ +3 earlier');
    await page.locator('#atreeEarlier').click();
    assert.equal(await page.locator('#atree .at-eg').count(), 2);
    assert.match(await page.locator('#atree .at-egh').first().textContent(), /turn 13/);
    assert.equal(await page.locator('#atree .at-er-btn[data-status=done]').count(), 1);
    await page.screenshot({ path: SHOTS + '/expanded-dark.png' });
    await page.locator('#atreeEarlier').click();
    assert.equal(await page.locator('#atree .at-eg').count(), 0);
    // A worker opens its reader; the terminal opening collapses the expanded view.
    await page.locator('#atree .at-cards > .at-card.done > .at-card-btn').click();
    await page.locator('.agent-reader-scroll').filter({ hasText: 'for w1.' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#chatTerminal').click();
    await page.waitForSelector('#term .term-head');
    assert.equal(await page.locator('#atree').isVisible(), false);
    assert.equal(await pane(page).isVisible(), true, 'collapsed back to the pane');
    // Expand again, then Collapse.
    await page.locator('#agentPaneExpand').click();
    assert.equal(await page.locator('#term').isVisible(), false);
    await page.locator('#atreeCollapse').click();
    assert.equal(await page.locator('#atree').isVisible(), false);
    assert.equal(await pane(page).isVisible(), true);
    assert.equal(await page.locator('.composer-wrap').isVisible(), true);

    // Retired: no floating island, no usage popup; /agent and Activity open the tree.
    assert.equal(await page.locator('#wfIsland, #subPop, #subagentsBtn, #chatAgents').count(), 0);
    await page.locator('#chatAgentTree').click();
    assert.equal(await pane(page).isVisible(), false);
    await page.locator('#chatActivity').click();
    await page.getByRole('menuitem', { name: 'Agent tree' }).click();
    await row(page, 'main').waitFor();
    assert.equal(await page.getByRole('menuitem', { name: 'Usage & subagents' }).count(), 0);

    // A chat row naming a subagent still opens the reader (bound on the next list refresh).
    await page.evaluate(() => { const r = document.createElement('div'); r.className = 'act sub'; r.dataset.agentId = 'w1'; const s = document.createElement('span'); s.className = 'el'; s.textContent = 'Subagent: Edit auth.ts'; r.appendChild(s); document.getElementById('chat').appendChild(r); });
    await page.locator('#chatAgentTree').click(); await page.locator('#chatAgentTree').click();
    await page.waitForSelector('#chat .act.sub.open', { timeout: 9000 });
    await page.locator('#chat .act.sub.open').click();
    await page.locator('.agent-reader-scroll').filter({ hasText: 'for w1.' }).waitFor();
    await page.keyboard.press('Escape');

    // A conversation with nothing on: the main node alone, no stepper without turns.
    await page.goto(base); await page.waitForSelector('.cr-task');
    await openConv(page, 'Review accessibility findings');
    await row(page, 'main').waitFor();
    await page.waitForTimeout(800); assert.deepEqual(await page.locator('#agentPane .ap-row').evaluateAll((l) => l.map((e) => e.dataset.key)), ['main']);

    // A ChatGPT conversation: its Codex child is listed and opens its history.
    await page.goto(base); await page.waitForSelector('.cr-task');
    await openConv(page, 'Update the component library');
    await row(page, 'sub:child').waitFor();
    assert.equal(await statusOf(page, 'sub:child'), 'run');
    assert.match(await row(page, 'sub:child').textContent(), /Codex agent.*Astra review agent/);
    await row(page, 'advisor').click();
    await page.locator('#agentPaneHistBody .ap-card').first().waitFor();
    await page.screenshot({ path: SHOTS + '/pane-codex-dark.png' });
    await page.locator('#agentPaneExpand').click();
    await page.waitForSelector('#atree .at-check.lit');
    assert.deepEqual(await page.locator('#atree .at-check.lit').evaluateAll((l) => l.map((e) => e.dataset.trigger)), ['plan', 'done']);
    await page.locator('#atreeClose').click();
    assert.equal(await page.locator('main .scroll').isVisible(), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // ---- no `turns` from the server: one "this turn", from turnStartedAt ----
  {
    withTurns = false;
    const { ctx, page, errors } = await newPage({ width: 1440, height: 900 }, 'light');
    await openConv(page, 'Build the new homepage');
    await page.locator('#chatAgentTree').click();
    await row(page, 'sub:w1').waitFor();
    assert.equal(await page.locator('#agentPane .ap-turn').isVisible(), false, 'no stepper with a single turn');
    assert.equal(await row(page, 'sub:old13').count(), 0);
    await row(page, 'earlier').click();
    assert.equal(await row(page, 'turn:before').count(), 1);
    await row(page, 'turn:before').click();
    assert.equal(await row(page, 'e:sub:old12').count(), 1);
    await page.screenshot({ path: SHOTS + '/pane-desktop-light-fallback.png' });
    assert.deepEqual(errors, []);
    await ctx.close();
    withTurns = true;
  }

  // ---- desktop, light ----
  {
    const { ctx, page, errors } = await newPage({ width: 1440, height: 900 }, 'light');
    await openConv(page, 'Build the new homepage');
    await page.locator('#chatAgentTree').click();
    await row(page, 'sub:w1').waitFor();
    await row(page, 'wf:audit').locator('.ap-chev').click();
    await row(page, 'wfa:audit:wa2').waitFor();
    await page.screenshot({ path: SHOTS + '/pane-desktop-light.png' });
    await row(page, 'dg:d-reviewer').click();
    await page.locator('#agentPaneHistory .ap-report').waitFor();
    await page.screenshot({ path: SHOTS + '/pane-history-light.png' });
    await detailShots(page, 'light', 1440);
    await page.locator('#agentPaneExpand').click();
    await page.waitForSelector('#atree .at-card');
    await page.screenshot({ path: SHOTS + '/expanded-light.png' });
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // ---- a narrow frame (tablet): no room for two columns, so the history drills in ----
  {
    const { ctx, page, errors } = await newPage({ width: 900, height: 900 }, 'dark');
    await openConv(page, 'Build the new homepage');
    await page.locator('#moreBtn').isVisible();
    await page.evaluate(() => document.getElementById('chatAgentTree').click());
    await row(page, 'sub:w1').waitFor();
    await row(page, 'sub:w1').click();
    await page.locator('#agentPaneHistBody .msg').first().waitFor();
    assert.equal(await page.locator('#agentPaneOutline').isVisible(), false, 'drilled in');
    await page.locator('#agentPaneHistory button[aria-label="Back to the tree"]').click();
    assert.equal(await page.locator('#agentPaneOutline').isVisible(), true);
    await page.screenshot({ path: SHOTS + '/pane-tablet-dark.png' });
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // ---- phone ----
  for (const theme of ['dark', 'light']) {
    const { ctx, page, errors } = await newPage({ width: 390, height: 844 }, theme);
    await openConv(page, 'Build the new homepage');
    assert.equal(await page.locator('#chatAgentTree').isVisible(), false, 'no header button on phones');
    await page.locator('#moreBtn').click();
    await page.getByRole('menuitem', { name: 'Agent tree' }).click();
    await row(page, 'sub:w1').waitFor();
    const lay = await page.evaluate(() => {
      const p = document.getElementById('agentPane').getBoundingClientRect();
      const over = [...document.querySelectorAll('#agentPane *')].some((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > window.innerWidth + 1; });
      return { left: p.left, right: p.right, over };
    });
    assert.ok(lay.left <= 1 && lay.right <= 391 && !lay.over, 'fills the frame without running off: ' + JSON.stringify(lay));
    await page.screenshot({ path: SHOTS + '/pane-phone-' + theme + '.png' });
    await row(page, 'sub:w1').click();
    await page.locator('#agentPaneHistBody .msg').first().waitFor();
    assert.equal(await page.locator('#agentPaneHistory button[aria-label="Back to the tree"]').isVisible(), true);
    await page.screenshot({ path: SHOTS + '/pane-phone-history-' + theme + '.png' });
    await detailShots(page, theme, 390);
    await page.locator('#agentPaneHistory button[aria-label="Back to the tree"]').click();
    await page.locator('#agentPaneClose').click();
    assert.equal(await pane(page).isVisible(), false);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  await browser.close();
  console.log('PASS agent tree: docked beside a usable chat; per-turn stepper; truthful ended/stopped/failed; working first; nested by parent; workflow run expands; subagent/workflow/delegate/advisor/Jev histories; keyboard; earlier fold expands and folds; resizable; coexists with the terminal; expanded view hides chat and composer and is exclusive with the terminal; Codex child listed; fallback without turns; tablet drill-in; phone');
})().catch((e) => { console.error(e); process.exit(1); });
