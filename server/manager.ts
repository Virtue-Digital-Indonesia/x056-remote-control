import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { findTranscript } from './history.js';
import { toActivity } from './activity.js';
import { ProjectRegistry, type Project } from './projects.js';
import { runSession, type SessionResult } from '../src/failover.js';
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

export class SessionManager {
  private buffer: GatewayEvent[] = [];
  private seq = 0;
  private subscribers = new Set<(e: GatewayEvent) => void>();
  private running = false;
  private currentSessionId: string | null = null;
  private lastResult: SessionResult | null = null;

  constructor(private readonly opts: SessionManagerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.migrateProjects();
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
  listProjects(): { current: string | null; projects: Project[] } {
    const reg = this.projects();
    return { current: reg.currentId(), projects: reg.list() };
  }

  createProject(name: string, cwd?: string): Project {
    const dir = this.resolveCwd(cwd ?? this.opts.workspaceRoot);
    const proj = this.projects().create(name, dir);
    return proj;
  }

  /** Switch the active project — repoints state.json at that project's session. */
  selectProject(id: string): void {
    if (this.running) throw new BusyError();
    const reg = this.projects();
    const proj = reg.get(id);
    if (!proj) throw new Error(`unknown project ${id}`);
    reg.select(id);
    writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: proj.lastSessionId, cwd: proj.cwd }));
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

  start(prompt: string, cwd?: string, opts?: TurnRunOptions): string {
    if (this.running) throw new BusyError();
    // Default to the current project's directory so a "new session" runs where
    // the selected project lives, not the workspace root.
    const dir = this.resolveCwd(cwd ?? this.projects().current()?.cwd ?? this.opts.workspaceRoot);
    const sessionId = randomUUID();
    this.launch(sessionId, prompt, dir, false, opts);
    return sessionId;
  }

  continueLast(prompt: string, opts?: TurnRunOptions): string {
    if (this.running) throw new BusyError();
    const st = this.loadState();
    if (!st.lastSessionId) throw new Error('no previous session — start one first');
    const dir = this.resolveCwd(st.cwd ?? this.opts.workspaceRoot);
    this.launch(st.lastSessionId, prompt, dir, true, opts);
    return st.lastSessionId;
  }

  private launch(sessionId: string, prompt: string, cwd: string, resume: boolean, runOpts?: TurnRunOptions): void {
    this.running = true;
    this.currentSessionId = sessionId;
    try {
      const runFn = this.opts.runSessionFn ?? runSession;
      const registry = AccountRegistry.load(join(this.opts.stateDir, 'accounts.json'));
      const log = new EmittingLog(join(this.opts.stateDir, 'events.jsonl'), (k, d) => this.emit(k, d));
      let stateSaved = resume;
      const currentProjectId = this.projects().currentId();
      const saveStateOnce = () => {
        if (!stateSaved) {
          writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd }));
          if (currentProjectId) this.projects().setLastSession(currentProjectId, sessionId);
          stateSaved = true;
        }
      };
      this.emit('session_started', { sessionId, cwd, resume, prompt, model: runOpts?.model, effort: runOpts?.effort });
      this.emit('turn_state', { active: true });
      void runFn({
        registry,
        log,
        sessionId,
        cwd,
        prompt,
        resume,
        claudePath: this.opts.claudePath,
        model: runOpts?.model,
        effort: runOpts?.effort,
        tap: (e: RawEvent) => {
          saveStateOnce();
          this.tapToEvents(e);
        },
      })
        .then((res) => {
          this.lastResult = res;
          this.emit('session_done', { sessionId, ...res });
        })
        .catch((err: unknown) => {
          this.emit('session_error', { sessionId, message: (err as Error).message });
        })
        .finally(() => {
          this.running = false;
          this.currentSessionId = null;
          this.emit('turn_state', { active: false });
        });
    } catch (err) {
      this.running = false;
      this.currentSessionId = null;
      this.emit('turn_state', { active: false });
      throw err;
    }
  }

  private tapToEvents(e: RawEvent): void {
    // Surface tool calls + subagent spawns as activity so the UI can show a
    // live "working / N running tasks" state instead of appearing to hang.
    for (const a of toActivity(e)) {
      this.emit('activity', a as unknown as Record<string, unknown>);
    }
    if (e.type !== 'assistant') return;
    const msg = e.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) this.emit('assistant_text', { text });
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
    currentSessionId: string | null;
    lastSessionId: string | null;
    lastResult: SessionResult | null;
    currentProjectId: string | null;
  } {
    return {
      running: this.running,
      currentSessionId: this.currentSessionId,
      lastSessionId: this.loadState().lastSessionId ?? null,
      lastResult: this.lastResult,
      currentProjectId: this.projects().currentId(),
    };
  }

  /** Point the gateway's current session at an already-present transcript (adoption). */
  setCurrent(sessionId: string, cwd: string): void {
    if (this.running) throw new BusyError();
    const dir = this.resolveCwd(cwd);
    const registry = AccountRegistry.load(join(this.opts.stateDir, 'accounts.json'));
    const configDirs = registry.list().map((a) => a.configDir);
    if (!findTranscript(configDirs, sessionId)) {
      throw new Error(`no transcript for session ${sessionId} in any account's projects tree`);
    }
    writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd: dir }));
    this.emit('session_adopted', { sessionId, cwd: dir });
  }

  forceSwitch(): boolean {
    if (!this.running) return false;
    process.kill(process.pid, 'SIGUSR1');
    return true;
  }
}
