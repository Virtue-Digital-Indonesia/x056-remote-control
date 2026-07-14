import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ProviderId } from '../src/provider.js';

/** One conversation (a resumable session) within a project. */
export interface Conversation {
  sessionId: string;
  title: string;
  createdAt: number;
  /** The CLI's OWN session id used to resume. For Claude this equals sessionId
   *  (we dictate it); for Codex it's the thread id the CLI assigned and we
   *  captured off the stream. Absent until the first turn has run. */
  providerSessionId?: string;
}

/** A workspace the panel can switch between. Holds N conversations grouped under
 *  it; `lastSessionId` is the currently-active one (what turns/history operate on). */
export interface Project {
  id: string;
  name: string;
  cwd: string;
  /** Which agent CLI this project's sessions run on. Absent = 'claude' (every
   *  project predating multi-provider is a Claude project). A project's provider
   *  is fixed at creation — it decides the account pool and adapter for its runs. */
  provider?: ProviderId;
  lastSessionId?: string;
  /** All conversations under this project, newest last. */
  conversations?: Conversation[];
  /** Last explicitly-chosen model/effort, reused on continuations (autopilot,
   *  orphan-resume, question answers) so the session doesn't revert to default. */
  model?: string;
  effort?: string;
}

interface ProjectsFile {
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
      if (!Array.isArray(data.projects)) return new ProjectRegistry(file, { current: null, projects: [] });
      return new ProjectRegistry(file, data);
    } catch {
      return new ProjectRegistry(file, { current: null, projects: [] });
    }
  }

  list(): Project[] {
    return this.data.projects.map((p) => ({ ...p }));
  }

  currentId(): string | null {
    return this.data.current;
  }

  get(id: string): Project | undefined {
    const p = this.data.projects.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  current(): Project | undefined {
    return this.data.current ? this.get(this.data.current) : undefined;
  }

  create(name: string, cwd: string, provider: ProviderId = 'claude'): Project {
    const proj: Project = { id: randomUUID(), name: name.trim() || 'Untitled', cwd, provider };
    this.data.projects.push(proj);
    if (!this.data.current) this.data.current = proj.id;
    this.save();
    return { ...proj };
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
    this.save();
  }

  remove(id: string): void {
    this.data.projects = this.data.projects.filter((p) => p.id !== id);
    if (this.data.current === id) this.data.current = this.data.projects[0]?.id ?? null;
    this.save();
  }

  /** Record the session a project should resume next time it's selected, and
   *  make sure it's registered as a conversation (idempotent) and set current. */
  setLastSession(id: string, sessionId: string, title?: string): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    p.lastSessionId = sessionId;
    p.conversations = p.conversations ?? [];
    if (!p.conversations.some((c) => c.sessionId === sessionId)) {
      p.conversations.push({ sessionId, title: (title ?? '').trim() || 'Conversation', createdAt: Date.now() });
    }
    this.save();
  }

  /** Add a brand-new conversation and make it current (used when starting a fresh
   *  session so it can carry a prompt-derived title). */
  addConversation(id: string, sessionId: string, title: string): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    p.conversations = p.conversations ?? [];
    if (!p.conversations.some((c) => c.sessionId === sessionId)) {
      p.conversations.push({ sessionId, title: title.trim() || 'New conversation', createdAt: Date.now() });
    }
    p.lastSessionId = sessionId;
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
    c.title = title.trim() || c.title;
    this.save();
  }

  /** Forget a conversation (its transcript on disk is left intact). Repoints the
   *  current pointer if the removed one was active. */
  removeConversation(projectId: string, sessionId: string): void {
    const p = this.data.projects.find((x) => x.id === projectId);
    if (!p || !p.conversations) return;
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

  /** Remember the model/effort last chosen for a project (only overwrites the
   *  fields actually provided), so continuations can reuse them. */
  setPrefs(id: string, prefs: { model?: string; effort?: string }): void {
    const p = this.data.projects.find((x) => x.id === id);
    if (!p) return;
    if (prefs.model) p.model = prefs.model;
    if (prefs.effort) p.effort = prefs.effort;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
