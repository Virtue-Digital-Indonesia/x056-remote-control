import { mkdtempSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { afterEach, describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import { backupProjectSpaces, restoreProjectSpaces, projectSpacesRecoveryReport } from '../server/project-spaces-recovery.js';
const managers: SessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.onModuleDestroy(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'space-recovery-')), stateDir = join(root, 'state'); mkdirSync(stateDir);
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'account') }]);
  const options = { stateDir, workspaceRoot: root, chatEnabled: true, projectSpacesEnabled: true, runSessionFn: async () => ({ status: 'completed' as const, failovers: 0 }) };
  const m = new SessionManager(options); managers.push(m);
  const parent = m.createProjectSpace({ requestId: 'recovery-parent-001', name: 'Proposal' });
  const chat = m.createChat({ requestId: 'recovery-chat-001', parentProjectId: parent.id });
  return { root, stateDir, options, m, parent, chat };
}
describe('Project spaces backup, rollback and repair reports', () => {
  it('backs up WAL writes and retained originals, then restores all new data at the original state path', async () => {
    const f = fixture(), path = join(f.chat.cwd, 'proposal.txt'); writeFileSync(path, 'Exact original bytes');
    const [file] = await f.m.files().upload(f.chat.id, 'backup-upload-0001', [{ path, name: 'proposal.txt' }]);
    f.m.files().addToProject(f.chat.id, { fileId: file.id, versionId: file.latestVersionId }, f.parent.id, 'backup-copy-0001');
    const memory = f.m.memory().create({ projectId: f.parent.id, status: 'confirmed', scope: 'project', title: 'Brief', content: 'Initial brief', pinned: true });
    expect(existsSync(join(f.stateDir, 'memory.sqlite-wal'))).toBe(true);
    const first = join(f.root, 'before-new-writes'); await backupProjectSpaces(f.stateDir, first, true);
    f.m.memory().update(memory.id, memory.revision, { content: 'New approved brief' });
    f.m.enqueue(f.chat.id, { text: 'Retain this later message', sessionId: f.chat.lastSessionId, paused: true });
    const latest = join(f.root, 'after-new-writes'), manifest = await backupProjectSpaces(f.stateDir, latest, true);
    expect(manifest.databases).toEqual(['chat-files.sqlite','memory.sqlite']);
    expect(() => restoreProjectSpaces(first, f.stateDir)).toThrow('preserve');
    f.m.onModuleDestroy(); f.m.memory().close();
    renameSync(f.stateDir, join(f.root, 'preserved-latest-state'));
    restoreProjectSpaces(latest, f.stateDir);
    const restored = new SessionManager(f.options); managers.push(restored);
    expect(restored.memory().get(memory.id)!.content).toBe('New approved brief');
    expect(restored.queues()[f.chat.id][0].text).toBe('Retain this later message');
    expect(restored.chat(f.chat.id)).toMatchObject({ cwd: f.chat.cwd, lastSessionId: f.chat.lastSessionId, parentProjectId: f.parent.id });
    expect(readFileSync(restored.files().version(f.chat.id, { fileId: file.id, versionId: file.latestVersionId }).path, 'utf8')).toBe('Exact original bytes');
    expect(projectSpacesRecoveryReport(f.stateDir)).toMatchObject({ ready: true, counts: { files: 2, versions: 2, memories: 1, queues: 1 } });
    const old = join(f.root, 'old-rollback-inspection'); restoreProjectSpaces(first, old);
    const db = new DatabaseSync(join(old, 'memory.sqlite'), { readOnly: true });
    expect(JSON.parse(String(db.prepare('SELECT data FROM memory_entries WHERE id=?').get(memory.id)!.data)).content).toBe('Initial brief'); db.close();
  });
  it('disables the hierarchy without downgrading schemas or losing later writes', () => {
    const f = fixture(), memory = f.m.memory().create({ projectId: f.parent.id, status: 'confirmed', scope: 'project', title: 'Parent fact', content: 'Inherited when enabled', pinned: true });
    f.m.onModuleDestroy();
    const off = new SessionManager({ ...f.options, projectSpacesEnabled: false }); managers.push(off);
    expect(off.projectSpaces().enabled).toBe(false); expect(off.chat(f.chat.id).lastSessionId).toBe(f.chat.lastSessionId);
    expect(off.memory().context(f.chat.id, f.chat.lastSessionId!, 'claude', '').items).not.toContainEqual(expect.objectContaining({ id: memory.id }));
    expect(off.memory().get(memory.id)).toBeDefined(); expect(off.listProjects().projects.find(p => p.id === f.chat.id)!.parentProjectId).toBe(f.parent.id);
    expect(() => off.fileExecution(f.parent.id, f.chat.id, f.chat.lastSessionId!)).toThrow('disabled');
  });
  it('reports broken queue and memory references without changing stored data', () => {
    const f = fixture(); f.m.memory().create({ projectId: 'gone', title: 'Retained orphan', content: 'Do not discard' });
    writeFileSync(join(f.stateDir, 'queues.json'), JSON.stringify({ [f.chat.id]: [{ id: 'orphan-queue', sessionId: 'gone', text: 'Retain', fileRefs: [{ fileId: 'gone', versionId: 'gone' }] }] }));
    const before = readFileSync(join(f.stateDir, 'projects.json'));
    const report = projectSpacesRecoveryReport(f.stateDir); expect(report.ready).toBe(false);
    expect(report.issues.map(x => x.store)).toEqual(expect.arrayContaining(['queues','memory']));
    expect(readFileSync(join(f.stateDir, 'projects.json'))).toEqual(before);
  });
  it('requires offline backup and rejects damaged snapshots before creating a restore', async () => {
    const f = fixture(); await expect(backupProjectSpaces(f.stateDir, join(f.root, 'unsafe'), false)).rejects.toThrow('Stop all');
    const snap = join(f.root, 'snapshot'); await backupProjectSpaces(f.stateDir, snap, true); writeFileSync(join(snap, 'projects.json'), '{}');
    expect(() => restoreProjectSpaces(snap, join(f.root, 'restore'))).toThrow('verification'); expect(existsSync(join(f.root, 'restore'))).toBe(false);
  });
});
