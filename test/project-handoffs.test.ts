import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import type { ProjectHandoffInput } from '../server/project-handoffs.js';
import { DeliveryStore } from '../server/workspace-store.js';

const managers: SessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.onModuleDestroy(); vi.restoreAllMocks(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'project-handoff-')), stateDir = join(root, 'state'); mkdirSync(stateDir);
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'a') }, { name: 'b', provider: 'codex', configDir: join(root, 'b') }]);
  const calls: unknown[] = [], opts = { stateDir, workspaceRoot: root, projectSpacesEnabled: true, chatEnabled: true,
    runSessionFn: async (o: unknown) => { calls.push(o); return { status: 'completed' as const, failovers: 0 }; } };
  const m = new SessionManager(opts); managers.push(m);
  const p = m.createProjectSpace({ requestId: 'handoff-parent-001', name: 'Proposal', cwd: root });
  const chat = m.createChat({ requestId: 'handoff-source-001', parentProjectId: p.id });
  const input: ProjectHandoffInput = { requestId: 'handoff-operation-0001', sourceProjectId: chat.id, sourceSessionId: chat.lastSessionId!, mode: 'work', brief: 'Revise the proposal; preserve the original.', choices: { provider: 'codex', account: 'b', model: 'gpt-6-astra', effort: 'xhigh' }, sources: [{ projectId: chat.id, sessionId: chat.lastSessionId! }] };
  return { root, stateDir, opts, m, p, chat, input, calls };
}
describe('Project Chat and Work handoffs', () => {
  it('refuses a damaged delivery journal without overwriting receipts or dispatching again', () => {
    const f = fixture(), path = join(f.stateDir, 'message-receipts.json');
    writeFileSync(path, '{damaged');
    expect(() => new DeliveryStore(f.stateDir)).toThrow('repair');
    expect(readFileSync(path, 'utf8')).toBe('{damaged'); expect(f.calls).toHaveLength(0);
  });
  it('reuses one target and initial message with exact memory and file versions', async () => {
    const f = fixture(), filePath = join(f.chat.cwd, 'proposal.txt'); writeFileSync(filePath, 'Original proposal');
    const [file] = await f.m.files().upload(f.chat.id, 'handoff-upload-001', [{ path: filePath, name: 'proposal.txt' }]);
    const memory = f.m.memory().create({ projectId: f.p.id, scope: 'project', status: 'confirmed', title: 'Audience', content: 'Write for the review committee.', pinned: true }, 'operator');
    f.input.fileRefs = [{ fileId: file.id, versionId: file.latestVersionId }]; f.input.memories = [{ id: memory.id, revision: memory.revision }];
    const first = f.m.projectHandoffs().run(f.input), again = f.m.projectHandoffs().run(f.input);
    expect(first.target).toEqual(again.target); expect(f.m.listConversations(f.p.id)).toHaveLength(1);
    const queue = f.m.queues()[f.p.id]; expect(queue).toHaveLength(1);
    expect(queue[0].text).toContain('Write for the review committee.'); expect(queue[0].text).toContain('/chat/' + f.chat.id);
    expect(queue[0].fileRefs![0]).toMatchObject({ ownerId: f.p.id });
    expect(f.m.files().list(f.p.id)).toHaveLength(1); expect(f.m.files().list(f.p.id)[0].sourceVersionId).toBe(file.latestVersionId);
    f.m.memory().update(memory.id, memory.revision, { content: 'A later approved audience.' });
    expect(f.m.projectHandoffs().run(f.input).memories[0].content).toBe('Write for the review committee.');
    expect(f.m.projectHandoffs().list(f.p.id, first.target!.sessionId)[0].id).toBe(f.input.requestId);
    expect(() => f.m.projectHandoffs().run({ ...f.input, brief: 'Another task' })).toThrow('already used');
  });

  it('recovers after target creation without creating another target', () => {
    const f = fixture(), enqueue = vi.spyOn(f.m, 'enqueue').mockImplementationOnce(() => { throw new Error('Interrupted before enqueue'); });
    expect(() => f.m.projectHandoffs().run(f.input)).toThrow('Interrupted');
    const target = f.m.listConversations(f.p.id)[0].sessionId; enqueue.mockRestore(); f.m.onModuleDestroy();
    const restarted = new SessionManager(f.opts); managers.push(restarted);
    expect(restarted.projectHandoffs().run(f.input).target!.sessionId).toBe(target);
    expect(restarted.listConversations(f.p.id)).toHaveLength(1); expect(restarted.queues()[f.p.id]).toHaveLength(1);
  });

  it('reconciles a durable queued message after an interrupted delivery receipt', () => {
    const f = fixture(), op = f.m.projectHandoffs().run(f.input); f.m.onModuleDestroy();
    const journalPath = join(f.stateDir, 'project-handoffs.json'), journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.operations[op.id].status = 'prepared'; writeFileSync(journalPath, JSON.stringify(journal));
    const receiptPath = join(f.stateDir, 'message-receipts.json'), receipts = JSON.parse(readFileSync(receiptPath, 'utf8'));
    receipts[op.id].status = 'processing'; writeFileSync(receiptPath, JSON.stringify(receipts));
    const restarted = new SessionManager(f.opts); managers.push(restarted);
    expect(restarted.projectHandoffs().run(f.input)).toMatchObject({ target: op.target, status: 'queued' });
    expect(restarted.queues()[f.p.id]).toHaveLength(1);
  });

  it('does not duplicate an uncertain dispatch with no durable queue evidence', () => {
    const f = fixture(), op = f.m.projectHandoffs().run(f.input); f.m.onModuleDestroy();
    writeFileSync(join(f.stateDir, 'queues.json'), '{}');
    const path = join(f.stateDir, 'message-receipts.json'), receipts = JSON.parse(readFileSync(path, 'utf8'));
    receipts[op.id].status = 'processing'; writeFileSync(path, JSON.stringify(receipts));
    const restarted = new SessionManager(f.opts); managers.push(restarted);
    expect(restarted.projectHandoffs().run(f.input)).toMatchObject({ status: 'uncertain', target: op.target });
    expect(restarted.queues()[f.p.id]).toBeUndefined(); expect(f.calls).toHaveLength(0);
  });

  it('rejects changed memory or unavailable workspace and supports a fresh linked Chat', () => {
    const f = fixture(), privateMemory = f.m.memory().create({ projectId: f.p.id, status: 'proposed', title: 'Unreviewed', content: 'Do not send' });
    expect(() => f.m.projectHandoffs().run({ ...f.input, memories: [{ id: privateMemory.id, revision: 1 }] })).toThrow('Selected memory');
    const standalone = f.m.createChat({ requestId: 'handoff-standalone-001' }), input = { ...f.input, sourceProjectId: standalone.id, sourceSessionId: standalone.lastSessionId!, sources: [{ projectId: standalone.id, sessionId: standalone.lastSessionId! }] };
    expect(() => f.m.projectHandoffs().run(input)).toThrow('workspace');
    const op = f.m.projectHandoffs().run({ ...input, mode: 'chat' });
    expect(f.m.chat(op.target!.projectId).parentProjectId).toBeUndefined();
    expect(f.m.queues()[op.target!.projectId][0].text).toContain('/chat/' + standalone.id);
    expect(f.m.chat(op.target!.projectId).id).not.toBe(standalone.id);
  });
});
