import { createRequire } from 'node:module';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectRegistry } from '../server/projects.js';
import { MemoryStore } from '../server/memory-store.js';
import { FileStore } from '../server/file-store.js';
import { ProjectSpaceRegistry, type ReviewedSpaceImport } from '../server/project-space-registry.js';
import { applySpaceMigration, inspectSpaceMigration, type SpaceMigrationPlan } from '../server/project-space-migration.js';
import { backupProjectSpaces, restoreProjectSpaces } from '../server/project-spaces-recovery.js';

const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); });
function fixture(firstBuild = true) {
  const state = mkdtempSync(join(tmpdir(), 'space-migration-')), file = join(state, 'projects.json');
  const projects = () => ProjectRegistry.load(file), reg = projects();
  const work = firstBuild ? reg.createSpace({ requestId: 'original-project', name: 'Proposal', cwd: state }) : reg.create('Legacy Work', state);
  reg.addConversation(work.id, 'work-session', 'Keep session', 'codex'); reg.setProviderSessionId(work.id, 'work-session', 'provider-thread');
  reg.createChat({ id: 'chat', kind: 'chat', name: 'Chat', cwd: state, lastSessionId: 'chat-session', ...(firstBuild ? { parentProjectId: work.id } : {}), conversations: [{ sessionId: 'chat-session', title: 'Chat', createdAt: 1 }] });
  const memory = new MemoryStore(state); close.push(() => memory.close());
  const repoNote = memory.create({ projectId: work.id, title: 'Repository convention', content: 'Keep original local scope', status: 'confirmed' });
  const brief = memory.create({ projectId: work.id, title: 'Reviewed brief', content: 'Project proposal', status: 'confirmed' });
  const conversation = memory.create({ projectId: work.id, sessionId: 'work-session', scope: 'conversation', title: 'Private session', content: 'Do not broaden' });
  const source = memory.ingest({ key: 'legacy-doc', kind: 'document', projectId: work.id, content: 'Original source', title: 'Source', at: 1 }).source;
  const store = new FileStore(state, id => projects().get(id)!); close.push(() => store.close());
  const spaces = new ProjectSpaceRegistry(state, () => projects().list());
  return { state, file, projects, work, memory, repoNote, brief, conversation, source, store, spaces };
}
function plan(f: ReturnType<typeof fixture>): SpaceMigrationPlan {
  const report = inspectSpaceMigration(f.state), c = report.candidates.find(c => c.projectId === f.work.id)!;
  const spaceId = 'space_reviewed-proposal';
  const item: ReviewedSpaceImport = { legacyProjectId: c.projectId, spaceId, includeWork: c.hasWork,
    memoryOwners: { [f.repoNote.id]: { kind: 'execution', id: f.work.id }, [f.brief.id]: { kind: 'space', id: spaceId } },
    sourceOwners: { [f.source.id]: { kind: 'space', id: spaceId } }, fileIds: c.fileIds };
  return { operationId: 'reviewed-migration-001', fingerprint: report.fingerprint, expectedRevision: report.revision, expectedTopology: report.topology, imports: [item] };
}
describe('Reviewed Project migration', () => {
  it('retains registry receipts, owner mappings and extraction artifacts through WAL-safe backup and restoration', async () => {
    const f = fixture(), reviewed = plan(f); applySpaceMigration(f.state, reviewed);
    mkdirSync(join(f.state, 'memory-extractions')); writeFileSync(join(f.state, 'memory-extractions', 'retained.txt'), 'Exact indexed text');
    const root = mkdtempSync(join(tmpdir(), 'space-migration-backup-')), snapshot = join(root, 'snapshot'), restored = join(root, 'restored');
    await backupProjectSpaces(f.state, snapshot, true); restoreProjectSpaces(snapshot, restored);
    const registry = new ProjectSpaceRegistry(restored, () => ProjectRegistry.load(join(restored, 'projects.json')).list());
    expect(registry.snapshot()).toEqual(f.spaces.snapshot());
    expect(registry.pending()[0].kind).toBe('migration');
    expect(readFileSync(join(restored, 'memory-extractions', 'retained.txt'), 'utf8')).toBe('Exact indexed text');
  });
  it('leaves production Work and Chat unassigned without inferring membership or changing legacy records', () => {
    const f = fixture(false), before = readFileSync(f.file, 'utf8'), original = f.memory.get(f.repoNote.id);
    const report = inspectSpaceMigration(f.state);
    expect(report.requiresReview).toBe(false); expect(report.candidates[0].requiresMapping).toBe(false);
    expect(f.spaces.list()).toEqual([]); expect(f.spaces.resolve(f.work.id, 'work-session').spaceId).toBeUndefined();
    expect(readFileSync(f.file, 'utf8')).toBe(before); expect(f.memory.get(f.repoNote.id)).toEqual(original);
  });
  it('does not mistake new Work-local file ownership for first-build Space data',async()=>{
    const f=fixture(false),path=join(f.state,'local.txt');writeFileSync(path,'Work-local file');await f.store.upload(f.work.id,'work-file-type-001',[{path,name:'local.txt'}]);
    expect(inspectSpaceMigration(f.state).requiresReview).toBe(false);expect(f.store.list(f.work.id)[0].owner).toEqual({kind:'work',id:f.work.id});
  });
  it('requires an explicit owner decision and retains files, sessions and original note/source identities after migration', async () => {
    const f = fixture(), path = join(f.state, 'original.txt'); writeFileSync(path, 'Original bytes');
    const [saved] = await f.store.upload(f.work.id, 'migration-upload-001', [{ path, name: 'Original.txt' }]);
    // Materialize the original v1 file-owner marker, not a new Work-local file.
    const legacyDb=new DatabaseSync(join(f.state,'chat-files.sqlite'));legacyDb.prepare("UPDATE files SET ownerKind='project' WHERE id=?").run(saved.id);legacyDb.close();
    const reviewed = plan(f), before = readFileSync(f.file, 'utf8');
    const incomplete = structuredClone(reviewed); delete incomplete.imports[0].memoryOwners[f.brief.id];
    expect(() => applySpaceMigration(f.state, incomplete)).toThrow('every ambiguous'); expect(f.spaces.list()).toHaveLength(0);
    const op = applySpaceMigration(f.state, reviewed), id = reviewed.imports[0].spaceId;
    expect(op.state).toBe('pending'); expect(f.spaces.get(f.work.id).id).toBe(id);
    expect(f.spaces.resolve('chat', 'chat-session').spaceId).toBe(id); expect(f.spaces.resolve(f.work.id, 'work-session').spaceId).toBe(id);
    expect(f.spaces.snapshot().ownerOverrides).toMatchObject({ memory: { [f.repoNote.id]: { kind: 'execution', id: f.work.id }, [f.brief.id]: { kind: 'space', id } }, file: { [saved.id]: id } });
    expect(f.spaces.snapshot().ownerOverrides.memory[f.conversation.id]).toBeUndefined();
    expect(f.memory.get(f.repoNote.id)?.projectId).toBe(f.work.id); expect(f.memory.source(f.source.id)?.hash).toBe(f.source.hash);
    expect(readFileSync(f.store.version(f.work.id, { fileId: saved.id, versionId: saved.latestVersionId }).path, 'utf8')).toBe('Original bytes');
    expect(readFileSync(f.file, 'utf8')).toBe(before);
    f.memory.update(f.brief.id, f.brief.revision, { content: 'Later write' });
    expect(applySpaceMigration(f.state, reviewed)).toEqual(op); expect(f.spaces.list()).toHaveLength(1);
    const changed = structuredClone(reviewed); changed.imports[0].memoryOwners[f.repoNote.id] = { kind: 'space', id };
    expect(() => applySpaceMigration(f.state, changed)).toThrow('Migration ID');
  });
  it('rejects a stale review and unrelated owner mappings without partial writes', () => {
    const f = fixture(), reviewed = plan(f); f.memory.update(f.brief.id, f.brief.revision, { content: 'Changed before apply' });
    expect(() => applySpaceMigration(f.state, reviewed)).toThrow('State changed'); expect(f.spaces.list()).toEqual([]);
    const fresh = plan(f); fresh.imports[0].memoryOwners[f.brief.id] = { kind: 'execution', id: 'unrelated' };
    expect(() => applySpaceMigration(f.state, fresh)).toThrow('unrelated'); expect(f.spaces.list()).toEqual([]);
  });
  it('preserves archived Work and empty first-build Spaces without inventing workspaces', () => {
    const f = fixture(), reg = f.projects(); reg.updateSpace(f.work.id, reg.get(f.work.id)!.revision!, { archivedAt: 1 });
    const empty = reg.createSpace({ requestId: 'empty-original-001', name: 'Empty' });
    const reviewed = plan(f); reviewed.imports.push({ legacyProjectId: empty.id, spaceId: 'space_empty-original', includeWork: false, memoryOwners: {}, sourceOwners: {}, fileIds: [] });
    const op = applySpaceMigration(f.state, reviewed);
    expect(op.state).toBe('pending'); expect(f.spaces.resolve(f.work.id, 'work-session').archived).toBe(true);
    expect(f.spaces.get(empty.id).id).toBe('space_empty-original'); expect(f.projects().get(empty.id)?.cwd).toBeUndefined();
    expect(f.spaces.members('space_empty-original')).toEqual([]);
  });
});
