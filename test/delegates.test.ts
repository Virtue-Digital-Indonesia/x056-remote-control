import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { readMessageSender } from '../src/message-sender.js';
import { SessionManager } from '../server/manager.js';
import { DelegateStore, decideGate, digest, checkRole, shouldWake, MAX_DELEGATES, ROUND_LIMIT, type Delegate, type DelegateReport } from '../server/delegates.js';
import type { ForkDecision } from '../server/jev.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the report gate', () => {
  it('lets rules decide what rules can, and only a sure answer say "done"', () => {
    expect(decideGate('failed', { choice: 'done', confidence: 1 }, 0.75)).toEqual({ gate: 'blocked', by: 'rule' });
    expect(decideGate('interrupted', undefined, 0.75)).toEqual({ gate: 'blocked', by: 'rule' });
    expect(decideGate('completed', undefined, 0.75)).toEqual({ gate: 'needs_orchestrator', by: 'none' });
    expect(decideGate('completed', { choice: 'done', confidence: 0.9 }, 0.75)).toEqual({ gate: 'done', confidence: 0.9, by: 'jev' });
    expect(decideGate('completed', { choice: 'done', confidence: 0.6 }, 0.75)).toEqual({ gate: 'needs_orchestrator', confidence: 0.6, by: 'jev' });
    expect(decideGate('completed', { choice: 'reboot', confidence: 1 }, 0.75).gate).toBe('needs_orchestrator');
  });

  it('wakes at once for the orchestrator or a blocker, and gathers the rest until the team is quiet', () => {
    expect(shouldWake('needs_orchestrator', true)).toBe(true);
    expect(shouldWake('blocked', true)).toBe(true);
    expect(shouldWake('done', true)).toBe(false);
    expect(shouldWake('needs_human', true)).toBe(false);
    expect(shouldWake('done', false)).toBe(true);
  });

  it('writes one message for a batch, clipping long reports with a way to the rest', () => {
    const r = (id: string, text: string, gate: DelegateReport['gate']): DelegateReport => ({ at: 't', delegateId: id, role: id === 'd-1' ? 'backend' : 'reviewer', turn: 1, status: 'completed', text, gate, gateBy: 'jev', gateConfidence: 0.9, woke: false });
    const roster = [{ id: 'd-1', role: 'backend', provider: 'codex', model: 'gpt-6.1-sol', status: 'idle' }, { id: 'd-2', role: 'reviewer', provider: 'claude', status: 'working' }] as Delegate[];
    const text = digest([r('d-1', 'DONE: shipped', 'done'), r('d-2', 'x'.repeat(7000), 'needs_orchestrator')], roster);
    expect(text).toMatch(/^\[Delegates\] 2 reports/);
    expect(text).toMatch(/## backend \(d-1\) - done \(90%\)\n<codex · gpt-6.1-sol · turn 1>\n\nDONE: shipped/);
    expect(text).toMatch(/1000 more characters: list_delegates \{"id":"d-2"\}/);
    expect(text).toMatch(/Team now: backend idle, reviewer working/);
    expect(() => checkRole('../x')).toThrow(/short name/);
  });
});

describe('delegates on the gateway', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'x056-delegates-')); dirs.push(dir);
    const stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }, { name: 'g', configDir: '/cfg/g', provider: 'codex' }]);
    const calls: RunSessionOptions[] = [];
    const open = new Map<string, (r: SessionResult) => void>();
    const runSessionFn = ((o: RunSessionOptions) => new Promise<SessionResult>((resolve) => {
      calls.push(o);
      open.set(o.sessionId, resolve);
      o.control?.({ abort: () => resolve({ status: 'stopped', failovers: 0 } as SessionResult), forceSwitch: () => {} } as never);
    })) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const finish = (sid: string, resultText: string, status: SessionResult['status'] = 'completed') => { const r = open.get(sid); open.delete(sid); r?.({ status, failovers: 0, resultText, finalAccount: 'a' } as SessionResult); };
    return { mgr, calls, open, finish, dir, stateDir };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const gate = (mgr: SessionManager, choice: string, confidence = 0.95) => {
    vi.spyOn(mgr.jev(), 'configured').mockReturnValue(true);
    return vi.spyOn(mgr.jev(), 'choose').mockResolvedValue({ at: 't', sessionId: 's', backend: 'jev', question: 'q', options: [], choice, confidence, verdict: 'sharp', latencyMs: 1 } as ForkDecision);
  };
  const orchestrator = async (f: ReturnType<typeof fixture>) => {
    const p = f.mgr.createProject('P', f.dir);
    const sid = f.mgr.start('orchestrate', undefined, {}, p.id);
    await tick();
    return { pid: p.id, sid };
  };
  const queued = (mgr: SessionManager, pid: string, sid: string) => ((mgr as unknown as { loadQueues(): Record<string, { sessionId?: string; text: string; sender?: { kind: string } }[]> }).loadQueues()[pid] ?? []).filter((q) => q.sessionId === sid);

  it('runs a hidden turn: its own session and prompt, no project row, and the orchestrator shows background work', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    f.finish(sid, 'planned'); await tick();
    const d = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'Fix the login test.' });
    await tick();
    const run = f.calls.at(-1)!;
    expect(run).toMatchObject({ sessionId: d.sessionId, cwd: f.dir, prompt: 'Fix the login test.', resume: false });
    expect(run.mcp).toBeUndefined();
    expect(run.appendSystemPrompt).toMatch(/DELEGATE MODE\. You are "backend"/);
    const listed = f.mgr.listProjects().projects.flatMap((p) => p.conversations ?? []).map((c) => c.sessionId);
    expect(listed).toEqual([sid]);
    expect(f.mgr.backgroundSessions()).toEqual([{ projectId: pid, sessionId: sid }]);
    expect(f.mgr.snapshot().backgroundProjects).toEqual([pid]);
    expect(f.mgr.listDelegates(pid, sid)[0]).toMatchObject({ id: d.id, working: true, status: 'working' });
  });

  it('holds "done" reports until the team is quiet, then wakes the orchestrator once', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    // Keep the orchestrator busy so its queue is inspectable.
    gate(f.mgr, 'done');
    const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
    const b = f.mgr.startDelegate(pid, sid, { role: 'reviewer', brief: 'B' });
    await tick();
    f.finish(a.sessionId, 'DONE: backend shipped'); await tick();
    expect(queued(f.mgr, pid, sid)).toHaveLength(0);
    expect(f.mgr.delegateStore().reports(sid).map((r) => [r.role, r.gate, r.woke])).toEqual([['backend', 'done', false]]);
    f.finish(b.sessionId, 'DONE: review clean'); await tick();
    const q = queued(f.mgr, pid, sid);
    expect(q).toHaveLength(1);
    expect(q[0].sender?.kind).toBe('delegate');
    expect(q[0].text).toMatch(/2 reports[\s\S]*## backend[\s\S]*## reviewer/);
    expect(f.mgr.delegateStore().reports(sid).every((r) => r.woke)).toBe(true);
  });

  it('wakes at once when the orchestrator is needed, and merges the next report into the waiting message', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    gate(f.mgr, 'needs_orchestrator');
    const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
    const b = f.mgr.startDelegate(pid, sid, { role: 'dwh', brief: 'B' });
    await tick();
    f.finish(a.sessionId, 'NEEDS ORCHESTRATOR: which schema?'); await tick();
    expect(queued(f.mgr, pid, sid)).toHaveLength(1);
    f.finish(b.sessionId, 'NEEDS ORCHESTRATOR: grants missing'); await tick();
    const q = queued(f.mgr, pid, sid);
    expect(q).toHaveLength(1);
    expect(q[0].text).toMatch(/which schema\?[\s\S]*---[\s\S]*grants missing/);
  });

  it('with no decision model, or a failed turn, the orchestrator is woken', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    vi.spyOn(f.mgr.jev(), 'configured').mockReturnValue(false);
    const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
    const b = f.mgr.startDelegate(pid, sid, { role: 'dwh', brief: 'B' });
    await tick();
    f.finish(a.sessionId, 'something', 'failed'); await tick();
    expect(f.mgr.delegateStore().reports(sid)[0]).toMatchObject({ gate: 'blocked', gateBy: 'rule', woke: true });
    expect(f.mgr.listDelegates(pid, sid).find((d) => d.id === a.id)?.status).toBe('failed');
    f.finish(b.sessionId, 'DONE'); await tick();
    expect(f.mgr.delegateStore().reports(sid)[1]).toMatchObject({ gate: 'needs_orchestrator', gateBy: 'none' });
  });

  it('queues a follow-up behind a working delegate and resumes the same session with it', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    gate(f.mgr, 'done');
    const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
    await tick();
    expect(f.mgr.delegateFollowup(pid, sid, a.id, 'Also add a test.')).toEqual({ id: a.id, status: 'queued' });
    f.finish(a.sessionId, 'DONE: A'); await tick();
    const next = f.calls.at(-1)!;
    expect(next).toMatchObject({ sessionId: a.sessionId, prompt: 'Also add a test.', resume: true });
    // Still working on the follow-up, so the "done" waits.
    expect(queued(f.mgr, pid, sid)).toHaveLength(0);
    // A person stepping in is marked as such.
    f.finish(a.sessionId, 'DONE: test added'); await tick();
    f.mgr.delegateFollowup(pid, sid, a.id, 'Rename it.', true);
    await tick();
    expect(f.calls.at(-1)!.prompt).toBe('[From the user, directly]\nRename it.');
  });

  it('is bounded: 8 active, unique roles, and 40 dispatches until the user writes again', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    for (let i = 0; i < MAX_DELEGATES; i++) f.mgr.startDelegate(pid, sid, { role: 'w' + i, brief: 'x' });
    expect(() => f.mgr.startDelegate(pid, sid, { role: 'one-more', brief: 'x' })).toThrow(/8 delegates/);
    f.mgr.stopDelegates(pid, sid, f.mgr.listDelegates(pid, sid)[0].id);
    expect(() => f.mgr.startDelegate(pid, sid, { role: 'w1', brief: 'x' })).toThrow(/already exists/);
    (f.mgr as unknown as { delegateRounds: Map<string, number> }).delegateRounds.set(sid, ROUND_LIMIT);
    expect(() => f.mgr.startDelegate(pid, sid, { role: 'late', brief: 'x' })).toThrow(/Delegate limit reached/);
    f.mgr.clearRelayChain(sid);
    expect(() => f.mgr.startDelegate(pid, sid, { role: 'late', brief: 'x' })).not.toThrow();
  });

  it('Stop on the orchestrator stops its delegates, and a stopped report wakes nobody', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    f.finish(sid, 'planned'); await tick();
    gate(f.mgr, 'needs_orchestrator');
    f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
    await tick();
    expect(f.mgr.stopTurn(pid, sid)).toBe(true);
    await tick();
    expect(f.mgr.listDelegates(pid, sid)[0]).toMatchObject({ status: 'stopped', working: false });
    expect(f.mgr.delegateStore().reports(sid)[0]).toMatchObject({ status: 'stopped', woke: true });
    expect(queued(f.mgr, pid, sid)).toHaveLength(0);
    expect(f.mgr.backgroundSessions()).toEqual([]);
  });

  it('after a restart, a delegate that was working is reported interrupted, once', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    const store = new DelegateStore(f.stateDir);
    store.save(pid, sid, [{ id: 'd-12345678', role: 'backend', brief: 'A', provider: 'claude', projectId: pid, cwd: f.dir, sessionId: 'x-11111111', status: 'working', createdAt: 't', updatedAt: 't', turns: 2, pending: [] }]);
    const again = new SessionManager({ stateDir: f.stateDir, workspaceRoot: f.dir, runSessionFn: (async () => new Promise(() => {})) as never });
    await tick();
    expect(again.listDelegates(pid, sid)[0]).toMatchObject({ status: 'interrupted', turns: 3 });
    expect(again.delegateStore().reports(sid)).toHaveLength(1);
    expect(again.delegateStore().reports(sid)[0]).toMatchObject({ status: 'interrupted', gate: 'blocked', woke: true });
    const woke = queued(again, pid, sid);
    expect(woke).toHaveLength(1);
    expect(readMessageSender(woke[0].text).text).toMatch(/Interrupted by a gateway restart/);
  });
});
