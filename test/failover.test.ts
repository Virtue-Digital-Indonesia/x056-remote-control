import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { CONTINUE_PROMPT, runSession } from '../src/failover.js';
import type { RunControl } from '../src/failover.js';
import type { TurnHandle, TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

const REJECTED: RawEvent = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 2000, rateLimitType: 'five_hour' },
};
const SUCCESS: RawEvent = { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'task done' };
const ASSISTANT: RawEvent = { type: 'assistant', message: { content: [] } };
const USER_EVENT: RawEvent = { type: 'user', message: { content: [] } };

interface Recorded {
  configDir: string;
  mode: string;
  prompt: string;
}

/** A marker interpreted by scriptTurns as "wait this long before dispatching the next event". */
interface DelayMarker {
  __delayMs: number;
}
type ScriptItem = RawEvent | DelayMarker;

function isDelayMarker(e: ScriptItem): e is DelayMarker {
  return typeof (e as DelayMarker).__delayMs === 'number';
}

/** Builds a startTurn stand-in that replays one scripted event list per call. */
function scriptTurns(script: ScriptItem[][], recorded: Recorded[]): (opts: TurnOptions) => TurnHandle {
  let call = 0;
  return (opts: TurnOptions) => {
    recorded.push({ configDir: opts.configDir, mode: opts.mode, prompt: opts.prompt });
    const events = script[call];
    call += 1;
    let killed = false;
    const done = (async () => {
      for (const e of events) {
        if (killed) break;
        if (isDelayMarker(e)) {
          await new Promise((r) => setTimeout(r, e.__delayMs));
          continue;
        }
        opts.onEvent(e);
        await new Promise((r) => setTimeout(r, 1));
      }
      return { code: killed ? null : 0, signal: killed ? ('SIGKILL' as const) : null };
    })();
    return { kill: () => { killed = true; }, interrupt: () => { killed = true; }, done };
  };
}

/**
 * Like scriptTurns, but interrupt() is a no-op — simulating a wedged CLI build that
 * ignores SIGINT. Only kill() stops the turn. kill() resolves a shared signal so any
 * in-flight delay is cut short immediately, keeping the grace-kill test fast and
 * deterministic (Finding 3, D7 grace-kill).
 */
function scriptTurnsIgnoreInterrupt(script: ScriptItem[][], recorded: Recorded[]): (opts: TurnOptions) => TurnHandle {
  let call = 0;
  return (opts: TurnOptions) => {
    recorded.push({ configDir: opts.configDir, mode: opts.mode, prompt: opts.prompt });
    const events = script[call];
    call += 1;
    let killed = false;
    let resolveKillSignal: (() => void) | undefined;
    const killSignal = new Promise<void>((r) => { resolveKillSignal = r; });
    const kill = () => {
      killed = true;
      resolveKillSignal?.();
    };
    const done = (async () => {
      for (const e of events) {
        if (killed) break;
        if (isDelayMarker(e)) {
          await Promise.race([new Promise((r) => setTimeout(r, e.__delayMs)), killSignal]);
          continue;
        }
        opts.onEvent(e);
        await Promise.race([new Promise((r) => setTimeout(r, 1)), killSignal]);
      }
      return { code: killed ? null : 0, signal: killed ? ('SIGKILL' as const) : null };
    })();
    return { kill, interrupt: () => { /* ignores SIGINT — only kill() stops it */ }, done };
  };
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'x056-fo-'));
  const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'a', configDir: '/cfg/a' },
    { name: 'b', configDir: '/cfg/b' },
  ]);
  const log = new EventLog(join(dir, 'events.jsonl'));
  return { registry, log };
}

const base = { sessionId: 'sid-x', cwd: '/tmp', prompt: 'build the thing', forceSwitchSignal: false };

describe('runSession', () => {
  it('completes on the first account when no limit hits', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: scriptTurns([[SUCCESS]], recorded),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'a', failovers: 0, resultText: 'task done' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ configDir: '/cfg/a', mode: 'new', prompt: 'build the thing' });
  });

  it('fails over to b on a rejected rate_limit_event and resumes with CONTINUE_PROMPT', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: scriptTurns([[REJECTED], [SUCCESS]], recorded),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1 });
    expect(recorded[1]).toMatchObject({ configDir: '/cfg/b', mode: 'resume', prompt: CONTINUE_PROMPT });
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 2000 });
    const types = log.read().map((r) => r.type);
    expect(types).toContain('limit_detected');
    expect(types).toContain('failover');
  });

  it('parks when both accounts are limited, with the earliest reset', async () => {
    const { registry, log } = fixtures();
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: scriptTurns([[REJECTED], [{ ...REJECTED, rate_limit_info: { status: 'rejected', resetsAt: 1500 } }]], []),
    });
    expect(res).toMatchObject({ status: 'parked', parkedUntil: 1500, failovers: 2 });
  });

  it('trips the flap guard after more than 3 failovers in an hour', async () => {
    const { registry, log } = fixtures();
    // accounts recover instantly: resetsAt in the past, so pickActive always finds one
    const INSTANT: RawEvent = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1 } };
    const res = await runSession({
      ...base, registry, log, now: () => 100, maxFailoversPerHour: 3,
      startTurnFn: scriptTurns([[INSTANT], [INSTANT], [INSTANT], [INSTANT], [SUCCESS]], []),
    });
    expect(res.status).toBe('failed');
    expect(res.failovers).toBe(4);
    expect(log.read().map((r) => r.type)).toContain('flap_guard_tripped');
  });

  it('uses the 30m fallback when a limit signal (synthetic transcript entry) has no resetsAt, flagged as estimated', async () => {
    const { registry, log } = fixtures();
    // A synthetic transcript entry ("You've hit your limit") carries no parsed reset time.
    const NO_RESET: RawEvent = { type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, message: { model: '<synthetic>', content: [] } };
    await runSession({
      ...base, registry, log, now: () => 1000,
      startTurnFn: scriptTurns([[NO_RESET], [SUCCESS]], []),
    });
    // estimated: true — this cooldown is our own 30m guess, not an Anthropic-reported
    // reset time, so the UI must not present it as a factual countdown.
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 1000 + 30 * 60, estimated: true });
  });

  it('marks a real rate_limit_event reset time as NOT estimated (it is Anthropic-reported fact)', async () => {
    const { registry, log } = fixtures();
    await runSession({ ...base, registry, log, now: () => 1000, startTurnFn: scriptTurns([[REJECTED], [SUCCESS]], []) });
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 2000 });
  });

  it('drains then interrupts on a forced switch (SIGUSR1), failing over with the 30m cooldown (D7)', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const resultPromise = runSession({
      ...base,
      forceSwitchSignal: true,
      registry,
      log,
      now: () => 100,
      startTurnFn: scriptTurns(
        [
          [ASSISTANT, { __delayMs: 50 }, USER_EVENT],
          [SUCCESS],
        ],
        recorded,
      ),
    });
    process.kill(process.pid, 'SIGUSR1');
    const res = await resultPromise;

    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1 });
    const types = log.read().map((r) => r.type);
    expect(types).toContain('forced_switch');
    expect(types).toContain('failover');
    // A forced switch is never backed by an Anthropic-reported reset time.
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 100 + 30 * 60, estimated: true });
  });

  it('user-directed forced switch (bench:false, via control) resumes on the target WITHOUT benching the account it left, and does not count as flapping', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    let ctrl: RunControl | undefined;
    const resultPromise = runSession({
      ...base,
      registry,
      log,
      now: () => 100,
      control: (c) => { ctrl = c; },
      startTurnFn: scriptTurns(
        [
          [ASSISTANT, { __delayMs: 50 }, USER_EVENT],
          [SUCCESS],
        ],
        recorded,
      ),
    });
    // Ask for the switch once the first turn is underway (before its USER_EVENT
    // drains). The manager points the registry at the target first (that's how a
    // user-directed switch chooses WHERE to resume); mirror that here.
    await new Promise((r) => setTimeout(r, 10));
    registry.setActive('b');
    ctrl!.forceSwitch({ bench: false });
    const res = await resultPromise;

    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b' });
    // Intentional, user-directed — not counted toward the flap guard.
    expect(res.failovers).toBe(0);
    const types = log.read().map((r) => r.type);
    expect(types).toContain('forced_switch');
    expect(types).toContain('failover');
    // The account we left stays usable (NOT benched), so the user can switch back.
    expect(registry.get('a').state.kind).not.toBe('limited');
    // And the second turn actually ran on account b (resume mode).
    expect(recorded[1]).toMatchObject({ configDir: registry.get('b').configDir, mode: 'resume' });
  });

  it('does not leave a stale forceSwitchRequested flag when a rate limit wins the SIGUSR1 race (Finding 2)', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const resultPromise = runSession({
      ...base,
      forceSwitchSignal: true,
      registry,
      log,
      now: () => 100,
      startTurnFn: scriptTurns(
        [
          [ASSISTANT, { __delayMs: 50 }, REJECTED],
          [USER_EVENT, SUCCESS],
        ],
        recorded,
      ),
    });
    process.kill(process.pid, 'SIGUSR1');
    const res = await resultPromise;

    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1 });
    expect(registry.get('b').state.kind).not.toBe('limited');
    const types = log.read().map((r) => r.type);
    expect(types).not.toContain('forced_switch');
  });

  it('surfaces a spawn error as a failed status with a reason, instead of discarding the TurnExit (Finding 1)', async () => {
    const { registry, log } = fixtures();
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: () => ({
        kill: () => {},
        interrupt: () => {},
        done: Promise.resolve({ code: null, signal: null, spawnError: 'spawn claude ENOENT' }),
      }),
    });
    expect(res.status).toBe('failed');
    expect(res.reason).toMatch(/ENOENT/);
    const row = log.read().find((r) => r.type === 'turn_failed');
    expect(row).toMatchObject({ spawnError: 'spawn claude ENOENT' });
  });

  it('grace-kills the turn when interrupt() is ignored after a forced switch, still failing over (Finding 3, D7)', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const resultPromise = runSession({
      ...base,
      forceSwitchSignal: true,
      interruptGraceMs: 50,
      registry,
      log,
      now: () => 100,
      startTurnFn: scriptTurnsIgnoreInterrupt(
        [
          [ASSISTANT, { __delayMs: 20 }, USER_EVENT, { __delayMs: 5000 }],
          [SUCCESS],
        ],
        recorded,
      ),
    });
    process.kill(process.pid, 'SIGUSR1');
    const res = await resultPromise;

    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1 });
    const types = log.read().map((r) => r.type);
    expect(types).toContain('forced_switch');
    expect(types).toContain('failover');
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 100 + 30 * 60, estimated: true });
  }, 10000);
});
