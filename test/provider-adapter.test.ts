import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { runSession } from '../src/failover.js';
import type { ProviderAdapter } from '../src/provider.js';
import type { TurnHandle, TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

/**
 * Proves the ProviderAdapter seam is real, not a Claude passthrough: this fake
 * adapter uses event shapes NOTHING like Claude's (no `type: 'result'`, no
 * `type: 'user'`) and drives a full failover purely through adapter methods. If
 * runSession still had Claude event-shapes hardcoded, none of this would work.
 */
const CX_CONTINUE = 'resume on the other account';

const codexLike: ProviderAdapter = {
  id: 'codex',
  label: 'FakeCodex',
  configEnvVar: 'FAKE_HOME',
  continuePrompt: CX_CONTINUE,
  startTurn: () => { throw new Error('startTurn should be overridden by startTurnFn in this test'); },
  classify: (e) =>
    e.kind === 'cx_limit'
      ? { kind: 'limited', resetsAt: e.resetsAt as number | undefined, source: 'cx' }
      : { kind: 'irrelevant', source: 'none' },
  isResult: (e) => e.kind === 'cx_done',
  resultOk: (e) => e.kind === 'cx_done' && e.ok === true,
  resultText: (e) => (typeof e.text === 'string' ? e.text : undefined),
  isDrainBoundary: (e) => e.kind === 'cx_turn_end',
  toActivity: () => [],
  readIdentity: () => ({}),
};

interface Recorded { configDir: string; mode: string; prompt: string }

function scriptTurns(script: RawEvent[][], recorded: Recorded[]): (opts: TurnOptions) => TurnHandle {
  let call = 0;
  return (opts: TurnOptions) => {
    recorded.push({ configDir: opts.configDir, mode: opts.mode, prompt: opts.prompt });
    const events = script[call];
    call += 1;
    let killed = false;
    const done = (async () => {
      for (const e of events) {
        if (killed) break;
        opts.onEvent(e);
        await new Promise((r) => setTimeout(r, 1));
      }
      return { code: killed ? null : 0, signal: killed ? ('SIGKILL' as const) : null };
    })();
    return { kill: () => { killed = true; }, interrupt: () => { killed = true; }, done };
  };
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'x056-cx-'));
  // The fake adapter's id is 'codex', so its failover pool must be codex accounts —
  // runSession now scopes pickActive/earliestReset to the session's provider.
  const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'a', configDir: '/cfg/a', provider: 'codex' },
    { name: 'b', configDir: '/cfg/b', provider: 'codex' },
  ]);
  const log = new EventLog(join(dir, 'events.jsonl'));
  return { registry, log };
}

const base = { sessionId: 'cx-1', cwd: '/tmp', prompt: 'do it', forceSwitchSignal: false as const };

describe('runSession with a non-Claude provider adapter', () => {
  it('completes using the adapter\'s own result shape (cx_done), returning its text', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const res = await runSession({
      ...base, registry, log, now: () => 100, adapter: codexLike,
      startTurnFn: scriptTurns([[{ kind: 'cx_done', ok: true, text: 'shipped it' }]], recorded),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'a', failovers: 0, resultText: 'shipped it' });
  });

  it('fails over on the adapter\'s own limit shape (cx_limit) and resumes with the adapter\'s continuePrompt', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const res = await runSession({
      ...base, registry, log, now: () => 100, adapter: codexLike,
      startTurnFn: scriptTurns(
        [[{ kind: 'cx_limit', resetsAt: 9000 }], [{ kind: 'cx_done', ok: true, text: 'done on b' }]],
        recorded,
      ),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1 });
    // The resume ran on b, in resume mode, with the CODEX continue prompt — not Claude's.
    expect(recorded[1]).toMatchObject({ configDir: '/cfg/b', mode: 'resume', prompt: CX_CONTINUE });
    // The adapter's reported reset time was honored (not estimated).
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 9000 });
  });
});
