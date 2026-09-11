import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';
import { CronScheduler } from '../server/cron.js';
import { AccountRegistry } from '../src/accounts.js';
import { associate, associateWork } from './project-space-fixture.js';
import { ChatCapabilities } from '../server/chat-capabilities.js';
import type { MembershipChange } from '../server/project-space-registry.js';
const managers: SessionManager[] = [];
afterEach(() => { managers.splice(0).forEach(m => m.onModuleDestroy()); vi.restoreAllMocks(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'space-dispatch-')), stateDir = join(root, 'state'); mkdirSync(stateDir);
  const accounts = AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'a') }]);
  const calls: unknown[] = [], opts = { stateDir, workspaceRoot: root, projectSpacesEnabled: true, chatEnabled: true,
    runSessionFn: async (o: unknown) => { calls.push(o); return { status: 'completed' as const, failovers: 0 }; } };
  const m = new SessionManager(opts); managers.push(m);
  const cron = new CronScheduler({ stateDir, deliver: () => { throw new Error('Unexpected scheduled delivery'); } });
  const pause: Parameters<SessionManager['setProjectAutomationPauser']>[0] = (t, reason, operationId) => { for (const j of cron.list()) if (j.sessionId ? t.executions.some(r => r.projectId === j.projectId && r.sessionId === j.sessionId) : t.futureWorkProjectIds.includes(j.projectId)) cron.pauseForContext(j.id, reason, operationId); };
  m.setProjectAutomationPauser(pause, () => cron.list());
  const work = m.createProject('Original repository', root), a = m.createProjectSpace({ requestId: 'dispatch-space-a', name: 'A' }), b = m.createProjectSpace({ requestId: 'dispatch-space-b', name: 'B' });
  const x = m.prepareProjectWork(work.id, { requestId: 'dispatch-conversation-x' }), y = m.prepareProjectWork(work.id, { requestId: 'dispatch-conversation-y' });
  associateWork(m, work.id, a.id);
  const change: MembershipChange = { target: { kind: 'work-conversation', ...x }, assignment: { mode: 'space', spaceId: b.id } };
  const applyPreview = (p: ReturnType<SessionManager['previewProjectMembership']>) => m.applyProjectMembership({ target: p.target, assignment: p.assignment, ...(p.includeOverrides !== undefined ? { includeOverrides: p.includeOverrides } : {}), operationId: 'review-' + crypto.randomUUID(), expectedRevision: p.revision, expectedTopology: p.topology, expectedImpactHash: p.impactHash, expectedReviewHash: p.reviewHash });
  return { root, stateDir, accounts, opts, calls, m, cron, pause, work, a, b, x, y, change, applyPreview };
}
describe('exact-conversation Project integration', () => {
  it('pauses inherited queues across compatible disable and restore, with review available while disabled',async()=>{
    const f=fixture(),q=f.m.enqueue(f.work.id,{sessionId:f.x.sessionId,text:'Retained queue',paused:true,notBefore:Date.now()+600000});
    const standalone=f.m.createChat({requestId:'disable-standalone-001'}),local=f.m.enqueue(standalone.id,{sessionId:standalone.lastSessionId,text:'Local only',paused:true});
    f.m.setAutopilot(f.work.id,f.x.sessionId,{count:3});const job=f.cron.add({projectId:f.work.id,schedule:'0 0 * * *',tz:'UTC',prompt:'Future work'});
    f.m.onModuleDestroy();const off=new SessionManager({...f.opts,projectSpacesEnabled:false});managers.push(off);
    expect(()=>off.reviewProjectQueue(f.work.id,q.id,0)).toThrow('recovery');off.setProjectAutomationPauser(f.pause);
    expect(off.queues()[f.work.id][0]).toMatchObject({id:q.id,text:q.text,paused:true,contextReview:{membershipRevision:0}});
    expect(off.queues()[standalone.id][0]).toEqual(local);expect(f.cron.list().find(j=>j.id===job.id)?.enabled).toBe(false);
    expect(off.autopilotStatus()[f.x.sessionId].paused).toBe(true);
    off.reviewProjectQueue(f.work.id,q.id,0,{expectedText:q.text,text:'Reviewed local context',fileRefs:[]});
    expect(off.queues()[f.work.id][0].contextReview).toBeUndefined();off.onModuleDestroy();
    const again=new SessionManager({...f.opts,projectSpacesEnabled:false});managers.push(again);again.setProjectAutomationPauser(f.pause);
    expect(again.queues()[f.work.id][0].contextReview).toBeUndefined();again.onModuleDestroy();
    const restored=new SessionManager(f.opts);managers.push(restored);restored.setProjectAutomationPauser(f.pause);
    expect(restored.queues()[f.work.id][0]).toMatchObject({text:'Reviewed local context',paused:true,contextReview:{reason:expect.stringContaining('restored')}});expect(f.calls).toHaveLength(0);
  });
  it('archives original Work wherever its conversations are organized without pausing member Chats or references',()=>{
    const f=fixture();associate(f.m,f.change);const chat=f.m.createChat({requestId:'archive-member-chat-001',spaceId:f.a.id});
    const qx=f.m.enqueue(f.work.id,{sessionId:f.x.sessionId,text:'X',paused:true}),qy=f.m.enqueue(f.work.id,{sessionId:f.y.sessionId,text:'Y',paused:true}),qc=f.m.enqueue(chat.id,{sessionId:chat.lastSessionId,text:'Chat',paused:true});
    const approval=f.m.requestMcpSend(f.work.id,undefined,'Retained future Work approval');
    const before=f.m.executionProject(f.work.id);f.m.archiveWorkProject(f.work.id,{operationId:'archive-work-001',expectedRevision:before.revision||0,archived:true});
    expect(approval.contextReview?.operationId).toBe('archive-work-001');
    for(const q of [qx,qy])expect(f.m.queues()[f.work.id].find(r=>r.id===q.id)?.contextReview).toBeDefined();expect(f.m.queues()[chat.id][0]).toEqual(qc);
    expect(()=>f.m.continueSession(f.work.id,f.x.sessionId,'Blocked')).toThrow('archived');
    const archived=f.m.executionProject(f.work.id);f.m.archiveWorkProject(f.work.id,{operationId:'restore-work-001',expectedRevision:archived.revision!,archived:false});
    expect(f.m.queues()[f.work.id].every(q=>q.paused&&q.contextReview)).toBe(true);expect(f.m.spaces().resolve(f.work.id,f.x.sessionId).spaceId).toBe(f.b.id);expect(f.calls).toHaveLength(0);
  });
  it('moves one conversation without pausing sibling queues, schedules, autopilots or leases', async () => {
    const f = fixture(), { m, work, x, y } = f;
    const qx = m.enqueue(work.id, { sessionId: x.sessionId, text: 'X', paused: true }), qy = m.enqueue(work.id, { sessionId: y.sessionId, text: 'Y', paused: true });
    m.setAutopilot(work.id, x.sessionId, { count: 4 }); m.setAutopilot(work.id, y.sessionId, { count: 5 });
    const jx = f.cron.add({ projectId: work.id, sessionId: x.sessionId, schedule: '0 0 * * *', tz: 'UTC', prompt: 'X schedule' }), jy = f.cron.add({ projectId: work.id, sessionId: y.sessionId, schedule: '0 0 * * *', tz: 'UTC', prompt: 'Y schedule' });
    const path = join(f.root, 'proposal.txt'); writeFileSync(path, 'Original');
    const [file] = await m.files().upload(f.a.id, 'dispatch-file-001', [{ path, name: 'proposal.txt' }]);
    const ref = { fileId: file.id, versionId: file.latestVersionId }, cx = m.files().checkoutShared(f.a.id, ref, work.id, x.sessionId), cy = m.files().checkoutShared(f.a.id, ref, work.id, y.sessionId);
    const before = m.executionProject(work.id), revision = m.projectContext().resolve(work.id, y.sessionId).membershipRevision;
    associate(m, f.change);
    expect(m.executionProject(work.id)).toEqual(before);
    expect(m.queues()[work.id].find(q => q.id === qx.id)?.contextReview).toBeDefined(); expect(m.queues()[work.id].find(q => q.id === qy.id)).toEqual(qy);
    expect(m.autopilotStatus()[x.sessionId].paused).toBe(true); expect(m.autopilotStatus()[y.sessionId].paused).toBeUndefined();
    expect(f.cron.list().find(j => j.id === jx.id)?.enabled).toBe(false); expect(f.cron.list().find(j => j.id === jy.id)?.enabled).toBe(true);
    expect(m.projectContext().resolve(work.id, y.sessionId).membershipRevision).toBe(revision);
    await expect(m.files().commit(f.a.id, file.id, { checkoutToken: cx.token, expectedBaseVersionId: ref.versionId, operationId: 'stale-x-001' })).rejects.toThrow();
    writeFileSync(cy.path, 'Sibling output'); await m.files().commit(f.a.id, file.id, { checkoutToken: cy.token, expectedBaseVersionId: ref.versionId, operationId: 'valid-y-001' });
    expect(m.files().file(f.a.id, file.id).versions).toHaveLength(2);
  });
  it('rejects stale review after queued content, execution topology or schedules change', () => {
    const f = fixture(), q = f.m.enqueue(f.work.id, { sessionId: f.x.sessionId, text: 'Original', paused: true });
    let p = f.m.previewProjectMembership(f.change); f.m.editQueueItem(f.work.id, q.id, { text: 'Changed' }); expect(() => f.applyPreview(p)).toThrow('changed');
    p = f.m.previewProjectMembership(f.change); f.m.prepareProjectWork(f.work.id, { requestId: 'new-topology-001' }); expect(() => f.applyPreview(p)).toThrow('changed');
    p = f.m.previewProjectMembership(f.change); f.cron.add({ projectId: f.work.id, sessionId: f.x.sessionId, schedule: '* * * * *', tz: 'UTC', prompt: 'New schedule' }); expect(() => f.applyPreview(p)).toThrow('changed');
    expect(f.m.spaces().resolve(f.work.id, f.x.sessionId).spaceId).toBe(f.a.id);
  });
  it('allows a move during unrelated sibling work and blocks an affected active or background run', () => {
    const f = fixture(); vi.spyOn(f.m as unknown as { sessionBusy(sid: string): boolean }, 'sessionBusy').mockImplementation((sid: string) => sid === f.y.sessionId);
    f.applyPreview(f.m.previewProjectMembership(f.change));
    vi.spyOn(f.m, 'backgroundSessions').mockReturnValue([{ projectId: f.work.id, sessionId: f.x.sessionId }]);
    const change = { ...f.change, assignment: { mode: 'standalone' as const } };
    expect(() => f.applyPreview(f.m.previewProjectMembership(change))).toThrow('active');
  });
  it('keeps overrides during whole-Work moves, includes future sessions, and reviews unbound schedules', () => {
    const f = fixture(); associate(f.m, f.change);
    const job = f.cron.add({ projectId: f.work.id, schedule: '0 0 * * *', tz: 'UTC', prompt: 'Future conversation' });
    const c = f.m.createProjectSpace({ requestId: 'dispatch-space-c', name: 'C' }); associateWork(f.m, f.work.id, c.id);
    const z = f.m.prepareProjectWork(f.work.id, { requestId: 'future-conversation-z' });
    expect(f.m.spaces().resolve(f.work.id, f.x.sessionId).spaceId).toBe(f.b.id); expect(f.m.spaces().resolve(f.work.id, z.sessionId).spaceId).toBe(c.id);
    const paused = f.cron.list().find(j => j.id === job.id)!;
    expect(paused).toMatchObject({ id: job.id, schedule: job.schedule, prompt: job.prompt, enabled: false, runCount: 0 });
    expect(() => f.cron.setEnabled(job.id, true)).toThrow('Review'); expect(f.cron.setEnabled(job.id, true, paused.contextReview!.operationId)?.enabled).toBe(true);
    const view = f.m.projectSpaces().projects.find(s => s.id === c.id)!; expect(view.workProjects[0].conversations.find(c => c.sessionId === f.x.sessionId)?.included).toBe(false);
  });
  it('reconciles an interrupted whole association before new Work can be created', () => {
    const f = fixture(), change: MembershipChange = { target: { kind: 'work-project', projectId: f.work.id }, assignment: { mode: 'space', spaceId: f.b.id } }, p = f.m.spaces().preview(change);
    f.m.spaces().apply({ ...change, operationId: 'interrupted-whole-001', expectedRevision: p.revision, expectedTopology: p.topology, expectedImpactHash: p.impactHash });
    expect(() => f.m.prepareProjectWork(f.work.id, { requestId: 'blocked-future-001' })).toThrow('reconciled');
    f.m.onModuleDestroy(); const restart = new SessionManager(f.opts); managers.push(restart);
    expect(() => restart.continueSession(f.work.id, f.x.sessionId, 'Do not run')).toThrow('reconciled'); restart.setProjectAutomationPauser(f.pause);
    const z = restart.prepareProjectWork(f.work.id, { requestId: 'blocked-future-001' }); expect(restart.spaces().resolve(f.work.id, z.sessionId).spaceId).toBe(f.b.id); expect(f.calls).toHaveLength(0);
  });
  it('recovers creation assignment and never reassigns a moved conversation on retry', () => {
    const f = fixture(), registry = ProjectRegistry.load(join(f.stateDir, 'projects.json'));
    const c = registry.prepareWork(f.work.id, { requestId: 'interrupted-create-001', provider: 'claude', fingerprint: 'fixture', initialSpaceId: f.b.id, initialAccount: 'a' });
    f.m.onModuleDestroy(); const restart = new SessionManager(f.opts); managers.push(restart); restart.setProjectAutomationPauser(f.pause);
    expect(restart.spaces().resolve(f.work.id, c.sessionId).spaceId).toBe(f.b.id);
    const input = { requestId: 'retry-create-001', spaceId: f.a.id, account: 'a' }, target = restart.prepareProjectWork(f.work.id, input);
    associate(restart, { target: { kind: 'work-conversation', ...target }, assignment: { mode: 'space', spaceId: f.b.id } });
    expect(restart.prepareProjectWork(f.work.id, input)).toEqual(target); expect(restart.spaces().resolve(f.work.id, target.sessionId).spaceId).toBe(f.b.id);
  });
  it('retains approvals and demands review of their changed context', () => {
    const f = fixture(), a = f.m.requestMcpSend(f.work.id, f.x.sessionId, 'Keep this approval'), sibling = f.m.requestMcpSend(f.work.id, f.y.sessionId, 'Sibling');
    const op = associate(f.m, f.change); expect(a).toMatchObject({ status: 'pending', message: 'Keep this approval', contextReview: { operationId: op.id } }); expect(sibling.contextReview).toBeUndefined();
    expect(() => f.m.decideMcpApproval(a.id, true)).toThrow('Review'); expect(a.status).toBe('pending'); expect(f.calls).toHaveLength(0);
    f.m.onModuleDestroy(); const restart = new SessionManager(f.opts); managers.push(restart); restart.setProjectAutomationPauser(f.pause);
    expect(restart.mcpApprovalStatus(a.id)).toMatchObject({ message: a.message, status: 'pending', contextReview: { operationId: op.id } });
    expect(() => restart.decideMcpApproval(a.id, true)).toThrow('Review');
    expect(restart.decideMcpApproval(a.id, false)?.status).toBe('denied');
  });
  it('keeps secondary references outside context, execution rights and Project totals', () => {
    const f = fixture(); f.m.spaces().addReference(f.b.id, { kind: 'work-project', projectId: f.work.id }, f.m.spaces().snapshot().revision, 'reference-work-001');
    expect(f.m.spaces().resolve(f.work.id, f.x.sessionId).spaceId).toBe(f.a.id);
    const v = f.m.projectSpaces().projects.find(s => s.id === f.b.id)!; expect(v.references).toHaveLength(1); expect(v.members).toHaveLength(0);
    expect(() => f.m.fileExecution(f.b.id, f.work.id, f.x.sessionId)).toThrow('outside');
    f.m.archiveProjectSpace(f.b.id, { expectedRevision: v.revision, expectedTopology: f.m.spaces().topology(), operationId: 'archive-ref-001', archived: true });
    expect(f.m.projectContext().resolve(f.work.id, f.x.sessionId).spaceArchived).toBe(false);
  });
  it('detects conflicting tool fingerprints and uses the actual execution directory', () => {
    const f = fixture(); f.m.updateProjectSpace(f.a.id, { expectedRevision: 1, requiredTools: [{ key: 'skill:proposal', fingerprint: 'space-version' }] });
    const service = new ChatCapabilities(f.stateDir, () => f.accounts.list(), undefined as never, undefined as never); f.m.setChatCapabilities(service);
    service.setRequirements(f.work.id, [{ key: 'skill:proposal', fingerprint: 'local-version' }], f.x.sessionId);
    expect(() => f.m.requiredProjectTools(f.work.id, f.x.sessionId)).toThrow('Conflicting');
    expect(f.m.requiredProjectTools(f.work.id, f.y.sessionId)).toEqual([{ key: 'skill:proposal', fingerprint: 'space-version' }]);
    expect(f.m.executionProject(f.work.id).cwd).toBe(f.root);
  });
  it('keeps a queued message when tool requirements change during asynchronous discovery', async () => {
    const f = fixture(); f.m.updateProjectSpace(f.a.id, { expectedRevision: 1, requiredTools: [{ key: 'skill:proposal' }] });
    const service = new ChatCapabilities(f.stateDir, () => f.accounts.list(), undefined as never, undefined as never); f.m.setChatCapabilities(service);
    let release!: (value: Record<string, string[]>) => void; const entered = vi.fn();
    vi.spyOn(service, 'blocked').mockImplementation(() => { entered(); return new Promise(r=>{release=r;}); });
    const q = f.m.enqueue(f.work.id, { sessionId: f.x.sessionId, text: 'Retain during tool discovery' });
    await vi.waitFor(()=>expect(entered).toHaveBeenCalled());
    f.m.updateProjectSpace(f.a.id, { expectedRevision: 2, requiredTools: [{ key: 'skill:revised-proposal' }] }); release({});
    await vi.waitFor(()=>expect(f.m.queues()[f.work.id][0]).toMatchObject({ id:q.id, paused:true, error:expect.stringContaining('Required tools changed') }));
    expect(f.calls).toHaveLength(0);
  });

});
