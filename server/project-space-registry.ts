import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectConflict, validateModeDefaults, type Project } from './projects.js';
import { writeState } from './workspace-store.js';

export interface ExecutionRef { projectId: string; sessionId: string }
export type SpaceTarget = { kind: 'chat' | 'work-project'; projectId: string } | ({ kind: 'work-conversation' } & ExecutionRef);
export type SpaceAssignment = { mode: 'inherit' | 'standalone' } | { mode: 'space'; spaceId: string };
export interface ProjectSpace {
  id: string; name: string; revision: number; createdAt: number; archivedAt?: number;
  defaults?: Project['defaults']; requiredTools?: Project['requiredTools']; defaultWorkProjectId?: string;
}
export interface SpaceBinding { target: SpaceTarget; assignment: SpaceAssignment; revision: number }
export interface SpaceReference { id: string; spaceId: string; target: SpaceTarget }
export interface ResolvedSpace {
  spaceId?: string; workProjectId?: string; assignment: SpaceAssignment;
  membershipRevision: number; inherited: boolean; archived: boolean;
}
export interface SpaceImpact extends ExecutionRef { beforeSpaceId?: string; afterSpaceId?: string; membershipRevision: number }
export interface MembershipChange { target: SpaceTarget; assignment: SpaceAssignment; includeOverrides?: boolean }
export interface MembershipPreview extends MembershipChange {
  revision: number; topology: string; impactHash: string; affected: SpaceImpact[];
  exceptions: (ExecutionRef & { spaceId?: string; mode: string })[];
}
export interface SpaceOperation {
  id: string; kind: 'membership' | 'archive' | 'migration'; fingerprint: string; at: number;
  state: 'pending' | 'complete'; revision: number; affected: SpaceImpact[];
  change?: MembershipChange; spaceId?: string; archived?: boolean;
}
export interface SpaceOwner { kind: 'space' | 'execution'; id: string }
export interface ReviewedSpaceImport {
  legacyProjectId: string; spaceId: string; includeWork: boolean;
  memoryOwners: Record<string, SpaceOwner>; sourceOwners: Record<string, SpaceOwner>; fileIds: string[];
}
interface Receipt { fingerprint: string; resultId: string }
interface SpaceState {
  schemaVersion: 1; revision: number; spaces: ProjectSpace[]; bindings: Record<string, SpaceBinding>;
  epochs: Record<string, number>; references: SpaceReference[]; operations: SpaceOperation[];
  requests: Record<string, Receipt>; aliases: Record<string, string>;
  ownerOverrides: { memory: Record<string, SpaceOwner>; source: Record<string, SpaceOwner>; file: Record<string, string> };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const executionKey = (ref: ExecutionRef) => JSON.stringify([ref.projectId, ref.sessionId]);
const targetKey = (target: SpaceTarget) => JSON.stringify([target.kind, target.projectId, 'sessionId' in target ? target.sessionId : '']);
const empty = (): SpaceState => ({ schemaVersion: 1, revision: 0, spaces: [], bindings: {}, epochs: {}, references: [], operations: [], requests: {}, aliases: {}, ownerOverrides: { memory: {}, source: {}, file: {} } });
function operationId(id: string) { if (typeof id !== 'string' || !/^[\w:-]{8,160}$/.test(id)) throw new Error('A stable operationId is required'); }
function name(value: string) { if (typeof value !== 'string' || !value.trim() || value.length > 300) throw new Error('Use a Project name between 1 and 300 characters'); return value.trim(); }
export function validateRequirements(value: Project['requiredTools']) {
  if (value !== undefined && (!Array.isArray(value) || value.length > 40 || value.some(r => !r || typeof r.key !== 'string' || !/^(skill|plugin|mcp):.{1,240}$/.test(r.key) || (r.fingerprint !== undefined && (typeof r.fingerprint !== 'string' || r.fingerprint.length > 200))))) throw new Error('Invalid required tools');
}

/** Organization is separate from execution. Every mutation reloads the latest
 * state and writes synchronously; asynchronous effects are durable receipts. */
export class ProjectSpaceRegistry {
  private file: string;
  constructor(stateDir: string, private projects: () => Project[]) { this.file = join(stateDir, 'project-spaces.json'); }
  private read(): SpaceState {
    if (!existsSync(this.file)) return empty();
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as SpaceState;
      if (data.schemaVersion !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.spaces) || !Array.isArray(data.references) || !Array.isArray(data.operations)) throw new Error('Unsupported Space registry');
      for (const key of ['bindings', 'epochs', 'requests', 'aliases', 'ownerOverrides'] as const) if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) throw new Error('Invalid Space registry');
      for (const key of ['memory', 'source', 'file'] as const) if (!data.ownerOverrides[key] || typeof data.ownerOverrides[key] !== 'object' || Array.isArray(data.ownerOverrides[key])) throw new Error('Invalid owner mapping');
      const ids = new Set<string>();
      for (const s of data.spaces) {
        if (!s || typeof s.id !== 'string' || !/^space_[\w-]{8,160}$/.test(s.id) || ids.has(s.id) || !Number.isSafeInteger(s.revision)) throw new Error('Invalid Space identity');
        name(s.name); ids.add(s.id);
      }
      const targetValid = (t: SpaceTarget) => t && ['chat','work-project','work-conversation'].includes(t.kind) && typeof t.projectId === 'string' && !!t.projectId && (t.kind !== 'work-conversation' || (typeof t.sessionId === 'string' && !!t.sessionId));
      for (const [key, b] of Object.entries(data.bindings)) {
        if (!b || !targetValid(b.target) || key !== targetKey(b.target) || !Number.isSafeInteger(b.revision) || b.revision < 0 || !b.assignment || !['inherit','standalone','space'].includes(b.assignment.mode)) throw new Error('Invalid membership');
        if (b.assignment.mode === 'space' && !ids.has(b.assignment.spaceId)) throw new Error('Missing membership destination');
        if (b.assignment.mode === 'inherit' && b.target.kind !== 'work-conversation') throw new Error('Invalid inheritance');
      }
      for (const epoch of Object.values(data.epochs)) if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Invalid membership generation');
      for (const alias of Object.values(data.aliases)) if (!ids.has(alias)) throw new Error('Invalid legacy alias');
      for (const ref of data.references) if (!ref || !ids.has(ref.spaceId) || !targetValid(ref.target)) throw new Error('Invalid Project reference');
      for (const op of data.operations) if (!op || !['membership','archive','migration'].includes(op.kind) || !['pending','complete'].includes(op.state) || !Array.isArray(op.affected) || op.affected.some(r => !r || typeof r.projectId !== 'string' || typeof r.sessionId !== 'string')) throw new Error('Invalid operation receipt');
      for (const group of [data.ownerOverrides.memory, data.ownerOverrides.source]) for (const owner of Object.values(group)) if (!owner || !['space','execution'].includes(owner.kind) || typeof owner.id !== 'string' || (owner.kind === 'space' && !ids.has(owner.id))) throw new Error('Invalid memory owner mapping');
      for (const owner of Object.values(data.ownerOverrides.file)) if (!ids.has(owner)) throw new Error('Invalid file owner mapping');
      return data;
    } catch (error) { throw new Error('Cannot read Project spaces; restore or repair before writing: ' + (error as Error).message); }
  }
  private save(data: SpaceState) { writeState(this.file, data); }
  snapshot() { return this.read(); }
  list() { return this.read().spaces; }
  get(id: string, allowArchived = false): ProjectSpace {
    const data = this.read(), canonical = Object.hasOwn(data.aliases, id) ? data.aliases[id] : id;
    const space = data.spaces.find(s => s.id === canonical);
    if (!space) throw new Error('Project space not found');
    if (space.archivedAt && !allowArchived) throw new Error('Restore this Project first');
    return space;
  }
  canonical(id: string) { const d = this.read(); return Object.hasOwn(d.aliases, id) ? d.aliases[id] : id; }
  private assertTarget(target: SpaceTarget, projects: Project[]) {
    if (!target || !['chat', 'work-project', 'work-conversation'].includes(target.kind)) throw new Error('Choose a Chat, Work conversation or Work project');
    const project = projects.find(p => p.id === target.projectId);
    if (!project || (target.kind === 'chat') !== (project.kind === 'chat')) throw new Error('Execution target unavailable');
    if (target.kind === 'work-conversation' && !project.conversations?.some(c => c.sessionId === target.sessionId)) throw new Error('Work conversation unavailable');
    return project;
  }
  private assertAssignment(target: SpaceTarget, assignment: SpaceAssignment, data: SpaceState) {
    if (!assignment || !['space', 'standalone', 'inherit'].includes(assignment.mode)) throw new Error('Choose a Project, Standalone or Inherit');
    if (assignment.mode === 'inherit' && target.kind !== 'work-conversation') throw new Error('Only Work conversations inherit a Work project association');
    if (assignment.mode === 'space' && !data.spaces.some(s => s.id === assignment.spaceId && !s.archivedAt)) throw new Error('Choose an available Project space');
  }
  private executions(projects: Project[]): ExecutionRef[] { return projects.flatMap(p => (p.conversations || []).map(c => ({ projectId: p.id, sessionId: c.sessionId }))); }
  topology(projects = this.projects()) {
    return hash(projects.map(p => ({ id: p.id, kind: p.kind || 'project', cwd: p.cwd, archivedAt: p.archivedAt, sessions: (p.conversations || []).map(c => c.sessionId).sort() })).sort((a,b) => a.id.localeCompare(b.id)));
  }
  private resolveInside(data: SpaceState, projects: Project[], ref: ExecutionRef): ResolvedSpace {
    const p = projects.find(p => p.id === ref.projectId);
    if (!p || !p.conversations?.some(c => c.sessionId === ref.sessionId)) throw new Error('Conversation unavailable');
    let binding = data.bindings[targetKey(p.kind === 'chat' ? { kind: 'chat', projectId: p.id } : { kind: 'work-conversation', ...ref })];
    const inherited = p.kind !== 'chat' && (!binding || binding.assignment.mode === 'inherit');
    if (inherited) binding = data.bindings[targetKey({ kind: 'work-project', projectId: p.id })];
    const assignment = binding?.assignment || { mode: 'standalone' as const };
    const spaceId = assignment.mode === 'space' ? assignment.spaceId : undefined;
    const space = data.spaces.find(s => s.id === spaceId);
    if (spaceId && !space) throw new Error('Primary Project is missing; repair membership before dispatch');
    return { spaceId, assignment, workProjectId: p.kind !== 'chat' ? p.id : undefined, inherited,
      membershipRevision: Math.max(binding?.revision || 0, data.epochs[executionKey(ref)] || 0), archived: !!space?.archivedAt };
  }
  /** A synchronous read batch never carries a snapshot across an await or mutation. */
  readView(){const state=this.read(),projects=this.projects();return {state,projects,
    resolve:(projectId:string,sessionId:string)=>this.resolveInside(state,projects,{projectId,sessionId}),
    defaultForWork:(projectId:string)=>{const assignment=state.bindings[targetKey({kind:'work-project',projectId})]?.assignment;return assignment?.mode==='space'?assignment.spaceId:undefined;}};}
  resolve(projectId: string, sessionId: string) { return this.resolveInside(this.read(), this.projects(), { projectId, sessionId }); }
  defaultForWork(projectId: string) {
    this.assertTarget({ kind: 'work-project', projectId }, this.projects());
    const assignment = this.read().bindings[targetKey({ kind: 'work-project', projectId })]?.assignment;
    return assignment?.mode === 'space' ? assignment.spaceId : undefined;
  }
  members(spaceId: string) {
    const data = this.read(), projects = this.projects();
    return this.executions(projects).filter(ref => this.resolveInside(data, projects, ref).spaceId === spaceId);
  }
  private install(data: SpaceState, change: MembershipChange, projects: Project[]) {
    this.assertTarget(change.target, projects); this.assertAssignment(change.target, change.assignment, data);
    const key = targetKey(change.target), old = data.bindings[key];
    if (JSON.stringify(old?.assignment) !== JSON.stringify(change.assignment)) data.bindings[key] = { ...structuredClone(change), revision: data.revision };
    if (change.target.kind === 'work-project' && change.includeOverrides) {
      for (const c of projects.find(p => p.id === change.target.projectId)?.conversations || []) {
        const target: SpaceTarget = { kind: 'work-conversation', projectId: change.target.projectId, sessionId: c.sessionId };
        const key = targetKey(target); if (data.bindings[key]) data.bindings[key] = { target, assignment: { mode: 'inherit' }, revision: data.revision };
      }
    }
  }
  private impact(before: SpaceState, after: SpaceState, projects: Project[]) {
    return this.executions(projects).flatMap(ref => {
      const a = this.resolveInside(before, projects, ref), b = this.resolveInside(after, projects, ref);
      return a.spaceId !== b.spaceId || a.membershipRevision !== b.membershipRevision || a.archived !== b.archived
        ? [{ ...ref, beforeSpaceId: a.spaceId, afterSpaceId: b.spaceId, membershipRevision: after.revision }] : [];
    });
  }
  preview(change: MembershipChange): MembershipPreview {
    const data = this.read(), projects = this.projects(), next = structuredClone(data); next.revision++;
    if (change.includeOverrides !== undefined && (typeof change.includeOverrides !== 'boolean' || change.target.kind !== 'work-project')) throw new Error('Override selection applies to a whole Work project');
    this.install(next, change, projects);
    const affected = this.impact(data, next, projects), topology = this.topology(projects);
    const exceptions = change.target.kind === 'work-project' ? (projects.find(p => p.id === change.target.projectId)?.conversations || []).flatMap(c => {
      const ref = { projectId: change.target.projectId, sessionId: c.sessionId }, b = data.bindings[targetKey({ kind: 'work-conversation', ...ref })];
      return b && b.assignment.mode !== 'inherit' ? [{ ...ref, spaceId: b.assignment.mode === 'space' ? b.assignment.spaceId : undefined, mode: b.assignment.mode }] : [];
    }) : [];
    return { ...structuredClone(change), revision: data.revision, topology, affected, exceptions, impactHash: hash([change, data.revision, topology, affected, exceptions]) };
  }
  apply(input: MembershipChange & { operationId: string; expectedRevision: number; expectedTopology: string; expectedImpactHash: string }): SpaceOperation {
    operationId(input.operationId); const data = this.read(), fingerprint = hash(input);
    const old = data.operations.find(o => o.id === input.operationId);
    if (old) { if (old.fingerprint !== fingerprint) throw new ProjectConflict('operationId was used for another membership change'); return old; }
    const change: MembershipChange = { target: input.target, assignment: input.assignment, ...(input.includeOverrides !== undefined ? { includeOverrides: input.includeOverrides } : {}) };
    const preview = this.preview(change);
    if (preview.revision !== input.expectedRevision || preview.topology !== input.expectedTopology || preview.impactHash !== input.expectedImpactHash) throw new ProjectConflict('Membership or conversations changed; review the current impact');
    data.revision++; this.install(data, change, this.projects());
    for (const ref of preview.affected) data.epochs[executionKey(ref)] = data.revision;
    const op: SpaceOperation = { id: input.operationId, kind: 'membership', fingerprint, at: Date.now(), state: 'pending', revision: data.revision, affected: preview.affected, change };
    data.operations.push(op); this.save(data); return structuredClone(op);
  }
  pending() { return this.read().operations.filter(o => o.state === 'pending'); }
  complete(id: string) { const d = this.read(), o = d.operations.find(o => o.id === id); if (o && o.state !== 'complete') { o.state = 'complete'; this.save(d); } }
  assertReady(projectId: string, sessionId?: string) {
    const pending = this.pending().some(op => op.affected.some(ref => ref.projectId === projectId && (!sessionId || ref.sessionId === sessionId))
      || (!sessionId && op.change?.target.kind === 'work-project' && op.change.target.projectId === projectId));
    if (pending) throw new Error('Project membership is being reconciled; retry after review completes');
  }
  create(input: { requestId: string; name: string; defaults?: Project['defaults']; defaultWorkProjectId?: string }): ProjectSpace {
    operationId(input.requestId); validateModeDefaults(input.defaults); const label = name(input.name), data = this.read(), fingerprint = hash(input);
    const previous = Object.hasOwn(data.requests, input.requestId) ? data.requests[input.requestId] : undefined;
    if (previous) { if (previous.fingerprint !== fingerprint) throw new ProjectConflict('requestId was used for another Project'); return data.spaces.find(s => s.id === previous.resultId)!; }
    if (input.defaultWorkProjectId) this.assertTarget({ kind: 'work-project', projectId: input.defaultWorkProjectId }, this.projects());
    data.revision++;
    const space: ProjectSpace = { id: 'space_' + randomUUID(), name: label, revision: 1, createdAt: Date.now(), defaults: structuredClone(input.defaults), defaultWorkProjectId: input.defaultWorkProjectId };
    data.spaces.push(space); data.requests = { ...data.requests, [input.requestId]: { fingerprint, resultId: space.id } }; this.save(data); return space;
  }
  update(id: string, expectedRevision: number, patch: Partial<Pick<ProjectSpace, 'name' | 'defaults' | 'requiredTools' | 'defaultWorkProjectId'>>) {
    const data = this.read(), s = data.spaces.find(s => s.id === id);
    if (!s) throw new Error('Project space not found');
    if (s.revision !== expectedRevision) throw new ProjectConflict('Project changed; refresh before saving');
    if (patch.name !== undefined) patch = { ...patch, name: name(patch.name) };
    validateModeDefaults(patch.defaults); validateRequirements(patch.requiredTools);
    if (patch.defaultWorkProjectId) this.assertTarget({ kind: 'work-project', projectId: patch.defaultWorkProjectId }, this.projects());
    Object.assign(s, structuredClone(patch)); s.revision++; data.revision++; this.save(data); return s;
  }
  archive(id: string, archived: boolean, expectedRevision: number, expectedTopology: string, idempotencyKey: string): SpaceOperation {
    operationId(idempotencyKey); const data = this.read(), fingerprint = hash([id, archived, expectedRevision, expectedTopology]);
    const previous = data.operations.find(o => o.id === idempotencyKey);
    if (previous) { if (previous.fingerprint !== fingerprint) throw new ProjectConflict('operationId was used for another archive'); return previous; }
    const s = data.spaces.find(s => s.id === id), projects = this.projects();
    if (!s) throw new Error('Project space not found');
    if (typeof archived !== 'boolean' || s.revision !== expectedRevision || this.topology(projects) !== expectedTopology) throw new ProjectConflict('Project or conversations changed; review before archiving');
    const before = structuredClone(data); data.revision++; s.revision++; s.archivedAt = archived ? Date.now() : undefined;
    const affected = this.impact(before, data, projects); for (const ref of affected) data.epochs[executionKey(ref)] = data.revision;
    const op: SpaceOperation = { id: idempotencyKey, kind: 'archive', fingerprint, at: Date.now(), state: 'pending', revision: data.revision, affected, spaceId: id, archived };
    data.operations.push(op); this.save(data); return op;
  }
  addReference(spaceId: string, target: SpaceTarget, expectedRevision: number, requestId: string) {
    operationId(requestId); const data = this.read(), fingerprint = hash([spaceId, target, expectedRevision]);
    const old = Object.hasOwn(data.requests, requestId) ? data.requests[requestId] : undefined; if (old) { if (old.fingerprint !== fingerprint) throw new ProjectConflict('requestId already used'); return data.references.find(r => r.id === old.resultId); }
    if (!data.spaces.some(s => s.id === spaceId && !s.archivedAt)) throw new Error('Choose an available Project space');
    this.assertTarget(target, this.projects()); if (data.revision !== expectedRevision) throw new ProjectConflict('Project changed; refresh before referencing');
    const ref = data.references.find(r => r.spaceId === spaceId && targetKey(r.target) === targetKey(target)) || { id: randomUUID(), spaceId, target: structuredClone(target) };
    if (!data.references.some(r => r.id === ref.id)) data.references.push(ref);
    data.requests = { ...data.requests, [requestId]: { fingerprint, resultId: ref.id } }; data.revision++; this.save(data); return ref;
  }
  removeReference(id: string, expectedRevision: number) {
    const data = this.read(); if (data.revision !== expectedRevision) throw new ProjectConflict('Project changed; refresh before removing');
    data.references = data.references.filter(r => r.id !== id); data.revision++; this.save(data);
  }
  /** The caller verifies database ownership mappings against its migration
   * report. Registry aliases and the migration receipt publish in one write. */
  importReviewed(imports: ReviewedSpaceImport[], expectedRevision: number, expectedTopology: string, requestId: string, sourceFingerprint = ''): SpaceOperation {
    operationId(requestId); const data = this.read(), projects = this.projects(), fingerprint = hash([imports, expectedRevision, expectedTopology, sourceFingerprint]);
    const old = data.operations.find(o => o.id === requestId); if (old) { if (old.fingerprint !== fingerprint) throw new ProjectConflict('Migration ID already used'); return old; }
    if (data.revision !== expectedRevision || this.topology(projects) !== expectedTopology) throw new ProjectConflict('State changed; review migration again');
    const before = structuredClone(data); data.revision++;
    for (const input of imports) {
      const p = this.assertTarget({ kind: 'work-project', projectId: input.legacyProjectId }, projects);
      if (!/^space_[\w-]{8,160}$/.test(input.spaceId) || data.spaces.some(s => s.id === input.spaceId) || Object.hasOwn(data.aliases, p.id)) throw new ProjectConflict('Migration Space or alias already exists');
      if (input.includeWork && !p.cwd) throw new Error('An empty Project cannot become a Work execution');
      data.spaces.push({ id: input.spaceId, name: p.name, revision: 1, createdAt: Date.now(), archivedAt: p.archivedAt, defaults: p.defaults, requiredTools: p.requiredTools }); data.aliases = { ...data.aliases, [p.id]: input.spaceId };
      if (input.includeWork) { const target: SpaceTarget = { kind: 'work-project', projectId: p.id }; data.bindings[targetKey(target)] = { target, assignment: { mode: 'space', spaceId: input.spaceId }, revision: data.revision }; }
      for (const chat of projects.filter(c => c.kind === 'chat' && c.parentProjectId === p.id)) {
        data.bindings[targetKey({ kind: 'chat', projectId: chat.id })] = { target: { kind: 'chat', projectId: chat.id }, assignment: { mode: 'space', spaceId: input.spaceId }, revision: data.revision };
      }
      data.ownerOverrides.memory = { ...data.ownerOverrides.memory, ...structuredClone(input.memoryOwners) }; data.ownerOverrides.source = { ...data.ownerOverrides.source, ...structuredClone(input.sourceOwners) };
      for (const fileId of input.fileIds) data.ownerOverrides.file[fileId] = input.spaceId;
    }
    const affected = this.impact(before, data, projects); for (const ref of affected) data.epochs[executionKey(ref)] = data.revision;
    const op: SpaceOperation = { id: requestId, kind: 'migration', fingerprint, at: Date.now(), state: 'pending', revision: data.revision, affected };
    data.operations.push(op); this.save(data); return op;
  }
}
