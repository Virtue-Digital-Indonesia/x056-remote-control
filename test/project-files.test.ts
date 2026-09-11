import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../server/manager.js';
import { ProjectRegistry } from '../server/projects.js';
import { FileStore } from '../server/file-store.js';
import { ArtifactStore } from '../server/workspace-store.js';
import { documentCommand } from '../server/documents.js';

const managers: SessionManager[] = [], stores: FileStore[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.onModuleDestroy(); for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-files-')), stateDir = join(root, 'state'), workspaceRoot = join(root, 'work');
  mkdirSync(stateDir); mkdirSync(workspaceRoot);
  const opts = { stateDir, workspaceRoot, chatEnabled: true, projectSpacesEnabled: true };
  const m = new SessionManager(opts); managers.push(m);
  const parent = m.createProjectSpace({ requestId: 'files-parent-001', name: 'Proposal', cwd: workspaceRoot });
  const a = m.createChat({ requestId: 'files-chat-001' }), b = m.createChat({ requestId: 'files-chat-002' });
  const registry = () => ProjectRegistry.load(join(stateDir, 'projects.json'));
  registry().moveChat(a.id, parent.id, 0, 'files-move-001'); registry().moveChat(b.id, parent.id, 0, 'files-move-002');
  registry().addConversation(parent.id, 'work-session', 'Work');
  const source = join(root, 'original.txt'); writeFileSync(source, 'Original proposal');
  return { root, stateDir, workspaceRoot, opts, m, parent, a, b, registry, source, store: m.files() };
}
const reference = (file: { id: string; latestVersionId: string }) => ({ fileId: file.id, versionId: file.latestVersionId });
const commit = (token: string, base: string, operationId: string) => ({ checkoutToken: token, expectedBaseVersionId: base, operationId });

describe('Project file lineage and execution leases', () => {
  it('creates an independent Project lineage from an exact private version and reuses immutable bytes', async () => {
    const f = fixture();
    const [file] = await f.store.upload(f.a.id, 'private-upload-001', [{ path: f.source, name: '提案.txt' }]);
    const shared = f.store.addToProject(f.a.id, reference(file), f.parent.id, 'shared-copy-001');
    expect(f.store.addToProject(f.a.id, reference(file), f.parent.id, 'shared-copy-001').id).toBe(shared.id);
    expect(shared.id).not.toBe(file.id); expect(shared.versions[0].id).not.toBe(file.versions[0].id);
    expect(shared.versions[0].blob).toBe(file.versions[0].blob);
    expect(shared).toMatchObject({ ownerKind: 'project', sourceOwnerId: f.a.id, sourceFileId: file.id, sourceVersionId: file.latestVersionId });
    const checkout = f.store.checkout(f.a.id, reference(file)); writeFileSync(checkout.path, 'Private revision');
    await f.store.commit(f.a.id, file.id, commit(checkout.token, file.latestVersionId, 'private-edit-001'));
    expect(readFileSync(f.store.version(f.parent.id, reference(shared)).path, 'utf8')).toBe('Original proposal');
    expect(f.store.file(f.parent.id, shared.id).versions).toHaveLength(1);
  });

  it('fences only the failed execution; a sibling checkout stays valid and conflicting versions cannot overwrite', async () => {
    const f = fixture(), [one, two] = await f.store.upload(f.parent.id, 'shared-upload-001', [{ path: f.source, name: 'one.txt' }, { path: f.source, name: 'two.txt' }]);
    const a = f.store.checkoutShared(f.parent.id, reference(one), f.a.id, f.a.lastSessionId!);
    const b = f.store.checkoutShared(f.parent.id, reference(two), f.b.id, f.b.lastSessionId!);
    writeFileSync(a.path, 'Stale A'); writeFileSync(b.path, 'Valid B');
    f.store.fenceExecution(f.a.id, f.a.lastSessionId!);
    await expect(f.store.commit(f.parent.id, one.id, commit(a.token, one.latestVersionId, 'stale-commit-001'))).rejects.toThrow('previous execution');
    const saved = await f.store.commit(f.parent.id, two.id, commit(b.token, two.latestVersionId, 'valid-commit-001'));
    expect(saved.versions).toHaveLength(2);
    expect(saved.versions[1]).toMatchObject({ sourceProjectId: f.b.id, sourceSessionId: f.b.lastSessionId });
    const competing = f.store.checkoutShared(f.parent.id, reference(saved), f.a.id, f.a.lastSessionId!);
    const work = f.store.checkoutShared(f.parent.id, reference(saved), f.parent.id, 'work-session');
    writeFileSync(competing.path, 'Chat edit'); writeFileSync(work.path, 'Work edit');
    await f.store.commit(f.parent.id, two.id, commit(work.token, saved.latestVersionId, 'work-commit-001'));
    await expect(f.store.commit(f.parent.id, two.id, commit(competing.token, saved.latestVersionId, 'conflict-commit-001'))).rejects.toThrow('newer version');
    expect(f.store.file(f.parent.id, two.id).versions).toHaveLength(3);
  });

  it('revalidates membership at attachment and commit, including after an async file snapshot', async () => {
    const f = fixture(), [file] = await f.store.upload(f.parent.id, 'shared-upload-002', [{ path: f.source, name: 'proposal.txt' }]);
    const copy = f.store.checkoutShared(f.parent.id, reference(file), f.a.id, f.a.lastSessionId!);
    const saving = f.store.commit(f.parent.id, file.id, commit(copy.token, file.latestVersionId, 'membership-save-001'));
    f.registry().moveChat(f.a.id, null, 1, 'detach-files-001');
    await expect(saving).rejects.toThrow('outside');
    expect(f.store.file(f.parent.id, file.id).versions).toHaveLength(1);
    expect(() => f.store.references(f.a.id, f.a.lastSessionId!, [{ ...reference(file), ownerId: f.parent.id }])).toThrow('outside');
    f.registry().moveChat(f.a.id, f.parent.id, 2, 'reattach-files-001');
    await expect(f.store.commit(f.parent.id, file.id, commit(copy.token, file.latestVersionId, 'membership-save-002'))).rejects.toThrow('previous execution or membership');
  });

  it('fences idle checkouts after restart, preserves download history, and restores through a new saved version', async () => {
    const f = fixture(), [file] = await f.store.upload(f.parent.id, 'shared-upload-003', [{ path: f.source, name: 'proposal.txt' }]);
    const old = f.store.checkoutShared(f.parent.id, reference(file), f.a.id, f.a.lastSessionId!);
    f.m.onModuleDestroy(); managers.splice(managers.indexOf(f.m), 1);
    const restarted = new SessionManager(f.opts); managers.push(restarted);
    const store = restarted.files();
    await expect(store.commit(f.parent.id, file.id, commit(old.token, file.latestVersionId, 'restart-save-001'))).rejects.toThrow('previous execution');
    store.setRemoved(f.parent.id, file.id, true);
    expect(readFileSync(store.version(f.parent.id, reference(file)).path, 'utf8')).toBe('Original proposal');
    expect(() => store.checkoutShared(f.parent.id, reference(file), f.b.id, f.b.lastSessionId!)).toThrow('Restore');
    store.setRemoved(f.parent.id, file.id, false);
    const restored = await store.restore(f.parent.id, file.id, { versionId: file.latestVersionId, expectedBaseVersionId: file.latestVersionId, operationId: 'restore-file-001' });
    expect(restored.versions).toHaveLength(2); expect(restored.latestVersionId).not.toBe(file.latestVersionId);
    expect(restored.versions[1].hash).toBe(file.versions[0].hash);
  });

  it('imports only the selected retained Work output with its provenance', async () => {
    const f = fixture(), output = join(f.workspaceRoot, 'output.txt'); writeFileSync(output, 'Work result');
    const library = new ArtifactStore(f.stateDir, () => [f.workspaceRoot]);
    const artifact = library.add({ projectId: f.parent.id, sessionId: 'work-session', title: 'output.txt', kind: 'file', source: 'manual', path: output });
    const file = await f.store.importArtifact(f.parent.id, f.parent.id, 'work-session', artifact.id, 'work-import-001');
    expect(file.sourceArtifactId).toBe(artifact.id); expect(file.sourceOwnerId).toBe(f.parent.id);
    expect((await f.store.importArtifact(f.parent.id, f.parent.id, 'work-session', artifact.id, 'work-import-001')).id).toBe(file.id);
    await expect(f.store.importArtifact(f.parent.id, f.parent.id, 'work-session', output, 'work-import-002')).rejects.toThrow('retained output');
  });

  it.skipIf(!existsSync('/opt/rc-documents/bin/python'))('preserves DOCX originals through Chat and Work editing and persistent preview', async () => {
    const f = fixture(), path = join(f.root, 'proposal.docx'), spec = join(f.root, 'spec.json');
    writeFileSync(spec, JSON.stringify({ title: 'Proposal', paragraphs: ['Original scope'], tables: [[['Item', 'Price'], ['Service', '100']]] }));
    await documentCommand('create', path, spec);
    const original = readFileSync(path), [privateFile] = await f.store.upload(f.a.id, 'docx-upload-001', [{ path, name: 'proposal.docx' }]);
    const shared = f.store.addToProject(f.a.id, reference(privateFile), f.parent.id, 'docx-share-001');
    let current = shared;
    for (const [pid, sid, from, to, op] of [[f.a.id, f.a.lastSessionId!, 'Original', 'Chat', 'docx-edit-001'], [f.parent.id, 'work-session', 'Chat', 'Work', 'docx-edit-002']]) {
      const copy = f.store.checkoutShared(f.parent.id, reference(current), pid, sid);
      writeFileSync(spec, JSON.stringify({ replacements: [{ find: from + ' scope', replace: to + ' scope' }] }));
      await documentCommand('edit', copy.path, spec);
      current = await f.store.commit(f.parent.id, current.id, commit(copy.token, current.latestVersionId, op));
    }
    expect(current.versions).toHaveLength(3);
    expect(readFileSync(f.store.version(f.a.id, reference(privateFile)).path)).toEqual(original);
    expect(readFileSync(f.store.version(f.parent.id, reference(shared)).path)).toEqual(original);
    const inspected = await documentCommand('inspect', f.store.version(f.parent.id, reference(current)).path);
    expect(JSON.stringify(inspected)).toContain('Work scope');
    let preview = f.store.preview(f.parent.id, reference(current));
    const deadline = Date.now() + 45000;
    while (['queued', 'running'].includes(preview.state) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50)); preview = f.store.preview(f.parent.id, reference(current));
    }
    expect(preview.state, preview.error || '').toBe('ready');
    expect(f.store.previewOutput(f.parent.id, reference(current), 0).mime).toBe('application/pdf');
  }, 60000);
});
