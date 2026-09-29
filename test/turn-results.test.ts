import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { TurnResults } from '../server/turn-results.js';

// The `result` of a real Haiku turn with an Opus advisor (live probe, 2.1.280).
const LIVE_RESULT = {
  type: 'result', subtype: 'success', is_error: false, duration_ms: 8523, num_turns: 1, total_cost_usd: 0.1750453,
  modelUsage: {
    'claude-haiku-4-5-20251001': { inputTokens: 11, outputTokens: 187, cacheReadInputTokens: 39103, cacheCreationInputTokens: 10995, costUSD: 0.0266693 },
    'claude-opus-5-5': { inputTokens: 35324, outputTokens: 354, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.148376 },
  },
};

describe('TurnResults', () => {
  // The advisor's cost exists only here -- never in a message's usage.
  it('keeps the per-model cost, so an advisor model shows as its own line item', () => {
    const t = new TurnResults(mkdtempSync(join(tmpdir(), 'x056-tr-')));
    const r = t.record('s-00000001', LIVE_RESULT)!;
    expect(r).toMatchObject({ ok: true, durationMs: 8523, numTurns: 1, totalCostUsd: 0.1750453 });
    expect(r.models).toEqual([
      { model: 'claude-haiku-4-5-20251001', costUsd: 0.0266693, inputTokens: 50109, outputTokens: 187 },
      { model: 'claude-opus-5-5', costUsd: 0.148376, inputTokens: 35324, outputTokens: 354 },
    ]);
    expect(t.list('s-00000001')).toHaveLength(1);
    expect(t.record('s-00000001', { type: 'assistant' })).toBeUndefined();
  });

  it('is recorded and emitted from a Claude turn\'s stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-trm-')), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const runSessionFn = (async (o: RunSessionOptions) => { o.tap?.(LIVE_RESULT as never); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('go', undefined, undefined, p.id);
    for (let i = 0; i < 100 && mgr.snapshot().running; i++) await new Promise((r) => setTimeout(r, 10));
    expect(mgr.turnResults().list(sid)[0]?.totalCostUsd).toBe(0.1750453);
    expect(seen.some((e) => e.kind === 'turn_result')).toBe(true);
  });
});
