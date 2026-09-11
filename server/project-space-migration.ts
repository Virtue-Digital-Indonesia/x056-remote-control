import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectConflict, ProjectRegistry } from './projects.js';
import { ProjectSpaceRegistry, type ReviewedSpaceImport } from './project-space-registry.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameIds = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

interface OwnedNote { id: string; revision: number; projectId?: string; sessionId?: string; scope: string }
interface OwnedSource { id: string; projectId: string; sessionId?: string; kind: string; hash: string }
interface OwnedFile { id: string; chatId: string; ownerKind: string; latestVersionId: string }
export interface SpaceMigrationCandidate {
  projectId: string; name: string; cwd?: string; archived: boolean; hasWork: boolean;
  requiresMapping: boolean; memberChats: string[]; memoryIds: string[]; sourceIds: string[]; fileIds: string[];
}
export interface SpaceMigrationPlan {
  operationId: string; fingerprint: string; expectedRevision: number; expectedTopology: string; imports: ReviewedSpaceImport[];
}

/** Read identities and revisions through SQLite, including committed WAL pages.
 * Do not initialize stores, migrate schemas, or change execution epochs here. */
export function inspectSpaceMigration(stateDir: string) {
  const projectPath = join(stateDir, 'projects.json'), projects = ProjectRegistry.load(projectPath).list();
  const spaces = new ProjectSpaceRegistry(stateDir, () => projects), state = spaces.snapshot();
  const notes: OwnedNote[] = [], sources: OwnedSource[] = [], files: OwnedFile[] = [];
  const storeFingerprints: unknown[] = [];
  const memoryPath = join(stateDir, 'memory.sqlite');
  if (existsSync(memoryPath)) {
    const db = new DatabaseSync(memoryPath, { readOnly: true });
    try {
      const entries = db.prepare('SELECT data FROM memory_entries ORDER BY id').all();
      const rawSources = db.prepare('SELECT data FROM memory_sources ORDER BY id').all();
      notes.push(...entries.map(row => JSON.parse(String(row.data)))); sources.push(...rawSources.map(row => JSON.parse(String(row.data))));
      storeFingerprints.push(entries, rawSources);
    } finally { db.close(); }
  }
  const filesPath = join(stateDir, 'chat-files.sqlite');
  if (existsSync(filesPath)) {
    const db = new DatabaseSync(filesPath, { readOnly: true });
    try {
      const hasOwnerKind = db.prepare('PRAGMA table_info(files)').all().some(c => c.name === 'ownerKind');
      files.push(...db.prepare(`SELECT id,chatId,latestVersionId,${hasOwnerKind ? 'ownerKind' : "'chat' AS ownerKind"} FROM files ORDER BY id`).all() as unknown as OwnedFile[]);
      storeFingerprints.push(files, db.prepare('SELECT id,fileId,hash FROM versions ORDER BY id').all());
    } finally { db.close(); }
  }
  const candidates: SpaceMigrationCandidate[] = projects.filter(p => p.kind !== 'chat' && !Object.hasOwn(state.aliases, p.id)).map(p => {
    const memberChats = projects.filter(c => c.kind === 'chat' && c.parentProjectId === p.id).map(c => c.id);
    const fileIds = files.filter(f => f.chatId === p.id && f.ownerKind === 'project').map(f => f.id);
    return { projectId: p.id, name: p.name, cwd: p.cwd, archived: !!p.archivedAt, hasWork: !!p.cwd,
      requiresMapping: !!p.creationRequestId || !!memberChats.length || !!fileIds.length,
      memberChats, fileIds,
      memoryIds: notes.filter(e => e.projectId === p.id && !e.sessionId && e.scope !== 'conversation' && e.scope !== 'global').map(e => e.id),
      sourceIds: sources.filter(s => s.projectId === p.id && !s.sessionId && s.kind !== 'conversation').map(s => s.id) };
  });
  const issues: string[] = [];
  for (const p of projects) {
    if (p.parentProjectId && (p.kind !== 'chat' || !projects.some(parent => parent.id === p.parentProjectId && parent.kind !== 'chat'))) issues.push('Invalid legacy parent: ' + p.id);
    if (p.conversations?.length && !p.cwd) issues.push('Conversation workspace unavailable: ' + p.id);
  }
  for (const f of files) if (!projects.some(p => p.id === f.chatId) && !state.spaces.some(s => s.id === f.chatId)) issues.push('File owner unavailable: ' + f.id);
  const extra = ['mcp-approvals.json', 'queues.json','autopilot.json','cron.json','project-handoffs.json'].map(name => { const path = join(stateDir, name); return [name, existsSync(path) ? hash(readFileSync(path, 'utf8')) : null]; });
  return { fingerprint: hash([existsSync(projectPath) ? readFileSync(projectPath, 'utf8') : null, state, storeFingerprints, extra]),
    topology: spaces.topology(), revision: state.revision, candidates, issues,
    requiresReview: candidates.some(c => c.requiresMapping), counts: { projects: projects.length, spaces: state.spaces.length, notes: notes.length, sources: sources.length, files: files.length } };
}

export function applySpaceMigration(stateDir: string, plan: SpaceMigrationPlan) {
  const registry = new ProjectSpaceRegistry(stateDir, () => ProjectRegistry.load(join(stateDir, 'projects.json')).list());
  // A completed or interrupted migration reuses its exact persisted intent even
  // when later writes have changed the report fingerprint.
  if (registry.snapshot().operations.some(o => o.id === plan.operationId)) return registry.importReviewed(plan.imports, plan.expectedRevision, plan.expectedTopology, plan.operationId, plan.fingerprint);
  const report = inspectSpaceMigration(stateDir);
  if (report.fingerprint !== plan.fingerprint || report.topology !== plan.expectedTopology || report.revision !== plan.expectedRevision) throw new ProjectConflict('State changed after migration review');
  if (report.issues.length) throw new Error('Repair migration issues first: ' + report.issues.join('; '));
  if (!Array.isArray(plan.imports) || !plan.imports.length) throw new Error('Review at least one Project mapping');
  const imported = new Set<string>();
  for (const input of plan.imports) {
    const candidate = report.candidates.find(c => c.projectId === input.legacyProjectId);
    if (!candidate || imported.has(input.legacyProjectId)) throw new Error('Unknown or duplicate legacy Project mapping');
    imported.add(input.legacyProjectId);
    if (typeof input.includeWork !== 'boolean' || input.includeWork !== candidate.hasWork) throw new Error('Preserve the original Work execution; empty Projects have no Work');
    for (const [mapping, ids] of [[input.memoryOwners, candidate.memoryIds], [input.sourceOwners, candidate.sourceIds]] as const) {
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !sameIds(Object.keys(mapping), ids)) throw new Error('Review every ambiguous memory and source owner explicitly');
      for (const owner of Object.values(mapping)) if (!owner || (owner.kind === 'space' ? owner.id !== input.spaceId : owner.kind !== 'execution' || owner.id !== candidate.projectId)) throw new Error('A migration cannot share ownership with an unrelated Project');
    }
    if (!Array.isArray(input.fileIds) || !sameIds(input.fileIds, candidate.fileIds)) throw new Error('Preserve every existing Project file in its reviewed Space');
  }
  if (report.candidates.some(c => c.requiresMapping && !imported.has(c.projectId))) throw new Error('Review all first-build Projects before applying migration');
  return registry.importReviewed(plan.imports, plan.expectedRevision, plan.expectedTopology, plan.operationId, plan.fingerprint);
}
