import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ProviderId } from '../src/provider.js';

export interface ModeDefaults { provider?: ProviderId; model?: string; effort?: string; account?: string }
export function validateModeDefaults(defaults: Project['defaults']): void {
  if (defaults === undefined) return;
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults) || Object.keys(defaults).some(k => k !== 'chat' && k !== 'work')) throw new Error('Invalid conversation defaults');
  for (const mode of ['chat', 'work'] as const) {
    const values = defaults[mode];
    if (values === undefined) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).some(k => !['provider', 'model', 'effort', 'account'].includes(k))) throw new Error('Invalid conversation defaults');
    if (values.provider !== undefined && !['claude', 'codex'].includes(values.provider)) throw new Error('Invalid default provider');
    for (const key of ['model', 'effort', 'account'] as const) {
      const value = values[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > 200 || value.trim() !== value || /[\x00-\x1f]/.test(value))) throw new Error('Invalid default ' + key);
    }
  }
}
export class ProjectConflict extends Error {}
export interface MembershipOperation {
  id: string; chatId: string; parentProjectId: string | null; expectedRevision: number;
  membershipRevision: number; state: 'pending' | 'complete';
}
export interface ArchiveOperation { id: string; projectId: string; expectedRevision: number; archived: boolean; executionIds: string[]; state: 'pending' | 'complete' }

/** One conversation (a resumable session) within a project. */
export interface Conversation {
  creationIntent?: boolean;
  initialSpaceId?: string;
  initialAccount?: string;
  creationRequestId?: string;
  creationFingerprint?: string;
  prepared?: boolean;
  sessionId: string;
  title: string;
  /** Missing on legacy titles: never assume an older title was automatic. */
  titleOrigin?: 'temporary' | 'generated' | 'manual';
  titleRevision?: number;
  titleUpdatedAt?: number;
  createdAt: number;
  /** Derived from the latest user/assistant transcript message in API responses. */
  lastMessageAt?: number | null;
  /** Last selected model/effort for this conversation. Empty means provider default. */
  model?: string;
  effort?: string;
  lastOutcome?: { status: 'completed' | 'failed' | 'parked'; at: string; reason?: string };
  /** Which agent CLI this conversation runs on. Stamped when it's created (from
   *  the project's provider) and then FIXED: its transcript is that provider's
   *  own format, so it can't be resumed by the other one. Absent on
   *  conversations that predate multi-provider — they're Claude. */
  provider?: ProviderId;
  /** The CLI's OWN session id used to resume. For Claude this equals sessionId
   *  (we dictate it); for Codex it's the thread id the CLI assigned and we
   *  captured off the stream. Absent until the first turn has run. */
  providerSessionId?: string;
}

/** A workspace the panel can switch between. Holds N conversations grouped under
 *  it; `lastSessionId` is the currently-active one (what turns/history operate on). */
export interface Project {
  /** Legacy records are ordinary projects. Chats own one prepared conversation. */
  kind?: 'project' | 'chat';
  creationRequestId?: string;
  creationFingerprint?: string;
  archivedAt?: number;
  revision?: number;
  parentProjectId?: string;
  membershipRevision?: number;
  defaults?: { chat?: ModeDefaults; work?: ModeDefaults };
  requiredTools?: { key: string; fingerprint?: string }[];
  references?: { projectId: string; sessionId: string }[];
  id: string;
  name: string;
  cwd?: string;
  /** The provider NEW conversations in this project start on (changeable —
   *  see setProvider). Existing conversations keep whatever they were created
   *  with; only Conversation.provider decides what a given turn actually runs on.
   *  Absent = 'claude' (every project predating multi-provider). */
  provider?: ProviderId;
  lastSessionId?: string;
  /** All conversations under this project, newest last. */
  conversations?: Conversation[];
  /** Defaults for new conversations and legacy conversations without their own
   *  saved selections. Continuations prefer Conversation.model/effort. */
  model?: string;
  effort?: string;
}

/** Only validated execution targets may reach filesystem discovery or a CLI. */
export type RunnableProject = Project & { cwd: string };
export type RunnableWork = RunnableProject & { kind?: 'project' };
export function requireWorkspace(project: Project | undefined): RunnableProject {
  if (!project) throw new Error('Unknown project');
  if (typeof project.cwd !== 'string' || !project.cwd.trim()) throw new Error('Configure a Work workspace before running this project');
  return project as RunnableProject;
}
export function requireWork(project: Project | undefined): RunnableWork {
  const target = requireWorkspace(project);
  if (target.kind === 'chat') throw new Error('Choose a Work project');
  return target as RunnableWork;
}

export interface SpacesMigrationReport {
  schemaVersion: number; projects: number; chats: number; conversations: number; changes: number;
  invalidParents: string[]; missingWorkspaces: string[]; brokenReferences: string[];
}

interface ProjectsFile {
  archiveOperations?: ArchiveOperation[];
  spacesVersion?: number;
  membershipOperations?: MembershipOperation[];
  current: string | null;
  projects: Project[];
}

/**
 * Persistent list of projects (state/projects.json). The manager keeps the
 * single-turn run path unchanged and uses this only to remember, per project,
 * which session to resume and in which directory — selecting a project swaps
 * the active session pointer.
 */
export class ProjectRegistry {
  private constructor(private readonly file: string, private data: ProjectsFile) {}

  static load(file: string): ProjectRegistry {
    if (!existsSync(file)) return new ProjectRegistry(file, { current: null, projects: [] });
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as ProjectsFile;
      if (!Array.isArray(data.projects)) throw new Error('Invalid project records');
      if ((data.spacesVersion ?? 0) > 1) throw new Error('Project registry requires a newer gateway');
      return new ProjectRegistry(file, data);
    } catch (error) {
      throw new Error('Cannot read project registry; restore or repair it before writing: ' + (error as Error).message);
    }
  }

  list(): Project[] {
    return structuredClone(this.data.projects);
  }

  currentId(): string | null {
    return this.data.current;
  }

  get(id: string): Project | undefined {
    const p = this.data.projects.find((x) => x.id === id);
    return p ? structuredClone(p) : undefined;
  }

  current(): Project | undefined {
    return this.data.current ? this.get(this.data.current) : undefined;
  }

  create(name: string, cwd: string, provider: ProviderId = 'claude'): RunnableProject {
    const proj: Project = { id: randomUUID(), name: name.trim() || 'Untitled', cwd, provider };
    this.data.projects.push(proj);
    if (!this.data.current) this.data.current = proj.id;
    this.save();
    return requireWorkspace(structuredClone(proj));
  }

  createChat(project: RunnableProject): RunnableProject {
    if (project.kind !== 'chat' || project.conversations?.length !== 1 || project.lastSessionId !== project.conversations[0].sessionId)
      throw new Error('A Chat must have exactly one conversation');
    if (this.get(project.id)) throw new Error('Chat already exists');
    if (project.parentProjectId) this.parent(project.parentProjectId);
    this.data.projects.push(structuredClone(project));
    this.save();
    return structuredClone(project);
  }

  archiveChat(id: string, archived: boolean): void {
    const p = this.data.projects.find(p => p.id === id && p.kind === 'chat');
    if (!p) throw new Error('unknown Chat');
    p.archivedAt = archived ? Date.now() : undefined;
    this.save();
  }
  setChatReferences(id: string, references: NonNullable<Project['references']>): void {
    const p = this.data.projects.find(p => p.id === id && p.kind === 'chat');
    if (!p) throw new Error('unknown Chat');
    if (!Array.isArray(references) || references.length > 30 || references.some(r => !r || !this.data.projects.some(p => p.id === r.projectId && p.conversations?.some(c => c.sessionId === r.sessionId)))) throw new Error('Invalid conversation reference');
    p.references = references; this.save();
  }

  select(id: string): void {
    if (!this.data.projects.some((p) => p.id === id)) throw new Error(`unknown project ${id}`);
    this.data.current = id;
    this.save();
  }

  rename(id: string, name: string): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    p.name = name.trim() || p.name;
    p.revision = (p.revision ?? 0) + 1;
    this.save();
  }

  remove(id: string): void {
    if (this.get(id)?.kind === 'chat') throw new Error('Archive Chats to retain their files');
    if (this.data.projects.some(p => p.parentProjectId === id)) throw new Error('Archive this Project to retain its member Chats');
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.current === id) this.data.current = this.data.projects[0]?.id ?? null;
    this.save();
  }

  /** Reorder the sidebar. `ids` is the desired order; any project omitted (or
   *  added concurrently by another tab) keeps its relative position at the end,
   *  so a stale client list can never drop a project from the registry. */
  reorder(ids: string[]): void {
    const byId = new Map(this.data.projects.map((p) => [p.id, p]));
    const ordered: Project[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (p && !ordered.includes(p)) ordered.push(p);
    }
    for (const p of this.data.projects) if (!ordered.includes(p)) ordered.push(p);
    this.data.projects = ordered;
    this.save();
  }

  /** Record the session a project should resume next time it's selected, and
   *  make sure it's registered as a conversation (idempotent) and set current. */
  setLastSession(id: string, sessionId: string, title?: string, provider?: ProviderId): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    if (p.kind === 'chat' && p.lastSessionId !== sessionId) throw new Error('A Chat has one conversation');
    p.lastSessionId = sessionId;
    p.conversations = p.conversations ?? [];
    if (!p.conversations.some((c) => c.sessionId === sessionId)) {
      p.conversations.push({ sessionId, title: (title ?? '').trim() || 'Conversation', createdAt: Date.now(), provider: provider ?? p.provider ?? 'claude' });
    }
    this.save();
  }

  /** Add a brand-new conversation and make it current (used when starting a fresh
   *  session so it can carry a prompt-derived title). */
  addConversation(id: string, sessionId: string, title: string, provider?: ProviderId, titleOrigin?: Conversation['titleOrigin']): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    if (p.kind === 'chat' && p.lastSessionId !== sessionId) throw new Error('A Chat has one conversation');
    p.conversations = p.conversations ?? [];
    if (!p.conversations.some((c) => c.sessionId === sessionId)) {
      // Stamp the provider now — this conversation is bound to it for life.
      p.conversations.push({ sessionId, title: title.trim() || 'New conversation', createdAt: Date.now(), provider: provider ?? p.provider ?? 'claude', ...(titleOrigin ? { titleOrigin, titleRevision: 1, titleUpdatedAt: Date.now() } : {}) });
    }
    p.lastSessionId = sessionId;
    this.save();
  }

  recordOutcome(projectId: string, sessionId: string, outcome: NonNullable<Conversation['lastOutcome']>): void {
    const c = this.data.projects.find(p => p.id === projectId)?.conversations?.find(c => c.sessionId === sessionId);
    if (c) { c.lastOutcome = outcome; this.save(); }
  }

  /** The provider a specific conversation runs on (what its transcript is in).
   *  An EXISTING conversation with no stamped provider predates multi-provider
   *  entirely — it's definitively Claude, NOT "whatever the project's default
   *  happens to be now" (the project default is mutable going forward; using it
   *  here would flip an old Claude conversation to codex the moment the project
   *  default changes, breaking its next continuation). Only when the
   *  conversation doesn't exist yet (not yet started) does the project's
   *  current default apply — there's genuinely nothing else to go on. */
  conversationProvider(projectId: string, sessionId: string): ProviderId {
    const p = this.data.projects.find((x) => x.id === projectId);
    const c = p?.conversations?.find((x) => x.sessionId === sessionId);
    if (c) return c.provider ?? 'claude';
    return p?.provider ?? 'claude';
  }

  /** Change which provider this project's NEW conversations start on. Existing
   *  conversations are untouched — each stays on the provider it was created
   *  with, because its transcript can only be resumed by that CLI. */
  setProvider(id: string, provider: ProviderId): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) throw new Error(`unknown project ${id}`);
    if (p.kind === 'chat' && p.provider !== provider) throw new Error('Create a new Chat to use another provider');
    p.provider = provider;
    p.revision = (p.revision ?? 0) + 1;
    this.save();
  }

  conversations(id: string): Conversation[] {
    return (this.get(id)?.conversations ?? []).map((c) => ({ ...c }));
  }

  /** The CLI session id to resume this conversation with (Codex thread id, or
   *  the Claude session id which is just the sessionId itself). */
  providerSessionId(projectId: string, sessionId: string): string | undefined {
    const p = this.data.projects.find((x) => x.id === projectId);
    return p?.conversations?.find((c) => c.sessionId === sessionId)?.providerSessionId;
  }

  /** Record the CLI's own session id once the first turn surfaced it, so later
   *  continuations resume the right underlying session. */
  setProviderSessionId(projectId: string, sessionId: string, providerSessionId: string): void {
    const p = this.data.projects.find((x) => x.id === projectId);
    const c = p?.conversations?.find((x) => x.sessionId === sessionId);
    if (!c || c.providerSessionId === providerSessionId) return;
    c.providerSessionId = providerSessionId;
    this.save();
  }

  /** Make a specific conversation the current one for its project. */
  selectConversation(projectId: string, sessionId: string): void {
    const p = this.data.projects.find((x) => x.id === projectId);
    if (!p) throw new Error(`unknown project ${projectId}`);
    if (!(p.conversations ?? []).some((c) => c.sessionId === sessionId)) throw new Error('unknown conversation');
    p.lastSessionId = sessionId;
    this.save();
  }

  renameConversation(projectId: string, sessionId: string, title: string): void {
    const p = this.data.projects.find((x) => x.id === projectId);
    const c = p?.conversations?.find((x) => x.sessionId === sessionId);
    if (!c) return;
    if (typeof title !== 'string' || !title.trim() || title.length > 300) throw new Error('Use a title between 1 and 300 characters');
    c.title = title.trim();
    c.titleOrigin = 'manual';
    c.titleRevision = (c.titleRevision || 0) + 1;
    c.titleUpdatedAt = Date.now();
    this.save();
  }

  applyTitle(projectId: string, sessionId: string, title: string, expected: { title: string; revision: number }, origin?: Conversation['titleOrigin']): Conversation {
    const c = this.data.projects.find(p => p.id === projectId)?.conversations?.find(c => c.sessionId === sessionId);
    if (!c) throw new Error('Conversation no longer exists');
    if (c.title !== expected.title || (c.titleRevision || 0) !== expected.revision)
      throw new Error('The title changed after this suggestion was requested');
    if (!title.trim() || title.length > 300) throw new Error('Invalid conversation title');
    c.title = title.trim(); c.titleOrigin = origin;
    c.titleRevision = (c.titleRevision || 0) + 1; c.titleUpdatedAt = Date.now();
    this.save();
    return { ...c };
  }

  /** Forget a conversation (its transcript on disk is left intact). Repoints the
   *  current pointer if the removed one was active. */
  removeConversation(projectId: string, sessionId: string): void {
    const p = this.data.projects.find((x) => x.id === projectId);
    if (!p || !p.conversations) return;
    if (p.kind === 'chat') throw new Error('Archive Chats to retain their conversation and files');
    p.conversations = p.conversations.filter((c) => c.sessionId !== sessionId);
    if (p.lastSessionId === sessionId) p.lastSessionId = p.conversations[p.conversations.length - 1]?.sessionId;
    this.save();
  }

  /** Backfill: a project that predates conversations but has a lastSessionId gets
   *  that session registered as its first conversation. */
  migrateConversations(): void {
    let changed = false;
    for (const p of this.data.projects) {
      if (p.lastSessionId && (!p.conversations || p.conversations.length === 0)) {
        p.conversations = [{ sessionId: p.lastSessionId, title: 'Conversation 1', createdAt: Date.now() }];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Remember defaults for new conversations, preserving legacy siblings first. */
  setPrefs(id: string, prefs: { model?: string; effort?: string }): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    // Migrate legacy siblings once, before a new choice changes the project
    // fallback. A large project still needs only one file write.
    for (const c of p.conversations ?? []) {
      const codex = c.provider === 'codex';
      if (c.model === undefined) c.model = p.model && (codex === /^(gpt-|codex-)/i.test(p.model)) ? p.model : '';
      if (c.effort === undefined) c.effort = p.effort && p.effort !== (codex ? 'ultracode' : 'ultra') ? p.effort : '';
    }
    if (prefs.model) p.model = prefs.model;
    if (prefs.effort) p.effort = prefs.effort;
    this.save();
  }

  setConversationPrefs(id: string, sessionId: string, prefs: { model?: string; effort?: string }): void {
    const p = this.data.projects.find((x) => x.id === id);
    const c = p?.conversations?.find((x) => x.sessionId === sessionId);
    if (!c) throw new Error('unknown conversation for that project');
    let changed = false;
    for (const key of ['model', 'effort'] as const) {
      if (prefs[key] !== undefined && prefs[key] !== c[key]) { c[key] = prefs[key]; changed = true; }
    }
    if (changed) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.data, null, 2)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.file);
    const dir = openSync(dirname(this.file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }

  parent(id: string, allowArchived = false): Project {
    const p = this.get(id);
    if (!p || p.kind === 'chat' || p.parentProjectId) throw new Error('Choose an existing ordinary Project');
    if (p.archivedAt && !allowArchived) throw new Error('Restore this Project first');
    return p;
  }

  createSpace(input: { requestId: string; name: string; cwd?: string; defaults?: Project['defaults'] }): Project {
    if (typeof input.requestId !== 'string' || !/^[\w-]{8,128}$/.test(input.requestId)) throw new Error('A stable requestId is required');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 300) throw new Error('Use a project name between 1 and 300 characters');
    validateModeDefaults(input.defaults);
    const fingerprint = JSON.stringify([input.name.trim(), input.cwd, input.defaults]);
    const previous = this.data.projects.find(p => p.kind !== 'chat' && p.creationRequestId === input.requestId);
    if (previous) {
      if (previous.creationFingerprint !== fingerprint) throw new ProjectConflict('requestId was used for another Project');
      return structuredClone(previous);
    }
    const p: Project = { id: randomUUID(), kind: 'project', name: input.name.trim(), cwd: input.cwd,
      revision: 1, defaults: structuredClone(input.defaults), creationRequestId: input.requestId, creationFingerprint: fingerprint };
    this.data.projects.push(p); this.save(); return structuredClone(p);
  }

  updateSpace(id: string, expectedRevision: number, patch: Partial<Pick<Project, 'name' | 'cwd' | 'defaults' | 'requiredTools' | 'archivedAt'>>): Project {
    validateModeDefaults(patch.defaults);
    if (patch.name !== undefined && (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 300)) throw new Error('Invalid project name');
    const current = this.parent(id, true);
    if (!Number.isInteger(expectedRevision) || (current.revision ?? 0) !== expectedRevision) throw new ProjectConflict('Project changed; refresh before saving');
    const p = this.data.projects.find(p => p.id === id)!;
    Object.assign(p, structuredClone(patch), { revision: expectedRevision + 1 });
    this.save(); return structuredClone(p);
  }

  /** Registry mutation and its reconciliation receipt share one atomic file write.
   * Manager serializes the synchronous call and completes queue/file effects. */
  moveChat(chatId: string, parentProjectId: string | null, expectedRevision: number, operationId: string): MembershipOperation {
    if (typeof operationId !== 'string' || !/^[\w:-]{8,160}$/.test(operationId)) throw new Error('A stable operationId is required');
    const old = this.data.membershipOperations?.find(o => o.id === operationId);
    if (old) {
      if (old.chatId !== chatId || old.parentProjectId !== parentProjectId || old.expectedRevision !== expectedRevision) throw new ProjectConflict('operationId was used for another move');
      return structuredClone(old);
    }
    const p = this.data.projects.find(p => p.id === chatId && p.kind === 'chat');
    if (!p) throw new Error('Unknown Chat');
    if (!Number.isInteger(expectedRevision) || (p.membershipRevision ?? 0) !== expectedRevision) throw new ProjectConflict('Chat membership changed; refresh before moving');
    if (parentProjectId !== null) this.parent(parentProjectId);
    p.parentProjectId = parentProjectId ?? undefined;
    p.membershipRevision = expectedRevision + 1;
    const op: MembershipOperation = { id: operationId, chatId, parentProjectId, expectedRevision, membershipRevision: p.membershipRevision, state: 'pending' };
    (this.data.membershipOperations ??= []).push(op);
    this.save(); return structuredClone(op);
  }
  pendingMembershipOperations(): MembershipOperation[] { return structuredClone((this.data.membershipOperations ?? []).filter(o => o.state === 'pending')); }
  completeMembershipOperation(id: string): void {
    const op = this.data.membershipOperations?.find(o => o.id === id);
    if (op && op.state !== 'complete') { op.state = 'complete'; this.save(); }
  }
  archiveSpace(id: string, expectedRevision: number, operationId: string, archived: boolean): ArchiveOperation {
    if (typeof operationId !== 'string' || !/^[\w:-]{8,160}$/.test(operationId) || typeof archived !== 'boolean') throw new Error('Invalid archive operation');
    const old = this.data.archiveOperations?.find(o => o.id === operationId);
    if (old) {
      if (old.projectId !== id || old.expectedRevision !== expectedRevision || old.archived !== archived) throw new ProjectConflict('operationId was used for another archive change');
      return structuredClone(old);
    }
    const p = this.parent(id, true);
    if (!Number.isInteger(expectedRevision) || (p.revision ?? 0) !== expectedRevision) throw new ProjectConflict('Project changed; refresh before archiving');
    const record = this.data.projects.find(p => p.id === id)!;
    record.archivedAt = archived ? Date.now() : undefined; record.revision = expectedRevision + 1;
    const op: ArchiveOperation = { id: operationId, projectId: id, expectedRevision, archived,
      executionIds: [id, ...this.data.projects.filter(p => p.parentProjectId === id).map(p => p.id)], state: 'pending' };
    (this.data.archiveOperations ??= []).push(op); this.save(); return structuredClone(op);
  }
  pendingArchiveOperations(): ArchiveOperation[] { return structuredClone((this.data.archiveOperations ?? []).filter(o => o.state === 'pending')); }
  completeArchiveOperation(id: string): void {
    const op = this.data.archiveOperations?.find(o => o.id === id);
    if (op && op.state !== 'complete') { op.state = 'complete'; this.save(); }
  }
  prepareWork(id: string, input: { requestId: string; name?: string; provider: ProviderId; model?: string; effort?: string; fingerprint: string; initialSpaceId?: string; initialAccount?: string }): Conversation {
    requireWork(this.parent(id));
    if (typeof input.requestId !== 'string' || !/^[\w-]{8,128}$/.test(input.requestId)) throw new Error('A stable requestId is required');
    const p = this.data.projects.find(p => p.id === id)!;
    const old = p.conversations?.find(c => c.creationRequestId === input.requestId);
    if (old) { if (old.creationFingerprint !== input.fingerprint) throw new ProjectConflict('requestId was used for another conversation'); return structuredClone(old); }
    const c: Conversation = { sessionId: randomUUID(), title: input.name?.trim() || 'New work', titleOrigin: input.name ? 'manual' : 'temporary', titleRevision: 1,
      createdAt: Date.now(), provider: input.provider, model: input.model ?? '', effort: input.effort ?? '', prepared: true,
      creationRequestId: input.requestId, creationFingerprint: input.fingerprint, creationIntent: true, initialSpaceId: input.initialSpaceId, initialAccount: input.initialAccount };
    (p.conversations ??= []).push(c); p.lastSessionId = c.sessionId;
    this.save(); return structuredClone(c);
  }

  /** Additive only: never infer membership or alter directories/session identities. */
  migrateSpaces(apply = false): SpacesMigrationReport {
    if ((this.data.spacesVersion ?? 0) > 1) throw new Error('Project registry requires a newer gateway');
    const report: SpacesMigrationReport = { schemaVersion: this.data.spacesVersion ?? 0, projects: 0, chats: 0, conversations: 0,
      changes: 0, invalidParents: [], missingWorkspaces: [], brokenReferences: [] };
    for (const p of this.data.projects) {
      if (p.kind === 'chat') report.chats++; else report.projects++;
      report.conversations += p.conversations?.length ?? (p.lastSessionId ? 1 : 0);
      if (!p.cwd || !existsSync(p.cwd)) report.missingWorkspaces.push(p.id);
      if (p.parentProjectId && (p.kind !== 'chat' || !this.data.projects.some(parent => parent.id === p.parentProjectId && parent.kind !== 'chat' && !parent.parentProjectId))) report.invalidParents.push(p.id);
      for (const r of p.references ?? []) if (!this.data.projects.some(target => target.id === r.projectId && (target.conversations?.some(c => c.sessionId === r.sessionId) || target.lastSessionId === r.sessionId))) report.brokenReferences.push(p.id + ':' + r.projectId + ':' + r.sessionId);
      if (p.revision === undefined || (p.kind === 'chat' && p.membershipRevision === undefined)) report.changes++;
    }
    if (apply) {
      if (report.invalidParents.length) throw new Error('Repair invalid Project parents before migration');
      if (report.changes || this.data.spacesVersion !== 1) {
        for (const p of this.data.projects) { p.revision ??= 0; if (p.kind === 'chat') p.membershipRevision ??= 0; }
        this.data.spacesVersion = 1; this.save();
      }
    }
    return report;
  }
}
