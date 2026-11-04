import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore, type MemoryEntry, type MemoryProvider } from '../server/memory-store.js';
import { MemoryStore as ReferenceStore } from './fixtures/memory-store-reference.js';
import { ProjectRegistry } from '../server/projects.js';
import { ProjectSpaceRegistry, type SpaceTarget, type SpaceAssignment } from '../server/project-space-registry.js';
import { ProjectContextResolver } from '../server/project-context.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// MemoryStore.context() reads owners, grants, turn references, settings and
// preferences once per call instead of once per row (it blocked the gateway's
// event loop for 300-450 ms per send). The output must not change: every
// case here runs the current store and a frozen copy of the old one on the
// same database and compares the whole MemoryContext.
const closers: { close(): void }[] = [];
afterEach(() => { for (const s of closers.splice(0)) s.close(); vi.useRealTimers(); });
const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 4, 12);
let clock = NOW - 10 * DAY;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); clock = NOW - 10 * DAY; vi.setSystemTime(clock); });
const at = (t: number) => { clock = t; vi.setSystemTime(t); };

function fixture(withResolver = true) {
  const state = mkdtempSync(join(tmpdir(), 'memory-identity-')), file = join(state, 'projects.json'), projects = () => ProjectRegistry.load(file), reg = projects();
  const work = reg.create('Work', state), other = reg.create('Other', state);
  reg.addConversation(work.id, 'one', 'One'); reg.addConversation(work.id, 'two', 'Two'); reg.addConversation(other.id, 'research', 'Research');
  reg.createChat({ id: 'chat', kind: 'chat', name: 'Chat', cwd: state, lastSessionId: 'chat-session', conversations: [{ sessionId: 'chat-session', title: 'Chat', createdAt: 1 }] });
  const spaces = new ProjectSpaceRegistry(state, () => projects().list()), a = spaces.create({ requestId: 'space-create-001', name: 'A' }), b = spaces.create({ requestId: 'space-create-002', name: 'B' });
  const move = (target: SpaceTarget, assignment: SpaceAssignment) => { const preview = spaces.preview({ target, assignment }); const op = spaces.apply({ target, assignment, operationId: randomUUID(), expectedRevision: preview.revision, expectedTopology: preview.topology, expectedImpactHash: preview.impactHash }); spaces.complete(op.id); };
  move({ kind: 'work-project', projectId: work.id }, { mode: 'space', spaceId: a.id }); move({ kind: 'work-conversation', projectId: work.id, sessionId: 'two' }, { mode: 'space', spaceId: b.id }); move({ kind: 'chat', projectId: 'chat' }, { mode: 'space', spaceId: a.id });
  const resolver = withResolver ? new ProjectContextResolver(() => projects().list(), () => true, spaces) : undefined;
  const store = new MemoryStore(state, resolver), reference = new ReferenceStore(state, resolver);
  closers.push(store, reference);
  let n = 0;
  const note = (patch: Partial<MemoryEntry> = {}) => { at(clock + 1000); return store.create({ title: 'Note ' + (n++), content: 'Plain content.', projectId: work.id, status: 'confirmed', ...patch }); };
  return { state, store, reference, spaces, a, b, work, other, note };
}

type F = ReturnType<typeof fixture>;
function seed(f: F) {
  // More than 200 visible confirmed notes for the chat, so the 200-row cut of
  // the "always" pass matters: the old preference below falls outside it.
  for (let i = 0; i < 230; i++) f.note({ projectId: 'chat', title: 'Deploy checklist ' + i, content: 'Watchdog logs and deploy status ' + i, tags: i % 7 ? [] : ['ops'] });
  const resume = clock;
  at(NOW - 300 * DAY);
  const oldPref = f.store.create({ title: 'Old preference', content: 'Prefer tabs.', projectId: 'chat', kind: 'preference', status: 'confirmed' });
  at(resume);
  const pinned = f.note({ projectId: 'chat', title: 'Pinned rule', content: 'Always pinned.', pinned: true });
  const globalPref = f.note({ projectId: undefined, scope: 'global', title: 'Global preference', content: 'Answer briefly.', kind: 'preference' });
  const workNote = f.note({ title: 'Work deploy note', content: 'deploy watchdog on work' });
  const convNote = f.note({ scope: 'conversation', sessionId: 'one', title: 'Conversation note', content: 'deploy only for one' });
  const spaceNote = f.note({ projectId: undefined, spaceId: f.a.id, scope: 'space', title: 'Space deploy note', content: 'space deploy status' });
  const otherNote = f.note({ projectId: f.other.id, title: 'Other deploy note', content: 'deploy status elsewhere' });
  const shared = f.note({ projectId: f.other.id, scope: 'shared', sharedProjectIds: [f.work.id], title: 'Shared deploy', content: 'shared deploy watchdog' });
  const expiring = f.note({ projectId: 'chat', title: 'Expiring deploy', content: 'deploy expiring', expiresAt: NOW - 1 });
  const codexOnly = f.note({ projectId: 'chat', title: 'Codex deploy', content: 'deploy for codex', providers: ['codex'] });
  const source = f.store.ingest({ key: 'evidence', kind: 'document', projectId: 'chat', title: 'Evidence', content: 'Deploy evidence text', at: 1 }).source;
  const sourced = f.note({ projectId: 'chat', title: 'Sourced deploy', content: 'deploy from evidence', sources: [{ id: source.id, hash: source.hash, label: 'Evidence' }] });
  f.store.excludeSource(source.id, true);
  const excluded = f.note({ projectId: 'chat', title: 'Excluded deploy', content: 'deploy excluded' });
  f.store.setPreferences('chat', 'chat-session', { excludedIds: [excluded.id], pinnedIds: [otherNote.id, pinned.id, 'missing-id'] });
  f.store.setPreferences(f.work.id, 'one', { pinnedIds: [spaceNote.id] });
  at(NOW);
  return { oldPref, pinned, globalPref, workNote, convNote, spaceNote, otherNote, shared, expiring, codexOnly, sourced, excluded };
}

const QUERIES = ['Please check the deploy status and the watchdog logs', '', 'tabs', '/compact now', 'ops deploy', 'excluded expiring sourced codex'];
function same(f: F, pid: string, sid: string, provider: MemoryProvider, query: string, requestId?: string) {
  let want: unknown, got: unknown;
  try { want = f.reference.context(pid, sid, provider, query, requestId); } catch (e) { want = { threw: (e as Error).constructor.name, message: (e as Error).message }; }
  try { got = f.store.context(pid, sid, provider, query, requestId); } catch (e) { got = { threw: (e as Error).constructor.name, message: (e as Error).message }; }
  expect(got, `${pid}/${sid}/${provider}/${JSON.stringify(query)}/${requestId}`).toEqual(want);
  return got as Record<string, unknown>;
}
function sweep(f: F, requestId?: string) {
  const out: Record<string, unknown>[] = [];
  for (const [pid, sid] of [['chat', 'chat-session'], [f.work.id, 'one'], [f.work.id, 'two'], [f.other.id, 'research']] as const)
    for (const provider of ['claude', 'codex'] as const)
      for (const query of QUERIES) out.push(same(f, pid, sid, provider, query, pid === 'chat' ? requestId : undefined));
  return out;
}

describe('MemoryStore.context fast path matches the old implementation', () => {
  it('with no owners, grants or turn references', () => {
    const f = fixture(), notes = seed(f);
    const results = sweep(f);
    // The fixture really exercises what the comparison is about.
    const chat = f.store.context('chat', 'chat-session', 'claude', '');
    expect(chat.items.some(i => i.id === notes.pinned.id)).toBe(true);
    expect(chat.items.some(i => i.id === notes.oldPref.id)).toBe(false);
    expect(chat.skipped.some(s => s.reason === 'Context budget')).toBe(true);
    const query = f.store.context('chat', 'chat-session', 'claude', QUERIES[5]);
    expect(query.skipped.map(s => s.reason)).toEqual(expect.arrayContaining(['Excluded from this conversation', 'Expired', 'Source excluded or removed']));
    expect(results.some(r => (r.items as unknown[]).length > 0)).toBe(true);
    f.store.setSettings({ crossProject: false, maxEntries: 40, maxTokens: 12000 });
    sweep(f);
    f.store.setSettings({ providers: ['codex'] });
    sweep(f);
  });

  it('with owners, grants and turn references present', () => {
    const f = fixture(), notes = seed(f);
    const db = new DatabaseSync(join(f.state, 'memory.sqlite')); closers.push(db);
    db.prepare('INSERT INTO memory_owners VALUES(?,?,?,?)').run('entry', notes.otherNote.id, 'space', f.a.id);
    db.prepare('INSERT INTO memory_owners VALUES(?,?,?,?)').run('entry', notes.workNote.id, 'execution', f.other.id);
    db.prepare('INSERT INTO memory_owners VALUES(?,?,?,?)').run('entry', notes.convNote.id, 'execution', f.work.id);
    const share = (id: string, recipient: { kind: 'space' | 'execution'; id: string }, active = true) =>
      f.store.access.setGrant({ operationId: randomUUID(), subject: { kind: 'entry', id }, expectedVersion: String(f.store.get(id)!.revision), recipient, expectedRevision: 0, active });
    share(notes.shared.id, { kind: 'space', id: f.a.id });
    share(notes.workNote.id, { kind: 'execution', id: 'chat' });
    share(notes.codexOnly.id, { kind: 'space', id: f.b.id });
    const refs = f.store.access.setReferences({ operationId: randomUUID(), projectId: 'chat', sessionId: 'chat-session', requestId: 'request-identity-1', expectedRevision: 0,
      selections: [{ kind: 'entry', id: notes.otherNote.id, version: String(notes.otherNote.revision), allowReadForTurn: true, allowCrossProjectForTurn: true }] });
    sweep(f);
    sweep(f, refs.requestId);
    const withRef = f.store.context('chat', 'chat-session', 'claude', '', refs.requestId);
    expect(withRef.items[0]?.reason).toBe('Selected for this turn');
    expect(withRef.referencesRevision).toBe(1);
    f.store.setSettings({ crossProject: false });
    sweep(f, refs.requestId);
  });

  it('throws the same reference conflict', () => {
    const f = fixture(), notes = seed(f);
    const refs = f.store.access.setReferences({ operationId: randomUUID(), projectId: 'chat', sessionId: 'chat-session', requestId: 'request-identity-2', expectedRevision: 0,
      selections: [{ kind: 'entry', id: notes.pinned.id, version: String(notes.pinned.revision) }] });
    f.store.setPreferences('chat', 'chat-session', { excludedIds: [notes.pinned.id] });
    const out = same(f, 'chat', 'chat-session', 'claude', 'deploy', refs.requestId);
    expect(out).toEqual({ threw: 'MemoryReferenceConflict', message: expect.stringContaining('Excluded') });
    // A later, valid call still works (the per-call caches were released).
    f.store.setPreferences('chat', 'chat-session', { excludedIds: [] });
    same(f, 'chat', 'chat-session', 'claude', 'deploy', refs.requestId);
  });

  it('without a resolver', () => {
    const f = fixture(false); seed(f);
    sweep(f);
  });
});
