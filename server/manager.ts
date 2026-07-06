import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
import { parseQuestion, stripAsk } from './question.js';

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
  /** Delay before a gateway-driven autopilot continuation (ms). */
  autopilotIntervalMs?: number;
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

// Injected into every spawned session (any project) via --append-system-prompt,
// so sessions don't rely on background execution that this gateway kills at
// turn end. Projects have their own CLAUDE.md; this teaches the runtime reality.
const CONTAINER_SYSTEM_NOTE =
  'EXECUTION ENVIRONMENT (x056 remote-control gateway): You run headless inside a container and your process ENDS when this turn ends. ' +
  'Consequences you must respect: (1) Background shell commands (run_in_background: true), backgrounded subagents, and the Workflow tool are ALL KILLED at turn end — their work is lost. Do NOT background work; run everything synchronously in the foreground even if it is long (a turn can run a long time and its activity is streamed to the user). ' +
  '(2) Never say you will continue "in the background" or that you will "be notified when it finishes" — you will not be. ' +
  '(3) For long autonomous or multi-turn work, tell the user to enable Autopilot (the gateway re-invokes you across turns with full context via resume) instead of backgrounding. ' +
  '(4) Your in-container `docker`/`docker compose` drive an isolated Docker-in-Docker sidecar (DOCKER_HOST=tcp://dind:2375), NOT the host Docker — use them for your project\'s own builds/e2e. Two caveats for a project compose: bind mounts resolve on the dind daemon (which shares the workspace at the same path /home/efran/remote-development, so mounts under the workspace work), and published ports are reachable at hostname `dind:<port>`, not localhost. Deploying THIS gateway is still the host actuator (commit + `touch .deploy/requested`), never docker. ' +
  '(5) When you genuinely need the HOST that runs this gateway (inspect/manage a sibling container or another project\'s stack, freeze a legacy service), `ssh valbox` (aka `legacy`, or 103.30.246.154) connects as user efran with real host Docker access (efran is in the docker group — no sudo needed for containers). This is the ACTUAL host, not a sandbox: do not disturb the gateway container, the dind sidecar, or other projects\' containers. ' +
  '(6) The host edge nginx (/etc/nginx/sites-enabled/) is self-serve from valbox via scoped passwordless sudo — `sudo nginx -t`, `sudo systemctl reload nginx`, and `sudo x056-write-vhost.sh <bare-filename> <<< "$content"` (writes ONE vhost file, refuses path traversal, self-tests before leaving a change in place). That is the entire sudo grant — no blanket root shell; anything else on the host (installing a cert, editing nginx.conf itself, other host-OS sudo) still needs the user. If a git push over an SSH remote fails on authentication, the credential for that remote is not configured — surface it to the user instead of retrying. ' +
  'Toolchains you DO have: Node/npm, Go (GOTOOLCHAIN=auto), Java 17 + Maven, Python 3 (create a venv — the system Python is externally-managed), PHP + Composer, gcc/make, git, ripgrep, and a headless Chromium — screenshot any local URL with `node /app/scripts/shot.cjs <url> <out.png>` then read the PNG. git push over SSH works to GitHub, the VPN host 192.168.83.20 (`ssh ocr`), and the gateway host `ssh valbox`.';

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
  private lastModelByPid = new Map<string, string>();
  private sharedRegistry?: AccountRegistry;

  constructor(private readonly opts: SessionManagerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.migrateProjects();
    this.detectOrphans();
    this.resumeAutopilots();
    if (opts.manageProcessSignals) {
      const onTerm = () => {
        for (const run of this.runs.values()) run.control?.abort();
        process.exit(130);
      };
      process.on('SIGTERM', onTerm);
      process.on('SIGINT', onTerm);
    }
  }

  private get inflightDir(): string {
    return join(this.opts.stateDir, 'inflight');
  }

  /** A turn writes an in-flight marker at launch and deletes it on any settled
   *  outcome. A marker still present at startup therefore means the process was
   *  killed mid-turn (crash/reboot) — surface it so the user can resume. */
  private detectOrphans(): void {
    let files: string[];
    try {
      files = readdirSync(this.inflightDir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    for (const f of files) {
      const path = join(this.inflightDir, f);
      try {
        const m = JSON.parse(readFileSync(path, 'utf8')) as { projectId?: string; projectName?: string; sessionId?: string; prompt?: string; startedAt?: string };
        this.emit('turn_orphaned', {
          projectId: m.projectId ?? f.replace(/\.json$/, ''),
          projectName: m.projectName ?? null,
          sessionId: m.sessionId ?? null,
          prompt: m.prompt ?? null,
          startedAt: m.startedAt ?? null,
        });
      } catch {
        // corrupt marker — ignore
      }
      rmSync(path, { force: true });
    }
  }

  private writeMarker(pid: string, sessionId: string, cwd: string, prompt: string): void {
    try {
      mkdirSync(this.inflightDir, { recursive: true });
      writeFileSync(join(this.inflightDir, `${pid}.json`), JSON.stringify({
        projectId: pid,
        projectName: this.projects().get(pid)?.name ?? null,
        sessionId, cwd,
        prompt: prompt.slice(0, 200),
        startedAt: new Date().toISOString(),
      }));
    } catch {
      // best-effort; marker absence just means no orphan detection for this turn
    }
  }

  private clearMarker(pid: string): void {
    rmSync(join(this.inflightDir, `${pid}.json`), { force: true });
  }

  // ---- autopilot: gateway-driven continuation so long/background work survives
  //      turn boundaries and restarts (the gateway keeps driving; the ephemeral
  //      claude process doesn't have to). ----
  private get autopilotFile(): string {
    return join(this.opts.stateDir, 'autopilot.json');
  }
  private loadAutopilot(): Record<string, { remaining: number; prompt: string; stopPhrase: string }> {
    try {
      return JSON.parse(readFileSync(this.autopilotFile, 'utf8')) as Record<string, { remaining: number; prompt: string; stopPhrase: string }>;
    } catch {
      return {};
    }
  }
  private saveAutopilot(map: Record<string, { remaining: number; prompt: string; stopPhrase: string }>): void {
    const tmp = `${this.autopilotFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.autopilotFile);
  }

  private readonly autopilotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly DEFAULT_AUTOPILOT_PROMPT =
    'Continue working on the task, one concrete step at a time. Do the work directly and synchronously — never background it. When the entire task is fully complete, reply with exactly: AUTOPILOT_DONE';
  private get autopilotInterval(): number { return this.opts.autopilotIntervalMs ?? 3000; }

  /** Turn on gateway-driven continuation for a project. */
  setAutopilot(projectId: string, opts: { count: number; prompt?: string; stopPhrase?: string }): void {
    if (!this.projects().get(projectId)) throw new Error(`unknown project ${projectId}`);
    const map = this.loadAutopilot();
    map[projectId] = {
      remaining: Math.max(1, Math.min(500, Math.floor(opts.count))),
      prompt: opts.prompt?.trim() || this.DEFAULT_AUTOPILOT_PROMPT,
      stopPhrase: opts.stopPhrase?.trim() || 'AUTOPILOT_DONE',
    };
    this.saveAutopilot(map);
    this.emit('autopilot', { projectId, active: true, remaining: map[projectId].remaining });
  }

  stopAutopilot(projectId: string): void {
    const map = this.loadAutopilot();
    if (map[projectId]) {
      delete map[projectId];
      this.saveAutopilot(map);
    }
    const t = this.autopilotTimers.get(projectId);
    if (t) { clearTimeout(t); this.autopilotTimers.delete(projectId); }
    this.emit('autopilot', { projectId, active: false, remaining: 0, reason: 'stopped' });
  }

  autopilotStatus(): Record<string, { remaining: number }> {
    const map = this.loadAutopilot();
    const out: Record<string, { remaining: number }> = {};
    for (const [pid, v] of Object.entries(map)) out[pid] = { remaining: v.remaining };
    return out;
  }

  /** After a completed turn, decide whether the gateway should auto-continue. */
  private maybeAutopilot(pid: string, res: SessionResult): void {
    const map = this.loadAutopilot();
    const ap = map[pid];
    if (!ap) return;
    // Only continue on a clean completion; park/error pauses (state kept so the
    // user or a later trigger can resume) but stops the auto-loop.
    if (res.status !== 'completed') {
      this.emit('autopilot', { projectId: pid, active: false, remaining: ap.remaining, reason: res.status });
      return;
    }
    if (typeof res.resultText === 'string' && res.resultText.includes(ap.stopPhrase)) {
      delete map[pid]; this.saveAutopilot(map);
      this.emit('autopilot', { projectId: pid, active: false, remaining: 0, reason: 'done' });
      return;
    }
    if (ap.remaining <= 0) {
      delete map[pid]; this.saveAutopilot(map);
      this.emit('autopilot', { projectId: pid, active: false, remaining: 0, reason: 'exhausted' });
      return;
    }
    // This continuation consumes one of the allotted steps.
    ap.remaining -= 1;
    map[pid] = ap; this.saveAutopilot(map);
    this.emit('autopilot', { projectId: pid, active: true, remaining: ap.remaining });
    this.scheduleAutopilot(pid, ap.prompt);
  }

  private scheduleAutopilot(pid: string, prompt: string): void {
    const existing = this.autopilotTimers.get(pid);
    if (existing) clearTimeout(existing);
    // Deferred so the finished run is out of the map before we continue.
    const t = setTimeout(() => {
      this.autopilotTimers.delete(pid);
      if (!this.loadAutopilot()[pid]) return; // stopped meanwhile
      if (this.runs.has(pid)) return; // a turn is somehow running; skip this tick
      try {
        this.continueLast(prompt, undefined, pid);
      } catch {
        // e.g. no previous session yet — drop autopilot for safety
        this.stopAutopilot(pid);
      }
    }, this.autopilotInterval);
    this.autopilotTimers.set(pid, t);
  }

  /** On startup, revive any project whose autopilot was mid-flight when the
   *  process died — this is what makes long autonomous work survive restarts. */
  private resumeAutopilots(): void {
    const map = this.loadAutopilot();
    let stagger = 1000;
    for (const [pid, ap] of Object.entries(map)) {
      if (ap.remaining <= 0) continue;
      const t = setTimeout(() => {
        this.autopilotTimers.delete(pid);
        if (!this.loadAutopilot()[pid] || this.runs.has(pid)) return;
        try { this.continueLast(ap.prompt, undefined, pid); } catch { this.stopAutopilot(pid); }
      }, stagger);
      this.autopilotTimers.set(pid, t);
      stagger += 1500;
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

  /** Remove a project from the list. Refuses while it has a turn running; stops
   *  its autopilot; repoints state.json if the removed one was current. */
  removeProject(id: string): void {
    if (this.runs.has(id)) throw new BusyError();
    const reg = this.projects();
    if (!reg.get(id)) throw new Error(`unknown project ${id}`);
    this.stopAutopilot(id);
    reg.remove(id);
    const cur = reg.currentId();
    const curProj = cur ? reg.get(cur) : null;
    if (curProj && !this.runs.has(curProj.id)) {
      writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: curProj.lastSessionId, cwd: curProj.cwd }));
    }
    this.emit('project_removed', { id });
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
      this.writeMarker(pid, sessionId, cwd, prompt);
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
        appendSystemPrompt: CONTAINER_SYSTEM_NOTE,
        forceSwitchSignal: false,
        control: (c) => { run.control = c; },
        tap: (e: RawEvent) => {
          saveStateOnce();
          this.tapToEvents(e, emit, pid);
        },
      })
        .then((res) => {
          this.lastResults.set(pid, res);
          // If the model ended its turn asking the user something, surface it as
          // an answerable card (only when not on autopilot, which drives itself).
          const onAutopilot = !!this.loadAutopilot()[pid];
          const q = onAutopilot ? null : parseQuestion(res.resultText ?? '');
          if (q) emit('question', { sessionId, question: q.question, options: q.options });
          emit('session_done', { sessionId, ...res });
          this.maybeAutopilot(pid, res);
        })
        .catch((err: unknown) => {
          emit('session_error', { sessionId, message: (err as Error).message });
        })
        .finally(() => {
          this.runs.delete(pid);
          this.clearMarker(pid);
          emit('turn_state', { active: false });
        });
    } catch (err) {
      this.runs.delete(pid);
      this.clearMarker(pid);
      emit('turn_state', { active: false });
      throw err;
    }
  }

  private tapToEvents(e: RawEvent, emit: (kind: string, data: Record<string, unknown>) => void, pid?: string): void {
    // Surface tool calls + subagent spawns as activity so the UI can show a
    // live "working / N running tasks" state instead of appearing to hang.
    for (const a of toActivity(e)) {
      emit('activity', a as unknown as Record<string, unknown>);
    }
    if (e.type !== 'assistant') return;
    const msg = e.message as { content?: unknown; model?: unknown } | undefined;
    // The actual model resolved for this turn (e.g. "claude-fable-5"), which is
    // what the UI shows as the live model — meaningful even when "auto" was sent.
    const model = typeof msg?.model === 'string' ? msg.model : undefined;
    if (model && pid && this.lastModelByPid.get(pid) !== model) {
      this.lastModelByPid.set(pid, model);
      emit('active_model', { model });
    }
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.length > 0) {
          const shown = stripAsk(text); // hide the raw <<<ASK>>> marker from the chat
          if (shown.length > 0) emit('assistant_text', { text: shown });
        }
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

  /** Abort a specific project's in-flight turn (user pressed Stop). Also stops
   *  its autopilot so it doesn't immediately auto-continue. The killed turn
   *  settles through the normal completion path (session_done/error). */
  stopTurn(projectId?: string): boolean {
    const pid = projectId ?? this.projects().currentId();
    const run = pid ? this.runs.get(pid) : undefined;
    if (!pid || !run?.control) return false;
    this.stopAutopilot(pid);
    run.control.abort();
    return true;
  }
}
