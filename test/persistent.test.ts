import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PersistentTurns } from '../src/persistent.js';
import type { TurnOptions } from '../src/turn.js';

/** A stand-in for the CLI: records what was written, emits what it is told to. */
function fakeCli() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stdin: { write: (s: string) => void }; kill: (s?: string) => void; pid?: number;
  };
  child.stdout = new EventEmitter();
  const written: string[] = [];
  child.stdin = { write: (s: string) => { written.push(s); } };
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null, 'SIGKILL'); };
  return {
    child, written,
    get killed() { return killed; },
    /** Messages the pool sent, parsed. */
    msgs: () => written.map((w) => JSON.parse(w)),
    emit: (e: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(e) + '\n')),
    result: (text: string) => child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: text }) + '\n')),
  };
}

function pool(opts: { idleTtlMs?: number; maxSessions?: number; workingGraceMs?: number; now?: () => number } = {}) {
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; cli: ReturnType<typeof fakeCli> }[] = [];
  const p = new PersistentTurns({
    ...opts,
    spawnFn: (_bin, args, _cwd, env) => {
      const cli = fakeCli();
      spawned.push({ args, env, cli });
      return cli.child as never;
    },
  });
  return { p, spawned };
}

const turn = (over: Partial<TurnOptions> = {}): TurnOptions => ({
  configDir: '/cfg/a', cwd: '/work', sessionId: 's1', mode: 'new', prompt: 'hello',
  onEvent: () => {}, ...over,
});

describe('one process across many turns', () => {
  it('reuses the same process for a second turn', async () => {
    const { p, spawned } = pool();
    const h1 = p.startTurn(turn({ prompt: 'first' }));
    spawned[0].cli.result('one');
    expect(await h1.done).toMatchObject({ code: 0 });

    const h2 = p.startTurn(turn({ prompt: 'second', mode: 'resume' }));
    spawned[0].cli.result('two');
    await h2.done;

    expect(spawned).toHaveLength(1); // no second process
    expect(spawned[0].cli.msgs().map((m) => m.message.content[0].text)).toEqual(['first', 'second']);
  });

  it('ends a turn at `result` while leaving the process alive', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn());
    spawned[0].cli.result('done');
    await h.done;
    // The whole point: the turn is over, the process is not.
    expect(spawned[0].cli.killed).toBe(false);
    expect(p.stats()).toEqual({ sessions: 1, busy: 0, working: 1 });
  });

  it('streams events to the turn in flight, and only that turn', async () => {
    const { p, spawned } = pool();
    const seen1: unknown[] = [];
    const h1 = p.startTurn(turn({ onEvent: (e) => seen1.push(e) }));
    spawned[0].cli.emit({ type: 'assistant', message: { content: [] } });
    spawned[0].cli.result('a');
    await h1.done;

    // An event arriving between turns belongs to nobody and must not be
    // replayed into the next turn's classifier.
    spawned[0].cli.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'stray' }] } });
    const seen2: unknown[] = [];
    const h2 = p.startTurn(turn({ mode: 'resume', onEvent: (e) => seen2.push(e) }));
    spawned[0].cli.result('b');
    await h2.done;
    expect(seen1).toHaveLength(2); // assistant + result
    expect(seen2).toHaveLength(1); // just its own result
  });

  it('hides control_response from the failover classifier', async () => {
    const { p, spawned } = pool();
    const seen: { type?: string }[] = [];
    const h = p.startTurn(turn({ onEvent: (e) => seen.push(e as { type?: string }) }));
    spawned[0].cli.emit({ type: 'control_response', response: { subtype: 'success' } });
    spawned[0].cli.result('x');
    await h.done;
    expect(seen.map((e) => e.type)).toEqual(['result']);
  });
});

describe('spawn arguments', () => {
  it('dictates the session id on a new turn and resumes on a later one', () => {
    const { p, spawned } = pool();
    p.startTurn(turn({ sessionId: 'abc', mode: 'new' }));
    expect(spawned[0].args).toContain('--session-id');
    expect(spawned[0].args).toContain('abc');
    expect(spawned[0].args).toContain('--input-format');
    expect(spawned[0].args).toContain('stream-json');
  });

  it('respawns when the model changes — argv is fixed at spawn', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn({ model: 'opus' }));
    spawned[0].cli.result('a'); await h.done;
    p.startTurn(turn({ model: 'sonnet', mode: 'resume' }));
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toContain('sonnet');
    expect(spawned[1].args).toContain('--resume');
  });

  it('keeps accounts apart: the same session on another configDir is a new process', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn({ configDir: '/cfg/a' }));
    spawned[0].cli.result('a'); await h.done;
    p.startTurn(turn({ configDir: '/cfg/b', mode: 'resume' }));
    expect(spawned).toHaveLength(2);
    expect(spawned[1].env.CLAUDE_CONFIG_DIR).toBe('/cfg/b');
  });
});

describe('failover handoff', () => {
  // The loop kills the handle on a usage limit and re-enters with the next
  // account. That only works if kill() really ends the process — a live one
  // still holds the session id the next account needs to --resume.
  it('kill() ends the process and frees the session for another account', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn({ configDir: '/cfg/a' }));
    h.kill();
    expect(spawned[0].cli.killed).toBe(true);
    expect(await h.done).toMatchObject({ signal: 'SIGKILL' });
    expect(p.stats().sessions).toBe(0);

    const h2 = p.startTurn(turn({ configDir: '/cfg/b', mode: 'resume' }));
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args).toEqual(expect.arrayContaining(['--resume', 's1']));
    spawned[1].cli.result('recovered');
    expect(await h2.done).toMatchObject({ code: 0 });
  });

  it('interrupt() asks the CLI to stop the turn, without killing it', () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn());
    h.interrupt();
    const last = spawned[0].cli.msgs().pop() as { type: string; request: { subtype: string } };
    expect(last.type).toBe('control_request');
    expect(last.request.subtype).toBe('interrupt');
    expect(spawned[0].cli.killed).toBe(false);
  });

  it('finishes the turn when the process dies under it', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn());
    spawned[0].cli.child.emit('close', 1, null);
    expect(await h.done).toMatchObject({ code: 1 });
    expect(p.stats().sessions).toBe(0);
  });

  it('refuses a second turn on a session already running one', async () => {
    const { p } = pool();
    p.startTurn(turn());
    const clash = p.startTurn(turn({ prompt: 'overlap' }));
    // Interleaving two turns would write both into one transcript.
    expect((await clash.done).spawnError).toMatch(/already running/);
  });
});

describe('bounding how long processes live', () => {
  it('evicts an idle session past the TTL', async () => {
    let t = 1_000_000;
    // The grace window has to be shorter than the silence, or the session still
    // counts as working — which is the point of it, and is asserted separately.
    const { p, spawned } = pool({ idleTtlMs: 1000, workingGraceMs: 500, now: () => t });
    const h = p.startTurn(turn());
    spawned[0].cli.result('a'); await h.done;
    expect(p.stats().sessions).toBe(1);
    t += 5000;
    p.startTurn(turn({ sessionId: 'other' })); // any call sweeps first
    expect(spawned[0].cli.killed).toBe(true);
  });

  it('never evicts a session that is mid-turn', async () => {
    let t = 1_000_000;
    const { p, spawned } = pool({ idleTtlMs: 1000, workingGraceMs: 500, now: () => t });
    p.startTurn(turn()); // left running
    t += 5000;
    p.startTurn(turn({ sessionId: 'other' }));
    expect(spawned[0].cli.killed).toBe(false);
  });

  it('drops the least recently active once over the cap', async () => {
    let t = 1_000_000;
    // Small grace so each finished session is genuinely quiet by the time the
    // next one starts; with the default 2min none may be touched.
    const { p, spawned } = pool({ maxSessions: 2, workingGraceMs: 500, now: () => t });
    for (const sid of ['a', 'b', 'c']) {
      t += 1000;
      const h = p.startTurn(turn({ sessionId: sid, mode: 'new' }));
      spawned[spawned.length - 1].cli.result('ok');
      await h.done;
    }
    expect(spawned[0].cli.killed).toBe(true);  // 'a', the oldest
    expect(spawned[1].cli.killed).toBe(false);
    expect(p.stats().sessions).toBe(2);
  });

  it('shutdown kills every live process', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn());
    spawned[0].cli.result('a'); await h.done;
    p.shutdown();
    expect(spawned[0].cli.killed).toBe(true);
    expect(p.stats().sessions).toBe(0);
  });
});

describe('work that continues after a turn ends', () => {
  // Both failures below are the same real incident: a session finished its turn
  // at 06:42:35, a finishing background task woke the model, it worked for 28
  // more seconds writing to its transcript, and 0.6s after its last write a new
  // conversation's startTurn evicted it as "idle" and SIGKILLed it. Nothing it
  // did in those 28 seconds ever reached the panel either.
  const taskNotification = { type: 'user', message: { content: [{ type: 'text', text: '<task-notification>done</task-notification>' }] } };

  it('still delivers events after `result`, to the idle sink not the classifier', async () => {
    const { p, spawned } = pool();
    const toTurn: unknown[] = [];
    const toIdle: unknown[] = [];
    const h = p.startTurn({ ...turn(), onEvent: (e) => toTurn.push(e), onIdleEvent: (e) => toIdle.push(e) });
    spawned[0].cli.result('turn over');
    await h.done;

    // The background task wakes the model; the turn is already finished.
    spawned[0].cli.emit(taskNotification);
    spawned[0].cli.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'resuming work' }] } });

    expect(toTurn).toHaveLength(1);                 // just its own result
    expect(toIdle).toHaveLength(2);                 // the post-turn work
    // Reaching the turn's sink would hand a finished turn's classifier a limit
    // verdict it can no longer act on.
    expect(toIdle.length).toBeGreaterThan(0);
  });

  it('does not evict a session that finished its turn but is still writing', async () => {
    let t = 1_000_000;
    const { p, spawned } = pool({ maxSessions: 1, workingGraceMs: 120_000, now: () => t });
    const h = p.startTurn(turn({ sessionId: 'worker' }));
    spawned[0].cli.result('turn over');
    await h.done;

    t += 29_000;                       // the real gap between result and the kill
    spawned[0].cli.emit(taskNotification); // still working, outside any turn
    t += 600;                          // 0.6s later, another conversation starts

    p.startTurn(turn({ sessionId: 'newcomer', mode: 'new' }));
    expect(spawned[0].cli.killed).toBe(false);  // was SIGKILLed before this fix
    expect(p.stats().working).toBe(2);
  });

  it('evicts once a session has genuinely gone quiet', async () => {
    let t = 1_000_000;
    const { p, spawned } = pool({ maxSessions: 1, workingGraceMs: 60_000, now: () => t });
    const h = p.startTurn(turn({ sessionId: 'quiet' }));
    spawned[0].cli.result('done'); await h.done;
    t += 120_000;                      // past the grace window, no output since
    p.startTurn(turn({ sessionId: 'newcomer', mode: 'new' }));
    expect(spawned[0].cli.killed).toBe(true);
  });

  it('runs over the cap rather than killing live work', async () => {
    let t = 1_000_000;
    const { p, spawned } = pool({ maxSessions: 1, workingGraceMs: 120_000, now: () => t });
    for (const sid of ['a', 'b', 'c']) {
      t += 100;
      const h = p.startTurn(turn({ sessionId: sid, mode: 'new' }));
      spawned[spawned.length - 1].cli.result('ok');
      await h.done;
    }
    // All three are inside the grace window, so none may be destroyed.
    expect(spawned.every((s) => !s.cli.killed)).toBe(true);
    expect(p.stats().sessions).toBe(3); // deliberately over the cap of 1
  });

  it('sweeps on silence, not on when the last turn happened', async () => {
    let t = 1_000_000;
    const { p, spawned } = pool({ idleTtlMs: 60_000, workingGraceMs: 10_000, now: () => t });
    const h = p.startTurn(turn({ sessionId: 'longjob' }));
    spawned[0].cli.result('turn over'); await h.done;

    // Turn ended long ago, but it keeps writing — a long background job.
    for (let i = 0; i < 5; i++) { t += 30_000; spawned[0].cli.emit(taskNotification); }
    t += 5_000;
    p.startTurn(turn({ sessionId: 'other', mode: 'new' }));   // triggers sweep()
    expect(spawned[0].cli.killed).toBe(false);
  });
});

describe('a turn that arrives over the cap', () => {
  // Reproduces the session lost at 06:45:30: four turns were already running
  // against a cap of four, so the fifth was the pool's only idle entry and it
  // evicted ITSELF between spawn and first write. The turn was left with no
  // process and nothing to resolve it, so the conversation hung indefinitely.
  it('runs the newcomer instead of killing it', async () => {
    const { p, spawned } = pool({ maxSessions: 4, workingGraceMs: 0 });
    for (let i = 0; i < 4; i++) p.startTurn(turn({ sessionId: `busy${i}`, mode: 'new' }));

    const h = p.startTurn(turn({ sessionId: 'newcomer', mode: 'new' }));

    expect(spawned).toHaveLength(5);
    expect(spawned[4].cli.killed).toBe(false);          // not evicted
    expect(spawned[4].cli.msgs()).toHaveLength(1);      // its prompt was sent
    spawned[4].cli.result('done');
    expect(await h.done).toMatchObject({ code: 0 });    // and the turn can end
  });

  it('still evicts an idle session to make room', async () => {
    let t = 1_000;
    const { p, spawned } = pool({ maxSessions: 2, workingGraceMs: 0, now: () => t });
    const h0 = p.startTurn(turn({ sessionId: 'old', mode: 'new' }));
    spawned[0].cli.result('x');
    await h0.done;

    t += 60_000;
    p.startTurn(turn({ sessionId: 'mid', mode: 'new' }));
    p.startTurn(turn({ sessionId: 'new', mode: 'new' }));

    expect(spawned[0].cli.killed).toBe(true);   // idle and oldest
    expect(spawned[2].cli.killed).toBe(false);  // the newcomer survives
  });
});

describe('work that outlives a turn is reportable', () => {
  it('lists a session still working after its turn ended, marked not-busy', async () => {
    let t = 1_000;
    const { p, spawned } = pool({ workingGraceMs: 60_000, now: () => t });
    const h = p.startTurn(turn({ sessionId: 's1', mode: 'new' }));

    expect(p.workingSessions()).toEqual([{ sessionId: 's1', busy: true, lastOutput: t }]);

    spawned[0].cli.result('done');
    await h.done;

    // The turn is over, but a background task keeps the process producing.
    t += 5_000;
    spawned[0].cli.emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'still going' }] } });
    const w = p.workingSessions();
    expect(w).toEqual([{ sessionId: 's1', busy: false, lastOutput: t }]);

    // Once it goes quiet past the grace, it stops counting as working.
    t += 120_000;
    expect(p.workingSessions()).toEqual([]);
  });

  it('interrupts background work without killing the session', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn({ sessionId: 's1', mode: 'new' }));
    spawned[0].cli.result('done');
    await h.done;

    expect(p.interruptSession('s1')).toBe(true);
    const last = spawned[0].cli.msgs().pop();
    expect(last).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } });
    expect(spawned[0].cli.killed).toBe(false); // still usable for the next turn

    expect(p.interruptSession('nobody')).toBe(false);
  });
});
