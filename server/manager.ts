import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { findTranscript } from './history.js';
import { toActivity } from './activity.js';
import { ProjectRegistry, type Project } from './projects.js';
import { adoptFromInteractive, listInteractiveSessions, type AvailableSession } from './discover.js';
import { runSession, type RunControl, type SessionResult } from '../src/failover.js';
import type { RawEvent } from '../src/types.js';

export interface GatewayEvent {
  seq: number;
  ts: string;
  kind: string;
  data: Record<string, unknown>;
}

export class BusyError extends Error {
  constructor() {
    super('a session is already running');
  }
}

export interface SessionManagerOptions {
  stateDir: string;
  workspaceRoot: string;
  claudePath?: string;
  runSessionFn?: typeof runSession;
  /** Register one process-level SIGTERM/SIGINT handler that aborts all runs.
   *  Set by the server entrypoint; left off in tests. */
  manageProcessSignals?: boolean;
  /** Where the user's interactive `claude` transcripts live (read-only mount).
   *  Defaults to ~/.claude/projects. */
  interactiveProjectsDir?: string;
}

/** Per-turn overrides chosen in the UI. */
export interface TurnRunOptions {
  model?: string;
  effort?: string;
}

const BUFFER_MAX = 1000;

/** EventLog that also forwards every supervisor row to the gateway stream. */
class EmittingLog extends EventLog {
  constructor(file: string, private readonly emit: (kind: string, data: Record<string, unknown>) => void) {
    super(file);
  }
  override append(event: Record<string, unknown>): void {
    super.append(event);
    this.emit('supervisor', event);
  }
}

interface PersistedState {
  lastSessionId?: string;
  cwd?: string;
}

interface ActiveRun {
  sessionId: string;
  cwd: string;
  control?: RunControl;
}

export class SessionManager {
  private buffer: GatewayEvent[] = [];
  private seq = 0;
  private subscribers = new Set<(e: GatewayEvent) => void>();
  // One concurrent turn per project (keyed by projectId); projects run in parallel.
  private runs = new Map<string, ActiveRun>();
  private lastResults = new Map<string, SessionResult>();
  private sharedRegistry?: AccountRegistry;

  constructor(private readonly opts: SessionManagerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.migrateProjects();
    if (opts.manageProcessSignals) {
      const onTerm = () => {
        for (const run of this.runs.values()) run.control?.abort();
        process.exit(130);
      };
      process.on('SIGTERM', onTerm);
      process.on('SIGINT', onTerm);
    }
  }

  /** Shared across all concurrent runs so failover's account-limit accounting
   *  is one authoritative in-process view (no cross-run file races). */
  private registry(): AccountRegistry {
    if (!this.sharedRegistry) {
      this.sharedRegistry = AccountRegistry.load(join(this.opts.stateDir, 'accounts.json'));
    }
    return this.sharedRegistry;
  }

  private get stateFile(): string {
    return join(this.opts.stateDir, 'state.json');
  }

  private get projectsFile(): string {
    return join(this.opts.stateDir, 'projects.json');
  }

  private projects(): ProjectRegistry {
    return ProjectRegistry.load(this.projectsFile);
  }

  /** First boot after the projects feature: adopt any pre-existing single
   *  session as the initial project so it stays visible and continuable. */
  private migrateProjects(): void {
    const reg = ProjectRegistry.load(this.projectsFile);
    if (reg.list().length > 0) return;
    const st = this.loadState();
    const proj = reg.create('X056 Remote Control', st.cwd ?? this.opts.workspaceRoot);
    if (st.lastSessionId) reg.setLastSession(proj.id, st.lastSessionId);
    reg.select(proj.id);
  }

  // ---- projects ----
  listProjects(): { current: string | null; projects: (Project & { running: boolean })[] } {
    const reg = this.projects();
    return {
      current: reg.currentId(),
      projects: reg.list().map((p) => ({ ...p, running: this.runs.has(p.id) })),
    };
  }

  createProject(name: string, cwd?: string): Project {
    const dir = this.resolveCwd(cwd ?? this.opts.workspaceRoot);
    const proj = this.projects().create(name, dir);
    return proj;
  }

  private get interactiveDir(): string {
    return this.opts.interactiveProjectsDir ?? join(homedir(), '.claude', 'projects');
  }

  /** Existing interactive sessions recorded for a project's directory. */
  listAvailableSessions(projectId?: string): AvailableSession[] {
    const pid = projectId ?? this.projects().currentId();
    const proj = pid ? this.projects().get(pid) : undefined;
    if (!proj) return [];
    return listInteractiveSessions(this.interactiveDir, proj.cwd);
  }

  /** Import an existing interactive session into a project and make it the
   *  session that project resumes. */
  resumeExisting(projectId: string, sessionId: string): void {
    const proj = this.projects().get(projectId);
    if (!proj) throw new Error(`unknown project ${projectId}`);
    if (this.runs.has(projectId)) throw new BusyError();
    const accounts = this.registry().list();
    if (accounts.length === 0) throw new Error('no accounts configured');
    const failoverProjects = join(accounts[0].configDir, 'projects');
    adoptFromInteractive(this.interactiveDir, failoverProjects, proj.cwd, sessionId);
    this.projects().setLastSession(projectId, sessionId);
    if (this.projects().currentId() === projectId) {
      writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd: proj.cwd }));
    }
    this.emit('session_adopted', { sessionId, projectId });
  }

  /** Repos under the workspace root you can add as projects with one click.
   *  Walks up to 3 levels so nested repos (e.g. poc-ahu-ai/ahu-ai-chatbot) are
   *  found: a directory containing `.git` is a project leaf (not descended
   *  into); top-level directories are always listed; intermediate containers
   *  are recursed but not themselves listed. */
  listWorkspaceDirs(): { name: string; rel: string; path: string; isProject: boolean }[] {
    const existing = new Set(this.projects().list().map((p) => p.cwd));
    const skip = new Set(['node_modules', 'dist', 'build', '.next', 'target', '__pycache__', 'vendor', '.venv', 'venv', 'coverage', '.cache', 'tmp']);
    const root = this.opts.workspaceRoot;
    const MAX_DEPTH = 3;
    const found: { rel: string; path: string }[] = [];
    const walk = (abs: string, rel: string, depth: number): void => {
      if (found.length >= 800 || depth > MAX_DEPTH) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      const hasGit = entries.some((e) => e.name === '.git');
      if (depth > 0) {
        if (hasGit) { found.push({ rel, path: abs }); return; }
        if (depth === 1) found.push({ rel, path: abs });
      }
      if (depth >= MAX_DEPTH) return;
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || skip.has(e.name)) continue;
        walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, depth + 1);
      }
    };
    walk(root, '', 0);
    return found
      .map(({ rel, path }) => ({ name: rel.split('/').pop() ?? rel, rel, path, isProject: existing.has(path) }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** Switch the active project (a pure view change — never blocked by a run).
   *  Repoints state.json only if that project isn't mid-turn, so a running
   *  project's own pointer isn't clobbered underneath it. */
  selectProject(id: string): void {
    const reg = this.projects();
    const proj = reg.get(id);
    if (!proj) throw new Error(`unknown project ${id}`);
    reg.select(id);
    if (!this.runs.has(id)) {
      writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: proj.lastSessionId, cwd: proj.cwd }));
    }
    this.emit('project_selected', { id, name: proj.name });
  }

  renameProject(id: string, name: string): void {
    this.projects().rename(id, name);
  }

  private loadState(): PersistedState {
    if (!existsSync(this.stateFile)) return {};
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as PersistedState;
    } catch {
      return {};
    }
  }

  private emit(kind: string, data: Record<string, unknown>): void {
    const e: GatewayEvent = { seq: ++this.seq, ts: new Date().toISOString(), kind, data };
    this.buffer.push(e);
    if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    for (const fn of this.subscribers) {
      try {
        fn(e);
      } catch {
        // subscriber errors must not affect the session
      }
    }
  }

  private resolveCwd(cwd: string): string {
    const root = realpathSync(this.opts.workspaceRoot);
    const target = realpathSync(resolve(cwd));
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`cwd outside workspace root: ${cwd}`);
    }
    return target;
  }

  start(prompt: string, cwd?: string, opts?: TurnRunOptions, projectId?: string): string {
    const pid = projectId ?? this.projects().currentId();
    if (!pid) throw new Error('no project selected');
    if (this.runs.has(pid)) throw new BusyError();
    const proj = this.projects().get(pid);
    const dir = this.resolveCwd(cwd ?? proj?.cwd ?? this.opts.workspaceRoot);
    const sessionId = randomUUID();
    this.launch(pid, sessionId, prompt, dir, false, opts);
    return sessionId;
  }

  continueLast(prompt: string, opts?: TurnRunOptions, projectId?: string): string {
    const pid = projectId ?? this.projects().currentId();
    if (!pid) throw new Error('no project selected');
    if (this.runs.has(pid)) throw new BusyError();
    const proj = this.projects().get(pid);
    const sessionId = proj?.lastSessionId ?? this.loadState().lastSessionId;
    if (!sessionId) throw new Error('no previous session — start one first');
    const dir = this.resolveCwd(proj?.cwd ?? this.loadState().cwd ?? this.opts.workspaceRoot);
    this.launch(pid, sessionId, prompt, dir, true, opts);
    return sessionId;
  }

  private launch(pid: string, sessionId: string, prompt: string, cwd: string, resume: boolean, runOpts?: TurnRunOptions): void {
    const run: ActiveRun = { sessionId, cwd };
    this.runs.set(pid, run);
    // Every event from this run carries its projectId so the panel can route it
    // to the right conversation while other projects run concurrently.
    const emit = (kind: string, data: Record<string, unknown>) => this.emit(kind, { ...data, projectId: pid });
    try {
      const runFn = this.opts.runSessionFn ?? runSession;
      const log = new EmittingLog(join(this.opts.stateDir, 'events.jsonl'), (k, d) => emit(k, d));
      let stateSaved = resume;
      const saveStateOnce = () => {
        if (!stateSaved) {
          this.projects().setLastSession(pid, sessionId);
          if (this.projects().currentId() === pid) {
            writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd }));
          }
          stateSaved = true;
        }
      };
      emit('session_started', { sessionId, cwd, resume, prompt, model: runOpts?.model, effort: runOpts?.effort });
      emit('turn_state', { active: true });
      void runFn({
        registry: this.registry(),
        log,
        sessionId,
        cwd,
        prompt,
        resume,
        claudePath: this.opts.claudePath,
        model: runOpts?.model,
        effort: runOpts?.effort,
        forceSwitchSignal: false,
        control: (c) => { run.control = c; },
        tap: (e: RawEvent) => {
          saveStateOnce();
          this.tapToEvents(e, emit);
        },
      })
        .then((res) => {
          this.lastResults.set(pid, res);
          emit('session_done', { sessionId, ...res });
        })
        .catch((err: unknown) => {
          emit('session_error', { sessionId, message: (err as Error).message });
        })
        .finally(() => {
          this.runs.delete(pid);
          emit('turn_state', { active: false });
        });
    } catch (err) {
      this.runs.delete(pid);
      emit('turn_state', { active: false });
      throw err;
    }
  }

  private tapToEvents(e: RawEvent, emit: (kind: string, data: Record<string, unknown>) => void): void {
    // Surface tool calls + subagent spawns as activity so the UI can show a
    // live "working / N running tasks" state instead of appearing to hang.
    for (const a of toActivity(e)) {
      emit('activity', a as unknown as Record<string, unknown>);
    }
    if (e.type !== 'assistant') return;
    const msg = e.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) emit('assistant_text', { text });
      }
    }
  }

  subscribe(fn: (e: GatewayEvent) => void, sinceSeq = 0): () => void {
    for (const e of this.buffer) {
      if (e.seq > sinceSeq) fn(e);
    }
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  snapshot(): {
    running: boolean;
    runningProjects: string[];
    currentSessionId: string | null;
    lastSessionId: string | null;
    lastResult: SessionResult | null;
    currentProjectId: string | null;
  } {
    const pid = this.projects().currentId();
    return {
      running: this.runs.size > 0,
      runningProjects: [...this.runs.keys()],
      currentSessionId: pid ? this.runs.get(pid)?.sessionId ?? null : null,
      lastSessionId: (pid ? this.projects().get(pid)?.lastSessionId : undefined) ?? this.loadState().lastSessionId ?? null,
      lastResult: (pid ? this.lastResults.get(pid) : undefined) ?? null,
      currentProjectId: pid,
    };
  }

  /** Point the current project at an already-present transcript (adoption). */
  setCurrent(sessionId: string, cwd: string): void {
    const pid = this.projects().currentId();
    if (pid && this.runs.has(pid)) throw new BusyError();
    const dir = this.resolveCwd(cwd);
    const configDirs = this.registry().list().map((a) => a.configDir);
    if (!findTranscript(configDirs, sessionId)) {
      throw new Error(`no transcript for session ${sessionId} in any account's projects tree`);
    }
    writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd: dir }));
    if (pid) this.projects().setLastSession(pid, sessionId);
    this.emit('session_adopted', { sessionId, cwd: dir, projectId: pid });
  }

  /** Force an account switch on a specific project's in-flight turn. */
  forceSwitch(projectId?: string): boolean {
    const pid = projectId ?? this.projects().currentId();
    const run = pid ? this.runs.get(pid) : undefined;
    if (!run?.control) return false;
    run.control.forceSwitch();
    return true;
  }
}
