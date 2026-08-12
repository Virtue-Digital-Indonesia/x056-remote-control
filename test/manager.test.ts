import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { BusyError, SessionManager, type GatewayEvent } from '../server/manager.js';

/** A stand-in for the `claude auth login` PTY child: emits a URL, and on the
 *  pasted code writes credentials + identity into the config dir (as the real
 *  CLI would after the OAuth exchange). */
function fakeLoginSpawn(email: string, displayName: string) {
  return (configDir: string): ChildProcess => {
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { stdin: { write: (s: string) => void } }).stdin = {
      write: () => {
        writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }));
        writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName, emailAddress: email } }));
      },
    };
    (child as unknown as { kill: () => void }).kill = () => { child.emit('exit', 0); };
    setImmediate(() => stdout.emit('data', Buffer.from('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ')));
    return child;
  };
}

/** Like fakeLoginSpawn, but the credentials write happens `delayMs` after the
 *  code is submitted — long enough to land after the poll's first tick (300ms
 *  in manager.ts), so a test can tell "resolved because a NEW file appeared"
 *  from "resolved because a STALE file was already sitting there". */
function fakeLoginSpawnDelayed(email: string, displayName: string, delayMs: number, token: string) {
  return (configDir: string): ChildProcess => {
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { stdin: { write: (s: string) => void } }).stdin = {
      write: () => {
        setTimeout(() => {
          writeFileSync(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
          writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { displayName, emailAddress: email } }));
        }, delayMs);
      },
    };
    (child as unknown as { kill: () => void }).kill = () => { child.emit('exit', 0); };
    setImmediate(() => stdout.emit('data', Buffer.from('If the browser did not open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1\nPaste code here if prompted > ')));
    return child;
  };
}

/** A stand-in for a rejected code: writes nothing and exits non-zero, as the
 *  real CLI would for a wrong/expired authorization code. */
function fakeLoginSpawnRejectingCode() {
  return (): ChildProcess => {
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new EventEmitter();
    (child as unknown as { stdout: EventEmitter }).stdout = stdout;
    (child as unknown as { stderr: EventEmitter }).stderr = new EventEmitter();
    (child as unknown as { stdin: { write: (s: string) => void } }).stdin = {
      write: () => { setImmediate(() => child.emit('exit', 1)); },
    };
    (child as unknown as { kill: () => void }).kill = () => {};
    setImmediate(() => stdout.emit('data', Buffer.from('visit: https://claude.com/cai/oauth/authorize?code=true&x=1\n')));
    return child;
  };
}

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
const FAILED: SessionResult = { status: 'failed', finalAccount: 'a', failovers: 0, reason: 'exit code 1' };

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

  it('runs a codex project through the codex adapter, and claude projects through claude', async () => {
    const { mgr, calls } = fixture(COMPLETED);
    const cx = mgr.createProject('CX', undefined, 'codex');
    const cl = mgr.createProject('CL', undefined, 'claude');
    mgr.start('do codex', undefined, undefined, cx.id);
    await waitFor(() => calls.length === 1);
    expect(calls[0].adapter?.id).toBe('codex'); // the run was handed the codex adapter
    mgr.start('do claude', undefined, undefined, cl.id);
    await waitFor(() => calls.length === 2);
    expect(calls[1].adapter?.id).toBe('claude');
  });

  it('stores a codex run\'s captured session id and resumes THAT (not the manager key) on continue', async () => {
    const { mgr, calls } = fixture({ ...COMPLETED, providerSessionId: 'codex-thread-1' });
    const p = mgr.createProject('CX', undefined, 'codex');
    const sid = mgr.start('go', undefined, undefined, p.id);
    await waitFor(() => mgr.snapshot().running === false && calls.length === 1);
    mgr.continueSession(p.id, sid, 'again');
    await waitFor(() => calls.length === 2);
    expect(calls[1].resume).toBe(true);
    expect(calls[1].providerSessionId).toBe('codex-thread-1'); // the captured codex thread, not sid
  });

  it('reuses a project\'s last chosen model/effort on a continue that specifies none', async () => {
    const { mgr, calls } = fixture(COMPLETED);
    mgr.start('first', undefined, { model: 'fable', effort: 'high' });
    await waitFor(() => mgr.snapshot().running === false);
    expect(calls[0].model).toBe('fable');
    expect(calls[0].effort).toBe('high');
    // A continue with no opts — the autopilot / orphan-resume / question-answer
    // path — must not silently revert to the CLI default.
    mgr.continueLast('keep going');
    await waitFor(() => calls.length === 2);
    expect(calls[1].model).toBe('fable');
    expect(calls[1].effort).toBe('high');
  });

  it('persists the model->effort default map, replacing on save and dropping blank entries', () => {
    const { mgr, stateDir } = fixture(COMPLETED);
    expect(mgr.getSettings()).toEqual({ modelEffort: {}, mcpSendMode: 'approval' }); // approval is the default
    mgr.setModelEffortDefaults({ fable: 'high', opus: 'max' });
    expect(mgr.getSettings().modelEffort).toEqual({ fable: 'high', opus: 'max' });
    const onDisk = JSON.parse(readFileSync(join(stateDir, 'settings.json'), 'utf8'));
    expect(onDisk.modelEffort).toEqual({ fable: 'high', opus: 'max' });
    expect(onDisk.mcpSendMode).toBe('approval'); // saving one setting keeps the other
    // A later save fully replaces the map (form semantics) and blank values drop.
    mgr.setModelEffortDefaults({ fable: 'low', sonnet: '' });
    expect(mgr.getSettings().modelEffort).toEqual({ fable: 'low' });
  });

  it('enqueue/edit/remove maintain a per-project queue', () => {
    const { mgr } = fixture(COMPLETED);
    const pid = mgr.listProjects().current as string;
    const a = mgr.enqueue(pid, { text: 'first' });
    mgr.enqueue(pid, { text: 'second', model: 'opus' });
    expect(mgr.queues()[pid].map((q) => q.text)).toEqual(['first', 'second']);
    mgr.editQueueItem(pid, a.id, { text: 'first-edited' });
    expect(mgr.queues()[pid][0].text).toBe('first-edited');
    mgr.removeQueueItem(pid, a.id);
    expect(mgr.queues()[pid].map((q) => q.text)).toEqual(['second']);
  });

  it('drains a queued message when the turn completes, sending its text as a resume', async () => {
    const { mgr, calls } = fixture(COMPLETED, { delayMs: 120 });
    const pid = mgr.listProjects().current as string;
    mgr.start('first');
    mgr.enqueue(pid, { text: 'queued follow-up' }); // queued while the first turn runs
    await waitFor(() => calls.length === 2, 3000);
    expect(calls[1].prompt).toBe('queued follow-up');
    expect(calls[1].resume).toBe(true);
    expect(mgr.queues()[pid] ?? []).toEqual([]); // drained
  });

  it('auto-drains a queued message when the project is idle but has a resumable session', async () => {
    const { mgr, calls } = fixture(COMPLETED);
    const pid = mgr.listProjects().current as string;
    mgr.start('first');
    await waitFor(() => mgr.snapshot().running === false, 3000); // turn done → project idle w/ a session
    expect(calls.length).toBe(1);
    mgr.enqueue(pid, { text: 'queued while idle' }); // would otherwise strand forever
    await waitFor(() => calls.length === 2, 3000);
    expect(calls[1].prompt).toBe('queued while idle');
    expect(calls[1].resume).toBe(true);
    expect(mgr.queues()[pid] ?? []).toEqual([]); // drained, not stranded
  });

  it('does not auto-drain an idle queue when there is no session to resume into', () => {
    const { mgr, calls } = fixture(COMPLETED);
    const pid = mgr.listProjects().current as string;
    mgr.enqueue(pid, { text: 'first' }); // no turn ever started → nothing to resume
    mgr.enqueue(pid, { text: 'second' });
    expect(mgr.queues()[pid].map((q) => q.text)).toEqual(['first', 'second']);
    expect(calls.length).toBe(0);
  });

  it('queues are per-conversation: an item drains into ITS OWN session, not the project\'s current one', async () => {
    const { mgr, calls } = fixture(COMPLETED, { delayMs: 80 });
    const pid = mgr.listProjects().current as string;
    const main = mgr.start('main work');                    // conversation "Main" runs
    const handoff = mgr.start('handoff task');              // conversation "Handoff" also runs; it's now current
    // Queue a follow-up explicitly for MAIN while both run.
    mgr.enqueue(pid, { text: 'follow-up for main', sessionId: main });
    // The item is bound to main and shows under main only.
    expect(mgr.queues()[pid].map((q) => ({ t: q.text, s: q.sessionId }))).toEqual([{ t: 'follow-up for main', s: main }]);
    await waitFor(() => calls.length === 3, 4000);          // both initial turns + the drained follow-up
    const drained = calls[2];
    expect(drained.prompt).toBe('follow-up for main');
    expect(drained.sessionId).toBe(main);                   // resumed MAIN, NOT handoff (the current conversation)
    expect(mgr.queues()[pid] ?? []).toEqual([]);
  });

  it('runs multiple conversations concurrently but blocks re-running the same one', async () => {
    const { mgr, calls } = fixture(COMPLETED, { delayMs: 100 });
    const pid = mgr.listProjects().current as string;
    const s1 = mgr.start('first');
    const s2 = mgr.start('second'); // a second NEW conversation starts in parallel
    expect(s2).not.toBe(s1);
    expect(mgr.listProjects().projects.find((p) => p.id === pid)?.runningSessionIds.slice().sort()).toEqual([s1, s2].slice().sort());
    // but resuming s1 while its own turn is still running is refused
    expect(() => mgr.continueSession(pid, s1, 'again')).toThrow(BusyError);
    await waitFor(() => mgr.snapshot().running === false);
    // after completion, continue works (resumes the project's current session, s2)
    mgr.continueLast('again');
    await waitFor(() => mgr.snapshot().running === false);
    const resume = calls.find((c) => c.resume);
    expect(resume?.sessionId).toBe(s2);
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

  it('runs two conversations of the SAME project concurrently, and a second project too', async () => {
    const { mgr, p1, p2 } = setup();
    const a = mgr.start('a', undefined, undefined, p1.id);
    const b = mgr.start('again', undefined, undefined, p1.id); // second conversation of p1 — no longer blocked
    expect(b).not.toBe(a);
    mgr.start('c', undefined, undefined, p2.id);
    const p1running = mgr.listProjects().projects.find((p) => p.id === p1.id)?.runningSessionIds ?? [];
    expect(p1running.slice().sort()).toEqual([a, b].slice().sort());
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

describe('SessionManager targeted account switch', () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'x056-tsw-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    const calls: Array<{ bench?: boolean } | undefined> = [];
    const runSessionFn = (async (o: RunSessionOptions) => {
      // Announce the running account like the real supervisor, so a targeted
      // switch can tell "same account" (refuse) from "different" (perform).
      o.log.append({ type: 'turn_started', sessionId: o.sessionId, account: 'a' });
      o.control?.({ forceSwitch: (opts) => calls.push(opts), abort: () => {} });
      await new Promise((r) => setTimeout(r, 60));
      return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult;
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn });
    const p = mgr.createProject('P', dir);
    return { mgr, p, calls, sd };
  }

  it('refuses a targeted switch to the same/unknown account, performs it (bench:false) to a different one', async () => {
    const { mgr, p, calls } = setup();
    const sid = mgr.start('go', undefined, undefined, p.id);
    // same account as the one running → nothing to switch
    expect(mgr.forceSwitch(p.id, sid, 'a')).toBe(false);
    // unknown account → refused
    expect(mgr.forceSwitch(p.id, sid, 'nope')).toBe(false);
    expect(calls).toEqual([]); // neither reached the run control
    // a different, valid account → performed as a user-directed (non-benching) switch
    expect(mgr.forceSwitch(p.id, sid, 'b')).toBe(true);
    expect(calls).toEqual([{ bench: false }]);
    // and the registry now prefers the target, so the resumed turn lands there
    expect(mgr.nextUpAccount()).toBe('b');
    await waitFor(() => mgr.listProjects().projects.every((pp) => !pp.running));
  });

  it('an untargeted forceSwitch still does the legacy benching rotate', async () => {
    const { mgr, p, calls } = setup();
    const sid = mgr.start('go', undefined, undefined, p.id);
    expect(mgr.forceSwitch(p.id, sid)).toBe(true);
    expect(calls).toEqual([undefined]); // no {bench:false} → benches, as before
    await waitFor(() => mgr.listProjects().projects.every((pp) => !pp.running));
  });

  it('setActiveAccount points the registry at the chosen account and rejects an unknown one', () => {
    const { mgr } = setup();
    mgr.setActiveAccount('b');
    expect(mgr.nextUpAccount()).toBe('b');
    expect(() => mgr.setActiveAccount('nope')).toThrow();
  });

  it('setActiveAccount on a still-limited account is silently overridden by pickActive WITHOUT force', () => {
    const { mgr, sd } = setup();
    AccountRegistry.load(join(sd, 'accounts.json')).markLimited('b', Math.floor(Date.now() / 1000) + 3600);
    mgr.setActiveAccount('b'); // "chosen" but still marked limited
    // pickActive re-checks usability every time — a stale/estimated 'limited'
    // mark silently wins over the explicit choice unless force clears it.
    expect(mgr.nextUpAccount()).toBe('a');
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('b').state.kind).toBe('limited');
  });

  it('setActiveAccount(name, force) clears a stale "limited" mark so the choice actually sticks', () => {
    const { mgr, sd } = setup();
    AccountRegistry.load(join(sd, 'accounts.json')).markLimited('b', Math.floor(Date.now() / 1000) + 3600);
    mgr.setActiveAccount('b', true);
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('b').state).toEqual({ kind: 'ok' });
    expect(mgr.nextUpAccount()).toBe('b'); // now actually usable
  });

  it('force never touches an "unauthenticated" account — that needs a real re-login, not an override', () => {
    const { mgr, sd } = setup();
    AccountRegistry.load(join(sd, 'accounts.json')).markUnauthenticated('b');
    mgr.setActiveAccount('b', true);
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('b').state).toEqual({ kind: 'unauthenticated' });
    expect(mgr.nextUpAccount()).toBe('a'); // still skipped
  });

  it('forceSwitch(force) clears a still-limited TARGET so the resumed turn actually lands there', async () => {
    const { mgr, p, sd, calls } = setup();
    // Mutate the on-disk registry BEFORE anything gives the manager a chance to
    // lazily cache its own (would-be-stale) AccountRegistry instance — it holds
    // that cache for its whole lifetime, so a write via a separate loaded
    // instance afterward would just get clobbered by the manager's next save.
    AccountRegistry.load(join(sd, 'accounts.json')).markLimited('b', Math.floor(Date.now() / 1000) + 3600);
    const sid = mgr.start('go', undefined, undefined, p.id);
    // forceSwitch itself doesn't gate on usability (the drain/interrupt still
    // happens either way) — what matters is that pickActive(), re-run once the
    // turn actually resumes, doesn't just skip straight back past 'b'.
    expect(mgr.forceSwitch(p.id, sid, 'b', true)).toBe(true);
    expect(calls).toEqual([{ bench: false }]);
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('b').state).toEqual({ kind: 'ok' });
    expect(mgr.nextUpAccount()).toBe('b');
    await waitFor(() => mgr.listProjects().projects.every((pp) => !pp.running));
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
    const sid = mgr.start('go', undefined, undefined, p.id); // markers are keyed by sessionId (concurrency)
    expect(existsSync(join(sd, 'inflight', sid + '.json'))).toBe(true); // marker present mid-turn
    await waitFor(() => !existsSync(join(sd, 'inflight', sid + '.json')));
    expect(existsSync(join(sd, 'inflight', sid + '.json'))).toBe(false); // cleared on settle
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
    const sid = mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, sid, { count: 2, prompt: 'CONTINUE_NOW' });
    // 1 initial + up to 2 auto-continues
    await waitFor(() => prompts.filter((x) => x === 'CONTINUE_NOW').length >= 2, 8000);
    expect(prompts.filter((x) => x === 'CONTINUE_NOW').length).toBe(2);
    await waitFor(() => mgr.autopilotStatus()[sid] === undefined, 3000); // clears when the final continue settles
  }, 12000);

  it('stops early when the result contains the stop phrase', async () => {
    const { mgr, p, prompts } = apFixture([done('AUTOPILOT_DONE now')]);
    const sid = mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, sid, { count: 10 });
    await waitFor(() => mgr.snapshot().running === false, 4000);
    await new Promise((r) => setTimeout(r, 200));
    expect(prompts.filter((x) => x.includes('Continue')).length).toBe(0); // never continued
    expect(mgr.autopilotStatus()[sid]).toBeUndefined();
  });

  it('is per-conversation: arming one conversation leaves a sibling un-armed', async () => {
    const { mgr, p } = apFixture([done('working')]);
    mgr.setAutopilot(p.id, 'sess-A', { count: 5 });
    expect(mgr.autopilotStatus()['sess-A']).toEqual({ remaining: 5, projectId: p.id });
    expect(mgr.autopilotStatus()['sess-B']).toBeUndefined(); // sibling conversation NOT armed
    expect(mgr.hasAutopilot('sess-A')).toBe(true);
    expect(mgr.hasAutopilot('sess-B')).toBe(false);
    mgr.stopAutopilot('sess-A');
    expect(mgr.autopilotStatus()['sess-A']).toBeUndefined();
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

// A project can have several conversations; only one can run at a time, but the
// panel must be able to tell WHICH one — so it doesn't bleed a running turn's
// activity/messages into an idle conversation the user happens to be viewing,
// and so Stop can refuse to kill a conversation the user isn't looking at.
describe('SessionManager per-conversation isolation', () => {
  it('tags turn_state, activity, and session_started with the run\'s sessionId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-sid-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    const runSessionFn = (async (o: RunSessionOptions) => {
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'ls' } }] } });
      return { status: 'completed', finalAccount: 'a', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn });
    const seen: GatewayEvent[] = [];
    mgr.subscribe((e) => seen.push(e));
    const sid = mgr.start('go');
    await waitFor(() => seen.some((e) => e.kind === 'session_done'));
    const sidsFor = (kind: string) => seen.filter((e) => e.kind === kind).map((e) => (e.data as { sessionId?: string }).sessionId);
    expect(sidsFor('turn_state')).toEqual([sid, sid]);
    expect(sidsFor('activity').every((s) => s === sid)).toBe(true);
    expect(sidsFor('session_started')).toEqual([sid]);
  });

  it('listProjects reports which conversations are running via runningSessionIds', async () => {
    const { mgr } = fixture(COMPLETED, { delayMs: 100 });
    const pid = mgr.listProjects().current as string;
    const sid = mgr.start('go');
    expect(mgr.listProjects().projects.find((p) => p.id === pid)?.runningSessionIds).toEqual([sid]);
    await waitFor(() => (mgr.listProjects().projects.find((p) => p.id === pid)?.runningSessionIds.length ?? 0) === 0);
    expect(mgr.listProjects().projects.find((p) => p.id === pid)?.running).toBe(false);
  });

  it('stopTurn only stops the named conversation; a mismatched sessionId is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-stop-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    let aborted = false;
    const runSessionFn = (async (o: { control?: (c: { forceSwitch: () => void; abort: () => void }) => void }) => {
      o.control?.({ forceSwitch: () => {}, abort: () => { aborted = true; } });
      await new Promise((r) => setTimeout(r, 200));
      return { status: 'completed', finalAccount: 'a', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn });
    const pid = mgr.createProject('P', dir).id;
    const sid = mgr.start('go', undefined, undefined, pid);
    expect(mgr.isSessionRunning(sid)).toBe(true);
    expect(mgr.stopTurn(pid, 'not-the-running-session')).toBe(false);
    expect(aborted).toBe(false);
    expect(mgr.stopTurn(pid, sid)).toBe(true);
    expect(aborted).toBe(true);
  });

  it('a conversation switch mid-turn survives the new conversation\'s first streamed event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-race-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'b', configDir: '/cfg/b' }]);
    let callN = 0;
    let releaseSecondTap: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseSecondTap = resolve; });
    const runSessionFn = (async (o: RunSessionOptions) => {
      callN++;
      if (callN === 2) await gate; // hold the brand-new conversation's turn until the test says go
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
      return { status: 'completed', finalAccount: 'a', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, runSessionFn });
    const pid = mgr.createProject('P', dir).id;
    const olderSid = mgr.start('older conversation', undefined, undefined, pid);
    await waitFor(() => !mgr.listProjects().projects.find((p) => p.id === pid)?.running);
    const newSid = mgr.start('brand new conversation', undefined, undefined, pid); // call #2, gated on `gate`
    expect(mgr.listProjects().projects.find((p) => p.id === pid)?.lastSessionId).toBe(newSid); // addConversation() makes it current immediately
    mgr.selectConversation(pid, olderSid); // user switches back to the older one while the new one's turn is still in flight
    expect(mgr.listProjects().projects.find((p) => p.id === pid)?.lastSessionId).toBe(olderSid);
    releaseSecondTap!(); // let the new conversation's first stream event arrive
    await waitFor(() => !mgr.listProjects().projects.find((p) => p.id === pid)?.running);
    // The manual switch back must survive — not get clobbered back to newSid by
    // the new conversation's first tap event.
    expect(mgr.listProjects().projects.find((p) => p.id === pid)?.lastSessionId).toBe(olderSid);
  });
});

describe('SessionManager account management', () => {
  function acctFixture(email = 'new@example.com', displayName = 'New Account') {
    const dir = mkdtempSync(join(tmpdir(), 'x056-acct-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    const cfgA = join(dir, 'cfg-a'); mkdirSync(cfgA, { recursive: true }); // real dir so the shared-projects symlink can be wired
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: cfgA }, { name: 'b', configDir: join(dir, 'cfg-b') }]);
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, loginSpawnFn: fakeLoginSpawn(email, displayName) });
    return { mgr, sd, dir, cfgA };
  }

  it('onboards a new account via the login flow: URL, code, register, shared-projects symlink', async () => {
    const { mgr, sd, cfgA } = acctFixture('carol@example.com', 'Carol');
    // a marker in the SHARED transcript tree (account a's) — the new account's
    // projects/ symlink must resolve to it so a resumed session survives failover.
    mkdirSync(join(cfgA, 'projects'), { recursive: true });
    writeFileSync(join(cfgA, 'projects', '.keep'), 'shared');
    const events: GatewayEvent[] = [];
    mgr.subscribe((e) => events.push(e));
    const { loginId, url } = await mgr.startAccountLogin();
    expect(url).toContain('oauth');
    expect(loginId).toBeTruthy();
    const res = await mgr.submitAccountLoginCode(loginId, 'THE-CODE');
    expect(res).toMatchObject({ name: 'c', email: 'carol@example.com', displayName: 'Carol' });
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['a', 'b', 'c']);
    // the account persisted with its credentials, and its projects/ points at the shared tree
    expect(existsSync(join(sd, 'accounts', 'c', '.credentials.json'))).toBe(true);
    expect(readFileSync(join(sd, 'accounts', 'c', 'projects', '.keep'), 'utf8')).toBe('shared'); // written into cfgA/projects, visible via the symlink
    expect(events.some((e) => e.kind === 'accounts')).toBe(true);
  });

  it('refuses to onboard a duplicate account (same email) and cleans up the pending dir', async () => {
    const { mgr } = acctFixture('dupe@example.com', 'Dupe');
    const first = await mgr.startAccountLogin();
    await mgr.submitAccountLoginCode(first.loginId, 'CODE1');
    const second = await mgr.startAccountLogin();
    await expect(mgr.submitAccountLoginCode(second.loginId, 'CODE2')).rejects.toThrow(/already added/);
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['a', 'b', 'c']); // no 'd' added
  });

  it('accountsInfo marks exactly one account as nextUp', () => {
    const { mgr } = acctFixture();
    const info = mgr.accountsInfo();
    expect(info.filter((a) => a.nextUp).length).toBe(1);
    expect(info.find((a) => a.nextUp)?.name).toBe('a');
    expect(mgr.nextUpAccount()).toBe('a');
  });

  it('relogin re-authenticates an EXISTING account in place — no new account, unauthenticated state clears', async () => {
    const { mgr, sd } = acctFixture('carol@example.com', 'Carol');
    // simulate the CLI having reported "Not logged in" for account a
    AccountRegistry.load(join(sd, 'accounts.json')).markUnauthenticated('a');
    const events: GatewayEvent[] = [];
    mgr.subscribe((e) => events.push(e));
    const { loginId, url } = await mgr.startAccountRelogin('a');
    expect(url).toContain('oauth');
    const res = await mgr.submitAccountLoginCode(loginId, 'THE-CODE');
    expect(res.name).toBe('a'); // the SAME account, not a new one
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['a', 'b']); // still just 2
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('a').state).toEqual({ kind: 'ok' });
    expect(events.some((e) => e.kind === 'accounts')).toBe(true);
  });

  it('relogin of an unknown account name is rejected', async () => {
    const { mgr } = acctFixture();
    await expect(mgr.startAccountRelogin('ghost')).rejects.toThrow(/unknown account/);
  });

  it('cancelling (or timing out) a relogin never deletes the existing account\'s config dir', async () => {
    const { mgr, cfgA } = acctFixture();
    const { loginId } = await mgr.startAccountRelogin('a');
    mgr.cancelAccountLogin(loginId);
    expect(existsSync(cfgA)).toBe(true); // preserved — unlike an abandoned ONBOARDING pending dir
  });

  it('relogin refuses a code that authenticates a DIFFERENT already-registered account (mixup guard), restoring the original credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-relog-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    const cfgA = join(dir, 'cfg-a'); mkdirSync(cfgA, { recursive: true });
    const cfgB = join(dir, 'cfg-b'); mkdirSync(cfgB, { recursive: true });
    writeFileSync(join(cfgA, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'original-tok' } }));
    writeFileSync(join(cfgB, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: 'Bob', emailAddress: 'bob@example.com' } }));
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: cfgA }, { name: 'b', configDir: cfgB }]);
    // the login flow will authenticate as Bob — but we're re-logging in account 'a'
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, loginSpawnFn: fakeLoginSpawn('bob@example.com', 'Bob') });
    const { loginId } = await mgr.startAccountRelogin('a');
    await expect(mgr.submitAccountLoginCode(loginId, 'THE-CODE')).rejects.toThrow(/different account/);
    // 'a' is untouched — still whatever it was, not silently repointed at Bob's identity
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('a').state).toEqual({ kind: 'unknown' });
    const creds = JSON.parse(readFileSync(join(cfgA, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } };
    expect(creds.claudeAiOauth.accessToken).toBe('original-tok'); // NOT Bob's — reverted, not left mismatched
    expect(existsSync(join(cfgA, '.credentials.json.relogin-backup'))).toBe(false);
  });

  it('relogin does not report success before the CLI actually rewrites credentials (race regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-relog-race-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    const cfgA = join(dir, 'cfg-a'); mkdirSync(cfgA, { recursive: true });
    // The account's OWN (broken) credentials are already sitting here — this is
    // exactly what made "does .credentials.json exist" a false-positive success
    // signal for a relogin (it's onboarding's brand-new-empty-dir check, reused).
    writeFileSync(join(cfgA, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'stale-broken-tok' } }));
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: cfgA }, { name: 'b', configDir: join(dir, 'cfg-b') }]);
    AccountRegistry.load(join(sd, 'accounts.json')).markUnauthenticated('a');
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, loginSpawnFn: fakeLoginSpawnDelayed('carol@example.com', 'Carol', 600, 'fresh-tok') });
    const { loginId } = await mgr.startAccountRelogin('a');
    // mid-flow: the stale credentials are moved aside, not left in place
    expect(existsSync(join(cfgA, '.credentials.json'))).toBe(false);
    const res = await mgr.submitAccountLoginCode(loginId, 'THE-CODE');
    expect(res.name).toBe('a');
    const creds = JSON.parse(readFileSync(join(cfgA, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } };
    expect(creds.claudeAiOauth.accessToken).toBe('fresh-tok'); // the NEW token — proves it actually waited
    expect(AccountRegistry.load(join(sd, 'accounts.json')).get('a').state).toEqual({ kind: 'ok' });
    expect(existsSync(join(cfgA, '.credentials.json.relogin-backup'))).toBe(false); // cleaned up
  });

  it('a rejected code (wrong/expired) restores the original credentials instead of leaving the account with none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-relog-fail-'));
    const sd = join(dir, 'state'); mkdirSync(sd, { recursive: true });
    const cfgA = join(dir, 'cfg-a'); mkdirSync(cfgA, { recursive: true });
    writeFileSync(join(cfgA, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'original-tok' } }));
    AccountRegistry.init(join(sd, 'accounts.json'), [{ name: 'a', configDir: cfgA }, { name: 'b', configDir: join(dir, 'cfg-b') }]);
    const mgr = new SessionManager({ stateDir: sd, workspaceRoot: dir, loginSpawnFn: fakeLoginSpawnRejectingCode() });
    const { loginId } = await mgr.startAccountRelogin('a');
    await expect(mgr.submitAccountLoginCode(loginId, 'WRONG-CODE')).rejects.toThrow(/did not complete/);
    const creds = JSON.parse(readFileSync(join(cfgA, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string } };
    expect(creds.claudeAiOauth.accessToken).toBe('original-tok'); // restored, not left missing
  });

  it('removeAccount drops an account and refuses the last one', () => {
    const { mgr } = acctFixture();
    mgr.removeAccount('b');
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['a']);
    expect(() => mgr.removeAccount('a')).toThrow(/last account/);
  });

  it('removeAccount is blocked while a turn\'s account is still unresolved (conservative default)', async () => {
    // fixture()'s fake run never emits turn_started, so its account stays
    // unknown for the whole run — every account is blocked until we'd know
    // which one it actually landed on.
    const { mgr } = fixture(COMPLETED, { delayMs: 150 });
    mgr.start('go');
    expect(() => mgr.removeAccount('b')).toThrow(BusyError);
    await waitFor(() => mgr.snapshot().running === false, 3000);
    mgr.removeAccount('b'); // fine once idle
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['a']);
  });

  it('removeAccount only blocks the SPECIFIC account a running turn reported using, not every account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-mgr-'));
    const stateDir = join(dir, 'state'); mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [
      { name: 'a', configDir: '/cfg/a' },
      { name: 'b', configDir: '/cfg/b' },
      { name: 'c', configDir: '/cfg/c' },
    ]);
    const runSessionFn = (async (o: RunSessionOptions) => {
      o.log.append({ type: 'turn_started', sessionId: o.sessionId, account: 'a' }); // this run is on 'a'
      await new Promise((r) => setTimeout(r, 150));
      return { status: 'completed', finalAccount: 'a', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    mgr.start('go');
    // 'c' isn't involved in this turn at all — no longer has to wait for it.
    mgr.removeAccount('c');
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['a', 'b']);
    // 'a' IS the account this turn is actually running on — still blocked.
    expect(() => mgr.removeAccount('a')).toThrow(BusyError);
    await waitFor(() => mgr.snapshot().running === false, 3000);
    mgr.removeAccount('a'); // fine once idle
    expect(mgr.accountsInfo().map((a) => a.name)).toEqual(['b']);
  });
});

describe('provider session id is captured LIVE, not only at turn end', () => {
  it('stores the codex thread id as soon as the stream announces it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-psid-'));
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'd', configDir: '/cfg/d', provider: 'codex' }]);

    let release: () => void = () => {};
    const finished = new Promise<void>((r) => { release = r; });
    let tapped: ((e: unknown) => void) | undefined;
    const runSessionFn = (async (o: { tap?: (e: unknown) => void }) => {
      tapped = o.tap;
      // codex announces its own thread id at the start of the stream…
      o.tap?.({ type: 'thread.started', thread_id: 'thread-abc-123' });
      await finished; // …and the turn keeps running for a long while after that
      return { status: 'completed', finalAccount: 'd', failovers: 0 };
    }) as unknown as typeof import('../src/failover.js').runSession;

    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const p = mgr.createProject('CX', dir, 'codex');
    const sid = mgr.start('write copy', undefined, undefined, p.id);
    await waitFor(() => tapped !== undefined);

    // MID-TURN: history must already resolve to the codex thread id. Before this
    // fix it fell back to the gateway's own uuid, matched no rollout, and the
    // conversation showed zero messages for the whole first turn.
    const ctx = mgr.historyContext(p.id, sid);
    expect(ctx.providerSessionId).toBe('thread-abc-123');
    expect(ctx.adapter.id).toBe('codex');

    release();
    await waitFor(() => !mgr.listProjects().projects.some((x) => (x.runningSessionIds ?? []).includes(sid)));
  });
});

describe('queue vs autopilot priority', () => {
  it('a queued message beats autopilot: the QUEUED text is what runs next', async () => {
    const { mgr, calls } = fixture(COMPLETED);
    const pid = mgr.listProjects().current as string;
    const sid = mgr.start('first');
    await waitFor(() => !mgr.listProjects().projects.some((p) => (p.runningSessionIds ?? []).includes(sid)));
    mgr.setAutopilot(pid, sid, { count: 5, prompt: 'AUTOPILOT_PROMPT' });
    mgr.enqueue(pid, { text: 'REAL MESSAGE', sessionId: sid });
    await waitFor(() => (mgr.queues()[pid] ?? []).length === 0, 8000);
    await waitFor(() => calls.length >= 2, 8000);
    // The turn after the first one carries the queued message, not the
    // autopilot prompt — that is the priority rule, asserted on the real prompt.
    expect(calls[1].prompt).toContain('REAL MESSAGE');
    expect(calls[1].prompt).not.toContain('AUTOPILOT_PROMPT');
    // and autopilot is still armed, to resume once the queue is empty
    expect(mgr.hasAutopilot(sid)).toBe(true);
  }, 20000);

  it('a queued message still drains after a FAILED turn instead of stranding', async () => {
    // autopilot deliberately pauses on failure; if the queue also skipped, the
    // item would sit there forever with nothing left to trigger it.
    const { mgr } = fixture(FAILED);
    const pid = mgr.listProjects().current as string;
    const sid = mgr.start('will fail');
    await waitFor(() => !mgr.listProjects().projects.some((p) => (p.runningSessionIds ?? []).includes(sid)));
    mgr.enqueue(pid, { text: 'after the failure', sessionId: sid });
    await waitFor(() => (mgr.queues()[pid] ?? []).length === 0, 8000);
    expect((mgr.queues()[pid] ?? []).length).toBe(0);
  }, 20000);
});
