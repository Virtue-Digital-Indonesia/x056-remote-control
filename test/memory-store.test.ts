import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore, MemoryConflict, type MemoryEntry } from '../server/memory-store.js';
import { cleanMemorySource } from '../server/memory-sources.js';
import { withMemoryContext, stripMemoryContext } from '../src/memory-context.js';
import { VersionInfo } from '../server/version.js';
let dir: string, store: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
  store = new MemoryStore(dir);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const note = (patch: Partial<MemoryEntry> = {}) =>
  store.create({
    title: 'Deployment decision',
    content: 'Deploy using the host actuator.',
    projectId: 'p1',
    kind: 'decision',
    status: 'confirmed',
    ...patch,
  });
describe('canonical memory', () => {
  it('persists independent of accounts, with immutable optimistic revisions', () => {
    const a = note();
    const b = store.update(a.id, 1, { content: 'Deploy after the tests pass.' });
    expect(b.revision).toBe(2);
    expect(() => store.update(a.id, 1, { content: 'Old edit' })).toThrow(MemoryConflict);
    expect(store.revisions(a.id).map((e) => e.content)).toEqual([b.content, a.content]);
    store.close();
    store = new MemoryStore(dir);
    expect(store.get(a.id)).toEqual(b);
  });
  it('isolates conversation, project, selected sharing and provider contexts', () => {
    const a = note(),
      b = note({ scope: 'conversation', sessionId: 's1' }),
      c = note({ scope: 'shared', sharedProjectIds: ['p2'] }),
      d = note({ scope: 'global' }),
      e = note({ scope: 'global', providers: ['claude'] });
    const ids = (pid: string, sid: string, provider: 'claude' | 'codex') =>
      store.context(pid, sid, provider, 'deploy').items.map((e) => e.id);
    expect(ids('p1', 's2', 'codex')).toEqual(expect.arrayContaining([a.id, c.id, d.id]));
    expect(ids('p1', 's2', 'codex')).not.toContain(b.id);
    expect(ids('p2', 's1', 'codex').sort()).toEqual([c.id, d.id].sort());
    expect(ids('p3', 's1', 'claude').sort()).toEqual([d.id, e.id].sort());
  });
  it('applies scope before search limits and handles FTS punctuation', () => {
    note({ projectId: 'p1', title: 'Unicode résumé deployment' });
    for (let i = 0; i < 220; i++) note({ projectId: 'p2' });
    expect(store.search({ query: 'résumé " OR **', projectId: 'p1', access: 'context' }).items).toHaveLength(
      1,
    );
    expect(
      store.search({ query: 'deploy', projectId: 'p1', access: 'context', limit: 1 }).items,
    ).toHaveLength(1);
  });
  it('never injects proposals, deleted, archived, superseded or expired knowledge', () => {
    for (const status of ['proposed', 'deleted', 'archived', 'superseded'] as const)
      note({ status, pinned: true });
    note({ expiresAt: Date.now() - 1000 });
    const valid = note();
    expect(store.context('p1', 's', 'codex', 'deploy').items.map((x) => x.id)).toEqual([valid.id]);
  });
  it('enforces context exclusions and budgets, including conversation pins', () => {
    const a = note(),
      b = note({ content: 'Deploy '.repeat(1000) });
    store.setSettings({ maxTokens: 300 });
    store.setPreferences('p1', 's', { pinnedIds: [b.id, a.id], excludedIds: [a.id] });
    const c = store.context('p1', 's', 'codex', 'deploy');
    expect(c.items).toEqual([]);
    expect(c.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining(['Context budget', 'Excluded from this conversation']),
    );
    expect(c.estimatedTokens).toBeLessThanOrEqual(300);
    store.setPreferences('p1', 's', { enabled: false });
    expect(store.context('p1', 's', 'codex', 'deploy').enabled).toBe(false);
  });
  it('respects global and provider settings', () => {
    note({ scope: 'global', projectId: 'p2' });
    store.setSettings({ crossProject: false });
    expect(store.context('p1', 's', 'claude', 'deploy').items).toHaveLength(0);
    store.setSettings({ crossProject: true, providers: ['codex'] });
    expect(store.context('p1', 's', 'claude', 'deploy').enabled).toBe(false);
    store.setSettings({ excludedProjects: ['p2'] });
    expect(store.context('p1', 's', 'codex', 'deploy').items).toHaveLength(0);
  });
  it('deduplicates sources and blocks stale/excluded source knowledge until reviewed', () => {
    const source = {
      key: 'reply-1',
      kind: 'conversation' as const,
      projectId: 'p1',
      title: 'Deploy decision',
      content: 'Deploy today.',
      at: Date.now(),
    };
    const first = store.ingest(source);
    expect(store.ingest(source).created).toBe(false);
    const proposed = store.proposeSource(first.source.id).entry;
    const approved = store.update(proposed.id, 1, { status: 'confirmed' });
    expect(store.context('p1', 's', 'codex', 'deploy').items).toHaveLength(1);
    const next = store.ingest({ ...source, content: 'Deploy tomorrow.' });
    expect(next.changed).toBe(true);
    expect(store.sourceVersion(first.source.id, first.source.hash)?.content).toBe('Deploy today.');
    expect(store.sourceVersion(next.source.id, next.source.hash)?.content).toBe('Deploy tomorrow.');
    expect(store.context('p1', 's', 'codex', 'deploy').items).toHaveLength(0);
    const reviewed = store.update(approved.id, 2, {
      content: next.source.content,
      sources: [{ id: next.source.id, hash: next.source.hash, label: 'Rechecked source' }],
    });
    expect(store.context('p1', 's', 'codex', 'deploy').items).toHaveLength(1);
    store.excludeSource(first.source.id, true);
    expect(store.context('p1', 's', 'codex', 'deploy').items).toHaveLength(0);
    expect(store.sources({ query: 'tomorrow' }).total).toBe(0);
    store.excludeSource(first.source.id, false);
    store.update(reviewed.id, 3, { status: 'deleted' });
    expect(store.proposeSource(first.source.id).existed).toBe(true);
  });
  it('rolls back an entire stale bulk review and unsafe merge', () => {
    const a = note({ status: 'proposed' }),
      b = note({ status: 'proposed' });
    expect(() =>
      store.bulk(
        [
          { id: a.id, revision: 1 },
          { id: b.id, revision: 9 },
        ],
        'confirmed',
      ),
    ).toThrow(MemoryConflict);
    expect(store.get(a.id)?.status).toBe('proposed');
    store.update(b.id, 1, { scope: 'global' });
    expect(() => store.merge(a.id, 1, [{ id: b.id, revision: 2 }], 'Merged')).toThrow('Align sharing');
    expect(store.get(a.id)?.revision).toBe(1);
  });
  it('merges with provenance and supersedes old records without reinjecting them', () => {
    const a = note(),
      b = note();
    store.link(a.id, b.id, 'supports');
    expect(store.related(a.id)[0].entry?.id).toBe(b.id);
    const merged = store.merge(a.id, 1, [{ id: b.id, revision: 1 }], 'Deploy after review');
    expect(merged.status).toBe('proposed');
    expect(store.get(b.id)?.supersededBy).toBe(a.id);
    expect(store.context('p1', 's', 'codex', 'deploy').items).toHaveLength(0);
  });
  it('round-trips exports as review proposals without duplicating repeated imports', () => {
    const a = note(),
      b = note();
    store.link(a.id, b.id, 'related');
    const bundle = store.export();
    const other = new MemoryStore(join(dir, 'other'));
    try {
      expect(other.importPackage(bundle).created).toBe(2);
      expect(other.importPackage(bundle).skipped).toBe(2);
      expect(other.search({ status: 'proposed' }).total).toBe(2);
      expect(other.related(other.search().items[0].id)).toHaveLength(1);
    } finally {
      other.close();
    }
  });
  it('records exact revision IDs without persisting a second copy of content', () => {
    const a = note();
    store.recordContext('p1', 's', 'codex', store.context('p1', 's', 'codex', 'deploy'));
    const row = store.contextHistory('p1', 's')[0];
    expect(row.text).toBeUndefined();
    expect(row.items).toEqual([expect.objectContaining({ id: a.id, revision: 1 })]);
  });
  it('keeps trashed entries searchable for recovery without making them eligible context', () => {
    const e = note();
    store.update(e.id, 1, { status: 'deleted' });
    expect(store.search({ query: 'deployment', status: 'deleted' }).items.map((x) => x.id)).toEqual([e.id]);
    expect(store.context('p1', 's', 'codex', 'deployment').items).toEqual([]);
  });
  it('rejects malformed source metadata and missing import evidence', () => {
    const source = {
      key: 'bad-source',
      kind: 'document' as const,
      projectId: 'p1',
      title: 'Evidence',
      content: 'A fact',
      at: Date.now(),
    };
    expect(() => store.ingest({ ...source, ref: { unexpected: true } as never })).toThrow(
      'Source ref must be text',
    );
    expect(() => store.ingest({ ...source, at: NaN })).toThrow('Invalid source date');
    expect(store.sources().total).toBe(0);
    const report = store.importPackage({
      entries: [
        {
          id: 'imported',
          title: 'Missing evidence',
          content: 'Fact',
          projectId: 'p1',
          sources: [{ id: 'missing', label: 'Original evidence' }],
        } as MemoryEntry,
      ],
    });
    expect(report.created).toBe(0);
    expect(report.errors[0]).toContain('Missing source');
  });
  it('continues source pagination when HTTP offsets are strings', () => {
    for (let i = 0; i < 5; i++)
      store.ingest({
        key: String(i),
        kind: 'document',
        projectId: 'p1',
        title: 'Source ' + i,
        content: 'value',
        at: i,
      });
    expect(store.sources({ offset: '2' as never, limit: '2' as never }).items.map((x) => x.title)).toEqual([
      'Source 2',
      'Source 1',
    ]);
  });
});
describe('provider reference boundaries', () => {
  it('preserves slash commands and hides injected context from history', () => {
    expect(withMemoryContext('/compact', 'context')).toBe('/compact');
    expect(store.context('p', 's', 'codex', '/compact').enabled).toBe(false);
    const prompt = 'Current request\n- details';
    expect(stripMemoryContext(withMemoryContext(prompt, 'Durable context'))).toBe(prompt);
    expect(stripMemoryContext(prompt)).toBe(prompt);
  });
  it('redacts credentials and never recursively captures hidden memory', () => {
    expect(
      cleanMemorySource(
        withMemoryContext(
          'Use Bearer abcdefghijklmnopqrstuvwxyz and sk-abcdefghijklmnopqrstu',
          'Hidden source',
        ),
      ),
    ).toBe('Use [credential removed] and [credential removed]');
  });
});
describe('release identity', () => {
  it('pins backend identity at startup but detects live UI updates and busts asset caches', () => {
    const pub = join(dir, 'public');
    mkdirSync(pub);
    writeFileSync(
      join(dir, 'build-info.json'),
      JSON.stringify({ revision: 'abcdef123456', source: 'built-source', builtAt: '2026-09-08T00:00:00Z' }),
    );
    for (const f of ['panel.html', 'control-room.js', 'control-room.css'])
      writeFileSync(join(pub, f), 'first');
    const info = new VersionInfo(pub, dir),
      first = info.current();
    expect(first.backend.revision).toBe('abcdef1');
    writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ revision: 'changed' }));
    writeFileSync(join(pub, 'control-room.js'), 'second version');
    expect(info.current().backend.revision).toBe('abcdef1');
    expect(info.current().ui.fingerprint).not.toBe(first.ui.fingerprint);
    expect(info.html('<head></head><script src="/control-room.js"></script>')).toContain(
      'window.X056_RELEASE',
    );
    expect(info.html('<head></head><script src="/control-room.js"></script>')).toContain(
      '/control-room.js?v=',
    );
  });
});
