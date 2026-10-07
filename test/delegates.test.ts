import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { readMessageSender } from '../src/message-sender.js';
import { SessionManager } from '../server/manager.js';
import { autoDismissible, saysDone, DelegateStore, decideGate, digest, checkRole, shouldWake, MAX_DELEGATES, ROUND_LIMIT, type Delegate, type DelegateReport } from '../server/delegates.js';
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

  // Audit 2026-10-07: 230 delegate turns, no pick, no advisor.
  it('works with its orchestrator\'s helpers: the picker (keyed per delegate) and the advisor', async () => {
    const f = fixture(); const { pid, sid } = await orchestrator(f);
    f.finish(sid, 'planned'); await tick();
    f.mgr.setHelpers(pid, sid, { advisor: true, router: 'none', lean: 'high' });
    vi.spyOn(f.mgr, 'routerFor').mockReturnValue('jev');
    const decide = vi.spyOn(f.mgr.jev(), 'decide').mockImplementation(async (s, i) => ({ at: 't', sessionId: s, provider: i.provider, notes: ['model -> fable'], latencyMs: 1, baseModel: i.currentModel, model: 'fable', effort: 'high' }));
    const d = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'Fix the login test.', model: 'opus', effort: 'medium' });
    await tick();
    // Keyed by the delegate's own session; its saved model/effort are the base; the parent's lean.
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0][0]).toBe(d.sessionId);
    expect(decide.mock.calls[0][1]).toMatchObject({ provider: 'claude', currentModel: 'opus', currentEffort: 'medium', lean: 'high', prompt: 'Fix the login test.' });
    expect(decide.mock.calls[0][1].team).toBeUndefined();
    // Applied like the main turn; the advisor follows the model it runs on.
    const run = f.calls.at(-1)!;
    expect(run).toMatchObject({ sessionId: d.sessionId, model: 'fable', effort: 'high', advisor: 'fable' });
    expect(run.prompt).toMatch(/^Fix the login test\.\n\n\[Advisor on: /);
    f.finish(d.sessionId, 'DONE\nfixed'); await tick();
    // A Codex delegate: the gateway advisor, stuck + checkpoint only, steered into ITS turn.
    const consult = vi.spyOn(f.mgr.codexAdvisor(), 'consult').mockImplementation(async (s, input) => ({ at: new Date().toISOString(), sessionId: s, trigger: input.trigger, model: input.model, latencyMs: 1, delivered: 'none', verdict: 'adjust', advice: 'Read the failing assertion.' }));
    const inject = vi.spyOn(f.mgr as unknown as { injectIntoProcess(s: string, t: string): Promise<boolean> }, 'injectIntoProcess').mockResolvedValue(true);
    const steer = vi.spyOn(f.mgr, 'steerSession');
    const cx = f.mgr.startDelegate(pid, sid, { role: 'codex-side', brief: 'Port the parser.', provider: 'codex' });
    await tick();
    const cxRun = f.calls.at(-1)!;
    expect(cxRun.sessionId).toBe(cx.sessionId);
    expect(cxRun.advisor).toBeUndefined();
    expect(cxRun.prompt).toBe('Port the parser.');
    cxRun.tap?.({ type: 'item.completed', item: { type: 'agent_message', text: 'on it' } } as never);
    for (let i = 0; i < 5; i++) cxRun.tap?.({ type: 'item.completed', item: { type: 'command_execution', command: 'make', exit_code: 2 } } as never);
    cxRun.tap?.({ type: 'item.completed', item: { type: 'todo_list', items: [{ text: 'x' }] } } as never);
    cxRun.tap?.({ type: 'turn.completed' } as never);
    await tick();
    expect(consult.mock.calls.map((c) => [c[0], c[1].trigger])).toEqual([[cx.sessionId, 'stuck'], [cx.sessionId, 'checkpoint']]);
    expect(inject).toHaveBeenCalledWith(cx.sessionId, expect.stringMatching(/failing assertion/));
    expect(steer).not.toHaveBeenCalled();
    expect(f.mgr.codexAdvisor().consultations(cx.sessionId).map((c) => c.delivered)).toEqual(['steered', 'steered']);
    expect(f.mgr.codexAdvisor().consultations(sid)).toEqual([]);
    expect(decide.mock.calls.at(-1)![0]).toBe(cx.sessionId);
    f.finish(cx.sessionId, 'DONE');
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

  describe('dismissing', () => {
    const byRole = (mgr: SessionManager, gates: Record<string, string>) => {
      vi.spyOn(mgr.jev(), 'configured').mockReturnValue(true);
      vi.spyOn(mgr.jev(), 'choose').mockImplementation(async (_sid, q) => ({ at: 't', sessionId: 's', backend: 'jev', question: 'q', options: [], choice: gates[(q.state as Record<string, string>).worker_role], confidence: 0.95, verdict: 'sharp', latencyMs: 1 }) as ForkDecision);
    };
    const drain = () => new Promise((r) => setTimeout(r, 600));
    const dismissed = (mgr: SessionManager, pid: string, sid: string) => Object.fromEntries(mgr.listDelegates(pid, sid).map((d) => [d.role, d.dismissedBy ?? null]));

    it('the rule: DONE gate, or needs_orchestrator with a DONE first line, and only once consumed', () => {
      expect([saysDone('DONE'), saysDone('\n  DONE — finalized'), saysDone('DONE: x'), saysDone('DONEish'), saysDone('NEEDS HUMAN\nDONE'), saysDone('')]).toEqual([true, true, true, false, false, false]);
      const r = (gate: DelegateReport['gate'], text = 'DONE', extra: Partial<DelegateReport> = {}): DelegateReport => ({ at: 't', delegateId: 'd-1', role: 'x', turn: 1, status: 'completed', text, gate, gateBy: 'jev', woke: true, ...extra });
      const d = (rep: DelegateReport, over: Partial<Delegate> = {}): Delegate => ({ id: 'd-1', role: 'x', brief: 'b', provider: 'claude', projectId: 'p', cwd: '/', sessionId: 's', status: 'idle', createdAt: 't', updatedAt: 't', turns: 1, pending: [], lastReport: rep, ...over });
      const ok = (rep: DelegateReport, over: Partial<Delegate> = {}, queued = new Set<string>(), delegateQueued = false, working = false) => autoDismissible(d(rep, over), new Map([['d-1@t', rep]]), queued, delegateQueued, working);
      expect(ok(r('done'))).toBe(true);
      expect(ok(r('needs_orchestrator'))).toBe(true);
      expect(ok(r('needs_orchestrator', 'NEEDS ORCHESTRATOR: pick one'))).toBe(false);
      expect(ok(r('needs_human'))).toBe(false);
      expect(ok(r('blocked'))).toBe(false);
      expect(ok(r('done', 'DONE', { woke: false }))).toBe(false);
      expect(ok(r('needs_orchestrator', 'DONE', { queueId: 'q1' }), {}, new Set(['q1']))).toBe(false);
      expect(ok(r('needs_orchestrator', 'DONE', { queueId: 'q1' }), {}, new Set(['q2']))).toBe(true);
      expect(ok(r('done'), {}, new Set(), true)).toBe(false);
      expect(ok(r('done'), {}, new Set(), false, true)).toBe(false);
      expect(ok(r('done'), { pending: ['more'] })).toBe(false);
      expect(ok(r('done'), { status: 'failed' })).toBe(false);
    });

    it('puts away a needs-orchestrator delegate that wrote DONE once the turn that read it ends', async () => {
      const f = fixture(); const { pid, sid } = await orchestrator(f);
      byRole(f.mgr, { backend: 'needs_orchestrator', dwh: 'needs_orchestrator' });
      const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
      const b = f.mgr.startDelegate(pid, sid, { role: 'dwh', brief: 'B' });
      await tick();
      f.finish(a.sessionId, 'DONE\nShipped.'); f.finish(b.sessionId, 'NEEDS ORCHESTRATOR: which schema?'); await tick(); await tick();
      f.finish(sid, 'planned'); await tick();
      expect(dismissed(f.mgr, pid, sid)).toEqual({ backend: null, dwh: null });
      await drain(); f.finish(sid, 'noted'); await tick();
      expect(dismissed(f.mgr, pid, sid)).toEqual({ backend: 'auto', dwh: null });
    });

    it('puts a DONE delegate away when the orchestrator turn that read its report ends; needs-a-person stays', async () => {
      const f = fixture(); const { pid, sid } = await orchestrator(f);
      byRole(f.mgr, { backend: 'done', reviewer: 'needs_human' });
      const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
      const b = f.mgr.startDelegate(pid, sid, { role: 'reviewer', brief: 'B' });
      await tick();
      f.finish(a.sessionId, 'DONE: shipped'); await tick();
      f.finish(b.sessionId, 'NEEDS HUMAN: credentials'); await tick();
      expect(queued(f.mgr, pid, sid)).toHaveLength(1);
      const queueId = f.mgr.delegateStore().reports(sid)[0].queueId;
      expect(queueId).toBeTruthy();
      expect(f.mgr.listDelegates(pid, sid).find((d) => d.role === 'backend')?.lastReport).toMatchObject({ woke: true, queueId });
      // The turn that was running when the reports arrived did not read them.
      f.finish(sid, 'planned'); await tick();
      expect(dismissed(f.mgr, pid, sid)).toEqual({ backend: null, reviewer: null });
      // The digest is dispatched as the next turn; when THAT ends, DONE goes.
      await drain();
      expect(f.calls.at(-1)!.sessionId).toBe(sid);
      expect(queued(f.mgr, pid, sid)).toHaveLength(0);
      f.finish(sid, 'noted'); await tick();
      expect(dismissed(f.mgr, pid, sid)).toEqual({ backend: 'auto', reviewer: null });
    });

    it('never puts away a delegate that is working again, and a failed orchestrator turn counts as read', async () => {
      const f = fixture(); const { pid, sid } = await orchestrator(f);
      byRole(f.mgr, { backend: 'done', dwh: 'done' });
      const a = f.mgr.startDelegate(pid, sid, { role: 'backend', brief: 'A' });
      const b = f.mgr.startDelegate(pid, sid, { role: 'dwh', brief: 'B' });
      await tick();
      f.finish(a.sessionId, 'DONE'); f.finish(b.sessionId, 'DONE'); await tick(); await tick();
      f.finish(sid, 'planned'); await drain();
      // The orchestrator reads the digest and sends backend more work.
      f.mgr.delegateFollowup(pid, sid, a.id, 'One more thing.');
      await tick();
      f.finish(sid, 'oops', 'failed'); await tick();
      expect(dismissed(f.mgr, pid, sid)).toEqual({ backend: null, dwh: 'auto' });
    });

    it('by hand: one, every finished one, and a working one is stopped first; out of the limit and the role names', async () => {
      const f = fixture(); const { pid, sid } = await orchestrator(f);
      byRole(f.mgr, {});
      for (let i = 0; i < MAX_DELEGATES; i++) f.mgr.startDelegate(pid, sid, { role: 'w' + i, brief: 'x' });
      await tick();
      const ds = f.mgr.listDelegates(pid, sid);
      f.finish(ds[0].sessionId, 'DONE'); f.finish(ds[1].sessionId, 'DONE'); await tick(); await tick();
      expect(() => f.mgr.dismissDelegates(pid, sid, { id: 'd-nope' })).toThrow(/unknown delegate/);
      expect(f.mgr.dismissDelegates(pid, sid, { id: ds[2].id })).toBe(1);
      await tick();
      expect(f.mgr.listDelegates(pid, sid)[2]).toMatchObject({ dismissedBy: 'user', status: 'stopped', working: false });
      expect(f.mgr.dismissDelegates(pid, sid, { all: 'finished' })).toBe(2);
      expect(f.mgr.listDelegates(pid, sid).filter((d) => d.dismissedAt).map((d) => d.role).sort()).toEqual(['w0', 'w1', 'w2']);
      // Three slots free, and the names with them.
      expect(() => f.mgr.startDelegate(pid, sid, { role: 'w0', brief: 'again' })).not.toThrow();
      const n1 = f.mgr.startDelegate(pid, sid, { role: 'n1', brief: 'x' }); f.mgr.startDelegate(pid, sid, { role: 'n2', brief: 'x' });
      expect(() => f.mgr.startDelegate(pid, sid, { role: 'n3', brief: 'x' })).toThrow(/8 delegates/);
      // Reviving needs a slot, and its name back.
      expect(() => f.mgr.delegateFollowup(pid, sid, ds[1].id, 'more')).toThrow(/8 active delegates/);
      expect(f.mgr.dismissDelegates(pid, sid, { id: n1.id })).toBe(1); // working: stopped, then put away
      await tick();
      expect(() => f.mgr.delegateFollowup(pid, sid, ds[0].id, 'more')).toThrow(/Another delegate named "w0"/);
      expect(f.mgr.delegateFollowup(pid, sid, ds[1].id, 'more')).toEqual({ id: ds[1].id, status: 'working' });
      const w1 = f.mgr.listDelegates(pid, sid).find((d) => d.id === ds[1].id)!;
      expect(w1).toMatchObject({ working: true, turns: 1 });
      expect(w1.dismissedAt).toBeUndefined();
      expect(f.calls.at(-1)).toMatchObject({ sessionId: ds[1].sessionId, prompt: 'more', resume: true });
      // Persisted: a restart still knows who was put away.
      const again = new SessionManager({ stateDir: f.stateDir, workspaceRoot: f.dir, runSessionFn: (async () => new Promise(() => {})) as never });
      expect(again.listDelegates(pid, sid).filter((d) => d.dismissedAt).length).toBe(f.mgr.listDelegates(pid, sid).filter((d) => d.dismissedAt).length);
    });

    it('at boot, DONE reports delivered before it are put away (a needs-orchestrator one too when it says DONE); the rest are not', async () => {
      const f = fixture(); const { pid, sid } = await orchestrator(f);
      const store = new DelegateStore(f.stateDir);
      const rep = (id: string, gate: DelegateReport['gate'], at: string): DelegateReport => ({ at, delegateId: id, role: id, turn: 1, status: 'completed', text: 'DONE', gate, gateBy: 'jev', woke: true });
      const base = (id: string, status: Delegate['status'], lastReport: DelegateReport): Delegate => ({ id, role: id, brief: 'x', provider: 'claude', projectId: pid, cwd: f.dir, sessionId: 's-' + id, status, createdAt: 't', updatedAt: 't', turns: 1, pending: [], lastReport: { ...lastReport, woke: false } });
      const r1 = rep('d-done', 'done', '2026-10-01T01:00:00Z'), r2 = rep('d-orch', 'needs_orchestrator', '2026-10-01T01:00:01Z'), r3 = rep('d-work', 'done', '2026-10-01T01:00:02Z');
      const r4 = { ...rep('d-ask', 'needs_orchestrator', '2026-10-01T01:00:03Z'), text: 'NEEDS ORCHESTRATOR: which schema?\nDONE with the rest' };
      const r5 = rep('d-human', 'needs_human', '2026-10-01T01:00:04Z');
      store.save(pid, sid, [base('d-done', 'idle', r1), base('d-orch', 'idle', r2), base('d-work', 'working', r3), base('d-ask', 'idle', r4), base('d-human', 'idle', r5)]);
      for (const r of [r1, r2, r3, r4, r5]) store.addReport(sid, r);
      const again = new SessionManager({ stateDir: f.stateDir, workspaceRoot: f.dir, runSessionFn: (async () => new Promise(() => {})) as never });
      await tick();
      expect(Object.fromEntries(again.listDelegates(pid, sid).map((d) => [d.id, d.dismissedBy ?? null]))).toEqual({ 'd-done': 'auto', 'd-orch': 'auto', 'd-work': null, 'd-ask': null, 'd-human': null });
    });
  });
});

