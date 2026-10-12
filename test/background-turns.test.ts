import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';

/**
 * A conversation still working in the background (agents running, a woken
 * reply) when the user writes. Live 2026-10-09: a Jev effort change spawned a
 * second process beside the working one, and a steered answer left the
 * question card up.
 */
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Captured = { model?: string; effort?: string; advisor?: string };
function fixture(conv: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-bg-')); dirs.push(dir);
  const stateDir = join(dir, 'state');
  const cwd = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{ id: 'p1', name: 'P', cwd, provider: 'claude',
      conversations: [{ sessionId: 'a', title: 'A', provider: 'claude', ...conv }], lastSessionId: 'a' }],
  }));
  const runs: Captured[] = [];
  const open = new Map<string, () => void>();
  const runSessionFn = ((o: Captured & { sessionId: string; control?: (c: { abort: () => void }) => void }) => new Promise((resolve) => {
    runs.push({ model: o.model, effort: o.effort, advisor: o.advisor });
    const done = () => resolve({ status: 'completed', finalAccount: 'a', failovers: 0, resultText: 'ok' });
    open.set(o.sessionId, done);
    o.control?.({ abort: done });
  })) as unknown as typeof import('../src/failover.js').runSession;
  const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  mgr.subscribe((e) => events.push({ kind: e.kind, data: e.data as Record<string, unknown> }));
  const end = async (sid: string) => { const f = open.get(sid); open.delete(sid); f?.(); await new Promise((r) => setTimeout(r, 30)); };
  return { mgr, events, runs, end };
}
const settle = () => new Promise((r) => setTimeout(r, 30));
const question = (at = '2026-10-12T07:00:00.000Z') => ({ projectId: 'p1', sessionId: 'a', question: 'Proceed?', options: ['Yes', 'No'], at });
type Internals = { pendingQuestions: Map<string, unknown>; persistent: { heldIdentity: (sid: string) => unknown; injectMessage: (...a: unknown[]) => Promise<boolean> } | null };

describe('a turn while the conversation works in the background', () => {
  it('runs on the working process as it is: no pick, and says why the saved choice was set aside', async () => {
    const f = fixture({ model: 'opus', effort: 'xhigh' });
    const pool = (f.mgr as unknown as Internals).persistent;
    if (!pool) return; // X056_PERSISTENT=off: no pool, nothing held
    vi.spyOn(pool, 'heldIdentity').mockReturnValue({ model: 'opus', effort: 'high', advisor: undefined });
    f.mgr.continueSession('p1', 'a', 'the architecture is attached');
    await settle();
    expect(f.runs[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect(f.events.find((e) => e.kind === 'identity_held')?.data).toMatchObject({ model: 'opus', effort: 'high', wantedModel: 'opus', wantedEffort: 'xhigh', reason: 'background_work' });
    expect(f.events.some((e) => e.kind === 'jev_decision')).toBe(false);
    await f.end('a');
  });

  it('says nothing when the working process already runs the saved choice', async () => {
    const f = fixture({ model: 'opus', effort: 'high' });
    const pool = (f.mgr as unknown as Internals).persistent;
    if (!pool) return;
    vi.spyOn(pool, 'heldIdentity').mockReturnValue({ model: 'opus', effort: 'high' });
    f.mgr.continueSession('p1', 'a', 'go on');
    await settle();
    expect(f.events.some((e) => e.kind === 'identity_held')).toBe(false);
    await f.end('a');
  });
});

describe('answering a pending question by steering', () => {
  it('a human steer into the running turn closes the card everywhere', async () => {
    const f = fixture();
    const pool = (f.mgr as unknown as Internals).persistent;
    if (!pool) return;
    vi.spyOn(pool, 'injectMessage').mockResolvedValue(true);
    f.mgr.continueSession('p1', 'a', 'work on it');
    await settle();
    (f.mgr as unknown as Internals).pendingQuestions.set('a', question());
    expect(await f.mgr.steerSession('p1', 'a', 'Yes')).toBe(true);
    expect(f.mgr.listPendingQuestions().some((q) => q.sessionId === 'a')).toBe(false);
    expect(f.events.find((e) => e.kind === 'question_answered')?.data).toMatchObject({ projectId: 'p1', sessionId: 'a', by: 'steer' });
    await f.end('a');
  });

  it('a steer from the gateway itself (advisor, AI senders) leaves it for the user', async () => {
    const f = fixture();
    const pool = (f.mgr as unknown as Internals).persistent;
    if (!pool) return;
    vi.spyOn(pool, 'injectMessage').mockResolvedValue(true);
    f.mgr.continueSession('p1', 'a', 'work on it');
    await settle();
    (f.mgr as unknown as Internals).pendingQuestions.set('a', question());
    expect(await f.mgr.steerSession('p1', 'a', 'note from the advisor', { humanOrigin: false })).toBe(true);
    expect(f.mgr.listPendingQuestions().some((q) => q.sessionId === 'a')).toBe(true);
    expect(f.events.some((e) => e.kind === 'question_answered')).toBe(false);
    await f.end('a');
  });
});
