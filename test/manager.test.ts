import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { BusyError, SessionManager, type GatewayEvent } from '../server/manager.js';

function fixture(result: SessionResult, opts?: { emitEvents?: boolean; delayMs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-mgr-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [
    { name: 'a', configDir: '/cfg/a' },
    { name: 'b', configDir: '/cfg/b' },
  ]);
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    if (opts?.emitEvents !== false) {
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello from claude' }] } });
      o.log.append({ type: 'failover', sessionId: o.sessionId, from: 'a' });
    }
    await new Promise((r) => setTimeout(r, opts?.delayMs ?? 20));
    return result;
  }) as unknown as typeof import('../src/failover.js').runSession;
  const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
  return { mgr, calls, dir, stateDir };
}

const COMPLETED: SessionResult = { status: 'completed', finalAccount: 'b', failovers: 1, resultText: 'done' };

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SessionManager', () => {
  it('runs a session, emits assistant text + log + lifecycle events, persists state', async () => {
    const { mgr, calls, dir, stateDir } = fixture(COMPLETED);
    const seen: GatewayEvent[] = [];
    mgr.subscribe((e) => seen.push(e));
    const sid = mgr.start('do it');
    expect(calls[0]?.prompt ?? '').toBe('do it');
    await waitFor(() => mgr.snapshot().running === false && seen.some((e) => e.kind === 'session_done'));
    const kinds = seen.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['session_started', 'assistant_text', 'supervisor', 'session_done']));
    expect(seen.find((e) => e.kind === 'assistant_text')?.data.text).toBe('hello from claude');
    expect(seen.find((e) => e.kind === 'supervisor')?.data.type).toBe('failover');
    const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    expect(st.lastSessionId).toBe(sid);
    expect(st.cwd).toBe(dir);
    expect(mgr.snapshot().lastResult).toEqual(COMPLETED);
  });

  it('rejects concurrent starts with BusyError and allows continue after completion', async () => {
    const { mgr, calls } = fixture(COMPLETED, { delayMs: 100 });
    mgr.start('first');
    expect(() => mgr.start('second')).toThrow(BusyError);
    await waitFor(() => mgr.snapshot().running === false);
    const sid2 = mgr.continueLast('again');
    expect(sid2).toBe(mgr.snapshot().currentSessionId ?? sid2);
    await waitFor(() => mgr.snapshot().running === false);
    expect(calls[1]?.resume).toBe(true);
    expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
  });

  it('continueLast without prior session throws', () => {
    const { mgr } = fixture(COMPLETED);
    expect(() => mgr.continueLast('x')).toThrow(/no previous session/);
  });

  it('rejects cwd outside workspace root', () => {
    const { mgr } = fixture(COMPLETED);
    expect(() => mgr.start('x', '/etc')).toThrow(/outside workspace root/);
  });

  it('replays buffered events to late subscribers from sinceSeq', async () => {
    const { mgr } = fixture(COMPLETED);
    mgr.start('task');
    await waitFor(() => mgr.snapshot().running === false);
    const all: GatewayEvent[] = [];
    mgr.subscribe((e) => all.push(e));
    expect(all.length).toBeGreaterThanOrEqual(3);
    const later: GatewayEvent[] = [];
    mgr.subscribe((e) => later.push(e), all[1].seq);
    expect(later[0].seq).toBe(all[2].seq);
  });

  it('forceSwitch returns false when idle', () => {
    const { mgr } = fixture(COMPLETED);
    expect(mgr.forceSwitch()).toBe(false);
  });

  it('wedge regression: recovers from synchronous launch failure (missing accounts.json)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-mgr-'));
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    // Deliberately DO NOT initialize accounts.json
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => {
      calls.push(o);
      await new Promise((r) => setTimeout(r, 20));
      return COMPLETED;
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });

    // start('x') should throw because accounts.json doesn't exist
    expect(() => mgr.start('x')).toThrow();
    // manager should NOT be wedged: running must be false
    expect(mgr.snapshot().running).toBe(false);
    // create valid accounts.json
    AccountRegistry.init(join(stateDir, 'accounts.json'), [
      { name: 'a', configDir: '/cfg/a' },
    ]);
    // now start('y') should succeed (not throw BusyError)
    const sid = mgr.start('y');
    expect(calls.length).toBe(1);
    expect(calls[0]?.prompt).toBe('y');
    await waitFor(() => mgr.snapshot().running === false);
  });

  it('corrupt state.json: snapshot() degrades gracefully', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-mgr-'));
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [
      { name: 'a', configDir: '/cfg/a' },
    ]);
    // Write invalid JSON to state.json
    writeFileSync(join(stateDir, 'state.json'), 'not-json');
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir });
    // snapshot() should not throw, returns null for lastSessionId
    const snap = mgr.snapshot();
    expect(snap.lastSessionId).toBe(null);
    expect(snap.running).toBe(false);
  });
});

describe('SessionManager.setCurrent (adoption)', () => {
  function adoptFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'x056-adopt-'));
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    const cfgA = join(dir, 'cfg-a');
    AccountRegistry.init(join(stateDir, 'accounts.json'), [
      { name: 'a', configDir: cfgA },
      { name: 'b', configDir: join(dir, 'cfg-b') },
    ]);
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir });
    return { dir, stateDir, cfgA, mgr };
  }

  it('points state.json at an existing transcript and emits session_adopted', () => {
    const { dir, stateDir, cfgA, mgr } = adoptFixture();
    const munged = dir.replace(/[/.]/g, '-');
    mkdirSync(join(cfgA, 'projects', munged), { recursive: true });
    writeFileSync(join(cfgA, 'projects', munged, 'adopt-me.jsonl'), '{"type":"user"}\n');
    const seen: GatewayEvent[] = [];
    mgr.subscribe((e) => seen.push(e));
    mgr.setCurrent('adopt-me', dir);
    const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    expect(st).toEqual({ lastSessionId: 'adopt-me', cwd: dir });
    expect(seen.some((e) => e.kind === 'session_adopted')).toBe(true);
  });

  it('rejects adoption of a transcript that exists in no account tree', () => {
    const { dir, mgr } = adoptFixture();
    expect(() => mgr.setCurrent('ghost', dir)).toThrow(/no transcript/);
  });

  it('rejects adoption while a session is running', async () => {
    const { mgr } = fixture(COMPLETED, { delayMs: 150 });
    mgr.start('busy work');
    expect(() => mgr.setCurrent('anything', '/tmp')).toThrow(BusyError);
    await waitFor(() => mgr.snapshot().running === false);
  });
});

describe('SessionManager model/effort passthrough', () => {
  it('forwards model and effort options into runSession', async () => {
    const { mgr, calls } = fixture(COMPLETED);
    mgr.start('build', undefined, { model: 'sonnet', effort: 'max' });
    await waitFor(() => mgr.snapshot().running === false);
    expect(calls[0].model).toBe('sonnet');
    expect(calls[0].effort).toBe('max');
  });
});

describe('SessionManager activity + turn_state', () => {
  it('emits turn_state active then inactive, and activity for tool calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-act-'));
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [
      { name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' },
    ]);
    const runSessionFn = (async (o: { tap?: (e: unknown) => void }) => {
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }] } });
      o.tap?.({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x1', is_error: false }] } });
      return { status: 'completed', finalAccount: 'a', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const seen: GatewayEvent[] = [];
    mgr.subscribe((e) => seen.push(e));
    mgr.start('go');
    await waitFor(() => seen.some((e) => e.kind === 'turn_state' && (e.data as { active: boolean }).active === false));
    const kinds = seen.map((e) => e.kind);
    expect(kinds.filter((k) => k === 'turn_state')).toEqual(['turn_state', 'turn_state']);
    const acts = seen.filter((e) => e.kind === 'activity').map((e) => (e.data as { status: string }).status);
    expect(acts).toEqual(['start', 'done']);
  });
});

describe('SessionManager parallel projects', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'x056-par-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    const switches: string[] = [];
    const runSessionFn = (async (o: { sessionId: string; cwd: string; control?: (c: { forceSwitch: () => void; abort: () => void }) => void; tap?: (e: unknown) => void }) => {
      o.control?.({ forceSwitch: () => switches.push(o.sessionId), abort: () => {} });
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi ' + o.cwd }] } });
      await new Promise((r) => setTimeout(r, 40));
      return { status: 'completed', finalAccount: 'a', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn });
    const p1 = mgr.createProject('P1', dir);
    const p2 = mgr.createProject('P2', dir);
    return { mgr, p1, p2, switches };
  }

  it('runs two projects at once and tags every event with its projectId', async () => {
    const { mgr, p1, p2 } = setup();
    const seen: GatewayEvent[] = [];
    mgr.subscribe((e) => seen.push(e));
    mgr.start('a', undefined, undefined, p1.id);
    mgr.start('b', undefined, undefined, p2.id);
    expect(mgr.listProjects().projects.filter((p) => p.running).map((p) => p.id).sort()).toEqual([p1.id, p2.id].sort());
    await waitFor(() => mgr.listProjects().projects.every((p) => !p.running));
    const pid = (e: GatewayEvent) => (e.data as { projectId?: string }).projectId;
    expect(seen.some((e) => e.kind === 'assistant_text' && pid(e) === p1.id)).toBe(true);
    expect(seen.some((e) => e.kind === 'assistant_text' && pid(e) === p2.id)).toBe(true);
    expect(seen.filter((e) => e.kind === 'turn_state' && pid(e) === p1.id).length).toBe(2);
  });

  it('blocks a second turn in the same project but allows a different one', async () => {
    const { mgr, p1, p2 } = setup();
    mgr.start('a', undefined, undefined, p1.id);
    expect(() => mgr.start('again', undefined, undefined, p1.id)).toThrow(BusyError);
    expect(() => mgr.start('b', undefined, undefined, p2.id)).not.toThrow();
    await waitFor(() => mgr.listProjects().projects.every((p) => !p.running));
  });

  it('forceSwitch targets one project run and returns false when idle', async () => {
    const { mgr, p1, p2, switches } = setup();
    expect(mgr.forceSwitch(p1.id)).toBe(false);
    const sid = mgr.start('a', undefined, undefined, p1.id);
    mgr.start('b', undefined, undefined, p2.id);
    expect(mgr.forceSwitch(p1.id)).toBe(true);
    expect(switches).toEqual([sid]);
    await waitFor(() => mgr.listProjects().projects.every((p) => !p.running));
  });
});

describe('SessionManager orphan detection', () => {
  it('emits turn_orphaned for an in-flight marker left by a killed process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-orphan-'));
    const sd = join(dir, 'state'); mkdirSync(join(sd, 'inflight'), { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    // simulate a marker a previous (killed) process left behind
    writeFileSync(join(sd, 'inflight', 'proj-9.json'), JSON.stringify({ projectId: 'proj-9', projectName: 'AHU', sessionId: 's-1', prompt: 'do the thing', startedAt: '2026-07-06T00:00:00Z' }));
    const events: GatewayEvent[] = [];
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn: (async () => ({ status: 'completed', finalAccount: 'a', failovers: 0 })) as never });
    mgr.subscribe((e) => events.push(e)); // buffer replays the startup-emitted event
    const orphan = events.find((e) => e.kind === 'turn_orphaned');
    expect(orphan).toBeTruthy();
    expect((orphan!.data as { projectId: string }).projectId).toBe('proj-9');
    expect((orphan!.data as { prompt: string }).prompt).toBe('do the thing');
    // marker consumed so it doesn't re-fire next boot
    expect(existsSync(join(sd, 'inflight', 'proj-9.json'))).toBe(false);
  });

  it('clears the in-flight marker when a normal turn settles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-mark-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn: (async () => { await new Promise((r) => setTimeout(r, 10)); return { status: 'completed', finalAccount: 'a', failovers: 0 }; }) as never });
    const p = mgr.createProject('P', dir);
    mgr.start('go', undefined, undefined, p.id);
    expect(existsSync(join(sd, 'inflight', p.id + '.json'))).toBe(true); // marker present mid-turn
    await waitFor(() => !existsSync(join(sd, 'inflight', p.id + '.json')));
    expect(existsSync(join(sd, 'inflight', p.id + '.json'))).toBe(false); // cleared on settle
  });
});

describe('SessionManager autopilot', () => {
  function apFixture(results: SessionResult[]) {
    const dir = mkdtempSync(join(tmpdir(), 'x056-ap-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    let call = 0; const prompts: string[] = [];
    const runSessionFn = (async (o: { prompt: string; tap?: (e: unknown) => void }) => {
      prompts.push(o.prompt);
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }); // persists lastSessionId like the real CLI
      await new Promise((r) => setTimeout(r, 5));
      return results[Math.min(call++, results.length - 1)];
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn, autopilotIntervalMs: 20 });
    const p = mgr.createProject('P', dir);
    return { mgr, p, prompts, sd };
  }
  const done = (text?: string): SessionResult => ({ status: 'completed', finalAccount: 'a', failovers: 0, resultText: text });

  it('auto-continues after a completed turn until the count is exhausted', async () => {
    const { mgr, p, prompts } = apFixture([done('working'), done('working'), done('working')]);
    mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, { count: 2, prompt: 'CONTINUE_NOW' });
    // 1 initial + up to 2 auto-continues
    await waitFor(() => prompts.filter((x) => x === 'CONTINUE_NOW').length >= 2, 8000);
    expect(prompts.filter((x) => x === 'CONTINUE_NOW').length).toBe(2);
    await waitFor(() => mgr.autopilotStatus()[p.id] === undefined, 3000); // clears when the final continue settles
  }, 12000);

  it('stops early when the result contains the stop phrase', async () => {
    const { mgr, p, prompts } = apFixture([done('AUTOPILOT_DONE now')]);
    mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, { count: 10 });
    await waitFor(() => mgr.snapshot().running === false, 4000);
    await new Promise((r) => setTimeout(r, 200));
    expect(prompts.filter((x) => x.includes('Continue')).length).toBe(0); // never continued
    expect(mgr.autopilotStatus()[p.id]).toBeUndefined();
  });

  it('stopAutopilot cancels the loop', async () => {
    const { mgr, p } = apFixture([done('working')]);
    mgr.setAutopilot(p.id, { count: 5 });
    expect(mgr.autopilotStatus()[p.id]).toEqual({ remaining: 5 });
    mgr.stopAutopilot(p.id);
    expect(mgr.autopilotStatus()[p.id]).toBeUndefined();
  });
});

describe('SessionManager question surfacing', () => {
  it('emits a question event when a turn ends with an ASK block, and not on autopilot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-q-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    const runSessionFn = (async (o: { tap?: (e: unknown) => void }) => {
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } });
      return { status: 'completed', finalAccount: 'a', failovers: 0, resultText: '<<<ASK\nquestion: Deploy now?\noptions: yes | no\n>>>' };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn });
    const p = mgr.createProject('P', dir);
    const events: GatewayEvent[] = [];
    mgr.subscribe((e) => events.push(e));
    mgr.start('go', undefined, undefined, p.id);
    await waitFor(() => events.some((e) => e.kind === 'question'), 4000);
    const q = events.find((e) => e.kind === 'question');
    expect((q!.data as { question: string }).question).toBe('Deploy now?');
    expect((q!.data as { options: string[] }).options).toEqual(['yes', 'no']);
  });
});
