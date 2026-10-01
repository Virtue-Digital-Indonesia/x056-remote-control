import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, transaction, userVersion } from '../server/sqlite.js';
import { closeAllGatewayDbs, gatewayDb, putReceipt, ROUTING_HISTORY_CAP } from '../server/gateway-db.js';
import { RoutingState } from '../server/routing-state.js';
import { ArtifactStore, DeliveryStore, RECEIPT_KEEP_MS, RECEIPT_KEEP_ROWS } from '../server/workspace-store.js';
import { TranscriptStatsReader } from '../server/transcript-stats.js';

const dir = () => mkdtempSync(join(tmpdir(), 'x056-gateway-db-'));
afterEach(() => { closeAllGatewayDbs(); vi.restoreAllMocks(); });

describe('openDb', () => {
  it('runs each migration once and records user_version', () => {
    const path = join(dir(), 'x.sqlite'), calls: number[] = [];
    const m = [(db: any) => { calls.push(1); db.exec('CREATE TABLE a(x)'); }, (db: any) => { calls.push(2); db.exec('CREATE TABLE b(x)'); }];
    openDb(path, { migrations: m.slice(0, 1) }).close();
    const db = openDb(path, { migrations: m });
    expect(userVersion(db)).toBe(2);
    expect(String(Object.values(db.prepare('PRAGMA journal_mode').get()!)[0])).toBe('wal');
    db.close();
    openDb(path, { migrations: m }).close();
    expect(calls).toEqual([1, 2]);
  });
  it('refuses a database written by a newer schema', () => {
    const path = join(dir(), 'x.sqlite');
    openDb(path, { migrations: [() => {}, () => {}] }).close();
    expect(() => openDb(path, { migrations: [() => {}] })).toThrow(/newer than this build/);
  });
  it('rolls a failed migration back, leaving the version where it was', () => {
    const path = join(dir(), 'x.sqlite');
    expect(() => openDb(path, { migrations: [(db) => { db.exec('CREATE TABLE a(x)'); throw new Error('boom'); }] })).toThrow('boom');
    const db = openDb(path, { migrations: [] });
    expect(userVersion(db)).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='a'").get()).toBeUndefined();
    db.close();
  });
  it('transaction rolls back on error and nests without a second BEGIN', () => {
    const db = openDb(join(dir(), 'x.sqlite'), { migrations: [(d) => d.exec('CREATE TABLE t(x)')] });
    expect(() => transaction(db, () => { db.exec('INSERT INTO t VALUES(1)'); throw new Error('no'); })).toThrow('no');
    transaction(db, () => transaction(db, () => db.exec('INSERT INTO t VALUES(2)')));
    expect(db.prepare('SELECT x FROM t').all().map((r) => r.x)).toEqual([2]);
    expect(db.isTransaction).toBe(false);
    db.close();
  });
});

describe('legacy JSON import', () => {
  const route = (i: number) => ({ id: 'r' + i, at: new Date(1e12 + i).toISOString(), projectId: 'p' + (i % 2), sessionId: 's' + (i % 3), kind: 'k', detail: {} });
  function legacyState() {
    const d = dir();
    // Newest first, as the old writer kept it.
    writeFileSync(join(d, 'routing-history.json'), JSON.stringify([5, 4, 3, 2, 1].map(route)));
    writeFileSync(join(d, 'message-receipts.json'), JSON.stringify({
      'request-aaaaaaaaaaaaaaaa': { requestId: 'request-aaaaaaaaaaaaaaaa', hash: 'h', status: 'accepted', at: Date.now(), sessionId: 's' },
      'request-bbbbbbbbbbbbbbbb': { requestId: 'request-bbbbbbbbbbbbbbbb', hash: 'h', status: 'processing', at: Date.now() },
      broken: 7,
    }));
    writeFileSync(join(d, 'transcript-stats.json'), JSON.stringify({ v: 4, entries: { '/nowhere/t.jsonl': { usage: {}, tasks: {}, partial: false, scanned: 1, size: 1, offset: 1 } } }));
    writeFileSync(join(d, 'message-receipts.json.tmp-e82a061e'), '');
    return d;
  }
  it('imports a good file once, renames it and keeps it, and cleans stray temp files', () => {
    const d = legacyState();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(new RoutingState(d).history().map((r) => r.id)).toEqual(['r5', 'r4', 'r3', 'r2', 'r1']);
    expect(new RoutingState(d).history('p1', 's1').map((r) => r.id)).toEqual(['r1']);
    const files = readdirSync(d);
    expect(files.filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(files.filter((f) => /\.migrated-/.test(f))).toHaveLength(3);
    expect(files.some((f) => f.includes('.tmp'))).toBe(false);
    const receipts = new DeliveryStore(d);
    expect(Object.keys(receipts.all()).sort()).toEqual(['request-aaaaaaaaaaaaaaaa', 'request-bbbbbbbbbbbbbbbb']);
    expect(receipts.get('request-bbbbbbbbbbbbbbbb')?.status).toBe('uncertain');
    const db = gatewayDb(d);
    expect(db.prepare("SELECT rows, skipped FROM legacy_imports WHERE name='message-receipts.json'").get()).toMatchObject({ rows: 2, skipped: 1 });
    // Reopen: nothing is imported twice.
    closeAllGatewayDbs();
    expect(new RoutingState(d).history()).toHaveLength(5);
    expect(Number(gatewayDb(d).prepare('SELECT count(*) n FROM legacy_imports').get()!.n)).toBe(3);
  });
  it('re-importing a rolled-back file upserts rather than duplicating', () => {
    const d = legacyState();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    new RoutingState(d).record({ projectId: 'p', sessionId: 's', kind: 'new', detail: {} });
    closeAllGatewayDbs();
    const migrated = readdirSync(d).find((f) => f.startsWith('routing-history.json.migrated-'))!;
    writeFileSync(join(d, 'routing-history.json'), readFileSync(join(d, migrated)));
    expect(new RoutingState(d).history().map((r) => r.kind).filter((k) => k === 'k')).toHaveLength(5);
    expect(new RoutingState(d).history()).toHaveLength(6);
  });
  it('leaves an unparseable store file in place, logs it, and uses the empty table', () => {
    const d = dir(), path = join(d, 'routing-history.json');
    writeFileSync(path, '[{"broken"');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(new RoutingState(d).history()).toEqual([]);
    expect(err.mock.calls.flat().join(' ')).toMatch(/routing-history\.json did not parse.*left in place/);
    expect(readFileSync(path, 'utf8')).toBe('[{"broken"');
    new RoutingState(d).record({ projectId: 'p', sessionId: 's', kind: 'k', detail: {} });
    expect(new RoutingState(d).history()).toHaveLength(1);
  });
  it('sets an unparseable transcript-stats cache aside and starts empty', () => {
    const d = dir();
    writeFileSync(join(d, 'transcript-stats.json'), '{nope');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    new TranscriptStatsReader(d);
    expect(existsSync(join(d, 'transcript-stats.json'))).toBe(false);
    expect(readdirSync(d).some((f) => f.startsWith('transcript-stats.json.corrupt-'))).toBe(true);
  });
});

describe('transcript_stats', () => {
  const line = (n: number) => JSON.stringify({ type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 0, output_tokens: n } } }) + '\n';
  it('writes only the entries that changed and drops stale versions and vanished transcripts', () => {
    const d = dir(), a = join(d, 'a.jsonl'), b = join(d, 'b.jsonl');
    writeFileSync(a, line(1)); writeFileSync(b, line(2));
    const r = new TranscriptStatsReader(d);
    r.statsFor(a); r.statsFor(b);
    const db = gatewayDb(d), rows = () => db.prepare('SELECT path, version, data FROM transcript_stats ORDER BY path').all();
    const before = rows();
    expect(before).toHaveLength(2);
    writeFileSync(a, line(1) + line(5));
    r.statsFor(a);
    const after = rows();
    expect(after[1]).toEqual(before[1]);
    expect(after[0]).not.toEqual(before[0]);
    db.prepare("INSERT INTO transcript_stats VALUES('/stale', 3, '{}')").run();
    unlinkSync(b);
    expect(new TranscriptStatsReader(d).statsFor(a).usage.output).toBe(6);
    expect(rows().map((x) => x.path)).toEqual([a]);
  });
});

describe('routing_history', () => {
  it(`keeps the newest ${ROUTING_HISTORY_CAP} rows`, () => {
    const d = dir(), s = new RoutingState(d), db = gatewayDb(d);
    transaction(db, () => {
      for (let i = 0; i < ROUTING_HISTORY_CAP + 2; i++) s.record({ projectId: 'p', sessionId: 's', kind: 'k' + i, detail: {} });
    });
    const h = s.history('p');
    expect(h).toHaveLength(ROUTING_HISTORY_CAP);
    expect(h[0].kind).toBe('k' + (ROUTING_HISTORY_CAP + 1));
    expect(h.at(-1)!.kind).toBe('k2');
  });
});

describe('message_receipts retention', () => {
  it('drops receipts older than 30 days only beyond the newest 5000', () => {
    const d = dir(), db = gatewayDb(d), old = Date.now() - RECEIPT_KEEP_MS - 1000;
    transaction(db, () => {
      for (let i = 0; i < RECEIPT_KEEP_ROWS + 3; i++) putReceipt(db, { requestId: 'old-' + i, hash: 'h', status: 'accepted', at: old }, old + i);
      putReceipt(db, { requestId: 'fresh', hash: 'h', status: 'accepted', at: Date.now() });
    });
    const store = new DeliveryStore(d);
    expect(Object.keys(store.all())).toHaveLength(RECEIPT_KEEP_ROWS);
    expect(store.get('fresh')).toBeDefined();
    expect(store.get('old-3')).toBeUndefined();
    expect(store.get('old-4')).toBeDefined();
  });
  it('keeps everything younger than 30 days even past 5000 rows', () => {
    const d = dir(), db = gatewayDb(d), now = Date.now();
    transaction(db, () => { for (let i = 0; i < RECEIPT_KEEP_ROWS + 3; i++) putReceipt(db, { requestId: 'r-' + i, hash: 'h', status: 'accepted', at: now }, now - i); });
    expect(Object.keys(new DeliveryStore(d).all())).toHaveLength(RECEIPT_KEEP_ROWS + 3);
  });
});

describe('artifacts', () => {
  it('imports the library in its order, keeps removed rows soft, and puts new ones on top', () => {
    const d = dir(), row = (id: string, removed?: boolean) => ({ id, projectId: 'p', sessionId: 's', title: id, kind: 'test', summary: id, at: '2026-01-01T00:00:00.000Z', source: 'response', ...(removed ? { removed } : {}) });
    writeFileSync(join(d, 'artifacts.json'), JSON.stringify([row('c'), row('b', true), row('a')]));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new ArtifactStore(d, () => []);
    expect(store.list().map((a) => a.id)).toEqual(['c', 'a']);
    const added = store.add({ projectId: 'p', sessionId: 's', title: 'n', kind: 'test', summary: 'new', source: 'response' });
    expect(store.list().map((a) => a.id)).toEqual([added.id, 'c', 'a']);
    // Same test summary in the same conversation: reused, not duplicated.
    expect(store.add({ projectId: 'p', sessionId: 's', title: 'n', kind: 'test', summary: 'new', source: 'response' }).id).toBe(added.id);
    // A manual re-add revives the soft-removed row in its old place.
    expect(store.add({ projectId: 'p', sessionId: 's', title: 'b', kind: 'test', summary: 'b', source: 'manual' }).id).toBe('b');
    expect(store.list().map((a) => a.id)).toEqual([added.id, 'c', 'b', 'a']);
    store.remove('c');
    expect(store.fileFor('c')).toBeUndefined();
    expect(Number(gatewayDb(d).prepare('SELECT count(*) n FROM artifacts').get()!.n)).toBe(4);
  });
});
