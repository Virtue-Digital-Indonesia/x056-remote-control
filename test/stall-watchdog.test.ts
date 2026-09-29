import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startStallWatchdog, topSelfTime } from '../server/stall-watchdog.js';

describe('stall watchdog', () => {
  it('ranks self time and drops idle', () => {
    const top = topSelfTime({
      nodes: [
        { id: 1, callFrame: { functionName: '(idle)', url: '', lineNumber: 0 } },
        { id: 2, callFrame: { functionName: 'listProjects', url: 'file:///app/server/manager.ts', lineNumber: 9 } },
        { id: 3, callFrame: { functionName: 'parse', url: '', lineNumber: 0 } },
      ],
      samples: [1, 2, 2, 3, 2], timeDeltas: [5000, 1000, 1000, 1000, 1000],
    });
    expect(top).toEqual([
      { fn: 'listProjects', where: 'server/manager.ts:10', selfMs: 3 },
      { fn: 'parse', where: '', selfMs: 1 },
    ]);
  });

  // The whole point: a real synchronous block leaves a profile that names it.
  it('keeps the profile of a window in which the loop blocked, naming the blocker', async () => {
    const state = mkdtempSync(join(tmpdir(), 'x056-stall-'));
    const stop = startStallWatchdog(state, { windowMs: 1200, thresholdMs: 300 });
    try {
      await new Promise((r) => setTimeout(r, 300));
      (function blockTheLoopOnPurpose() { const end = Date.now() + 700; while (Date.now() < end) { /* spin */ } })();
      const dir = join(state, 'stall-profiles');
      for (let i = 0; i < 40 && !(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.json'))); i++) await new Promise((r) => setTimeout(r, 100));
      const summary = JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.json'))!), 'utf8'));
      expect(summary.maxDelayMs).toBeGreaterThanOrEqual(300);
      expect(summary.top.map((t: { fn: string }) => t.fn)).toContain('blockTheLoopOnPurpose');
      expect(readdirSync(dir).some((f) => f.endsWith('.cpuprofile'))).toBe(true);
    } finally { stop(); }
  }, 15000);

  it('keeps nothing when the loop never blocks', async () => {
    const state = mkdtempSync(join(tmpdir(), 'x056-stall-'));
    const stop = startStallWatchdog(state, { windowMs: 400, thresholdMs: 300 });
    await new Promise((r) => setTimeout(r, 1100));
    stop();
    expect(existsSync(join(state, 'stall-profiles'))).toBe(false);
  });
});
