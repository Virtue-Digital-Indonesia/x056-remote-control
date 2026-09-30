// The agent tree: main session, advisor, Jev fork layer, workers, delegates and
// a session log, in the chat's place (exclusive with the terminal view). Start
// fixture.ts first (with X056_PROJECT_SPACES_ENABLED=1 X056_CHAT_ENABLED=1).
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8870';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
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

  // Three forks and one report gate (the gate is NOT a fork).
  fs.mkdirSync(path.join(state, 'jev', 'forks'), { recursive: true });
  fs.writeFileSync(path.join(state, 'jev', 'forks', sid + '.jsonl'), [
    { at: iso(100000), sessionId: sid, backend: 'jev', question: 'which file', options: ['src/auth.ts', 'README.md'], choice: 'src/auth.ts', confidence: 0.79, verdict: 'sharp', latencyMs: 280 },
    { at: iso(90000), sessionId: sid, backend: 'jev', question: 'which tool', options: ['grep', 'codegraph'], choice: 'grep', confidence: 0.48, verdict: 'split', latencyMs: 300 },
    { at: iso(80000), sessionId: sid, backend: 'jev', question: 'retry or stop', options: ['retry', 'stop'], choice: 'stop', confidence: 0.53, verdict: 'split', latencyMs: 250 },
    { at: iso(40000), sessionId: sid, backend: 'jev', question: 'report gate · backend', options: ['done', 'needs_orchestrator', 'needs_human', 'blocked'], choice: 'done', confidence: 0.91, verdict: 'sharp', latencyMs: 310 },
  ].map((f) => JSON.stringify(f)).join('\n') + '\n');

  // Claude's advisor: two calls, no checkpoints to light.
  fs.mkdirSync(path.join(state, 'advisor'), { recursive: true });
  fs.writeFileSync(path.join(state, 'advisor', sid + '.claude.jsonl'), [
    { at: iso(70000), model: 'opus', status: 'reviewed' }, { at: iso(20000), model: 'opus', status: 'reviewed' },
  ].map((c) => JSON.stringify(c)).join('\n') + '\n');

  // Delegates: one working, one that reported and waits on a person.
  const reviewerSid = crypto.randomUUID();
  const report = { at: iso(30000), delegateId: 'd-reviewer', role: 'reviewer', turn: 1, status: 'completed', text: 'NEEDS HUMAN: staging credentials are missing.', durationMs: 95000, gate: 'needs_human', gateConfidence: 0.93, gateBy: 'jev', woke: false };
  fs.mkdirSync(path.join(state, 'delegates'), { recursive: true });
  fs.writeFileSync(path.join(state, 'delegates', sid + '.json'), JSON.stringify({ parentProjectId: project.id, parentSessionId: sid, delegates: [
    { id: 'd-backend', role: 'backend', brief: 'Fix the flaky login test.', provider: 'claude', model: 'opus', projectId: project.id, cwd: root, sessionId: crypto.randomUUID(), status: 'working', createdAt: iso(60000), updatedAt: iso(60000), turns: 1, pending: [] },
    { id: 'd-reviewer', role: 'reviewer', brief: 'Review the DWH views.', provider: 'claude', model: 'fable', projectId: project.id, cwd: root, sessionId: reviewerSid, status: 'idle', createdAt: iso(90000), updatedAt: iso(30000), turns: 1, pending: [], lastReport: report },
  ] }));
  fs.writeFileSync(path.join(state, 'delegates', sid + '.reports.jsonl'), JSON.stringify(report) + '\n');
  fs.writeFileSync(path.join(root, 'primary', 'projects', 'fixture', reviewerSid + '.jsonl'), [
    { type: 'user', timestamp: iso(120000), message: { role: 'user', content: 'Review the DWH views.' } },
    { type: 'assistant', timestamp: iso(100000), message: { role: 'assistant', model: 'claude-fable-5-1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'psql -c "\\\\dv"' } }] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');

  // The tree reads exactly this from the server: 3 forks, 1 gate.
  const t = await api(`/api/conversations/agent-tree?projectId=${project.id}&sessionId=${sid}`);
  assert.equal(t.forks.total, 3); assert.equal(t.gates.length, 1);

  // Workers: this turn's (finished, so the floating Agents island stays shut) and one from earlier.
  const subagents = [
    { agentId: 'w1', agentType: 'worker', description: 'Edit auth.ts and run tests', status: 'done', spawnDepth: 1, startedAt: now - 100000, endedAt: now - 50000 },
    { agentId: 'e1', agentType: 'explorer', description: 'Map the login flow', status: 'done', spawnDepth: 1, startedAt: now - 95000, endedAt: now - 70000 },
    { agentId: 'g1', agentType: 'general-purpose', description: 'Check the <img src=x onerror=alert(1)> docs', status: 'done', spawnDepth: 1, startedAt: now - 90000, endedAt: now - 60000 },
    { agentId: 'n1', agentType: 'explorer', description: 'Find the session cookie', status: 'done', spawnDepth: 2, spawnedBy: 'w1', startedAt: now - 80000, endedAt: now - 75000 },
    { agentId: 'old', agentType: 'worker', description: 'Yesterday task', status: 'done', spawnDepth: 1, startedAt: now - 3600000, endedAt: now - 3500000 },
  ];
  const codexTree = { provider: 'codex', helpers: { advisor: true, team: true }, turnStartedAt: iso(120000),
    main: { model: 'gpt-6-sol', effort: 'high', running: false, background: false, lastTurn: null },
    advisor: { on: true, kind: 'gateway', model: 'gpt-6-astra', checkpoints: true, calls: [
      { at: iso(100000), trigger: 'plan', verdict: 'proceed', delivered: 'none' }, { at: iso(30000), trigger: 'done', verdict: 'concern', delivered: 'queued', advice: 'Add a test for the expired cookie.' }] },
    team: { effort: 'medium', roles: ['explorer', 'worker', 'default'] }, forks: { total: 0, sharp: 0, split: 0, recent: [] }, gates: [], picks: [], delegates: [] };

  async function newPage(vp, theme) {
    const ctx = await browser.newContext({ viewport: vp, colorScheme: theme });
    await ctx.addInitScript((th) => { localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); localStorage.setItem('x056_theme', th); if (!sessionStorage.getItem('at-init')) { sessionStorage.setItem('at-init', '1'); localStorage.removeItem('x056_terminal'); localStorage.removeItem('x056_agent_tree'); } }, theme);
    const page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.route('**/api/conversations/subagents?**', (r) => r.fulfill({ json: { subagents: new URL(r.request().url()).searchParams.get('sessionId') === sid ? subagents : [], self: null } }));
    await page.route('**/api/conversations/workflows?**', (r) => r.fulfill({ json: { runs: [] } }));
    await page.route('**/api/conversations/subagent-history?**', (r) => r.fulfill({ json: { rows: [{ role: 'assistant', text: 'Edited auth.ts.' }], done: true, cursor: 0 } }));
    await page.route('**/api/conversations/agent-tree?**', (r) => new URL(r.request().url()).searchParams.get('sessionId') === codexConv.c.sessionId ? r.fulfill({ json: codexTree }) : r.continue());
    await page.goto(base); await page.waitForSelector('.cr-task');
    return { ctx, page, errors };
  }
  const openConv = async (page, title) => { await page.locator('.cr-task').filter({ hasText: title }).first().click(); await page.waitForTimeout(700); };
  const tree = (page) => page.locator('#atree');

  // ---- desktop, dark ----
  {
    const { ctx, page, errors } = await newPage({ width: 1280, height: 900 }, 'dark');
    await openConv(page, 'Build the new homepage');
    await page.locator('#chatAgentTree').click();
    await page.waitForSelector('#atree .at-card');
    assert.equal(await page.locator('main .scroll').isVisible(), false, 'the chat is swapped out');
    assert.equal(await page.locator('#chatAgentTree').getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#atreeTitle').textContent(), /WORKS · OPUS ON CALL/);
    // Fork count excludes the gate.
    assert.equal((await page.locator('#atreeForkCount b').textContent()).trim(), '3');
    assert.equal(await tree(page).locator('.at-fork').count(), 3);
    assert.equal(await tree(page).locator('.at-fork.sharp .vd').first().textContent(), 'SHARP');
    // This turn's workers; the earlier one folded.
    assert.equal(await page.locator('#atreeEarlier').textContent(), '+1 earlier');
    assert.equal(await tree(page).locator('.at-card').filter({ hasText: 'Yesterday task' }).count(), 0);
    const worker = tree(page).locator('.at-cards > .at-card').filter({ hasText: 'Edit auth.ts' });
    assert.equal(await worker.locator('> .at-card-btn .at-card-model').textContent(), 'Opus · medium');
    assert.equal(await worker.locator('.at-kids .at-card').count(), 1, 'nested child sits in its spawner');
    const gp = tree(page).locator('.at-card').filter({ hasText: 'general-purpose' });
    assert.equal(await gp.locator('.at-card-model').count(), 0, 'no model label outside the team roles');
    assert.equal(await tree(page).locator('img').count(), 0, 'text is never parsed as HTML');
    // Claude advisor: calls counted, checkpoints NOT lit.
    assert.equal(await tree(page).locator('.at-check.lit').count(), 0);
    assert.equal(await tree(page).locator('.at-check.neutral').count(), 3);
    assert.match(await tree(page).locator('.at-adv').textContent(), /calls2/);
    // Delegates and the log.
    assert.equal(await tree(page).locator('.at-dg').count(), 2);
    assert.match(await tree(page).locator('.at-dg').filter({ hasText: 'reviewer' }).textContent(), /reviewerFable○ idle · 1 turnneeds you/);
    const log = await tree(page).locator('.at-log').textContent();
    assert.match(log, /gatebackend → done  p=0\.91/);
    assert.match(log, /jevwhich file → src\/auth\.ts  p=0\.79  SHARP → follow/);
    assert.ok(await tree(page).locator('.at-log li').count() <= 15);
    await page.screenshot({ path: '/tmp/x056-agent-tree-desktop.png', fullPage: false });
    await tree(page).locator('.at-workers').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/x056-agent-tree-desktop-workers.png' });
    await tree(page).locator('.at-node.dg').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/x056-agent-tree-desktop-delegates.png' });
    await tree(page).locator('.at-log').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '/tmp/x056-agent-tree-desktop-log.png' });

    // A worker opens its own reader.
    await worker.locator('> .at-card-btn').click();
    await page.locator('.agent-reader-scroll').filter({ hasText: 'Edited auth.ts.' }).waitFor();
    await page.keyboard.press('Escape');

    // Exclusive with the terminal, both ways, flags included.
    await page.locator('#chatTerminal').click();
    await page.waitForSelector('#term .tl');
    assert.equal(await tree(page).isVisible(), false);
    assert.equal(await page.evaluate(() => [localStorage.getItem('x056_agent_tree'), localStorage.getItem('x056_terminal'), document.querySelector('body > main').classList.contains('atree-open')].join()), ',1,false');
    assert.equal(await page.locator('#chatAgentTree').getAttribute('aria-pressed'), 'false');
    await page.locator('#chatAgentTree').click();
    await page.waitForSelector('#atree .at-card');
    assert.equal(await page.locator('#term').isVisible(), false);
    assert.equal(await page.evaluate(() => [localStorage.getItem('x056_agent_tree'), localStorage.getItem('x056_terminal'), document.querySelector('body > main').classList.contains('term-open')].join()), '1,,false');

    // Clicking a delegate opens the terminal on its transcript, and closes the tree.
    await tree(page).locator('.at-dg-btn[data-delegate=d-reviewer]').click();
    await page.waitForSelector('#term .tl.tool', { timeout: 6000 });
    assert.match(await page.locator('#termMeta').textContent(), /^Delegate reviewer/);
    assert.equal(await tree(page).isVisible(), false);

    // Another conversation with nothing on: the main node and the hint.
    // (reloads: the tree remembers it was open)
    await page.locator('#chatAgentTree').click();
    await page.goto(base); await page.waitForSelector('.cr-task');
    await openConv(page, 'Review accessibility findings');
    await page.waitForSelector('#atree .at-hint');
    assert.match(await tree(page).locator('.at-hint').textContent(), /Turn on Advisor, Agent team or Jev/);
    assert.equal(await tree(page).locator('.at-adv, .at-node.fork, .at-cards').count(), 0);

    // A ChatGPT conversation: the gateway advisor lights the checkpoints it hit.
    await page.goto(base); await page.waitForSelector('.cr-task');
    await openConv(page, 'Update the component library');
    await page.waitForSelector('#atree .at-check.lit');
    assert.deepEqual(await tree(page).locator('.at-check.lit').evaluateAll((l) => l.map((e) => e.dataset.trigger)), ['plan', 'done']);
    assert.match(await tree(page).locator('.at-check[data-trigger=done]').textContent(), /concern/);
    assert.equal(await tree(page).locator('.at-link-label').first().textContent(), 'delegate to subagents · effort medium');
    await page.screenshot({ path: '/tmp/x056-agent-tree-codex.png' });

    await page.locator('#chatAgentTree').click();
    assert.equal(await page.locator('main .scroll').isVisible(), true);
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // ---- desktop, light ----
  {
    const { ctx, page, errors } = await newPage({ width: 1280, height: 900 }, 'light');
    await openConv(page, 'Build the new homepage');
    await page.locator('#chatAgentTree').click();
    await page.waitForSelector('#atree .at-card');
    await page.screenshot({ path: '/tmp/x056-agent-tree-light.png' });
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  // ---- phone ----
  {
    const { ctx, page, errors } = await newPage({ width: 390, height: 844 }, 'dark');
    await openConv(page, 'Build the new homepage');
    assert.equal(await page.locator('#chatAgentTree').isVisible(), false, 'no header button on phones');
    await page.locator('#moreBtn').click();
    await page.getByRole('menuitem', { name: 'Agent tree' }).click();
    await page.waitForSelector('#atree .at-card');
    const tops = await page.evaluate(() => [...document.querySelector('#conversationSurface .topbar').children].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().top)));
    assert.ok(Math.max(...tops) - Math.min(...tops) < 12, 'header on one row');
    const lay = await page.evaluate(() => {
      const r = (s) => document.querySelector(s).getBoundingClientRect();
      const body = document.getElementById('atreeBody');
      const cards = [...document.querySelectorAll('#atree .at-cards > .at-card')].map((c) => c.getBoundingClientRect());
      const over = [...document.querySelectorAll('#atree *')].some((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > window.innerWidth + 1; });
      return { flowBottom: r('#atree .at-flow').bottom, advTop: r('#atree .at-adv').top, scrollX: body.scrollWidth - body.clientWidth, stacked: cards.every((c, i) => i === 0 || c.top >= cards[i - 1].bottom), over };
    });
    assert.ok(lay.advTop >= lay.flowBottom, 'advisor stacks under the pipeline: ' + JSON.stringify(lay));
    assert.ok(lay.stacked, 'worker cards stack');
    assert.ok(lay.scrollX <= 0 && !lay.over, 'nothing runs off the side: ' + JSON.stringify(lay));
    await page.screenshot({ path: '/tmp/x056-agent-tree-phone.png' });
    await page.screenshot({ path: '/tmp/x056-agent-tree-phone-full.png', fullPage: true });
    assert.deepEqual(errors, []);
    await ctx.close();
  }

  await browser.close();
  console.log('PASS agent tree: main/advisor/forks/workers/delegates/log; forks exclude the gate; earlier workers folded; Claude checkpoints unlit, ChatGPT lit; exclusive with the terminal; delegate opens its transcript; phone stacks with a one-row header; no page errors');
})().catch((e) => { console.error(e); process.exit(1); });
