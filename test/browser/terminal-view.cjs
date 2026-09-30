// The terminal view: the whole session, raw, like the CLI shows it.
// Start fixture.ts first; this finds the fixture's transcript on disk to append
// entries and prove the view tails a running conversation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
let playwright; try { playwright = require('playwright'); } catch { playwright = require('/usr/local/lib/node_modules/playwright'); }
const base = process.argv[2] || 'http://127.0.0.1:8779';
const TOKEN = 'browser-fixture-token-0123456789';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('x056_token', 'browser-fixture-token-0123456789'); });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const api = async (p) => (await context.request.get(base + p, { headers: { Authorization: 'Bearer ' + TOKEN } })).json();

  const projects = await api('/api/projects');
  const project = projects.projects.find((p) => p.name === 'Website refresh');
  const conv = project.conversations.find((c) => c.title === 'Build the new homepage');
  const transcript = execSync(`find /tmp -path '*primary/projects/fixture/${conv.sessionId}.jsonl' 2>/dev/null | head -1`).toString().trim();
  assert.ok(transcript, 'fixture transcript not found');
  const stateDir = path.join(transcript.split('/primary/')[0], 'state');

  const open = async () => {
    await page.goto(base); await page.waitForSelector('.cr-task');
    await page.locator('.cr-task').filter({ hasText: 'Build the new homepage' }).first().click();
    await page.waitForTimeout(800);
  };
  await open();
  await page.locator('#chatTerminal').click();
  await page.waitForSelector('#term .tl.user');
  assert.equal(await page.locator('#term').isVisible(), true);
  assert.equal(await page.locator('main .scroll').isVisible(), false, 'the chat is swapped out while the terminal is open');
  assert.equal(await page.locator('#chatTerminal').getAttribute('aria-pressed'), 'true');
  assert.match(await page.locator('#termMeta').textContent(), /Claude transcript/);

  // Live: a running turn appends tool calls, results and an advisor consultation.
  const now = new Date().toISOString();
  const add = (o) => fs.appendFileSync(transcript, JSON.stringify({ timestamp: now, ...o }) + '\n');
  add({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test -- --run layout' } }] } });
  add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Tests 12 passed (12)' }] } });
  add({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'server_tool_use', id: 's1', name: 'advisor', input: {} }, { type: 'advisor_tool_result', tool_use_id: 's1', content: { type: 'advisor_redacted_result', encrypted_content: 'xyz' } }] } });
  add({ type: 'custom-title', customTitle: 'Build the new homepage' });
  await page.waitForSelector('#term .tl.tool', { timeout: 6000 });
  assert.match(await page.locator('#term .tl.tool').last().textContent(), /Bash\(npm test -- --run layout\)/);
  assert.match(await page.locator('#term .tl.result').last().textContent(), /Tests 12 passed/);
  assert.match(await page.locator('#term .tl.advisor').first().textContent(), /Advising/);
  assert.match(await page.locator('#term .tl.advisor').last().textContent(), /advisor reviewed · advice encrypted/);
  // Metadata lines exist but are hidden until asked for.
  assert.equal(await page.locator('#term .tl.meta').last().isVisible(), false);
  await page.locator('#termShowMeta').check();
  assert.equal(await page.locator('#term .tl.meta').last().isVisible(), true);

  // Clicking a line shows its raw entry.
  await page.locator('#term .tl.tool').last().click();
  assert.match(await page.locator('#term .tl.tool .td').last().textContent(), /"command": "npm test -- --run layout"/);
  await page.screenshot({ path: '/tmp/x056-terminal-view.png' });

  // The helper menu: helpers combine; Jev is offered only with a key.
  const helper = page.locator('#helperBtn');
  assert.equal(await helper.isDisabled(), false);
  await page.locator('#prompt').click(); // the composer rests as one line; focus opens its controls
  await helper.click();
  assert.equal(await page.locator('#helperMenu [data-value=jev]').isDisabled(), true, 'no Jev key in the fixture');
  // OpenAI Decisions is the alternative to Jev, offered once an OpenAI key exists.
  assert.equal(await page.locator('#helperMenu [data-value=decisions]').isDisabled(), true, 'no OpenAI key in the fixture');
  assert.match(await page.locator('#helperDecisionsDesc').textContent(), /Needs an OpenAI API key/);
  await page.screenshot({ path: '/tmp/x056-helper-menu.png' });
  await page.locator('#helperMenu [data-kind=advisor]').click();
  await page.waitForTimeout(500);
  // The menu stays open, so a second helper can be added in the same visit.
  assert.equal(await page.locator('#helperMenu').isVisible(), true);
  await page.locator('#helperMenu [data-kind=team]').click();
  await page.waitForTimeout(500);
  assert.equal(await helper.getAttribute('data-state'), 'on');
  assert.equal(await page.locator('#helperLabel').textContent(), 'Advisor · Team');
  assert.equal(await page.locator('#helperMenu [data-kind=team]').getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('#helperMenu [data-kind=router][data-value=""]').getAttribute('aria-checked'), 'true');
  await page.screenshot({ path: '/tmp/x056-helper-menu-team.png' });
  await page.keyboard.press('Escape');
  const after = (await api('/api/projects')).projects.find((p) => p.id === project.id).conversations.find((c) => c.sessionId === conv.sessionId);
  assert.deepEqual(after.helpers, { advisor: true, team: true });

  // A Jev decision recorded for this conversation shows up merged in, by time,
  // and so does one from OpenAI Decisions (same store, told apart by backend).
  fs.mkdirSync(path.join(stateDir, 'jev', 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jev', 'decisions', conv.sessionId + '.jsonl'), JSON.stringify({ at: now, sessionId: conv.sessionId, provider: 'claude', pickedModel: 'haiku', modelConfidence: 1, pickedEffort: 'low', effortConfidence: 1, model: 'haiku', effort: 'low', notes: ['model -> haiku', 'effort -> low'], latencyMs: 404, costUsd: 0.000026 }) + '\n'
    + JSON.stringify({ at: now, sessionId: conv.sessionId, provider: 'claude', backend: 'openai', lean: 'low', pickedEffort: 'high', effortConfidence: 0.9, effort: 'high', notes: ['effort -> high'], latencyMs: 151, inputTokens: 96 }) + '\n');
  // A Claude turn's result, with its advisor's cost as a separate line item.
  // Two forks the team handed off: one followed, one sent back to the main model.
  fs.mkdirSync(path.join(stateDir, 'jev', 'forks'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'jev', 'forks', conv.sessionId + '.jsonl'), [
    { at: now, sessionId: conv.sessionId, backend: 'jev', question: 'which file', options: ['src/auth.ts', 'README.md'], choice: 'src/auth.ts', confidence: 0.79, verdict: 'sharp', latencyMs: 280 },
    { at: now, sessionId: conv.sessionId, backend: 'jev', question: 'retry or stop', options: ['retry', 'stop'], choice: 'stop', confidence: 0.53, verdict: 'split', latencyMs: 250 },
  ].map((f) => JSON.stringify(f)).join('\n') + '\n');
  fs.mkdirSync(path.join(stateDir, 'turn-results'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'turn-results', conv.sessionId + '.jsonl'), JSON.stringify({ at: now, sessionId: conv.sessionId, ok: true, durationMs: 8523, numTurns: 1, totalCostUsd: 0.1750453, models: [{ model: 'claude-haiku-4-5-20251001', costUsd: 0.0266693 }, { model: 'claude-opus-5-5', costUsd: 0.148376 }] }) + '\n');
  await open();
  await page.waitForSelector('#term .tl.jev', { timeout: 6000 }); // reopened: the view remembers it was open
  assert.match(await page.locator('#term .tl.sys').filter({ hasText: 'turn done' }).last().textContent(), /turn done · 1 step · 8\.5 s · \$0\.175 \(haiku-4-5-20251001 \$0\.027 · opus-5-5 \$0\.148\)/);
  const picks = page.locator('#term .tl.jev').filter({ hasNotText: 'fork' });
  assert.match(await picks.first().textContent(), /jev · model haiku 100% · effort low 100% → model -> haiku, effort -> low · 404 ms/);
  assert.match(await picks.last().textContent(), /decisions \(low\) · effort high 90% → effort -> high · 151 ms · 96 tok/);
  assert.equal(await page.locator('#helperBtn').getAttribute('data-state'), 'on');
  const forks = page.locator('#term .tl.jev').filter({ hasText: 'fork' });
  assert.match(await forks.first().textContent(), /jev · fork · which file → src\/auth\.ts 79% SHARP → follow · 280 ms/);
  assert.match(await forks.last().textContent(), /jev · fork · retry or stop → stop 53% SPLIT → main model · 250 ms/);

  // The docked agent tree may sit beside the terminal; only its expanded view is exclusive.
  await page.locator('#chatAgentTree').click();
  await page.locator('#agentPane .ap-row[data-key="main"]').waitFor();
  assert.equal(await page.locator('#term').isVisible(), true, 'the terminal stays with the pane open');
  await page.locator('#agentPaneExpand').click();
  assert.equal(await page.locator('#term').isVisible(), false, 'the expanded tree replaces the terminal');
  await page.locator('#atreeClose').click();
  await page.locator('#chatTerminal').click();
  assert.equal(await page.locator('#term').isVisible(), true);

  await page.locator('#chatTerminal').click();
  assert.equal(await page.locator('#term').isVisible(), false);
  assert.equal(await page.locator('main .scroll').isVisible(), true);
  assert.deepEqual(errors, []);
  await browser.close();
  console.log('PASS terminal view: tails tool calls, results and advisor lines live, raw entries on click, metadata toggle, Jev decisions merged, helpers combine and persist, team forks shown');
})().catch((e) => { console.error(e); process.exit(1); });
