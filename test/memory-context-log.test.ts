import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, type MemoryContext } from '../server/memory-store.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

const S = MemoryStore as unknown as { CONTEXT_KEEP: number; CONTEXT_TRIM_EVERY: number };
const keep = S.CONTEXT_KEEP, every = S.CONTEXT_TRIM_EVERY;
const closers: { close(): void }[] = [];
afterEach(() => { S.CONTEXT_KEEP = keep; S.CONTEXT_TRIM_EVERY = every; for (const c of closers.splice(0)) c.close(); });
const ctx = (n: number): MemoryContext => ({ text: 't' + n, estimatedTokens: n, budget: 100, items: [], skipped: [], enabled: true });

describe('memory_contexts log', () => {
  it('is indexed on `at` without changing the schema version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-log-'));
    closers.push(new MemoryStore(dir));
    const db = new DatabaseSync(join(dir, 'memory.sqlite')); closers.push(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='memory_contexts_at'").get()).toBeTruthy();
    expect(Number(db.prepare('PRAGMA user_version').get()!.user_version)).toBe(4);
  });

  it('trims on the first insert and then every Nth, keeping the newest rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-log-'));
    S.CONTEXT_KEEP = 10; S.CONTEXT_TRIM_EVERY = 5;
    const first = new MemoryStore(dir); closers.push(first);
    const db = new DatabaseSync(join(dir, 'memory.sqlite')); closers.push(db);
    // Rows a previous gateway left over the cap: the first insert trims them.
    for (let i = 0; i < 25; i++) db.prepare('INSERT INTO memory_contexts VALUES(?,?,?,?,?)').run('old-' + i, 'p', 's', i, '{}');
    const count = () => Number(db.prepare('SELECT count(*) n FROM memory_contexts').get()!.n);
    first.recordContext('p', 's', 'claude', ctx(0));
    expect(count()).toBe(10);
    for (let i = 1; i <= 4; i++) first.recordContext('p', 's', 'claude', ctx(i));
    expect(count()).toBe(14); // under the cap + N-1 between trims
    first.recordContext('p', 's', 'claude', ctx(5));
    expect(count()).toBe(10);
    // The newest are what remain, and contextHistory still reads newest first.
    const history = first.contextHistory('p', 's');
    expect(history.slice(0, 6).map(r => r.estimatedTokens).sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(history.slice(6).every(r => r.estimatedTokens === undefined)).toBe(true);
    expect(db.prepare("SELECT count(*) n FROM memory_contexts WHERE id LIKE 'old-%'").get()!.n).toBe(4);
  });
});
