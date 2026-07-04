import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, afterEach, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { CONTINUE_PROMPT, runSession } from '../src/failover.js';

const FAKE = new URL('./bin/fake-claude', import.meta.url).pathname;

describe('e2e: failover across accounts via fake-claude', () => {
  afterEach(() => {
    delete process.env.X056_FAKE_SCENARIO;
    delete process.env.X056_FAKE_SCENARIO_RESUME;
  });

  it('detects the limit on A, kills the turn, resumes on B, completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-e2e-'));

    // Account A's turn: init, some work, then the CLI starts retrying a quota 429 and hangs.
    // The supervisor must kill it (kill-on-first-signal, D3) — the scenario never exits by itself.
    const scenarioA = join(dir, 'a.jsonl');
    writeFileSync(
      scenarioA,
      [
        JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'e2e-sid' } }),
        JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } } }),
        JSON.stringify({ delayMs: 20 }),
        JSON.stringify({ event: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' } }),
        JSON.stringify({ hang: true }),
      ].join('\n'),
    );

    // Account B's resume turn: completes the task.
    const scenarioB = join(dir, 'b.jsonl');
    writeFileSync(
      scenarioB,
      [
        JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'e2e-sid' } }),
        JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'finished on b' } }),
        JSON.stringify({ exit: 0 }),
      ].join('\n'),
    );

    process.env.X056_FAKE_SCENARIO = scenarioA;
    process.env.X056_FAKE_SCENARIO_RESUME = scenarioB;

    const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'a', configDir: join(dir, 'cfg-a') },
      { name: 'b', configDir: join(dir, 'cfg-b') },
    ]);
    const log = new EventLog(join(dir, 'events.jsonl'));

    const res = await runSession({
      registry, log,
      sessionId: 'e2e-sid', cwd: dir, prompt: 'do the task',
      claudePath: FAKE, forceSwitchSignal: false,
      now: () => 100,
    });

    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1, resultText: 'finished on b' });
    expect(registry.get('a').state.kind).toBe('limited');
    const types = log.read().map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['limit_detected', 'failover', 'turn_completed']));
  }, 15000);
});
