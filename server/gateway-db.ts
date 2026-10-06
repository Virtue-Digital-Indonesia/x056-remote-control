import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, transaction, type Db, type Migration } from './sqlite.js';
export { transaction } from './sqlite.js';

/**
 * `state/gateway.sqlite`: the gateway's busiest stores, which used to be whole
 * JSON files rewritten (and re-parsed) on every change.
 *
 *   transcript_stats  per-transcript token/Task cache   (was transcript-stats.json)
 *   routing_history   routing events, newest 3000       (was routing-history.json)
 *   message_receipts  panel send idempotency receipts   (was message-receipts.json)
 *   artifacts         the artifact library (soft-removed) (was artifacts.json)
 *   push_sent         push notification ids already sent (7 days), so a
 *                     restart does not send them again
 *   push_settings     per-device notification settings, keyed by a hash of
 *                     the device's push endpoint
 *   mcp_oauth(_clients) OAuth sign-ins to http MCP servers: client
 *                     registrations and the tokens the refresher keeps fresh
 *
 * ONE connection per state directory, opened lazily and shared by every store
 * instance (RoutingState is constructed per call all over the manager). Stores
 * call `gatewayDb()` on every operation and never keep the handle, so closing
 * it (shutdown, a test tearing a manager down) only means the next access
 * reopens it.
 *
 * Legacy JSON import rule (runs at every open, after migrations):
 *  - an old file that is PRESENT is imported in one transaction, upserting by
 *    its natural key (the file wins: after a rollback and roll-forward it is
 *    the newer truth), then renamed to `<name>.migrated-<ts>` and kept;
 *    rollback = rename it back and run the previous image;
 *  - rows that do not parse are skipped and counted; a file that does not
 *    parse AT ALL is left in place untouched, an error is logged, and the
 *    table is used as it is (a human must look at the file). The one
 *    exception is the transcript-stats cache, which is rebuildable: it is
 *    renamed `.corrupt-<ts>` and the cache starts empty.
 */
export const GATEWAY_DB = 'gateway.sqlite';
export const ROUTING_HISTORY_CAP = 3000;
/** Keep the newest ROUTING_HISTORY_CAP rows. Ids are an INTEGER PRIMARY KEY
 *  without AUTOINCREMENT and rows only ever leave from the bottom, so they are
 *  contiguous and `max(id) - cap` is the cut. The `ORDER BY id DESC LIMIT 1
 *  OFFSET cap` form walks 3000 wide table rows: 2.6 ms per routing event on
 *  the live data, against 0.3 ms for this. */
export function trimRoutingHistory(db: Db): void {
  db.prepare(`DELETE FROM routing_history WHERE id <= (SELECT max(id) FROM routing_history) - ${ROUTING_HISTORY_CAP}`).run();
}

const MIGRATIONS: Migration[] = [
  (db) => db.exec(`
    CREATE TABLE legacy_imports(name TEXT NOT NULL, at INTEGER NOT NULL, rows INTEGER NOT NULL, skipped INTEGER NOT NULL, renamed_to TEXT);
    CREATE TABLE transcript_stats(path TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE routing_history(id INTEGER PRIMARY KEY, record_id TEXT NOT NULL UNIQUE, at TEXT NOT NULL, project_id TEXT, session_id TEXT, data TEXT NOT NULL);
    CREATE INDEX routing_history_project ON routing_history(project_id, session_id, id);
    CREATE INDEX routing_history_session ON routing_history(session_id, id);
    CREATE TABLE message_receipts(request_id TEXT PRIMARY KEY, project_id TEXT, session_id TEXT, status TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX message_receipts_status ON message_receipts(status);
    CREATE INDEX message_receipts_updated ON message_receipts(updated_at);
  `),
  // `seq` is the library order (newest = highest); rowid is not stable across
  // VACUUM for a table with a TEXT primary key.
  (db) => db.exec(`
    CREATE TABLE artifacts(id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project_id TEXT, session_id TEXT, removed INTEGER NOT NULL DEFAULT 0, created_at TEXT, data TEXT NOT NULL);
    CREATE INDEX artifacts_seq ON artifacts(seq);
    CREATE INDEX artifacts_scope ON artifacts(project_id, session_id, seq);
    CREATE INDEX artifacts_removed ON artifacts(removed, seq);
  `),
  (db) => db.exec(`
    CREATE TABLE push_sent(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE INDEX push_sent_at ON push_sent(at);
    CREATE TABLE push_settings(device TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `),
  // MCP OAuth sign-in (server/mcp-oauth.ts). A client registration is kept
  // per (server, issuer, redirect_uri): a different callback URL needs a new
  // registration. Tokens never leave through any API.
  (db) => db.exec(`
    CREATE TABLE mcp_oauth_clients(name TEXT NOT NULL, issuer TEXT NOT NULL, redirect_uri TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT, auth_method TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(name, issuer, redirect_uri));
    CREATE TABLE mcp_oauth(name TEXT PRIMARY KEY, issuer TEXT NOT NULL, token_endpoint TEXT NOT NULL, client_id TEXT NOT NULL, client_secret TEXT, auth_method TEXT NOT NULL, redirect_uri TEXT NOT NULL, resource TEXT, scope TEXT,
      access_token TEXT, refresh_token TEXT, expires_at INTEGER, signed_in_at INTEGER NOT NULL, last_refresh_at INTEGER, applied_hash TEXT, apply_error TEXT, error TEXT, failures INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER);
  `),
];

type Row = Record<string, unknown>;
const isObject = (x: unknown): x is Row => !!x && typeof x === 'object' && !Array.isArray(x);

interface LegacyFile {
  name: string;
  /** A rebuildable cache: an unparseable file is set aside, not kept. */
  cache?: boolean;
  /** Write the parsed file into the tables; returns [imported, skipped]. */
  load(db: Db, raw: unknown): [number, number];
}

export function putRoute(db: Db, row: Row): void {
  db.prepare(`INSERT INTO routing_history(record_id, at, project_id, session_id, data) VALUES(?,?,?,?,?)
    ON CONFLICT(record_id) DO UPDATE SET data=excluded.data`).run(
    String(row.id), String(row.at ?? ''), str(row.projectId), str(row.sessionId), JSON.stringify(row));
}
export function putReceipt(db: Db, row: Row, updatedAt = Date.now()): void {
  db.prepare(`INSERT INTO message_receipts(request_id, project_id, session_id, status, updated_at, data) VALUES(?,?,?,?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET project_id=excluded.project_id, session_id=excluded.session_id, status=excluded.status, updated_at=excluded.updated_at, data=excluded.data`).run(
    String(row.requestId), str(row.projectId), str(row.sessionId), String(row.status), updatedAt, JSON.stringify(row));
}
/** Insert or update an artifact; a new one goes to the top of the library,
 *  an existing one keeps its place. */
export function putArtifact(db: Db, row: Row): void {
  db.prepare(`INSERT INTO artifacts(id, seq, project_id, session_id, removed, created_at, data)
    VALUES(?, (SELECT coalesce(max(seq), 0) + 1 FROM artifacts), ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id, session_id=excluded.session_id, removed=excluded.removed, created_at=excluded.created_at, data=excluded.data`).run(
    String(row.id), str(row.projectId), str(row.sessionId), row.removed ? 1 : 0, str(row.at), JSON.stringify(row));
}
const str = (x: unknown) => (typeof x === 'string' ? x : null);

const LEGACY: LegacyFile[] = [
  {
    name: 'transcript-stats.json',
    cache: true,
    load(db, raw) {
      // A bare map (v1) or no `entries`: nothing comparable to import.
      if (!isObject(raw) || !isObject(raw.entries)) return [0, 0];
      const version = typeof raw.v === 'number' ? raw.v : 0;
      const put = db.prepare('INSERT INTO transcript_stats(path, version, data) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET version=excluded.version, data=excluded.data');
      let n = 0, bad = 0;
      for (const [path, entry] of Object.entries(raw.entries)) {
        if (!isObject(entry)) { bad++; continue; }
        put.run(path, version, JSON.stringify(entry)); n++;
      }
      return [n, bad];
    },
  },
  {
    name: 'routing-history.json',
    load(db, raw) {
      if (!Array.isArray(raw)) throw new Error('expected an array');
      let n = 0, bad = 0;
      // Newest first on disk; insert oldest first so ids ascend with time.
      for (const row of [...raw].reverse()) {
        if (!isObject(row) || typeof row.id !== 'string') { bad++; continue; }
        putRoute(db, row); n++;
      }
      // Exact count-based cut, once per import.
      db.prepare(`DELETE FROM routing_history WHERE id <= (SELECT id FROM routing_history ORDER BY id DESC LIMIT 1 OFFSET ${ROUTING_HISTORY_CAP})`).run();
      return [n, bad];
    },
  },
  {
    name: 'message-receipts.json',
    load(db, raw) {
      if (!isObject(raw)) throw new Error('expected an object keyed by request id');
      let n = 0, bad = 0;
      for (const [id, row] of Object.entries(raw)) {
        if (!isObject(row) || typeof row.status !== 'string') { bad++; continue; }
        putReceipt(db, { ...row, requestId: id }, typeof row.at === 'number' ? row.at : Date.now()); n++;
      }
      return [n, bad];
    },
  },
  {
    name: 'artifacts.json',
    load(db, raw) {
      if (!Array.isArray(raw)) throw new Error('expected an array');
      let n = 0, bad = 0;
      // Newest first on disk: insert oldest first so it gets the lowest seq.
      for (const row of [...raw].reverse()) {
        if (!isObject(row) || typeof row.id !== 'string') { bad++; continue; }
        putArtifact(db, row); n++;
      }
      return [n, bad];
    },
  },
];

function importLegacy(db: Db, stateDir: string): void {
  for (const spec of LEGACY) {
    const file = join(stateDir, spec.name);
    if (!existsSync(file)) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      if (spec.cache) {
        const to = `${file}.corrupt-${stamp}`;
        try { renameSync(file, to); } catch { /* left for the next boot */ }
        console.error(`[gateway-db] ${spec.name} did not parse (${(e as Error).message}); set aside as ${to}, starting the cache empty`);
      } else {
        console.error(`[gateway-db] ${spec.name} did not parse (${(e as Error).message}); NOT imported, left in place for repair. Using ${GATEWAY_DB} as it is.`);
      }
      continue;
    }
    let counts: [number, number];
    try {
      counts = transaction(db, () => {
        const c = spec.load(db, raw);
        db.prepare('INSERT INTO legacy_imports(name, at, rows, skipped) VALUES(?,?,?,?)').run(spec.name, Date.now(), c[0], c[1]);
        return c;
      });
    } catch (e) {
      console.error(`[gateway-db] ${spec.name} could not be imported (${(e as Error).message}); left in place for repair.`);
      continue;
    }
    const to = `${file}.migrated-${stamp}`;
    try {
      renameSync(file, to);
      db.prepare('UPDATE legacy_imports SET renamed_to=? WHERE rowid=(SELECT max(rowid) FROM legacy_imports WHERE name=?)').run(to, spec.name);
    } catch (e) {
      // Imported but still present: the next open upserts it again, harmlessly.
      console.error(`[gateway-db] ${spec.name} imported but could not be renamed: ${(e as Error).message}`);
    }
    console.log(`[gateway-db] imported ${counts[0]} rows from ${spec.name}${counts[1] ? ` (${counts[1]} unreadable rows skipped)` : ''}`);
  }
}

/** The old writers left `<name>.tmp-<uuid>` (and `transcript-stats.json.tmp`)
 *  behind when interrupted; nothing writes those files any more. */
function removeStrayTemps(stateDir: string): void {
  let names: string[];
  try { names = readdirSync(stateDir); } catch { return; }
  for (const name of names)
    if (LEGACY.some((s) => name === s.name + '.tmp' || name.startsWith(s.name + '.tmp-')))
      try { unlinkSync(join(stateDir, name)); } catch { /* best effort */ }
}

const open = new Map<string, { db: Db; dev: number; ino: number }>();

/** The shared gateway database for a state directory, opened (migrated,
 *  legacy files imported) on first use. Cheap to call per operation. */
export function gatewayDb(stateDir: string): Db {
  mkdirSync(stateDir, { recursive: true });
  const key = realpathSync(stateDir), path = join(key, GATEWAY_DB);
  const hit = open.get(key);
  if (hit) {
    // A state directory removed and recreated (tests) must not keep writing
    // into the unlinked inode.
    try { const s = statSync(path); if (s.ino === hit.ino && s.dev === hit.dev) return hit.db; } catch { /* reopen */ }
    try { hit.db.close(); } catch { /* already closed */ }
    open.delete(key);
  }
  const db = openDb(path, { migrations: MIGRATIONS });
  try {
    importLegacy(db, key);
    removeStrayTemps(key);
  } catch (e) {
    db.close();
    throw e;
  }
  const s = statSync(path);
  open.set(key, { db, dev: s.dev, ino: s.ino });
  return db;
}

function closeEntry(db: Db): void {
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* still close */ }
  try { db.close(); } catch { /* already closed */ }
}
export function closeGatewayDb(stateDir: string): void {
  let key: string;
  try { key = realpathSync(stateDir); } catch { return; }
  const hit = open.get(key);
  if (!hit) return;
  open.delete(key);
  closeEntry(hit.db);
}
export function closeAllGatewayDbs(): void {
  for (const [key, hit] of open) { open.delete(key); closeEntry(hit.db); }
}
