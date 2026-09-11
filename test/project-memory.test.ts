import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, type MemoryEntry } from '../server/memory-store.js';
import { ProjectContextResolver } from '../server/project-context.js';
import { ProjectRegistry, type Project } from '../server/projects.js';
import { SessionManager } from '../server/manager.js';
import { MemoryController } from '../server/memory.controller.js';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions } from '../src/failover.js';

const stores: MemoryStore[] = [], managers: SessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.onModuleDestroy(); for (const s of stores.splice(0)) s.close(); });
function fixture() {
  const state = mkdtempSync(join(tmpdir(), 'project-memory-'));
  const records: Project[] = [
    { id: 'parent', name: 'Proposal', conversations: [{ sessionId: 'work', title: 'Work', createdAt: 1 }] },
    { id: 'chat', name: 'Chat', kind: 'chat', parentProjectId: 'parent', membershipRevision: 2, conversations: [{ sessionId: 'chat-session', title: 'Chat', createdAt: 2 }] },
    { id: 'sibling', name: 'Sibling', kind: 'chat', parentProjectId: 'parent', conversations: [{ sessionId: 'sibling-session', title: 'Sibling', createdAt: 3 }] },
    { id: 'other', name: 'Other' },
  ];
  let enabled = true;
  const resolver = new ProjectContextResolver(() => records, () => enabled), store = new MemoryStore(state, resolver); stores.push(store);
  const note = (patch: Partial<MemoryEntry> = {}) => store.create({ title: 'Proposal requirements', content: 'Keep the proposal editable.',
    projectId: 'parent', status: 'confirmed', pinned: true, ...patch });
  return { state, records, store, resolver, note, disable: () => { enabled = false; } };
}

describe('Project memory inheritance', () => {
  it('shares reviewed parent memory between Chat and Work with cross-project retrieval off, while keeping Chat-local and conversation scopes private', () => {
    const f = fixture(), brief = f.note({ kind: 'context', tags: ['project-brief'] }), local = f.note({ projectId: 'chat' });
    const privateWork = f.note({ scope: 'conversation', sessionId: 'work' });
    const external = f.note({ projectId: 'other', scope: 'shared', sharedProjectIds: ['parent'] });
    f.store.setSettings({ crossProject: false });
    const chat = f.store.context('chat', 'chat-session', 'codex', 'proposal');
    expect(chat.items.map(e => e.id).sort()).toEqual([brief.id, local.id].sort());
    expect(chat.scope).toMatchObject({ executionProjectId: 'chat', parentProjectId: 'parent', membershipRevision: 2 });
    expect(f.store.context('parent', 'work', 'codex', 'proposal').items.map(e => e.id).sort()).toEqual([brief.id, privateWork.id].sort());
    expect(f.store.context('sibling', 'sibling-session', 'codex', 'proposal').items.map(e => e.id)).toEqual([brief.id]);
    expect(chat.skipped).toContainEqual({ id: external.id, reason: 'Cross-project retrieval disabled' });
    f.store.setSettings({ crossProject: true });
    expect(f.store.context('chat', 'chat-session', 'codex', '').items.map(e => e.id)).toContain(external.id);
  });

  it('applies exclusions before pins with one budget, deduplicates inherited entries and records exact revisions and sources', () => {
    const f = fixture(), excluded = f.note(), included = f.note(), huge = f.note({ content: 'Proposal '.repeat(2000) });
    f.store.setSettings({ maxEntries: 2, maxTokens: 500 });
    f.store.setPreferences('chat', 'chat-session', { pinnedIds: [excluded.id, included.id], excludedIds: [excluded.id] });
    const context = f.store.context('chat', 'chat-session', 'claude', 'proposal');
    expect(context.items.map(e => e.id)).toEqual([included.id]);
    expect(context.estimatedTokens).toBeLessThanOrEqual(500);
    expect(context.skipped).toEqual(expect.arrayContaining([{ id: excluded.id, reason: 'Excluded from this conversation' }, { id: huge.id, reason: 'Context budget' }]));
    const audit = f.store.recordContext('chat', 'chat-session', 'claude', context);
    f.store.update(included.id, 1, { content: 'A new approved requirement' });
    expect(f.store.contextHistory('chat', 'chat-session')[0].items).toEqual(audit.items);
    expect(audit.items[0].revision).toBe(1); expect(audit.scope?.membershipRevision).toBe(2);
    expect(f.store.context('chat', 'chat-session', 'claude', '/compact').items).toEqual([]);
  });

  it('uses the same eligibility for MCP and context: proposals, expired, provider restricted and source exclusions never become inherited notes', () => {
    const f = fixture(), approved = f.note();
    f.note({ status: 'proposed' }); f.note({ status: 'superseded' }); f.note({ expiresAt: Date.now() - 1 }); f.note({ providers: ['claude'] });
    const source = f.store.ingest({ key: 'source', kind: 'document', projectId: 'parent', title: 'Source', content: 'Proposal source', at: 1 }).source;
    f.note({ sources: [{ id: source.id, hash: source.hash, label: 'Source' }] }); f.store.excludeSource(source.id, true);
    const q = { projectId: 'chat', sessionId: 'chat-session', provider: 'codex' as const };
    expect(f.store.searchContext(q).items.map(e => e.id)).toEqual([approved.id]);
    expect(f.store.context('chat', 'chat-session', 'codex', '').items.map(e => e.id)).toEqual([approved.id]);
  });

  it('changes future inheritance on move or flag disable without sharing old local memory; sources aggregate under the parent', () => {
    const f = fixture(), parent = f.note(), local = f.note({ projectId: 'chat' }), nextParent = f.note({ projectId: 'other' });
    f.store.ingest({ key: 'chat-doc', kind: 'document', projectId: 'chat', title: 'Proposal draft', content: 'Draft', at: 1 });
    expect(f.store.sources({ projectId: 'parent' }).items).toHaveLength(1);
    f.records[1].parentProjectId = 'other'; f.records[1].membershipRevision = 3;
    expect(f.store.context('chat', 'chat-session', 'codex', '').items.map(e => e.id).sort()).toEqual([local.id, nextParent.id].sort());
    expect(f.store.context('parent', 'work', 'codex', '').items.map(e => e.id)).toEqual([parent.id]);
    expect(f.store.sources({ projectId: 'parent' }).items).toHaveLength(0);
    f.disable();
    expect(f.store.context('chat', 'chat-session', 'codex', '').items.map(e => e.id)).toEqual([local.id]);
    expect(() => f.resolver.resolve('chat', 'work')).toThrow('Conversation');
  });

  it('binds HTTP/MCP reads to the caller and keeps dispatch snapshots unchanged through a simulated account switch', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'project-memory-launch-')), workspaceRoot = join(stateDir, 'workspace'); mkdirSync(workspaceRoot);
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(stateDir, 'a') }, { name: 'b', configDir: join(stateDir, 'b') }]);
    const calls: RunSessionOptions[] = [];
    let finish!: () => void;
    const manager = new SessionManager({ stateDir, workspaceRoot, chatEnabled: true, projectSpacesEnabled: true,
      runSessionFn: async o => { calls.push(o); await new Promise<void>(r => { finish = r; }); return { status: 'completed', failovers: 1 }; } }); managers.push(manager);
    const parent = manager.createProjectSpace({ requestId: 'memory-parent-001', name: 'Proposal' }), chat = manager.createChat({ requestId: 'memory-chat-001' });
    ProjectRegistry.load(join(stateDir, 'projects.json')).moveChat(chat.id, parent.id, 0, 'memory-move-001');
    const store = manager.memory(); stores.push(store);
    const approved = store.create({ title: 'Approved brief', content: 'Keep document originals.', kind: 'context', tags: ['project-brief'], projectId: parent.id, status: 'confirmed', pinned: true });
    const other = manager.createProject('Unrelated');
    const privateNote = store.create({ title: 'Private decision', content: 'Unrelated information', projectId: other.id, status: 'confirmed', pinned: true });
    const controller = new MemoryController(manager, stateDir);
    const q = { callerProjectId: chat.id, callerSessionId: chat.lastSessionId!, projectId: other.id };
    expect(controller.search(q).items.map(e => e.id)).toEqual([approved.id]);
    expect(() => controller.entry(privateNote.id, undefined, undefined, undefined, chat.id, chat.lastSessionId)).toThrow('scope');
    const preview = controller.context(chat.id, chat.lastSessionId!, 'proposal');
    expect(preview.preview).toBe(true);
    manager.continueSession(chat.id, chat.lastSessionId!, 'proposal');
    store.update(approved.id, 1, { content: 'Changed after dispatch.' });
    calls[0].log.append({ type: 'turn_started', account: 'a' });
    calls[0].log.append({ type: 'turn_started', account: 'b' });
    expect(calls[0].prompt).toContain('Keep document originals.');
    expect(calls[0].prompt).not.toContain('Changed after dispatch.');
    expect(store.contextHistory(chat.id, chat.lastSessionId)[0].items).toEqual(preview.items);
    finish(); await new Promise(r => setTimeout(r, 20));
  });
});
