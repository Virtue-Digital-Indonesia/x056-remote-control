import { moveChat } from './project-space-fixture.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../server/projects.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions } from '../src/failover.js';

const managers: SessionManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.onModuleDestroy(); });
function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'rc-spaces-')), stateDir = join(root, 'state'), workspaceRoot = join(root, 'workspace');
  mkdirSync(stateDir); mkdirSync(workspaceRoot);
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'a') }]);
  const calls: RunSessionOptions[] = [];
  const opts = { stateDir, workspaceRoot, chatEnabled: true, projectSpacesEnabled: enabled,
    runSessionFn: async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed' as const, finalAccount: 'a', failovers: 0 }; } };
  const manager = new SessionManager(opts); managers.push(manager); manager.setProjectAutomationPauser(() => {});
  return { root, stateDir, workspaceRoot, calls, opts, manager, file: join(stateDir, 'projects.json') };
}

describe('Project spaces contracts and migration', () => {
  it('creates a Git workspace and first Work once, including after restart', () => {
    const f=fixture(),space=f.manager.createProjectSpace({requestId:'new-work-parent',name:'Fresh project'});
    const input={requestId:'new-work-request',name:'Fresh work',folder:'fresh-work',provider:'claude' as const};
    const created=f.manager.createSpaceWorkspace(space.id,input);
    expect(execFileSync('git',['-C',created.cwd,'symbolic-ref','HEAD'],{encoding:'utf8'}).trim()).toBe('refs/heads/main');
    expect(f.manager.projectContext().resolve(created.projectId,created.sessionId).spaceId).toBe(space.id);
    expect(f.manager.createSpaceWorkspace(space.id,input)).toEqual(created);
    const restarted=new SessionManager(f.opts);managers.push(restarted);restarted.setProjectAutomationPauser(()=>{});
    expect(restarted.createSpaceWorkspace(space.id,input)).toEqual(created);
    expect(restarted.executionProject(created.projectId).conversations).toHaveLength(1);
    expect(f.calls).toHaveLength(0);
    expect(()=>restarted.createSpaceWorkspace(space.id,{...input,folder:'different'})).toThrow('changed');
  });
  it('rejects traversal, existing folders and symlinks without touching their contents', () => {
    const f=fixture(),space=f.manager.createProjectSpace({requestId:'safe-work-parent',name:'Project'});
    mkdirSync(join(f.workspaceRoot,'existing'));writeFileSync(join(f.workspaceRoot,'existing','keep'),'preserved');symlinkSync(f.root,join(f.workspaceRoot,'linked'));
    for(const folder of ['../escape','/tmp/escape','nested/path','.git','existing','linked'])expect(()=>f.manager.createSpaceWorkspace(space.id,{requestId:'safe-'+folder.replace(/[^a-z]/g,'x'),name:'New',folder})).toThrow();
    expect(readFileSync(join(f.workspaceRoot,'existing','keep'),'utf8')).toBe('preserved');
  });
  it('resumes a partial creation without a duplicate repository or conversation', () => {
    const f=fixture(),space=f.manager.createProjectSpace({requestId:'resume-work-parent',name:'Project'});
    const input={requestId:'resume-work-create',name:'Recoverable',folder:'recoverable',provider:'claude' as const};
    const prepare=f.manager.prepareProjectWork.bind(f.manager);
    f.manager.prepareProjectWork=()=>{throw new Error('Interrupted');};
    expect(()=>f.manager.createSpaceWorkspace(space.id,input)).toThrow('Interrupted');
    f.manager.prepareProjectWork=prepare;
    const result=f.manager.createSpaceWorkspace(space.id,input);
    expect(ProjectRegistry.load(f.file).list().filter(p=>p.cwd===result.cwd)).toHaveLength(1);
    expect(f.manager.executionProject(result.projectId).conversations).toHaveLength(1);
  });
  it('rejects invalid provider preferences before creating a folder', () => {
    const f=fixture(),space=f.manager.createProjectSpace({requestId:'invalid-work-parent',name:'Project'});
    expect(()=>f.manager.createSpaceWorkspace(space.id,{requestId:'invalid-work-create',name:'Invalid',folder:'invalid',provider:'claude',model:'gpt-6-astra'})).toThrow();
    expect(existsSync(join(f.workspaceRoot,'invalid'))).toBe(false);
  });
  it('migrates legacy records without changing identities, sessions, selections or cwd; rerunning is byte-stable', () => {
    const f = fixture(), work = f.manager.createProject('Work'), chat = f.manager.createChat({ requestId: 'legacy-chat-001' });
    let reg = ProjectRegistry.load(f.file);
    reg.addConversation(work.id, 'legacy-session', 'Original', 'codex');
    reg.setProviderSessionId(work.id, 'legacy-session', 'provider-session');
    reg.setConversationPrefs(work.id, 'legacy-session', { model: 'gpt-6-astra', effort: 'xhigh' });
    const before = reg.list();
    const dry = reg.migrateSpaces();
    expect(dry.invalidParents).toEqual([]); expect(dry.chats).toBe(1);
    expect(reg.list()).toEqual(before);
    reg.migrateSpaces(true);
    const bytes = readFileSync(f.file, 'utf8');
    reg = ProjectRegistry.load(f.file); reg.migrateSpaces(true);
    expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    for (const p of before) expect(reg.get(p.id)).toMatchObject(p);
    expect(reg.get(chat.id)?.parentProjectId).toBeUndefined();
    expect(reg.get(work.id)?.conversations?.[0].providerSessionId).toBe('provider-session');
  });

  it('supports an empty Project while all execution entrypoints reject missing workspaces', () => {
    const f = fixture(), input = { requestId: 'empty-project-001', name: 'Proposal' };
    const p = f.manager.createProjectSpace(input);
    expect(f.manager.createProjectSpace(input).id).toBe(p.id);
    expect(() => f.manager.createProjectSpace({ ...input, name: 'Different' })).toThrow('requestId');
    expect(p).not.toHaveProperty('cwd');
    expect(f.manager.projectSpaces().projects.find(x => x.id === p.id)?.workspaceConfigured).toBe(false);
    expect(() => f.manager.start('hello', undefined, undefined, p.id)).toThrow('Unknown project');
    expect(() => f.manager.start('hello', f.workspaceRoot, undefined, p.id)).toThrow('Unknown project');
    expect(() => f.manager.continueSession(p.id, 'arbitrary', 'hello')).toThrow('Unknown project');
    expect(() => f.manager.resumeExisting(p.id, 'legacy')).toThrow('Unknown project');
    expect(f.manager.listAvailableSessions(p.id)).toEqual([]);
    expect(f.manager.listConversations(p.id)).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  it('persists retryable membership receipts and rejects invalid or stale parents without changing execution identity', () => {
    const f = fixture(), parent = ProjectRegistry.load(f.file).createSpace({ requestId: 'parent-space-001', name: 'Proposal' });
    const chat = f.manager.createChat({ requestId: 'member-chat-001' }), other = f.manager.createChat({ requestId: 'member-chat-002' });
    const reg = ProjectRegistry.load(f.file);
    expect(() => reg.moveChat(chat.id, 'missing', 0, 'move-0001')).toThrow('Project');
    expect(() => reg.moveChat(chat.id, other.id, 0, 'move-0001')).toThrow('Project');
    expect(() => reg.moveChat(parent.id, chat.id, 0, 'move-0001')).toThrow('Chat');
    const op = reg.moveChat(chat.id, parent.id, 0, 'move-0001');
    expect(reg.get(chat.id)).toMatchObject({ ...JSON.parse(JSON.stringify(chat)), parentProjectId: parent.id, membershipRevision: 1 });
    const restart = ProjectRegistry.load(f.file);
    expect(restart.moveChat(chat.id, parent.id, 0, 'move-0001')).toEqual(op);
    expect(restart.pendingMembershipOperations()).toEqual([op]);
    expect(() => restart.moveChat(chat.id, null, 0, 'move-0002')).toThrow('changed');
    expect(() => restart.moveChat(chat.id, null, 1, 'move-0001')).toThrow('operationId');
    expect(() => restart.remove(parent.id)).toThrow('Archive');
    restart.completeMembershipOperation(op.id);
    expect(ProjectRegistry.load(f.file).pendingMembershipOperations()).toEqual([]);
  });

  it('feature disable preserves new data and standalone access but exposes no inherited aggregate API', () => {
    const f = fixture(), p = f.manager.createProjectSpace({ requestId: 'flag-project-001', name: 'Proposal' });
    const chat = f.manager.createChat({ requestId: 'flag-chat-001' });
    moveChat(f.manager, chat.id, p.id, 'flag-move-001');
    const bytes = readFileSync(f.file, 'utf8');
    const disabled = new SessionManager({ ...f.opts, projectSpacesEnabled: false }); managers.push(disabled);
    expect(disabled.projectSpaces()).toMatchObject({ enabled: false, projects: [] });
    expect(disabled.chat(chat.id).cwd).toBe(chat.cwd);
    expect(() => disabled.createProjectSpace({ requestId: 'flag-project-002', name: 'Blocked' })).toThrow('disabled');
    expect(readFileSync(f.file, 'utf8')).toBe(bytes);
  });

  it('reports broken references and parents; corrupt registry cannot be silently overwritten', () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ current: 'broken', projects: [{ id: 'broken', name: 'Broken', kind: 'chat', parentProjectId: 'missing', references: [{ projectId: 'gone', sessionId: 'gone' }] }] }));
    const reg = ProjectRegistry.load(f.file), report = reg.migrateSpaces();
    expect(report.invalidParents).toEqual(['broken']); expect(report.missingWorkspaces).toEqual(['broken']);
    expect(report.brokenReferences).toHaveLength(1);
    expect(() => reg.migrateSpaces(true)).toThrow('invalid');
    writeFileSync(f.file, '{broken');
    expect(() => ProjectRegistry.load(f.file)).toThrow('repair');
    expect(readFileSync(f.file, 'utf8')).toBe('{broken');
  });

  it('returns independent snapshots and detects stale settings updates', () => {
    const f = fixture(), reg = ProjectRegistry.load(f.file), p = reg.createSpace({ requestId: 'settings-project-001', name: 'Proposal' });
    reg.updateSpace(p.id, 1, { name: 'Renamed', defaults: { chat: { provider: 'codex' } } });
    expect(() => reg.updateSpace(p.id, 1, { name: 'Stale' })).toThrow('changed');
    const snapshot = reg.get(p.id)!; snapshot.defaults!.chat!.provider = 'claude';
    expect(reg.get(p.id)?.defaults?.chat?.provider).toBe('codex');
    reg.rename(p.id, 'Legacy API rename');
    expect(() => reg.updateSpace(p.id, 2, { name: 'Stale' })).toThrow('changed');
  });
});
