import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export type Db = SQLiteDatabase;
/** Migration N (1-based) runs once, in its own BEGIN IMMEDIATE, and leaves
 *  `user_version = N`. Never edit a shipped migration: append a new one. */
export type Migration = (db: Db) => void;

/**
 * Open a SQLite database with the gateway's standard settings.
 *
 * WAL + synchronous=NORMAL: a commit is an append to the WAL with no fsync, so
 * a write costs microseconds; a power cut can lose the last few commits but
 * never corrupts the file. Refuses a database whose `user_version` is newer
 * than the migrations this build knows: an older image must not write into a
 * schema it does not understand.
 */
export function openDb(path: string, opts: { migrations: Migration[]; readOnly?: boolean }): Db {
  if (!opts.readOnly) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, opts.readOnly ? { readOnly: true } : {});
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (!opts.readOnly) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON');
    const version = userVersion(db);
    if (version > opts.migrations.length)
      throw new Error(`${path} has schema version ${version}, newer than this build understands (${opts.migrations.length})`);
    if (opts.readOnly) return db;
    for (let n = version + 1; n <= opts.migrations.length; n++) {
      db.exec('BEGIN IMMEDIATE');
      try {
        // Another process may have migrated while we waited for the lock.
        if (userVersion(db) >= n) { db.exec('COMMIT'); continue; }
        opts.migrations[n - 1](db);
        db.exec(`PRAGMA user_version=${n}`);
        db.exec('COMMIT');
      } catch (e) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw e;
      }
    }
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

export function userVersion(db: Db): number {
  return Number(Object.values(db.prepare('PRAGMA user_version').get() ?? {})[0] ?? 0);
}

/** Run `fn` in one IMMEDIATE transaction; inside an open one it just runs. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw e;
  }
}

export function hasTable(db: Db, name: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
