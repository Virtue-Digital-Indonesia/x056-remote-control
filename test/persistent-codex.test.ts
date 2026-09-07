import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PersistentTurns } from '../src/persistent.js';
import { CodexTransport, mapItem } from '../src/persistent-codex.js';
import { codexAdapter, captureSessionId, classifyCodexEvent } from '../src/adapters/codex.js';
import type { TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

/**
 * A stand-in for `codex app-server`: parses JSON-RPC requests off stdin,
 * answers the handshake and turn/start the way the real one does (verified
 * live on 0.153.4), and emits notifications when the test says so.
 */
function fakeAppServer(opts: { threadId?: string; failThread?: boolean; noRollout?: boolean; refuseTurn?: boolean } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stdin: { write: (s: string) => void; destroyed: boolean; writableEnded: boolean };
    kill: (s?: string) => void; pid?: number;
  };
  child.stdout = new EventEmitter();
  const requests: { id?: number; method: string; params: Record<string, unknown> }[] = [];
  const out = (o: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  let turnSeq = 0;
  child.stdin = {
    destroyed: false, writableEnded: false,
    write: (s: string) => {
      const m = JSON.parse(s) as { id?: number; method: string; params: Record<string, unknown> };
      requests.push(m);
      if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } });
      else if (m.method === 'thread/start' || m.method === 'thread/resume') {
        if (opts.failThread) out({ id: m.id, error: { code: -32000, message: 'no such thread' } });
        // Verbatim from 0.153.4 when the id has no rollout under this CODEX_HOME.
        else if (opts.noRollout && m.method === 'thread/resume') out({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${String(m.params.threadId)}` } });
        else out({ id: m.id, result: { thread: { id: opts.threadId ?? (m.params.threadId as string) ?? 'thr_new' }, model: m.params.model ?? 'gpt-5.6-sol' } });
      } else if (m.method === 'turn/start') {
        if (opts.refuseTurn) out({ id: m.id, error: { code: -32600, message: 'model gpt-6-astra is not available on this account' } });
        else out({ id: m.id, result: { turn: { id: `turn_${++turnSeq}`, status: 'inProgress' } } });
      } else if (m.id !== undefined) out({ id: m.id, result: {} }); // steer / interrupt acks
    },
  };
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null, 'SIGKILL'); };
  const sent = (method: string) => requests.filter((r) => r.method === method);
  return {
    child, requests, sent,
    get killed() { return killed; },
    notify: (method: string, params: unknown) => out({ method, params }),
    item: (phase: 'started' | 'completed', item: Record<string, unknown>) =>
      out({ method: `item/${phase}`, params: { threadId: 't', turnId: `turn_${turnSeq}`, item } }),
    complete: (status = 'completed', error?: string) =>
      out({ method: 'turn/completed', params: { threadId: 't', turn: { id: `turn_${turnSeq}`, status, ...(error ? { error: { message: error } } : {}) } } }),
  };
}

function pool(o: { threadId?: string; failThread?: boolean; noRollout?: boolean; refuseTurn?: boolean; workingGraceMs?: number; now?: () => number } = {}) {
  const spawned: ReturnType<typeof fakeAppServer>[] = [];
  const p = new PersistentTurns({
    transport: new CodexTransport(),
    workingGraceMs: o.workingGraceMs, now: o.now,
    spawnFn: () => { const f = fakeAppServer(o); spawned.push(f); return f.child as never; },
  });
  return { p, spawned };
}

const turn = (over: Partial<TurnOptions> = {}): TurnOptions => ({
  configDir: '/cfg/d', cwd: '/work', sessionId: 'x056-conv', mode: 'new', prompt: 'hello',
  onEvent: () => {}, ...over,
});

const collect = () => { const ev: RawEvent[] = []; return { ev, onEvent: (e: RawEvent) => { ev.push(e); } }; };

describe('codex persistent: handshake', () => {
  it('spawns app-server under CODEX_HOME, opens a thread, and only then sends the prompt', async () => {
    const { p, spawned } = pool({ threadId: 'thr_abc' });
    const c = collect();
    const h = p.startTurn(turn({ onEvent: c.onEvent }));
    const f = spawned[0];
    expect(f.sent('initialize')).toHaveLength(1);
    expect(f.sent('thread/start')).toHaveLength(1);
    expect(f.sent('thread/start')[0].params).toMatchObject({ cwd: '/work', approvalPolicy: 'never', sandbox: 'danger-full-access' });
    // The prompt went out as turn/start AFTER the thread id came back.
    const ts = f.sent('turn/start');
    expect(ts).toHaveLength(1);
    expect(ts[0].params).toMatchObject({ threadId: 'thr_abc', input: [{ type: 'text', text: 'hello' }] });
    expect(f.requests.map((r) => r.method)).toEqual(['initialize', 'thread/start', 'turn/start']);
    f.complete();
    expect(await h.done).toMatchObject({ code: 0 });
  });

  it('emits thread.started with the provider id so captureSessionId works unchanged', () => {
    const { p } = pool({ threadId: 'thr_abc' });
    const c = collect();
    p.startTurn(turn({ onEvent: c.onEvent }));
    const started = c.ev.find((e) => e.type === 'thread.started');
    expect(started).toBeTruthy();
    expect(captureSessionId(started!)).toBe('thr_abc');
  });

  it('resumes an existing thread with thread/resume and the stored id', () => {
    const { p, spawned } = pool();
    p.startTurn(turn({ mode: 'resume', sessionId: '019f9220-old' }));
    const f = spawned[0];
    expect(f.sent('thread/start')).toHaveLength(0);
    expect(f.sent('thread/resume')[0].params).toMatchObject({ threadId: '019f9220-old' });
    expect(f.sent('turn/start')[0].params).toMatchObject({ threadId: '019f9220-old' });
  });

  it('passes model and effort on turn/start, and MCP wiring on thread/start', () => {
    const { p, spawned } = pool();
    p.startTurn(turn({ model: 'gpt-6-astra', effort: 'ultra', mcp: { configPath: '/x', command: 'node', args: ['s.js'], env: { T: '1' } } }));
    const f = spawned[0];
    expect(f.sent('turn/start')[0].params).toMatchObject({ model: 'gpt-6-astra', effort: 'ultra' });
    expect(f.sent('thread/start')[0].params).toMatchObject({ config: { mcp_servers: { x056: { command: 'node', args: ['s.js'], env: { T: '1' } } } } });
  });

  it('ends the turn as thread.failed when the thread cannot be opened, instead of hanging', async () => {
    const { p } = pool({ failThread: true });
    const c = collect();
    const h = p.startTurn(turn({ onEvent: c.onEvent }));
    expect(await h.done).toMatchObject({ code: 0 });
    expect(c.ev.some((e) => e.type === 'thread.failed')).toBe(true);
  });
});

describe('codex persistent: a turn', () => {
  it('translates items into the exec shapes the codex adapter reads', async () => {
    const { p, spawned } = pool();
    const c = collect();
    const h = p.startTurn(turn({ onEvent: c.onEvent }));
    const f = spawned[0];
    f.item('started', { type: 'commandExecution', id: 'i1', command: 'ls -la', status: 'inProgress' });
    f.item('completed', { type: 'commandExecution', id: 'i1', command: 'ls -la', status: 'completed', exitCode: 0, aggregatedOutput: 'ok' });
    f.item('started', { type: 'fileChange', id: 'i2', status: 'inProgress', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '' }] });
    f.item('completed', { type: 'fileChange', id: 'i2', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '' }] });
    f.item('completed', { type: 'agentMessage', id: 'i3', text: 'All done.' });
    f.complete();
    await h.done;

    const types = c.ev.map((e) => e.type);
    expect(types).toEqual(['thread.started', 'turn.started', 'item.started', 'item.completed', 'item.started', 'item.completed', 'item.completed', 'turn.completed']);
    // The REAL adapter, not our idea of it: activity rows and the final text.
    const acts = c.ev.flatMap((e) => codexAdapter.toActivity(e));
    expect(acts.some((a) => /Running: ls -la/.test(a.label))).toBe(true);
    expect(acts.some((a) => /Edit|a\.ts/.test(a.label + a.tool))).toBe(true);
    expect(c.ev.flatMap((e) => codexAdapter.assistantText?.(e) ?? [])).toEqual(['All done.']);
    expect(codexAdapter.isResult(c.ev.at(-1)!)).toBe(true);
    expect(codexAdapter.resultOk(c.ev.at(-1)!)).toBe(true);
  });

  it('a failed turn surfaces error + turn.failed, ends the turn, and classifies for failover', async () => {
    const { p, spawned } = pool();
    const c = collect();
    const h = p.startTurn(turn({ onEvent: c.onEvent }));
    spawned[0].complete('failed', 'Your workspace is out of credits. Add credits to continue.');
    await h.done;
    const tf = c.ev.find((e) => e.type === 'turn.failed');
    expect(tf).toBeTruthy();
    expect(classifyCodexEvent(tf!).kind).toBe('limited');
    expect(codexAdapter.resultOk(c.ev.at(-1)!)).toBe(false);
  });

  it('a second turn reuses the process and the thread: no new handshake', async () => {
    const { p, spawned } = pool({ threadId: 'thr_1' });
    const h1 = p.startTurn(turn({ prompt: 'one' }));
    spawned[0].complete(); await h1.done;
    const h2 = p.startTurn(turn({ prompt: 'two', mode: 'resume', sessionId: 'x056-conv' }));
    spawned[0].complete(); await h2.done;
    expect(spawned).toHaveLength(1);
    expect(spawned[0].sent('thread/start').length + spawned[0].sent('thread/resume').length).toBe(1);
    expect(spawned[0].sent('turn/start').map((r) => (r.params.input as { text: string }[])[0].text)).toEqual(['one', 'two']);
  });
});

describe('codex persistent: steering and stopping', () => {
  it('mid-turn steer is turn/steer bound to the running turn id', () => {
    const { p, spawned } = pool();
    p.startTurn(turn({ sessionId: 's1' }));
    expect(p.injectMessage('s1', 'also check the tests')).toBe(true);
    const st = spawned[0].sent('turn/steer');
    expect(st).toHaveLength(1);
    expect(st[0].params).toMatchObject({ expectedTurnId: 'turn_1', input: [{ type: 'text', text: 'also check the tests' }] });
  });

  it('a steer between turns is a new turn/start whose result does not settle the next gateway turn', async () => {
    const { p, spawned } = pool();
    const h1 = p.startTurn(turn({ sessionId: 's1', prompt: 'first' }));
    spawned[0].complete(); await h1.done;

    expect(p.injectMessage('s1', 'background steer')).toBe(true);
    expect(spawned[0].sent('turn/start')).toHaveLength(2);
    expect(spawned[0].sent('turn/steer')).toHaveLength(0);

    const h2 = p.startTurn(turn({ sessionId: 's1', prompt: 'second', mode: 'resume' }));
    let settled: unknown = null; void h2.done.then((x) => { settled = x; });
    spawned[0].complete();                      // belongs to the steer
    await new Promise((r) => setImmediate(r));
    expect(settled).toBeNull();
    spawned[0].complete();                      // this one is turn 2's
    expect(await h2.done).toMatchObject({ code: 0 });
  });

  it('cannot steer before the thread is open', () => {
    const { p } = pool();
    // failThread keeps ext.threadId unset forever
    const q = pool({ failThread: true });
    q.p.startTurn(turn({ sessionId: 's9' }));
    expect(q.p.injectMessage('s9', 'x')).toBe(false);
    void p;
  });

  it('interrupt is turn/interrupt with the thread and turn ids; the process lives', () => {
    const { p, spawned } = pool({ threadId: 'thr_i' });
    const h = p.startTurn(turn({ sessionId: 's1' }));
    h.interrupt();
    const ir = spawned[0].sent('turn/interrupt');
    expect(ir).toHaveLength(1);
    expect(ir[0].params).toMatchObject({ threadId: 'thr_i', turnId: 'turn_1' });
    expect(spawned[0].killed).toBe(false);
    expect(p.interruptSession('s1')).toBe(true);
  });

  it('kill really ends the process (failover depends on it)', async () => {
    const { p, spawned } = pool();
    const h = p.startTurn(turn({ sessionId: 's1' }));
    h.kill();
    expect(spawned[0].killed).toBe(true);
    expect(await h.done).toMatchObject({ signal: 'SIGKILL' });
  });
});

describe('mapItem', () => {
  it('renames the type and camelCase fields to the exec --json shape', () => {
    expect(mapItem({ type: 'commandExecution', exitCode: 1, aggregatedOutput: 'x', status: 'failed' }))
      .toMatchObject({ type: 'command_execution', exit_code: 1, aggregated_output: 'x', status: 'failed' });
    expect(mapItem({ type: 'mcpToolCall', tool: 'wiki_search', server: 'codegraph', status: 'completed' }))
      .toMatchObject({ type: 'mcp_tool_call', tool: 'wiki_search', server: 'codegraph' });
  });
  it('treats a declined approval as a failure and flattens change kinds', () => {
    const m = mapItem({ type: 'fileChange', status: 'declined', changes: [{ path: 'a', kind: { type: 'delete' } }] });
    expect(m.status).toBe('failed');
    expect(m.changes).toEqual([{ path: 'a', kind: 'delete' }]);
  });
});

describe('codex persistent: a resume with nothing to resume', () => {
  // thread/start hands out an id at once but writes no rollout until a turn
  // runs. A thread whose first turn died (401, limit, a container swap) is
  // therefore an id with no history, and every later resume of it failed in
  // 300 ms with a reason the panel never showed. Seen live: one conversation
  // wedged across a re-login, a failover AND a deploy.
  it('falls back to a fresh thread, reports the new id, and runs the turn on it', async () => {
    const { p, spawned } = pool({ noRollout: true, threadId: 'thr_fresh' });
    const c = collect();
    const h = p.startTurn(turn({ mode: 'resume', sessionId: 'thr_gone', onEvent: c.onEvent }));
    const f = spawned[0];
    expect(f.sent('thread/resume')).toHaveLength(1);
    const starts = f.sent('thread/start');
    expect(starts).toHaveLength(1);
    expect(starts[0].params).toMatchObject({ cwd: '/work', approvalPolicy: 'never' });
    expect(starts[0].params.threadId).toBeUndefined();
    // The manager stores whatever thread.started names -- so it must be the NEW id.
    expect(c.ev.find((e) => e.type === 'thread.started')).toMatchObject({ thread_id: 'thr_fresh' });
    expect(c.ev.find((e) => e.type === 'thread.reset')).toMatchObject({ from: 'thr_gone' });
    expect(c.ev.some((e) => e.type === 'thread.failed')).toBe(false);
    // The prompt went to the fresh thread.
    expect(f.sent('turn/start')[0].params).toMatchObject({ threadId: 'thr_fresh' });
    f.complete();
    const exit = await h.done;
    expect(exit.code).toBe(0);
  });

  it('does not loop: a second miss ends the turn with the reason attached', async () => {
    const { p, spawned } = pool({ failThread: true });
    const c = collect();
    const h = p.startTurn(turn({ mode: 'resume', sessionId: 'thr_x', onEvent: c.onEvent }));
    expect(spawned[0].sent('thread/start')).toHaveLength(0); // 'no such thread' is not the no-rollout answer
    await h.done;
    expect(c.ev.map((e) => e.type)).toEqual(expect.arrayContaining(['error', 'thread.failed']));
    expect(c.ev.find((e) => e.type === 'error')).toMatchObject({ message: 'no such thread' });
  });

  it('a refused turn/start carries its message too', async () => {
    const { p, spawned } = pool({ refuseTurn: true });
    const c = collect();
    const h = p.startTurn(turn({ onEvent: c.onEvent }));
    await h.done;
    expect(c.ev.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('not available') });
    expect(codexAdapter.failureText!(c.ev.find((e) => e.type === 'turn.failed')!)).toContain('not available');
    expect(spawned[0].killed).toBe(false);
  });

  it('a thread.reset is not a limit, so it never triggers a failover', () => {
    expect(classifyCodexEvent({ type: 'thread.reset', from: 'x', message: 'no rollout found for thread id x' }).kind).toBe('irrelevant');
  });
});
