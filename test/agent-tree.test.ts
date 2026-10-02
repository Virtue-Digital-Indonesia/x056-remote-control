import { JevService } from '../server/jev.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { SessionManager } from '../server/manager.js';
import { ClaudeAdvisorLog, forkSummary, isGate, mainRun, tailJsonl, teamRun } from '../server/agent-tree.js';
import type { ForkDecision, JevDecision } from '../server/jev.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'x056-tree-')); dirs.push(d); return d; };
const fork = (question: string, verdict: 'sharp' | 'split', at = '2026-09-30T10:00:00Z'): ForkDecision => ({ at, sessionId: 's', backend: 'jev', question, options: ['a', 'b'], choice: 'a', confidence: verdict === 'sharp' ? 0.9 : 0.5, verdict, latencyMs: 300 });

describe('agent tree pieces', () => {
  it('shows the team\'s picked model and effort for this turn, else the fixed default', () => {
    const pick = (at: string, team?: JevDecision['team'], extra: Partial<JevDecision> = {}): JevDecision => ({ at, sessionId: 's', provider: 'claude', notes: [], latencyMs: 1, ...(team ? { team } : {}), ...extra });
    const t = { model: 'sonnet', effort: 'high', base: { model: 'opus', effort: 'medium' }, pickedModel: 'sonnet', pickedEffort: 'high', modelConfidence: 0.7, effortConfidence: 0.62 };
    const roles = ['explorer', 'worker', 'researcher'];
    expect(teamRun('claude', [pick('2026-09-30T10:00:00Z', t)], '2026-09-30T09:59:00Z')).toEqual({ model: 'sonnet', effort: 'high', pickedBy: 'jev', confidence: 0.62, roles });
    // An older turn's pick does not describe this turn; a failed one never does.
    expect(teamRun('claude', [pick('2026-09-30T10:00:00Z', t)], '2026-09-30T11:00:00Z')).toEqual({ model: 'opus', effort: 'medium', roles });
    expect(teamRun('claude', [pick('2026-09-30T10:00:00Z', t, { error: 'x' })], undefined)).toEqual({ model: 'opus', effort: 'medium', roles });
    expect(teamRun('codex', [pick('2026-09-30T10:00:00Z', { effort: 'xhigh', base: { effort: 'medium' }, pickedEffort: 'xhigh', effortConfidence: 0.8 }, { backend: 'openai' })], undefined))
      .toEqual({ effort: 'xhigh', pickedBy: 'openai', confidence: 0.8, roles: ['explorer', 'worker', 'default'] });
  });

  it('reads only the tail of a log, skipping a line the window cut', () => {
    const f = join(temp(), 'log.jsonl');
    for (let i = 0; i < 200; i++) appendFileSync(f, JSON.stringify({ i, pad: 'x'.repeat(50) }) + '\n');
    expect(tailJsonl<{ i: number }>(f, 3).map((r) => r.i)).toEqual([197, 198, 199]);
    const small = tailJsonl<{ i: number }>(f, 1000, 1000);
    expect(small.length).toBeGreaterThan(5);
    expect(small.at(-1)!.i).toBe(199);
    expect(small[0].i).toBe(199 - small.length + 1); // no half line at the front
    expect(tailJsonl(join(temp(), 'missing.jsonl'), 5)).toEqual([]);
  });

  it('keeps the delegate report gate out of the fork counts', () => {
    const s = forkSummary([fork('which file', 'sharp'), fork('retry or stop', 'split'), fork('report gate · backend', 'sharp'), fork('which tool', 'sharp')]);
    expect(s).toMatchObject({ total: 3, sharp: 2, split: 1 });
    expect(s.recent.map((f) => f.question)).toEqual(['which file', 'retry or stop', 'which tool']);
    expect(s.gates.map((f) => f.question)).toEqual(['report gate · backend']);
    expect(isGate({ question: 'report gate · dwh' })).toBe(true);
  });

  it('shows the main session on this turn\'s pick, else its saved choice', () => {
    const picks = [
      { at: '2026-09-30T09:00:00Z', effort: 'low', baseModel: 'opus', baseEffort: 'high' },
      { at: '2026-09-30T10:00:05Z', model: 'sonnet', baseModel: 'opus', baseEffort: 'high', lean: 'low', backend: 'jev' },
    ] as JevDecision[];
    expect(mainRun({ model: 'opus', effort: 'high' }, picks, '2026-09-30T10:00:00Z')).toEqual({ model: 'sonnet', effort: 'high', pickedBy: 'jev', lean: 'low' });
    // An older turn's pick does not describe this one.
    expect(mainRun({ model: 'opus', effort: 'high' }, picks.slice(0, 1), '2026-09-30T10:00:00Z')).toEqual({ model: 'opus', effort: 'high' });
    expect(mainRun({}, [], undefined)).toEqual({ model: undefined, effort: undefined });
  });

  it('logs Claude advisor calls per conversation', () => {
    const log = new ClaudeAdvisorLog(temp());
    log.record('s-00000001', { at: 't1', model: 'opus', status: 'reviewed' });
    log.record('s-00000001', { at: 't2', model: 'opus', status: 'unavailable', error: 'overloaded' });
    log.record('../escape', { at: 't3', model: 'opus', status: 'reviewed' });
    expect(log.tail('s-00000001').map((c) => c.status)).toEqual(['reviewed', 'unavailable']);
    expect(log.tail('../escape')).toEqual([]);
  });
});

describe('SessionManager.agentTree', () => {
  function fixture() {
    const dir = temp(), stateDir = join(dir, 'state');
    mkdirSync(join(stateDir, 'secrets'), { recursive: true });
    writeFileSync(join(stateDir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' }));
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    // A key makes Jev the DEFAULT picker; keep that off the network.
    (mgr as unknown as { jevService: JevService }).jevService = new JevService(stateDir, (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch);
    return { mgr, calls, dir, stateDir };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('assembles helpers, advisor, forks without gates, picks and delegates', async () => {
    const { mgr, calls, dir, stateDir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('orchestrate', undefined, { model: 'opus', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setHelpers(p.id, sid, { advisor: true, team: true, router: 'jev', lean: 'high' });
    mkdirSync(join(stateDir, 'jev', 'forks'), { recursive: true });
    writeFileSync(join(stateDir, 'jev', 'forks', sid + '.jsonl'), [fork('which file', 'sharp'), fork('report gate · backend', 'sharp'), fork('retry or stop', 'split')].map((f) => JSON.stringify(f)).join('\n') + '\n');
    mgr.claudeAdvisorLog().record(sid, { at: '2026-09-30T10:01:00Z', model: 'opus', status: 'reviewed' });
    vi.spyOn(mgr as unknown as { runDelegateTurn(): void }, 'runDelegateTurn').mockImplementation(() => {});
    mgr.startDelegate(p.id, sid, { role: 'backend', brief: 'A' });
    const t = mgr.agentTree(p.id, sid);
    expect(t.provider).toBe('claude');
    expect(t.helpers).toEqual({ advisor: true, team: true, router: 'jev', savedRouter: 'jev', lean: 'high' });
    expect(t.main).toMatchObject({ model: 'opus', effort: 'high', running: false });
    expect(t.turnStartedAt).toBeTruthy();
    expect(t.advisor).toMatchObject({ on: true, kind: 'claude', model: 'opus', checkpoints: false });
    expect((t.advisor as { calls: unknown[] }).calls).toHaveLength(1);
    expect(t.team).toEqual({ effort: 'medium', model: 'opus', roles: ['explorer', 'worker', 'researcher'] });
    expect(t.forks).toMatchObject({ total: 2, sharp: 1, split: 1 });
    expect(t.gates.map((g) => g.question)).toEqual(['report gate · backend']);
    expect(t.delegates.map((d) => d.role)).toEqual(['backend']);
    // One gateway turn, finished: its end is the recorded session_done.
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]).toMatchObject({ n: 1, prompt: 'orchestrate', running: false });
    expect(t.turns[0].endedAt! >= t.turns[0].startedAt).toBe(true);
    // Helpers off: nothing claims to be on.
    mgr.setHelpers(p.id, sid, {});
    expect(mgr.agentTree(p.id, sid)).toMatchObject({ advisor: { on: false }, team: null });
    expect(() => mgr.agentTree(p.id, 'nope')).toThrow(/unknown conversation/);
  });
});
