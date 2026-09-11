import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const { backup, DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ProjectRegistry } from './projects.js';
import { ProjectSpaceRegistry } from './project-space-registry.js';

const JSON_FILES = ['project-space-runtime.json','project-dispatches.jsonl','projects.json','project-spaces.json','project-space-migration.json','state.json','accounts.json','queues.json','autopilot.json','cron.json','questions.json','mcp-approvals.json','artifacts.json','conversation-routing.json','routing-history.json','provider-handoffs.json','project-handoffs.json','chat-requirements.json','message-receipts.json'];
const DATABASES = ['chat-files.sqlite','memory.sqlite'];
const DIRECTORIES = ['artifacts','chats','project-files','memory-extractions'];
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
  return [...JSON_FILES, ...DIRECTORIES, ...DATABASES, ...(wal ? DATABASES.map(p => p + '-wal') : [])].flatMap(p => entries(root, p))
    // Opening an offline WAL database may create an empty WAL. It contains no
    // frames and is not a source write; committed pages still change its hash.
    .filter(e => !(DATABASES.some(db => e.path === db + '-wal') && e.link === undefined && (e.bytes ?? 0) <= 32)).sort((a,b) => a.path.localeCompare(b.path));
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
  for (const row of readJSON('artifacts.json', [])) { counts.artifacts++; if (!ids.has(row.projectId) && !(ownerIds.has(row.projectId) && !row.sessionId)) issues.push({ store: 'artifacts', id: row.id, reason: 'Source Project unavailable' }); }
  const runtime=readJSON('project-space-runtime.json',{}),pendingArchives=registry.pendingArchiveOperations().map(o=>o.id);
  return { runtime:{enabled:runtime.enabled,pending:runtime.pending?.id},pendingArchives,registry: registry.migrateSpaces(), spaces: { count: spaces.spaces.length, revision: spaces.revision, pendingOperations: spaces.operations.filter(o => o.state === 'pending').map(o => o.id) }, counts, issues, ready: !issues.length && !spaces.operations.some(o=>o.state==='pending') && !runtime.pending && !pendingArchives.length && !registry.migrateSpaces().invalidParents.length };
}
