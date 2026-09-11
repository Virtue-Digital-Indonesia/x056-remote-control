import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { backup, DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ProjectRegistry } from './projects.js';

const JSON_FILES = ['projects.json','state.json','accounts.json','queues.json','autopilot.json','cron.json','questions.json','artifacts.json','conversation-routing.json','routing-history.json','provider-handoffs.json','project-handoffs.json','chat-requirements.json','message-receipts.json'];
const DATABASES = ['chat-files.sqlite','memory.sqlite'];
const DIRECTORIES = ['artifacts','chats','project-files'];
interface SnapshotFile { path: string; hash?: string; link?: string; bytes?: number }
interface Snapshot { schemaVersion: 1; createdAt: string; source: string; files: SnapshotFile[]; databases: string[] }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function entries(root: string, name: string): SnapshotFile[] {
  const full = join(root, name); if (!existsSync(full)) { try { lstatSync(full); } catch { return []; } }
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) return [{ path: name, link: readlinkSync(full) }];
  if (stat.isDirectory()) return readdirSync(full).sort().flatMap(child => entries(root, join(name, child)));
  if (!stat.isFile()) throw new Error('Backup contains an unsupported file: ' + name);
  return [{ path: name, hash: hash(readFileSync(full)), bytes: stat.size }];
}
function inventory(root: string, wal: boolean): SnapshotFile[] {
  return [...JSON_FILES, ...DIRECTORIES, ...DATABASES, ...(wal ? DATABASES.map(p => p + '-wal') : [])].flatMap(p => entries(root, p)).sort((a,b) => a.path.localeCompare(b.path));
}
function checkPath(path: string) {
  if (path !== relative('.', path) || path.startsWith('..') || path.startsWith(sep)) throw new Error('Invalid backup path');
}

/** Run only after all state writers have stopped. SQLite's backup API includes
 * WAL pages. A second inventory rejects writes racing the cross-store copy. */
export async function backupProjectSpaces(source: string, output: string, offline: boolean): Promise<Snapshot> {
  if (!offline) throw new Error('Stop all gateway and provider writers, then explicitly choose offline backup');
  source = realpathSync(source); output = resolve(output);
  if (output === source || output.startsWith(source + sep) || existsSync(output)) throw new Error('Choose a new backup directory outside the source state');
  const before = inventory(source, true), databases: string[] = [];
  mkdirSync(output, { recursive: true, mode: 0o700 });
  try {
    for (const entry of before) {
      if (DATABASES.some(db => entry.path === db || entry.path === db + '-wal')) continue;
      const dest = join(output, entry.path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (entry.link !== undefined) symlinkSync(entry.link, dest); else copyFileSync(join(source, entry.path), dest);
    }
    for (const name of DATABASES) {
      if (!existsSync(join(source, name))) continue;
      const db = new DatabaseSync(join(source, name), { readOnly: true });
      try { await backup(db, join(output, name)); } finally { db.close(); }
      const saved = new DatabaseSync(join(output, name), { readOnly: true });
      try { if (Object.values(saved.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok') throw new Error('Backup database failed integrity check'); } finally { saved.close(); }
      databases.push(name);
    }
    if (JSON.stringify(before) !== JSON.stringify(inventory(source, true))) throw new Error('State changed during backup; stop writers and retry');
    const files = inventory(output, false);
    for (const original of before.filter(e => !DATABASES.some(db => e.path === db || e.path === db + '-wal'))) {
      const copied = files.find(e => e.path === original.path);
      if (!copied || copied.hash !== original.hash || copied.link !== original.link) throw new Error('Copied file differs: ' + original.path);
    }
    const manifest: Snapshot = { schemaVersion: 1, createdAt: new Date().toISOString(), source, files, databases };
    writeFileSync(join(output, 'project-spaces-snapshot.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return manifest;
  } catch (error) { rmSync(output, { recursive: true, force: true }); throw error; }
}

/** Restore into a new directory, never overwrite live state or newer writes. */
export function restoreProjectSpaces(snapshotPath: string, output: string): Snapshot {
  const snapshot: Snapshot = JSON.parse(readFileSync(join(snapshotPath, 'project-spaces-snapshot.json'), 'utf8'));
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.files)) throw new Error('Invalid snapshot manifest');
  if (existsSync(output)) throw new Error('Restore requires a new empty location; preserve the current state first');
  const links = snapshot.files.filter(e => e.link !== undefined).map(e => e.path + sep);
  for (const entry of snapshot.files) {
    checkPath(entry.path);
    if (links.some(prefix => entry.path.startsWith(prefix))) throw new Error('Snapshot paths cannot descend through a symlink');
    const actual = entries(snapshotPath, entry.path);
    if (actual.length !== 1 || actual[0].hash !== entry.hash || actual[0].link !== entry.link) throw new Error('Snapshot verification failed: ' + entry.path);
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const entry of snapshot.files) {
    const target = join(output, entry.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.link !== undefined) symlinkSync(entry.link, target); else copyFileSync(join(snapshotPath, entry.path), target);
  }
  return snapshot;
}

/** Read-only report. Missing references are repair requests, not instructions
 * to discard history or infer memberships from directory names. */
export function projectSpacesRecoveryReport(state: string) {
  const registry = ProjectRegistry.load(join(state, 'projects.json')), projects = registry.list(), ids = new Set(projects.map(p => p.id));
  const issues: { store: string; id: string; reason: string }[] = [];
  const counts = { files: 0, versions: 0, memories: 0, queues: 0, artifacts: 0 };
  const checkSession = (pid: string, sid?: string) => ids.has(pid) && (!sid || projects.find(p => p.id === pid)?.conversations?.some(c => c.sessionId === sid));
  const readJSON = (name: string, fallback: any) => existsSync(join(state, name)) ? JSON.parse(readFileSync(join(state, name), 'utf8')) : fallback;
  const queues = readJSON('queues.json', {}) as Record<string, { id: string; sessionId?: string; fileRefs?: { ownerId?: string; fileId: string; versionId: string }[] }[]>;
  const catalog = existsSync(join(state, 'chat-files.sqlite')) ? new DatabaseSync(join(state, 'chat-files.sqlite'), { readOnly: true }) : undefined;
  try {
    if (catalog) {
      counts.files = Number(catalog.prepare('SELECT count(*) n FROM files').get()!.n); counts.versions = Number(catalog.prepare('SELECT count(*) n FROM versions').get()!.n);
      for (const row of catalog.prepare('PRAGMA foreign_key_check').all()) issues.push({ store: 'files', id: String(row.rowid), reason: 'Broken database reference' });
      for (const row of catalog.prepare('SELECT id,chatId,latestVersionId FROM files').all()) {
        if (!ids.has(String(row.chatId))) issues.push({ store: 'files', id: String(row.id), reason: 'Owner unavailable' });
        if (!catalog.prepare('SELECT id FROM versions WHERE id=? AND fileId=?').get(row.latestVersionId!, row.id!)) issues.push({ store: 'files', id: String(row.id), reason: 'Latest version unavailable' });
      }
      for (const v of catalog.prepare('SELECT id,blob,hash FROM versions').all()) {
        const blob = String(v.blob), full = join(state, 'artifacts', blob);
        if (blob.includes('/') || blob.includes('\\') || !existsSync(full) || hash(readFileSync(full)) !== v.hash) issues.push({ store: 'files', id: String(v.id), reason: 'Saved bytes missing or damaged' });
      }
    }
    for (const [pid, rows] of Object.entries(queues)) for (const row of rows) {
      counts.queues++;
      if (!checkSession(pid, row.sessionId)) issues.push({ store: 'queues', id: row.id, reason: 'Execution target unavailable' });
      for (const ref of row.fileRefs || []) if (!catalog?.prepare('SELECT v.id FROM versions v JOIN files f ON f.id=v.fileId WHERE v.id=? AND f.id=? AND f.chatId=?').get(ref.versionId, ref.fileId, ref.ownerId || pid)) issues.push({ store: 'queues', id: row.id, reason: 'Saved file reference unavailable' });
    }
  } finally { catalog?.close(); }
  const memory = existsSync(join(state, 'memory.sqlite')) ? new DatabaseSync(join(state, 'memory.sqlite'), { readOnly: true }) : undefined;
  try {
    if (memory) for (const row of memory.prepare('SELECT id,data FROM memory_entries').all()) {
      counts.memories++; const e = JSON.parse(String(row.data));
      if ((e.projectId && !ids.has(e.projectId)) || (e.sharedProjectIds || []).some((id: string) => !ids.has(id))) issues.push({ store: 'memory', id: String(row.id), reason: 'Owning or shared Project unavailable' });
    }
  } finally { memory?.close(); }
  for (const row of readJSON('artifacts.json', [])) { counts.artifacts++; if (!ids.has(row.projectId)) issues.push({ store: 'artifacts', id: row.id, reason: 'Source Project unavailable' }); }
  return { registry: registry.migrateSpaces(), counts, issues, ready: !issues.length && !registry.migrateSpaces().invalidParents.length };
}
