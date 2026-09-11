import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';
import { CronScheduler } from '../server/cron.js';
import { AccountRegistry } from '../src/accounts.js';
import { ChatCapabilities } from '../server/chat-capabilities.js';
import type { RunSessionOptions } from '../src/failover.js';

const managers: SessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.onModuleDestroy(); vi.restoreAllMocks(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-membership-')), stateDir = join(root, 'state'), workspaceRoot = join(root, 'work'); mkdirSync(stateDir); mkdirSync(workspaceRoot);
  const accounts = AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'a') }, { name: 'b', provider: 'codex', configDir: join(root, 'b') }]);
  const calls: RunSessionOptions[] = [];
  const opts = { stateDir, workspaceRoot, chatEnabled: true, projectSpacesEnabled: true, runSessionFn: async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed' as const, failovers: 0 }; } };
  const m = new SessionManager(opts); managers.push(m);
  const cron = new CronScheduler({ stateDir, deliver: () => { throw new Error('Unexpected fixture delivery'); } });
  const pause = (ids: string[], reason: string) => { for (const job of cron.list()) if (ids.includes(job.projectId)) cron.pauseForContext(job.id, reason); };
  m.setProjectAutomationPauser(pause);
  const parent = m.createProjectSpace({ requestId: 'membership-parent-001', name: 'Proposal', cwd: workspaceRoot }), chat = m.createChat({ requestId: 'membership-chat-001' });
  return { root, stateDir, workspaceRoot, accounts, calls, opts, m, cron, pause, parent, chat };
}

describe('Project membership, defaults and paused work', () => {
  it('retains queued messages, references and automations, with explicit context review before dispatch', () => {
    const f = fixture(), sid = f.chat.lastSessionId!;
    const item = f.m.enqueue(f.chat.id, { text: 'Keep this message', sessionId: sid, paused: true, notBefore: Date.now() + 86400000, model: 'claude-sonnet-5' });
    f.m.setAutopilot(f.chat.id, sid, { count: 4, prompt: 'Keep this plan' });
    const job = f.cron.add({ projectId: f.chat.id, sessionId: sid, schedule: '0 0 * * *', tz: 'UTC', prompt: 'Scheduled task' });
    const moved = f.m.moveProjectChat(f.chat.id, { parentProjectId: f.parent.id, expectedRevision: 0, operationId: 'membership-move-001' });
    expect(moved.id).toBe(f.chat.id); expect(moved.cwd).toBe(f.chat.cwd); expect(moved.lastSessionId).toBe(sid);
    const queued = f.m.queues()[f.chat.id][0];
    expect(queued).toMatchObject({ id: item.id, text: item.text, model: item.model, notBefore: item.notBefore, contextReview: { membershipRevision: 1 }, paused: true });
    expect(f.cron.list().find(j => j.id === job.id)?.enabled).toBe(false);
    expect(f.m.autopilotStatus()[sid]).toMatchObject({ remaining: 4, paused: true });
    expect(() => f.m.editQueueItem(f.chat.id, item.id, { paused: false })).toThrow('Review');
    expect(() => f.m.reviewProjectQueue(f.chat.id, item.id, 0)).toThrow('changed');
    f.m.reviewProjectQueue(f.chat.id, item.id, 1);
    expect(f.m.queues()[f.chat.id][0].contextReview).toBeUndefined();
    expect(f.m.queues()[f.chat.id][0].paused).toBe(false);
    f.m.moveProjectChat(f.chat.id, { parentProjectId: f.parent.id, expectedRevision: 0, operationId: 'membership-move-001' });
    expect(f.m.queues()[f.chat.id][0].contextReview).toBeUndefined();
    expect(f.calls).toHaveLength(0);
  });

  it('reconciles an interrupted membership write before queues or autopilots can resume', () => {
    const f = fixture(), sid = f.chat.lastSessionId!;
    f.m.enqueue(f.chat.id, { text: 'Pending', sessionId: sid, paused: true }); f.m.setAutopilot(f.chat.id, sid, { count: 3 });
    ProjectRegistry.load(join(f.stateDir, 'projects.json')).moveChat(f.chat.id, f.parent.id, 0, 'interrupted-move-001');
    const restarted = new SessionManager(f.opts); managers.push(restarted); restarted.setProjectAutomationPauser(f.pause);
    expect(restarted.queues()[f.chat.id][0].contextReview?.operationId).toBe('interrupted-move-001');
    expect(restarted.autopilotStatus()[sid].paused).toBe(true);
    expect(ProjectRegistry.load(join(f.stateDir, 'projects.json')).pendingMembershipOperations()).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects membership and archive changes during background work, and restoration never resumes paused work', () => {
    const f = fixture(), sid = f.chat.lastSessionId!;
    f.m.moveProjectChat(f.chat.id, { parentProjectId: f.parent.id, expectedRevision: 0, operationId: 'archive-member-001' });
    const busy = vi.spyOn(f.m, 'backgroundSessions').mockReturnValue([{ projectId: f.chat.id, sessionId: sid }]);
    expect(() => f.m.moveProjectChat(f.chat.id, { parentProjectId: null, expectedRevision: 1, operationId: 'busy-member-001' })).toThrow('active');
    expect(() => f.m.archiveProjectSpace(f.parent.id, { expectedRevision: 1, archived: true, operationId: 'busy-archive-001' })).toThrow('active');
    busy.mockRestore();
    const item = f.m.enqueue(f.chat.id, { text: 'Pending', sessionId: sid, paused: true });
    const archived = f.m.archiveProjectSpace(f.parent.id, { expectedRevision: 1, archived: true, operationId: 'archive-project-001' });
    expect(() => f.m.continueSession(f.chat.id, sid, 'Should not run')).toThrow('Restore');
    f.m.archiveProjectSpace(f.parent.id, { expectedRevision: archived.revision!, archived: false, operationId: 'restore-project-001' });
    expect(f.m.queues()[f.chat.id][0]).toMatchObject({ id: item.id, paused: true, contextReview: { reason: 'Project archived' } });
    expect(f.calls).toHaveLength(0);
  });

  it('applies separate defaults to new modes without changing old selections and prepares Work idempotently', async () => {
    const f = fixture();
    f.m.updateProjectSpace(f.parent.id, { expectedRevision: 1, defaults: { chat: { provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh', account: 'b' }, work: { provider: 'claude', model: 'claude-sonnet-5', account: 'a' } } });
    const chat = f.m.createChat({ requestId: 'default-chat-001', parentProjectId: f.parent.id });
    expect(chat).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', effort: 'xhigh' });
    expect(f.m.chat(f.chat.id).provider).toBe('claude');
    const work = f.m.prepareProjectWork(f.parent.id, { requestId: 'default-work-001', name: 'Prepared Work' });
    expect(f.m.prepareProjectWork(f.parent.id, { requestId: 'default-work-001', name: 'Prepared Work' })).toEqual(work);
    f.m.continueSession(f.parent.id, work.sessionId, 'Start prepared Work');
    expect(f.calls[0]).toMatchObject({ resume: false, model: 'claude-sonnet-5', cwd: f.workspaceRoot });
    await new Promise(r => setTimeout(r, 20));
    const p = f.m.listProjects().projects.find(p => p.id === f.parent.id)!;
    expect(() => f.m.updateProjectSpace(p.id, { expectedRevision: p.revision!, cwd: f.root })).toThrow();
    expect(JSON.parse(readFileSync(join(f.stateDir, 'conversation-routing.json'), 'utf8'))[f.parent.id + '::' + work.sessionId].lockedAccount).toBe('a');
  });

  it('checks Project requirements using the actual Work or Chat directory and account on each attempt', async () => {
    const f = fixture(), seen: string[] = [];
    f.m.updateProjectSpace(f.parent.id, { expectedRevision: 1, requiredTools: [{ key: 'skill:repository-only' }] });
    const service = new ChatCapabilities(f.stateDir, () => f.accounts.list(), undefined as never, undefined as never, undefined, async (account, target) => {
      seen.push(target.cwd!);
      return { account: account.name, errors: [], capabilities: target.cwd === f.workspaceRoot ? [{ key: 'skill:repository-only', name: 'Repository skill', kind: 'skill', state: 'ready' }] : [] };
    });
    f.m.setChatCapabilities(service);
    const chat = f.m.createChat({ requestId: 'capabilities-chat-001', parentProjectId: f.parent.id, provider: 'claude' });
    const work = f.m.prepareProjectWork(f.parent.id, { requestId: 'capabilities-work-001', provider: 'claude' });
    f.m.continueSession(chat.id, chat.lastSessionId!, 'Chat task'); f.m.continueSession(f.parent.id, work.sessionId, 'Work task');
    expect(await f.calls[0].accountEligibility!()).toMatchObject({ a: [expect.stringContaining('Required tool')] });
    expect(await f.calls[1].accountEligibility!()).toEqual({});
    expect(seen).toEqual([chat.cwd, f.workspaceRoot]);
    await new Promise(r => setTimeout(r, 20));
  });
});
