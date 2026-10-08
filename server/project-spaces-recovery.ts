import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { backup, DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ProjectRegistry } from './projects.js';
import { ProjectSpaceRegistry } from './project-space-registry.js';

const JSON_FILES = ['project-space-runtime.json','project-dispatches.jsonl','projects.json','project-spaces.json','project-space-migration.json','state.json','accounts.json','queues.json','autopilot.json','cron.json','questions.json','mcp-approvals.json','conversation-routing.json','routing-history.json','provider-handoffs.json','project-handoffs.json','chat-requirements.json','message-receipts.json'];
// The artifact library lives in gateway.sqlite (gateway-db.ts), so artifacts.json
// is no longer listed: a state this build has never opened still holds it and
// must be booted once (which imports it) before an offline backup.
const DATABASES = ['chat-files.sqlite','memory.sqlite','gateway.sqlite'];
const DIRECTORIES = ['artifacts','chats','project-files','memory-extractions'];
interface SnapshotFile { path: string; hash?: string; link?: string; bytes?: number }
export type BackupScope = 'full' | 'application-state';
const WORKTREE_EXCLUSION = 'chats/*/work';
function backupScope(value: unknown): BackupScope {
  if (value !== 'full' && value !== 'application-state') throw new Error('Invalid backup scope: ' + String(value));
  return value;
}
function excludedWorktree(path: string): boolean {
  const parts = path.split(sep);
  return parts.length >= 3 && parts[0] === 'chats' && parts[2] === 'work';
}
interface Snapshot { scope: BackupScope; excludedPathPatterns: string[]; schemaVersion: 1 | 2; createdAt: string; source: string; files: SnapshotFile[]; databases: string[] }
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
// Hashing is synchronous; one reusable buffer bounds allocations even across
// millions of small files, without retaining a whole workspace file in RAM.
const hashBuffer = Buffer.allocUnsafe(1024 * 1024);
function fileHash(path: string): string {
  const fd = openSync(path, 'r'), digest = createHash('sha256');
  try { let count: number; while ((count = readSync(fd, hashBuffer, 0, hashBuffer.length, null))) digest.update(hashBuffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return digest.digest('hex');
}
function* entries(root: string, name: string, scope: BackupScope = 'full'): Generator<SnapshotFile> {
  if (scope === 'application-state' && excludedWorktree(name)) return;
  const full = join(root, name);
  let stat;
  try { stat = lstatSync(full); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) { yield { path: name, link: readlinkSync(full) }; return; }
  if (stat.isDirectory()) {
    const directory = opendirSync(full);
    try { let child; while ((child = directory.readSync())) yield* entries(root, join(name, child.name), scope); }
    finally { directory.closeSync(); }
    return;
  }
  if (!stat.isFile()) throw new Error('Backup contains an unsupported file: ' + name);
  yield { path: name, hash: fileHash(full), bytes: stat.size };
}
function* inventory(root: string, wal: boolean, scope: BackupScope): Generator<SnapshotFile> {
  for (const name of [...JSON_FILES, ...DIRECTORIES, ...DATABASES, ...(wal ? DATABASES.map(p => p + '-wal') : [])]) {
    for (const entry of entries(root, name, scope)) {
      // An empty WAL created by opening an offline database has no committed pages.
      if (DATABASES.some(db => entry.path === db + '-wal') && entry.link === undefined && (entry.bytes ?? 0) <= 32) continue;
      yield entry;
    }
  }
}
function checkPath(path: string) {
  if (path !== relative('.', path) || path.startsWith('..') || path.startsWith(sep)) throw new Error('Invalid backup path');
}

interface SnapshotSummary { saved: number; databases: string[]; scope: BackupScope; excludedPathPatterns: string[] }
interface BackupOptions { summaryOnly?: boolean; scope?: BackupScope }

/** Run only after all state writers have stopped. SQLite's backup API includes
 * WAL pages. A second inventory rejects writes racing the cross-store copy.
 * summaryOnly also bounds the return value for the deployment CLI. */
export function backupProjectSpaces(source: string, output: string, offline: boolean, options: BackupOptions & { summaryOnly: true }): Promise<SnapshotSummary>;
export function backupProjectSpaces(source: string, output: string, offline: boolean, options?: BackupOptions & { summaryOnly?: false }): Promise<Snapshot>;
export async function backupProjectSpaces(source: string, output: string, offline: boolean, options?: BackupOptions): Promise<Snapshot | SnapshotSummary> {
  const scope = backupScope(options?.scope ?? 'full');
  const excludedPathPatterns = scope === 'application-state' ? [WORKTREE_EXCLUSION] : [];
  if (!offline) throw new Error('Stop all gateway and provider writers, then explicitly choose offline backup');
  source = realpathSync(source); output = resolve(output);
  if (output === source || output.startsWith(source + sep) || existsSync(output)) throw new Error('Choose a new backup directory outside the source state');
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const indexPath = join(output, '.snapshot-inventory.sqlite');
  let index: InstanceType<typeof DatabaseSync> | undefined;
  try {
    // Inventories can contain millions of workspace files. Keep them on disk,
    // including comparisons and sorting, instead of arrays and JSON strings.
    index = new DatabaseSync(indexPath);
    index.exec('PRAGMA journal_mode=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;');
    for (const table of ['before_files', 'after_files', 'copied_files']) index.exec(`CREATE TABLE ${table} (path TEXT PRIMARY KEY, data TEXT NOT NULL) WITHOUT ROWID`);
    const record = (table: string, root: string, wal: boolean) => {
      const insert = index!.prepare(`INSERT INTO ${table} VALUES (?, ?)`);
      index!.exec('BEGIN');
      try { for (const entry of inventory(root, wal, scope)) insert.run(entry.path, JSON.stringify(entry)); index!.exec('COMMIT'); }
      catch (error) { index!.exec('ROLLBACK'); throw error; }
    };
    record('before_files', source, true);
    const isDatabase = (path: string) => DATABASES.some(db => path === db || path === db + '-wal');
    for (const row of index.prepare('SELECT data FROM before_files ORDER BY path').iterate()) {
      const entry: SnapshotFile = JSON.parse(String(row.data));
      if (isDatabase(entry.path)) continue;
      const dest = join(output, entry.path); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      if (entry.link !== undefined) symlinkSync(entry.link, dest); else copyFileSync(join(source, entry.path), dest);
    }
    const databases: string[] = [];
    for (const name of DATABASES) {
      if (!existsSync(join(source, name))) continue;
      const db = new DatabaseSync(join(source, name), { readOnly: true });
      try { await backup(db, join(output, name)); } finally { db.close(); }
      const saved = new DatabaseSync(join(output, name), { readOnly: true });
      try { if (Object.values(saved.prepare('PRAGMA integrity_check').get()!)[0] !== 'ok') throw new Error('Backup database failed integrity check'); } finally { saved.close(); }
      databases.push(name);
    }
    record('after_files', source, true);
    if (index.prepare('SELECT data FROM before_files EXCEPT SELECT data FROM after_files LIMIT 1').get() ||
        index.prepare('SELECT data FROM after_files EXCEPT SELECT data FROM before_files LIMIT 1').get()) throw new Error('State changed during backup; stop writers and retry');
    record('copied_files', output, false);
    for (const row of index.prepare('SELECT b.path FROM before_files b LEFT JOIN copied_files c ON b.path=c.path WHERE c.data IS NULL OR b.data != c.data').iterate()) {
      if (!isDatabase(String(row.path))) throw new Error('Copied file differs: ' + row.path);
    }
    const manifest: Snapshot = { scope, excludedPathPatterns, schemaVersion: scope === 'full' ? 1 : 2, createdAt: new Date().toISOString(), source, files: [], databases };
    const fd = openSync(join(output, 'project-spaces-snapshot.json'), 'wx', 0o600);
    let saved = 0;
    try {
      writeFileSync(fd, JSON.stringify({ scope, excludedPathPatterns, schemaVersion: manifest.schemaVersion, createdAt: manifest.createdAt, source, databases }).slice(0, -1) + ',"files":[');
      for (const row of index.prepare('SELECT data FROM copied_files ORDER BY path').iterate()) {
        const data = String(row.data);
        writeFileSync(fd, (saved++ ? ',\n' : '\n') + data);
        // Existing programmatic callers may request the full legacy result;
        // the deployment CLI uses summaryOnly to stay bounded end to end.
        if (!options?.summaryOnly) manifest.files.push(JSON.parse(data));
      }
      writeFileSync(fd, '\n]}\n');
    } finally { closeSync(fd); }
    index.close(); index = undefined;
    rmSync(indexPath);
    return options?.summaryOnly ? { saved, databases, scope, excludedPathPatterns } : manifest;
  } catch (error) {
    index?.close(); rmSync(output, { recursive: true, force: true }); throw error;
  }
}

/** Restore into a new directory, never overwrite live state or newer writes. */
export function restoreProjectSpaces(snapshotPath: string, output: string): Snapshot {
  const snapshot: Snapshot = JSON.parse(readFileSync(join(snapshotPath, 'project-spaces-snapshot.json'), 'utf8'));
  if (![1, 2].includes(snapshot.schemaVersion) || !Array.isArray(snapshot.files)) throw new Error('Invalid snapshot manifest');
  // Legacy schema-1 manifests predate scope and always used the full selected roots.
  if (snapshot.schemaVersion === 2 && snapshot.scope !== 'application-state') throw new Error('Scoped snapshot must declare application-state scope');
  if (snapshot.schemaVersion === 1 && snapshot.scope !== undefined && snapshot.scope !== 'full') throw new Error('Scoped snapshot requires schema version 2');
  snapshot.scope = backupScope(snapshot.scope ?? 'full');
  const expectedExclusions = snapshot.scope === 'application-state' ? [WORKTREE_EXCLUSION] : [];
  if (snapshot.excludedPathPatterns !== undefined && JSON.stringify(snapshot.excludedPathPatterns) !== JSON.stringify(expectedExclusions)) throw new Error('Invalid snapshot exclusions');
  if (snapshot.scope === 'application-state' && snapshot.excludedPathPatterns === undefined) throw new Error('Scoped snapshot must declare exclusions');
  snapshot.excludedPathPatterns = expectedExclusions;
  if (existsSync(output)) throw new Error('Restore requires a new empty location; preserve the current state first');
  const links = snapshot.files.filter(e => e.link !== undefined).map(e => e.path + sep);
  for (const entry of snapshot.files) {
    checkPath(entry.path);
    if (snapshot.scope === 'application-state' && excludedWorktree(entry.path)) throw new Error('Snapshot contains an excluded worktree path');
    if (links.some(prefix => entry.path.startsWith(prefix))) throw new Error('Snapshot paths cannot descend through a symlink');
    const actual = [...entries(snapshotPath, entry.path)];
    if (actual.length !== 1 || actual[0].hash !== entry.hash || actual[0].link !== entry.link) throw new Error('Snapshot verification failed: ' + entry.path);
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const entry of snapshot.files) {
    const target = join(output, entry.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (entry.link !== undefined) symlinkSync(entry.link, target); else copyFileSync(join(snapshotPath, entry.path), target);
  }
  return snapshot;
}

/** The artifact library as the gateway will see it: gateway.sqlite, read-only
 *  and through SQLite (committed WAL pages included), plus a legacy
 *  artifacts.json the gateway has not imported yet, which wins by id exactly
 *  as the import would. Never initialises or migrates anything. */
function artifactRows(state: string): { id: string; projectId: string; sessionId?: string }[] {
  const rows = new Map<string, any>(), path = join(state, 'gateway.sqlite');
  if (existsSync(path)) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='artifacts'").get())
        for (const r of db.prepare('SELECT data FROM artifacts ORDER BY seq DESC').all()) { const a = JSON.parse(String(r.data)); rows.set(a.id, a); }
    } finally { db.close(); }
  }
  const legacy = join(state, 'artifacts.json');
  if (existsSync(legacy)) for (const a of JSON.parse(readFileSync(legacy, 'utf8'))) if (a && typeof a.id === 'string') rows.set(a.id, a);
  return [...rows.values()];
}

/** Read-only report. Missing references are repair requests, not instructions
 * to discard history or infer memberships from directory names. */
export function projectSpacesRecoveryReport(state: string) {
  const registry = ProjectRegistry.load(join(state, 'projects.json')), projects = registry.list(), ids = new Set(projects.map(p => p.id));
  const spaces = new ProjectSpaceRegistry(state, () => projects).snapshot();
  const ownerIds = new Set([...ids, ...spaces.spaces.map(s => s.id)]);
  const issues: { store: string; id: string; reason: string }[] = [];
  for (const binding of Object.values(spaces.bindings)) {
    const ref = binding.target, target = projects.find(p => p.id === ref.projectId);
    if (!target || (ref.kind === 'work-conversation' && !target.conversations?.some(c => c.sessionId === ref.sessionId))) issues.push({ store: 'spaces', id: ref.projectId, reason: 'Membership execution unavailable' });
  }
  const counts = { files: 0, versions: 0, memories: 0, queues: 0, artifacts: 0, aliases:0, leases:0, sources:0, sourceVersions:0, grants:0, documents:0, extractionJobs:0, passages:0, turnReferences:0, contexts:0 };
  const table=(db:InstanceType<typeof DatabaseSync>,name:string)=>!!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const checkSession = (pid: string, sid?: string) => ids.has(pid) && (!sid || projects.find(p => p.id === pid)?.conversations?.some(c => c.sessionId === sid));
  const readJSON = (name: string, fallback: any) => existsSync(join(state, name)) ? JSON.parse(readFileSync(join(state, name), 'utf8')) : fallback;
  const queues = readJSON('queues.json', {}) as Record<string, { id: string; sessionId?: string; fileRefs?: { ownerId?: string; fileId: string; versionId: string }[] }[]>;
  const catalog = existsSync(join(state, 'chat-files.sqlite')) ? new DatabaseSync(join(state, 'chat-files.sqlite'), { readOnly: true }) : undefined;
  try {
    if (catalog) {
      if(table(catalog,'file_owner_aliases'))for(const row of catalog.prepare('SELECT * FROM file_owner_aliases').all()){counts.aliases++;if(!ids.has(String(row.legacyOwnerId))||!spaces.spaces.some(s=>s.id===row.ownerId)||catalog.prepare('SELECT chatId FROM files WHERE id=?').get(row.fileId!)?.chatId!==row.ownerId)issues.push({store:'files',id:String(row.fileId),reason:'Invalid retained owner alias'});}
      if(table(catalog,'shared_leases'))for(const row of catalog.prepare('SELECT * FROM shared_leases').all()){counts.leases++;if(!ownerIds.has(String(row.ownerId))||!checkSession(String(row.executionId),String(row.sessionId)))issues.push({store:'files',id:String(row.token),reason:'Lease identity unavailable'});}
      counts.files = Number(catalog.prepare('SELECT count(*) n FROM files').get()!.n); counts.versions = Number(catalog.prepare('SELECT count(*) n FROM versions').get()!.n);
      for (const row of catalog.prepare('PRAGMA foreign_key_check').all()) issues.push({ store: 'files', id: String(row.rowid), reason: 'Broken database reference' });
      for (const row of catalog.prepare('SELECT id,chatId,latestVersionId FROM files').all()) {
        if (!ownerIds.has(String(row.chatId))) issues.push({ store: 'files', id: String(row.id), reason: 'Owner unavailable' });
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
      for (const ref of row.fileRefs || []) {const alias=catalog&&table(catalog,'file_owner_aliases')?catalog.prepare('SELECT ownerId FROM file_owner_aliases WHERE legacyOwnerId=? AND fileId=?').get(ref.ownerId||pid,ref.fileId):undefined; if (!catalog?.prepare('SELECT v.id FROM versions v JOIN files f ON f.id=v.fileId WHERE v.id=? AND f.id=? AND f.chatId=?').get(ref.versionId, ref.fileId, alias?.ownerId||ref.ownerId || pid)) issues.push({ store: 'queues', id: row.id, reason: 'Saved file reference unavailable' });}
    }
  } finally { catalog?.close(); }
  const memory = existsSync(join(state, 'memory.sqlite')) ? new DatabaseSync(join(state, 'memory.sqlite'), { readOnly: true }) : undefined;
  const fileCatalog=existsSync(join(state,'chat-files.sqlite'))?new DatabaseSync(join(state,'chat-files.sqlite'),{readOnly:true}):undefined;
  try {
    if(memory){
      const rows=(name:string)=>table(memory,name)?memory.prepare('SELECT * FROM '+name).all():[];
      const data=(name:string)=>rows(name).map(r=>JSON.parse(String(r.data)));
      const notes=data('memory_entries'),sources=data('memory_sources'),versions=data('memory_source_versions'),documents=data('memory_documents'),jobs=data('memory_extraction_jobs'),passages=data('memory_passages'),grants=data('memory_grants'),refs=data('memory_turn_references'),contexts=data('memory_contexts');
      Object.assign(counts,{memories:notes.length,sources:sources.length,sourceVersions:versions.length,documents:documents.length,extractionJobs:jobs.length,passages:passages.length,grants:grants.length,turnReferences:refs.length,contexts:contexts.length});
      const issue=(store:string,id:string,reason:string)=>issues.push({store,id,reason});
      const ownerValid=(o:any)=>!!o&&(o.kind==='space'?spaces.spaces.some(s=>s.id===o.id):o.kind==='execution'&&ids.has(o.id));
      const sourceVersion=(id:string,version:string)=>versions.some(s=>s.id===id&&(s.versionId||s.hash)===version);
      const noteVersion=(id:string,version:string)=>rows('memory_revisions').some(r=>r.id===id&&String(r.revision)===version);
      const selectionValid=(s:any)=>s?.kind==='source'?sourceVersion(s.id,s.version):s?.kind==='entry'&&noteVersion(s.id,s.version);
      const fileValid=(f:any)=>{if(!fileCatalog||!f)return false;const alias=table(fileCatalog,'file_owner_aliases')?fileCatalog.prepare('SELECT ownerId FROM file_owner_aliases WHERE legacyOwnerId=? AND fileId=?').get(f.ownerId,f.fileId):undefined;return !!fileCatalog.prepare('SELECT v.id FROM versions v JOIN files f ON f.id=v.fileId WHERE f.id=? AND v.id=? AND f.chatId=?').get(f.fileId,f.versionId,alias?.ownerId||f.ownerId);};
      for(const e of notes)if((e.projectId&&!ids.has(e.projectId))||(e.spaceId&&!spaces.spaces.some(s=>s.id===e.spaceId))||(e.sharedProjectIds||[]).some((id:string)=>!ids.has(id)))issue('memory',e.id,'Owning or shared Project unavailable');
      for(const o of rows('memory_owners'))if(!ownerValid({kind:o.owner_kind,id:o.owner_id})||!(o.subject_kind==='entry'?notes:sources).some(e=>e.id===o.subject_id))issue('memory',String(o.subject_id),'Reviewed ownership mapping unavailable');
      for(const source of sources){if(!sourceVersion(source.id,source.versionId||source.hash))issue('sources',source.id,'Active source version unavailable');if(source.spaceId&&!spaces.spaces.some(s=>s.id===source.spaceId)||source.projectId&&!ids.has(source.projectId))issue('sources',source.id,'Source owner unavailable');}
      for(const source of versions)if(source.document&&!fileValid(source.document.file))issue('sources',source.id,'Cited original file version unavailable');
      for(const doc of documents){if(!ownerValid(doc.owner)||!fileValid(doc.file))issue('documents',doc.id,'Document owner or original unavailable');if(!jobs.some(j=>j.id===doc.jobId&&j.sourceId===doc.id))issue('documents',doc.id,'Current extraction job unavailable');if(doc.activeVersionId&&!sourceVersion(doc.id,doc.activeVersionId))issue('documents',doc.id,'Active indexed version unavailable');}
      for(const job of jobs){if(!documents.some(d=>d.id===job.sourceId)||!fileValid(job.file))issue('extraction',job.id,'Extraction source or saved version unavailable');if(['queued','processing'].includes(job.state)&&!documents.some(d=>d.id===job.sourceId&&d.jobId===job.id&&d.generation===job.generation&&!d.excluded))issue('extraction',job.id,'Active worker generation is stale');}
      for(const passage of passages)if(!sourceVersion(passage.sourceId,passage.versionId)||!passage.locator||!passage.text?.trim())issue('passages',passage.id,'Passage version, locator or text unavailable');
      for(const grant of grants)if(!ownerValid(grant.owner)||!ownerValid(grant.recipient)||!(grant.subject.kind==='entry'?notes:sources).some(s=>s.id===grant.subject.id))issue('grants',grant.id,'Grant owner, recipient or subject unavailable');
      for(const set of refs){if(!checkSession(set.projectId,set.sessionId))issue('references',set.requestId,'Reference execution unavailable');for(const selection of set.selections)if(!selectionValid(selection)||selection.grantId&&!grants.some(g=>g.id===selection.grantId))issue('references',set.requestId,'Pinned revision or retained grant unavailable');}
      const checkSnapshot=(snapshot:any,id:string)=>{for(const p of snapshot?.passages||[])if(!passages.some(r=>r.id===p.id&&r.sourceId===p.sourceId&&r.versionId===p.versionId)&&!sourceVersion(p.sourceId,p.versionId))issue('contexts',id,'Cited passage history unavailable');for(const g of snapshot?.grants||[])if(!grants.some(row=>row.id===g.id))issue('contexts',id,'Retained sharing dependency unavailable');};
      for(const context of contexts)checkSnapshot(context,context.id);
      const handoffs=readJSON('project-handoffs.json',[]);for(const h of Array.isArray(handoffs)?handoffs:Object.values(handoffs.operations||handoffs))if(h&&typeof h==='object')checkSnapshot((h as any).memorySnapshot,(h as any).requestId||'handoff');
    }
  } finally { memory?.close();fileCatalog?.close(); }
  for (const row of artifactRows(state)) { counts.artifacts++; if (!ids.has(row.projectId) && !(ownerIds.has(row.projectId) && !row.sessionId)) issues.push({ store: 'artifacts', id: row.id, reason: 'Source Project unavailable' }); }
  const runtime=readJSON('project-space-runtime.json',{}),pendingArchives=registry.pendingArchiveOperations().map(o=>o.id);
  return { runtime:{enabled:runtime.enabled,pending:runtime.pending?.id},pendingArchives,registry: registry.migrateSpaces(), spaces: { count: spaces.spaces.length, revision: spaces.revision, pendingOperations: spaces.operations.filter(o => o.state === 'pending').map(o => o.id) }, counts, issues, ready: !issues.length && !spaces.operations.some(o=>o.state==='pending') && !runtime.pending && !pendingArchives.length && !registry.migrateSpaces().invalidParents.length };
}
