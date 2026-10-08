import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArchivedUsageLedger, archiveRecord } from '../server/archived-usage.js';
import { TranscriptStatsReader } from '../server/transcript-stats.js';
import { projectCosts, groupSpaceCosts } from '../server/project-costs.js';
import { gatewayDb } from '../server/gateway-db.js';
import { ProjectRegistry } from '../server/projects.js';
import { ProjectSpaceRegistry } from '../server/project-space-registry.js';

const parent = 'aa61178e-6f89-4d05-9e77-dde9cb45a9bf';
const second = '0816736d-aa76-466a-b749-ea058f32ba61';
const asOf = '2026-10-01T08:20:00.000Z';
const pathFor = (home: string, id = parent, agent?: string) => join(home, 'projects', '-repo', id + (agent ? `/subagents/agent-${agent}` : '') + '.jsonl');
const entry = (output = 20) => ({ partial: false, size: 100, scanned: 100, offset: 100,
  usage: { input: 10, output, cacheRead: 30, cacheWrite: 40, messages: 1,
    byModel: { 'claude-opus-5': { input: 10, output, cacheRead: 30, cacheWrite: 40 } } },
  tasks: { secret: { result: 'NEVER ARCHIVE ME' } },
});
const setup = () => {
  const d = mkdtempSync(join(tmpdir(), 'archived-usage-')), home = join(d, 'account');
  mkdirSync(home);
  const projects = [{ id: 'p', name: 'Project', conversations: [{ sessionId: parent }] }];
  return { d, home, projects, context: (_pid?: string, sid = parent) => ({ adapter: { id: 'claude' }, providerSessionId: sid, configDirs: [home] }) };
};
const backup = (d: string, entries: Record<string, unknown>, name = 'transcript-stats.json.migrated-2026-10-01') => {
  const file = join(d, name); writeFileSync(file, JSON.stringify({ v: 4, entries })); utimesSync(file, new Date(asOf), new Date(asOf)); return file;
};
const live = (path: string, output: number) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: output }, content: [] } }) + '\n');
};

describe('archived usage evidence', () => {
  it('accepts reconciled complete v4 counters, strips task data, and rejects invalid or ambiguous formats', () => {
    const path = pathFor('/old/account');
    const record = archiveRecord(path, entry(), 4, 'snapshot', asOf);
    expect(record).toMatchObject({ parentId: parent, agent: false, size: 100, scanned: 100, asOf });
    expect(JSON.stringify(record)).not.toContain('NEVER ARCHIVE ME');
    for (const change of [{ partial: true }, { scanned: 99 }, { size: Infinity }, { usage: { ...entry().usage, input: 11 } }, { usage: { ...entry().usage, messages: -1 } }]) {
      expect(archiveRecord(path, { ...entry(), ...change }, 4, 'snapshot', asOf)).toBeNull();
    }
    expect(archiveRecord(path, entry(), 3, 'snapshot', asOf)).toBeNull();
    expect(archiveRecord('/codex/sessions/rollout-' + parent + '.jsonl', entry(), 4, 'snapshot', asOf)).toBeNull();
    expect(archiveRecord(path, entry(), 4, 'snapshot', null)?.asOf).toBeNull();
  });

  it('imports missing parent and agent snapshots with exact metadata and keeps missing true', () => {
    const f = setup(), source = backup(f.d, { [pathFor('/old')]: entry(20), [pathFor('/old', parent, 'worker')]: entry(7) });
    const stats = new TranscriptStatsReader(f.d), r = projectCosts(f.projects, f.context, new Set(), stats);
    expect(r.totals).toMatchObject({ output: 27, archivedRecords: 2, archiveDates: [asOf] });
    expect(r.conversations[0]).toMatchObject({ missing: true, archivedRecords: 2, agentCount: 1, size: 0 });
    expect(stats.archives.forParent(parent)[0]).toMatchObject({ source, schemaVersion: 4 });
    expect(JSON.stringify(gatewayDb(f.d).prepare('SELECT data FROM archived_usage').all())).not.toContain('NEVER ARCHIVE ME');
    expect(new ArchivedUsageLedger(f.d).forParent(parent)).toHaveLength(2);
  });

  it('deduplicates account aliases and backup files, choosing the newest complete evidence', () => {
    const f = setup();
    backup(f.d, { [pathFor('/old-a')]: entry(), [pathFor('/old-b')]: entry() });
    const newer = backup(f.d, { [pathFor('/old-c')]: { ...entry(50), size: 200, scanned: 200 } }, 'transcript-stats.json.migrated-2026-10-02');
    utimesSync(newer, new Date('2026-10-02Z'), new Date('2026-10-02Z'));
    const stats = new TranscriptStatsReader(f.d), r = projectCosts(f.projects, f.context, new Set(), stats);
    expect(r.totals).toMatchObject({ output: 50, archivedRecords: 1, archiveDates: ['2026-10-02T00:00:00.000Z'] });
  });

  it('gives relocated live parent and agent identities precedence and restores archive fallback after removal', () => {
    const f = setup(); backup(f.d, { [pathFor('/old')]: entry(20), [pathFor('/old', parent, 'worker')]: entry(7) });
    const stats = new TranscriptStatsReader(f.d), own = pathFor(f.home), agent = pathFor(f.home, parent, 'worker');
    live(own, 50); live(agent, 9);
    const active = projectCosts(f.projects, f.context, new Set(), stats, 1000);
    expect(active.totals).toMatchObject({ output: 59, archivedRecords: 0 });
    unlinkSync(own); unlinkSync(agent);
    const absent = projectCosts(f.projects, f.context, new Set(), stats, 1000);
    expect(absent.totals).toMatchObject({ output: 59, archivedRecords: 2 });
    expect(absent.conversations[0].missing).toBe(true);
    // A restored transcript may live under an entirely different account.
    const restoredHome = join(f.d, 'restored');
    live(pathFor(restoredHome), 3); live(pathFor(restoredHome, parent, 'worker'), 2);
    expect(projectCosts(f.projects, () => ({ ...f.context(), configDirs: [restoredHome] }), new Set(), stats, 1000).totals).toMatchObject({ output: 5, archivedRecords: 0 });
  });

  it('preserves future complete scans through removal and restart, without inventing an old cache scan date', () => {
    const f = setup(), own = pathFor(f.home); live(own, 60);
    const stats = new TranscriptStatsReader(f.d); stats.statsFor(own); const saved = stats.archives.forParent(parent)[0];
    expect(Number.isFinite(Date.parse(saved.asOf!))).toBe(true);
    unlinkSync(own);
    const resumed = new TranscriptStatsReader(f.d);
    expect(resumed.archives.forParent(parent)[0].asOf).toBe(saved.asOf);
    expect(projectCosts(f.projects, f.context, new Set(), resumed).totals.output).toBe(60);
    const old = pathFor('/old', second);
    gatewayDb(f.d).prepare('INSERT INTO transcript_stats(path,version,data) VALUES(?,?,?)').run(old, 4, JSON.stringify(entry(80)));
    const legacy = new TranscriptStatsReader(f.d);
    expect(legacy.archives.forParent(second)[0].asOf).toBeNull();
    expect(gatewayDb(f.d).prepare('SELECT path FROM transcript_stats WHERE path=?').get(old)).toBeUndefined();
  });

  it('excludes archived fallback when the provider parent has multiple registered owners', () => {
    const f = setup(); backup(f.d, { [pathFor('/old')]: entry() });
    const projects = [...f.projects, { id: 'alias', name: 'Alias', conversations: [{ sessionId: 'internal-alias' }] }];
    const r = projectCosts(projects, () => f.context(), new Set(), new TranscriptStatsReader(f.d));
    expect(r.totals).toMatchObject({ output: 0, archivedRecords: 0 }); expect(r.missing).toBe(2);
  });

  it('uses archived activity to correct stale not-started metadata', () => {
    const f = setup(); backup(f.d, { [pathFor('/old')]: entry() });
    Object.assign(f.projects[0].conversations[0], { lastMessageAt: null });
    const r = projectCosts(f.projects, f.context, new Set(), new TranscriptStatsReader(f.d));
    expect(r.conversations[0]).toMatchObject({ archivedRecords: 1, missing: true, unstarted: false });
    expect(r.unstarted).toBe(0);
  });

  it('prefers a provable undated cumulative extension without claiming a scan date', () => {
    const f = setup(); backup(f.d, { [pathFor('/old')]: entry(20) });
    const ledger = new ArchivedUsageLedger(f.d), larger = { ...entry(70), size: 200, scanned: 200 };
    ledger.preserve(pathFor('/later'), larger, 4, 'old-cache', null);
    expect(ledger.forParent(parent)[0]).toMatchObject({ asOf: null, size: 200, usage: { output: 70 } });
    ledger.preserve(pathFor('/old'), entry(20), 4, 'snapshot', asOf);
    expect(ledger.forParent(parent)[0]).toMatchObject({ asOf: null, usage: { output: 70 } });
  });

  it('skips unreadable legacy candidates and malformed snapshots without blocking valid ones', () => {
    const f = setup();
    mkdirSync(join(f.d, 'transcript-stats.json.migrated-0-directory'));
    writeFileSync(join(f.d, 'transcript-stats.json.migrated-1-broken'), '{broken');
    backup(f.d, { [pathFor('/old')]: entry() });
    const ledger = new ArchivedUsageLedger(f.d);
    expect(ledger.forParent(parent)).toHaveLength(1);
  });

  it('sums archived metadata and cost under current space membership once', () => {
    const f = setup(); backup(f.d, { [pathFor('/old')]: entry(20), [pathFor('/old', parent, 'worker')]: entry(7) });
    const file = join(f.d, 'projects.json'), reg = ProjectRegistry.load(file), work = reg.create('Work', f.home); reg.addConversation(work.id, parent, 'Build', 'claude');
    const spaces = new ProjectSpaceRegistry(f.d, () => ProjectRegistry.load(file).list()), space = spaces.create({ requestId: 'archive-space-001', name: 'Space' });
    const change = { target: { kind: 'work-project' as const, projectId: work.id }, assignment: { mode: 'space' as const, spaceId: space.id } };
    const preview = spaces.preview(change), op = spaces.apply({ ...change, operationId: 'archive-op-001', expectedRevision: preview.revision, expectedTopology: preview.topology, expectedImpactHash: preview.impactHash }); spaces.complete(op.id);
    const projects = reg.list(), r = projectCosts(projects, f.context, new Set(), new TranscriptStatsReader(f.d)), groups = groupSpaceCosts(r, projects, spaces);
    expect(groups.find(g => g.projectId === space.id)).toMatchObject({ archivedRecords: 2, archiveDates: [asOf], missing: 1 });
    expect(groups.reduce((sum, g) => sum + g.cost.usd, 0)).toBeCloseTo(r.totals.usd);
    expect(groups.reduce((sum, g) => sum + g.archivedRecords, 0)).toBe(r.totals.archivedRecords);
  });
});
