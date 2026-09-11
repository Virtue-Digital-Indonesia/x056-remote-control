import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../server/file-store.js';
import type { RunnableProject } from '../server/projects.js';
const stores: FileStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'rc-files-'));
  const chat: RunnableProject = { id: 'chat-a', kind: 'chat', name: 'Chat', cwd: join(state, 'work'), lastSessionId: 'session-a' };
  mkdirSync(chat.cwd);
  const owner = (id: string) => { if (id !== chat.id) throw new Error('unknown Chat'); return chat; };
  const store = new FileStore(state, owner); stores.push(store);
  const source = join(state, 'source.txt'); writeFileSync(source, 'original');
  return { state, chat, owner, store, source };
}

describe('Chat file versions', () => {
  it('commits byte-exact uploads once, preserving duplicate Unicode names independently', async () => {
    const f = fixture(), uploads = [{ path: f.source, name: '提案.txt' }, { path: f.source, name: '提案.txt' }];
    const files = await f.store.upload(f.chat.id, 'upload-001', uploads);
    expect(files).toHaveLength(2); expect(files[0].id).not.toBe(files[1].id);
    expect((await f.store.upload(f.chat.id, 'upload-001', uploads)).map(f => f.id)).toEqual(files.map(f => f.id));
    const reopened = new FileStore(f.state, f.owner); stores.push(reopened);
    const ref = { fileId: files[0].id, versionId: files[0].latestVersionId };
    expect(readFileSync(reopened.version(f.chat.id, ref).path, 'utf8')).toBe('original');
    await expect(f.store.upload(f.chat.id, 'upload-001', [{ path: f.source, name: 'different.txt' }])).rejects.toThrow('different input');
    expect(() => f.store.version(f.chat.id, { ...ref, fileId: 'missing' })).toThrow('not found');
    expect(() => f.store.references(f.chat.id, 'wrong-session', [ref])).toThrow('association');
  });
  it('keeps earlier versions and rejects stale commits and old-run checkouts', async () => {
    const f = fixture(), [file] = await f.store.upload(f.chat.id, 'upload-002', [{ path: f.source, name: 'proposal.txt' }]);
    const ref = { fileId: file.id, versionId: file.latestVersionId };
    const a = f.store.checkout(f.chat.id, ref), b = f.store.checkout(f.chat.id, ref);
    writeFileSync(a.path, 'revised');
    const input = { checkoutToken: a.token, expectedBaseVersionId: ref.versionId, operationId: 'edit-0001' };
    const updated = await f.store.commit(f.chat.id, file.id, input);
    expect(updated.versions).toHaveLength(2);
    expect((await f.store.commit(f.chat.id, file.id, input)).versions).toHaveLength(2);
    expect(readFileSync(f.store.version(f.chat.id, ref).path, 'utf8')).toBe('original');
    expect(readFileSync(f.store.version(f.chat.id, { ...ref, versionId: updated.latestVersionId }).path, 'utf8')).toBe('revised');
    await expect(f.store.commit(f.chat.id, file.id, { ...input, checkoutToken: b.token, operationId: 'edit-0002' })).rejects.toThrow('newer version');
    const c = f.store.checkout(f.chat.id, { ...ref, versionId: updated.latestVersionId });
    f.store.fence(f.chat.id);
    await expect(f.store.commit(f.chat.id, file.id, { checkoutToken: c.token, expectedBaseVersionId: updated.latestVersionId, operationId: 'edit-0003' })).rejects.toThrow('previous run');
  });
  it('rejects traversal, symlinks, malformed text, and a partial batch', async () => {
    const f = fixture();
    await expect(f.store.upload(f.chat.id, 'upload-003', [{ path: f.source, name: '../secret.txt' }])).rejects.toThrow('filename');
    writeFileSync(f.source, '{bad json');
    await expect(f.store.upload(f.chat.id, 'upload-004', [{ path: f.source, name: 'ok.txt' }, { path: f.source, name: 'bad.json' }])).rejects.toThrow('JSON');
    expect(f.store.list(f.chat.id)).toHaveLength(0);
    const link = join(f.state, 'link'); symlinkSync(f.source, link);
    await expect(f.store.upload(f.chat.id, 'upload-005', [{ path: link, name: 'link.txt' }])).rejects.toThrow();
  });
});
