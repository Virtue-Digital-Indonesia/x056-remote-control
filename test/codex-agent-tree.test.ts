import 'reflect-metadata';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { codexAdapter, codexTaskName } from '../src/adapters/codex.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { ApiController, codexBrief } from '../server/api.controller.js';
import { inTurn } from '../server/agent-tree.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { CodexTurnMeter, TurnResults } from '../server/turn-results.js';

// The shapes below are copied from a real 0.159.2 child rollout ("Godel",
// /root/implement_dev101_runner, 6 tasks) of the AHU Rebuild conversation.
const P = '01a1174e-9c88-7723-917e-abc331d647f0';
const C = '01a11775-68ae-75b0-804c-0beb7541b686';

const meta = {
  type: 'session_meta', timestamp: '2026-10-07T17:42:12.910Z',
  payload: {
    session_id: P, id: C, parent_thread_id: P, timestamp: '2026-10-07T17:42:12.910Z', cwd: '/tmp', originator: 'x056', cli_version: '0.159.2',
    base_instructions: 'x'.repeat(16 * 1024),
    source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1, agent_path: '/root/implement_dev101_runner', agent_nickname: 'Godel', agent_role: null } } },
    thread_source: 'subagent', agent_nickname: 'Godel', agent_path: '/root/implement_dev101_runner', model_provider: 'openai',
  },
};
const ev = (timestamp: string, payload: Record<string, unknown>) => ({ type: 'event_msg', timestamp, payload });
const ctx = (timestamp: string, effort = 'medium') => ({ type: 'turn_context', timestamp, payload: { model: 'gpt-6-astra', effort, collaboration_mode: { mode: 'default', settings: { model: 'gpt-6-astra', reasoning_effort: effort } } } });
const started = (iso: string) => ev(iso, { type: 'task_started', turn_id: 't', started_at: Date.parse(iso) / 1000 });
const complete = (iso: string, startIso: string, text: string) => ev(iso, { type: 'task_complete', turn_id: 't', last_agent_message: text, started_at: Date.parse(startIso) / 1000, completed_at: Date.parse(iso) / 1000, duration_ms: Date.parse(iso) - Date.parse(startIso) });
const cmd = (iso: string, command: string) => ev(iso, { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/sh', '-lc', command], parsed_cmd: [{ type: 'read', cmd: command }], status: 'completed', exit_code: 0 } });
const tokens = (iso: string, input: number) => ev(iso, { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 10, output_tokens: 5, total_tokens: input + 5 } } });

function home(lines: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-tree-'));
  const day = join(dir, 'sessions', '2026', '10', '07');
  mkdirSync(day, { recursive: true });
  const parent = { type: 'session_meta', timestamp: '2026-10-07T16:59:50.704Z', payload: { session_id: P, id: P, timestamp: '2026-10-07T16:59:50.704Z', cwd: '/tmp', source: 'vscode', thread_source: 'user' } };
  writeFileSync(join(day, `rollout-2026-10-07T16-59-50-${P}.jsonl`), JSON.stringify(parent) + '\n');
  const file = join(day, `rollout-2026-10-07T17-42-12-${C}.jsonl`);
  writeFileSync(file, [meta, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

// Two tasks: one in turn 1 (17:42-17:50), one in turn 2 (18:26-18:28).
const TWO_TASKS = [
  started('2026-10-07T17:42:12.974Z'), ctx('2026-10-07T17:42:14.432Z'), cmd('2026-10-07T17:43:00.000Z', 'cat package.json'),
  tokens('2026-10-07T17:49:00.000Z', 1000), complete('2026-10-07T17:50:00.000Z', '2026-10-07T17:42:12.974Z', 'Runner implemented.'),
  started('2026-10-07T18:26:11.329Z'), ctx('2026-10-07T18:26:11.375Z', 'high'), cmd('2026-10-07T18:27:00.000Z', 'npm test -- tenancy'),
  tokens('2026-10-07T18:28:00.000Z', 2000), complete('2026-10-07T18:28:27.549Z', '2026-10-07T18:26:11.329Z', 'Fixed the review notes.'),
];

describe('Codex children in the agent tree', () => {
  it('names a child by the task its parent filed it under', () => {
    expect(codexTaskName('/root/implement_dev101_ssh_ingress')).toBe('Implement dev101 ssh ingress');
    expect(codexTaskName('/root/review/check_auth')).toBe('Check auth');
    expect(codexTaskName('/root')).toBeUndefined();
    expect(codexTaskName(undefined)).toBeUndefined();
    const h = home(TWO_TASKS);
    const [row] = codexAdapter.listSubagents!([h.dir], P);
    expect(row).toMatchObject({ agentId: C, agentType: 'codex-subagent', task: 'Implement dev101 runner', nickname: 'Godel', agentPath: '/root/implement_dev101_runner', description: 'Implement dev101 runner · Godel' });
  });

  it('reads its own model and effort, every task, the first start and the last step', () => {
    const h = home(TWO_TASKS);
    const st = codexAdapter.subagentStatus!([h.dir], P, C)!;
    expect(st).toMatchObject({
      status: 'done', result: 'Fixed the review notes.', model: 'gpt-6-astra', effort: 'high', tasks: 2,
      firstStartedAt: Date.parse('2026-10-07T17:42:12.974Z'), startedAt: Date.parse('2026-10-07T18:26:11.329Z'), endedAt: Date.parse('2026-10-07T18:28:27.549Z'),
      current: 'npm test -- tenancy', usage: { input: 2000, output: 5, cached: 10 },
    });
    expect(st.activeMs).toBe((Date.parse('2026-10-07T17:50:00.000Z') - Date.parse('2026-10-07T17:42:12.974Z')) + (Date.parse('2026-10-07T18:28:27.549Z') - Date.parse('2026-10-07T18:26:11.329Z')));
  });

  it('the API row spans every task, so a child working in two turns is in both; its brief is the task, never the result', () => {
    const h = home(TWO_TASKS);
    const controller = Object.create(ApiController.prototype) as ApiController & Record<string, unknown>;
    Object.assign(controller, {
      manager: { historyContext: () => ({ providerSessionId: P, configDirs: [h.dir], adapter: codexAdapter }), isSessionRunning: () => false, subagentRunning: () => undefined },
      stats: { statsFor: () => null },
    });
    const [row] = (controller.conversationSubagents('p', 's') as { subagents: Record<string, unknown>[] }).subagents;
    expect(row).toMatchObject({ status: 'done', model: 'gpt-6-astra', effort: 'high', tasks: 2, current: 'npm test -- tenancy', startedAt: Date.parse('2026-10-07T17:42:12.974Z') });
    expect(row.brief).toMatch(/^Task: Implement dev101 runner \(agent Godel\)/);
    expect(row.brief).toMatch(/Given 2 tasks/);
    expect(row.brief).not.toContain(row.result as string);
    const turn1 = { startedAt: '2026-10-07T17:40:12.000Z', endedAt: '2026-10-07T18:00:00.000Z' };
    const turn2 = { startedAt: '2026-10-07T18:20:00.000Z', endedAt: '2026-10-07T18:40:00.000Z' };
    const before = { startedAt: '2026-10-07T17:20:00.000Z', endedAt: '2026-10-07T17:33:00.000Z' };
    expect(inTurn(row as never, turn1)).toBe(true);
    expect(inTurn(row as never, turn2)).toBe(true);
    expect(inTurn(row as never, before)).toBe(false);
    expect(codexBrief({}, null)).toBe('');
  });

  it('a running child reports its latest step, and a later task updates it', () => {
    const h = home([started('2026-10-07T17:42:12.974Z'), ctx('2026-10-07T17:42:14.432Z'), cmd('2026-10-07T17:43:00.000Z', 'rg -n jobRunDir server/tenancy')]);
    expect(codexAdapter.subagentStatus!([h.dir], P, C)).toMatchObject({ status: 'running', current: 'rg -n jobRunDir server/tenancy', tasks: 1 });
  });
});

describe('Codex turn results', () => {
  const usage = (threadId: string, total: [number, number, number], last: [number, number, number]) => ({
    type: 'thread.tokenUsage.updated', threadId, turnId: 't',
    tokenUsage: { total: { inputTokens: total[0], cachedInputTokens: total[1], outputTokens: total[2], reasoningOutputTokens: 0, totalTokens: total[0] + total[2] }, last: { inputTokens: last[0], cachedInputTokens: last[1], outputTokens: last[2], reasoningOutputTokens: 0, totalTokens: last[0] + last[2] } },
  });

  it('meters the turn from the thread\'s token updates, ignoring its children', () => {
    const m = new CodexTurnMeter();
    // The thread had already used 50k/5k before this turn.
    m.observe(usage(P, [60_000, 40_000, 6_000], [10_000, 8_000, 1_000]));
    m.observe({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 0 } });
    m.observe(usage(C, [999_999, 0, 99_999], [999_999, 0, 99_999])); // a child in the same app-server
    m.observe({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } });
    m.observe({ type: 'item.completed', item: { type: 'collab_agent_tool_call' } });
    m.observe(usage(P, [80_000, 55_000, 7_500], [20_000, 15_000, 1_500]));
    expect(m.result(P)).toEqual({ steps: 2, usage: { input: 30_000, output: 2_500, cached: 23_000, written: 0 } });
  });

  it('prices the turn with the model it ran on', () => {
    const t = new TurnResults(mkdtempSync(join(tmpdir(), 'x056-trc-')));
    const r = t.recordCodex('s-00000002', { ok: true, durationMs: 1234, steps: 3, model: 'gpt-6-astra', usage: { input: 30_000, output: 2_500, cached: 23_000, written: 0 } })!;
    // gpt-6-astra: $10/M in, $50/M out, cached at a tenth of input.
    expect(r.totalCostUsd).toBeCloseTo((7_000 * 10 + 23_000 * 1 + 2_500 * 50) / 1e6, 9);
    expect(r).toMatchObject({ provider: 'codex', ok: true, durationMs: 1234, numTurns: 3, models: [{ model: 'gpt-6-astra', inputTokens: 30_000, outputTokens: 2_500 }] });
    expect(t.recordCodex('s-00000002', { ok: true, steps: 0, model: 'gpt-9-unknown', usage: { input: 1, output: 1, cached: 0, written: 0 } })!.totalCostUsd).toBeUndefined();
  });

  it('is recorded from a Codex turn\'s stream and lights the main node\'s last turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-trcm-')), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'g', configDir: join(dir, 'g'), provider: 'codex' }]);
    const runSessionFn = (async (o: RunSessionOptions) => {
      o.tap?.({ type: 'thread.started', thread_id: P } as never);
      o.tap?.(usage(P, [1000, 0, 100], [1000, 0, 100]) as never);
      o.tap?.({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', exit_code: 0 } } as never);
      o.tap?.({ type: 'turn.completed' } as never);
      return { status: 'completed', finalAccount: 'g', failovers: 0 } as SessionResult;
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    const p = mgr.createProject('C', dir, 'codex');
    const sid = mgr.start('go', undefined, { model: 'gpt-6-astra' }, p.id);
    for (let i = 0; i < 100 && mgr.snapshot().running; i++) await new Promise((r) => setTimeout(r, 10));
    const [r] = mgr.turnResults().list(sid);
    expect(r).toMatchObject({ provider: 'codex', ok: true, numTurns: 1, models: [{ model: 'gpt-6-astra', inputTokens: 1000, outputTokens: 100 }] });
    expect(r.totalCostUsd).toBeCloseTo((1000 * 10 + 100 * 50) / 1e6, 9);
    expect(typeof r.durationMs).toBe('number');
    expect(seen.some((e) => e.kind === 'turn_result')).toBe(true);
    const tree = mgr.agentTree(p.id, sid) as { main: { lastTurn: { steps?: number; costUsd?: number } | null } };
    expect(tree.main.lastTurn).toMatchObject({ steps: 1 });
  });
});

it('the advisor\'s checkpoint trigger has its own label and lights in the console view', () => {
  const src = readFileSync(join(__dirname, '..', 'server', 'public', 'agent-tree.js'), 'utf8');
  expect(src).toMatch(/TRIG = \{[^}]*checkpoint: 'Checkpoint'/);
  expect(src).toMatch(/var CHECKPOINTS = \[.*\['checkpoint', 'checkpoint'\]/);
});
