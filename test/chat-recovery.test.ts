import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStore } from '../server/file-store.js';
import type { Project } from '../server/projects.js';
import { documentCommand } from '../server/documents.js';
vi.mock('../server/documents.js', () => ({ DOCUMENT_CONVERTER: 'test-converter', documentCommand: vi.fn() }));
const stores: FileStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.clearAllMocks(); });
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'chat-recovery-'));
  const chat: Project = { id: 'chat', kind: 'chat', name: 'Chat', cwd: join(state, 'work'), lastSessionId: 'session' };
  mkdirSync(chat.cwd);
  const owner = () => chat, store = new FileStore(state, owner); stores.push(store);
  const source = join(state, 'source.pdf'); writeFileSync(source, '%PDF-1.4\nfixture');
  return { state, chat, source, store, owner };
}
function converter() {
  vi.mocked(documentCommand).mockImplementation(async (_command, path, dir) => {
    const page = join(dir, 'page-1.png');
    writeFileSync(page, Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
    return { pdf: path, pages: [page] };
  });
}
describe('Chat file recovery', () => {
  it('keeps queued references and saved versions when a file is removed or restored', async () => {
    const f = fixture(), [file] = await f.store.upload('chat', 'upload-one', [{ path: f.source, name: 'proposal.pdf' }]);
    const ref = { fileId: file.id, versionId: file.latestVersionId };
    f.store.references('chat', 'session', [ref], 'queued-message');
    expect(f.store.setRemoved('chat', file.id, true).removed).toBe(true);
    expect(() => f.store.checkout('chat', ref)).toThrow('Restore this file');
    expect(readFileSync(f.store.version('chat', ref).path)).toEqual(readFileSync(f.source));
    f.store.setRemoved('chat', file.id, false);
    expect(f.store.checkout('chat', ref).versionId).toBe(ref.versionId);
    const path = f.store.version('chat', ref).path;
    expect(statSync(path).mode & 0o222).toBe(0);
    chmodSync(path, 0o600); // Simulate damage outside the file service.
    const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
    expect(() => f.store.version('chat', ref)).toThrow('damaged');
  });
  it('rejects publication when failover occurs while a working copy is being validated', async () => {
    const f = fixture(), [file] = await f.store.upload('chat', 'upload-two', [{ path: f.source, name: 'proposal.pdf' }]);
    const ref = { fileId: file.id, versionId: file.latestVersionId }, checkout = f.store.checkout('chat', ref);
    writeFileSync(checkout.path, '%PDF-1.4\nrevised');
    let resume!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const prepare = (f.store as any).prepare.bind(f.store);
    vi.spyOn(f.store as any, 'prepare').mockImplementation(async (...args: any[]) => { const result = await prepare(...args); entered(); await gate; return result; });
    const input = { checkoutToken: checkout.token, operationId: 'interrupted-edit', expectedBaseVersionId: ref.versionId };
    const saving = f.store.commit('chat', file.id, input);
    await started; f.store.fence('chat'); resume();
    await expect(saving).rejects.toThrow('previous run');
    const restarted = new FileStore(f.state, f.owner); stores.push(restarted); restarted.fence('chat');
    expect(restarted.file('chat', file.id).versions).toHaveLength(1);
    await expect(restarted.commit('chat', file.id, input)).rejects.toThrow('interrupted');
    expect(readFileSync(restarted.version('chat', ref).path)).toEqual(readFileSync(f.source));
  });
  it('recovers an unfinished preview, shares cached output by hash, and preserves downloads after conversion failure', async () => {
    const f = fixture(), [file] = await f.store.upload('chat', 'upload-three', [{ path: f.source, name: 'proposal.pdf' }]);
    const ref = { fileId: file.id, versionId: file.latestVersionId };
    let abandon!: (e: Error) => void;
    vi.mocked(documentCommand).mockImplementationOnce(() => new Promise((_resolve, reject) => { abandon = reject; }));
    f.store.preview('chat', ref);
    await expect.poll(() => f.store.preview('chat', ref).state).toBe('running');
    f.store.close(); stores.splice(stores.indexOf(f.store), 1);
    converter();
    const restarted = new FileStore(f.state, f.owner); stores.push(restarted);
    abandon(new Error('Old worker stopped'));
    await expect.poll(() => restarted.preview('chat', ref).state).toBe('ready');
    const calls = vi.mocked(documentCommand).mock.calls.length;
    const restored = await restarted.restore('chat', file.id, { versionId: ref.versionId, expectedBaseVersionId: ref.versionId, operationId: 'restore-same-bytes' });
    const next = { fileId: file.id, versionId: restored.latestVersionId };
    await expect.poll(() => restarted.preview('chat', next).state).toBe('ready');
    expect(vi.mocked(documentCommand)).toHaveBeenCalledTimes(calls);
    expect(restarted.previewOutput('chat', next, 1).path).toBe(restarted.previewOutput('chat', ref, 1).path);
    const working = restarted.checkout('chat', next); writeFileSync(working.path, '%PDF-1.4\nnew output');
    const updated = await restarted.commit('chat', file.id, { checkoutToken: working.token, expectedBaseVersionId: next.versionId, operationId: 'new-document' });
    const failed = { fileId: file.id, versionId: updated.latestVersionId };
    vi.mocked(documentCommand).mockRejectedValueOnce(new Error('Document processing timed out'));
    await expect.poll(() => restarted.preview('chat', failed).state).toBe('failed');
    expect(readFileSync(restarted.version('chat', failed).path, 'utf8')).toContain('new output');
    restarted.preview('chat', failed, true);
    await expect.poll(() => restarted.preview('chat', failed).state).toBe('ready');
  });
});
