import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { findTranscript } from './history.js';
import { toActivity } from './activity.js';
import { ProjectRegistry, type Project, type Conversation } from './projects.js';
import { adoptFromInteractive, listInteractiveSessions, type AvailableSession } from './discover.js';
import { runSession, type RunControl, type SessionResult } from '../src/failover.js';
import type { RawEvent } from '../src/types.js';
import { parseQuestion, stripAsk, stripAskInstructions } from './question.js';

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

/** A follow-up message queued to send when the current turn completes. */
export interface QueueItem {
  id: string;
  text: string;
  model?: string;
  effort?: string;
  at: number;
}

const BUFFER_MAX = 1000;

// Injected into every spawned session (any project) via --append-system-prompt,
// so sessions don't rely on background execution that this gateway kills at
// turn end. Projects have their own CLAUDE.md; this teaches the runtime reality.
// Universal to any deployment. A deployment MAY append host-specific guidance
// (SSH escape hatches, self-serve nginx, extra remotes, …) via the X056_HOST_NOTE
// env var — kept out of the shared code so a colleague's clone isn't told about
// infra it doesn't have.
const BASE_SYSTEM_NOTE =
  'EXECUTION ENVIRONMENT (x056 remote-control gateway): You run headless inside a container and your process ENDS when this turn ends. ' +
  'Consequences you must respect: (1) Background shell commands (run_in_background: true), backgrounded subagents, and the Workflow tool are ALL KILLED at turn end — their work is lost. Do NOT background work; run everything synchronously in the foreground even if it is long (a turn can run a long time and its activity is streamed to the user). ' +
  '(2) Never say you will continue "in the background" or that you will "be notified when it finishes" — you will not be. ' +
  '(3) For long autonomous or multi-turn work, tell the user to enable Autopilot (the gateway re-invokes you across turns with full context via resume) instead of backgrounding. ' +
  '(4) Your in-container `docker`/`docker compose` drive an isolated Docker-in-Docker sidecar (DOCKER_HOST=tcp://dind:2375), NOT the host Docker — use them for your project\'s own builds/e2e. Two caveats for a project compose: bind mounts resolve on the dind daemon (which shares the workspace at the same absolute path, so mounts under the workspace root work), and published ports are reachable at hostname `dind:<port>`, not localhost. Deploying THIS gateway itself is a host-side actuator (commit, then `touch .deploy/requested`), never docker. ' +
  'Toolchains you DO have: Node/npm, Go (GOTOOLCHAIN=auto), Java 17 + Maven, Python 3 (create a venv — the system Python is externally-managed), PHP + Composer, gcc/make, git, ripgrep, and a headless Chromium — screenshot any local URL with `node /app/scripts/shot.cjs <url> <out.png>` then read the PNG. If a git push over an SSH remote fails on authentication, the credential for that remote is not configured — surface it to the user instead of retrying.';
const CONTAINER_SYSTEM_NOTE = BASE_SYSTEM_NOTE + (process.env.X056_HOST_NOTE ? ' ' + process.env.X056_HOST_NOTE.trim() : '');

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

/** A short conversation title from the opening prompt (first non-empty line,
 *  minus the appended ASK convention and any image-attachment marker). */
function titleFromPrompt(prompt: string): string {
  const line = stripAskInstructions(prompt ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('[The user attached'));
  const t = (line ?? '').replace(/\s+/g, ' ').slice(0, 60);
  return t || 'New conversation';
}

export class SessionManager {
  private buffer: GatewayEvent[] = [];
  // Seed from wall-clock ms so seq is monotonic ACROSS container restarts, not
  // just within one process. A swap used to reset this to 0, so a browser that
  // reconnected with its old (high) lastSeq had every replayed event —
  // including the orphan-resume card for a turn the swap just killed — filtered
  // out by subscribe()'s `e.seq > sinceSeq`, silently freezing the panel until
  // a manual refresh. A time-based base guarantees the new container's events
  // outrank anything the browser already saw.
  private seq = Date.now();
  private subscribers = new Set<(e: GatewayEvent) => void>();
  // One concurrent turn per project (keyed by projectId); projects run in parallel.
  private runs = new Map<string, ActiveRun>();
  private lastResults = new Map<string, SessionResult>();
  private lastModelByPid = new Map<string, string>();
  private sharedRegistry?: AccountRegistry;

  constructor(private readonly opts: SessionManagerOptions) {
    mkdirSync(opts.stateDir, { recursive: true });
    this.migrateProjects();
    this.projects().migrateConversations();
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
        const opid = m.projectId ?? f.replace(/\.json$/, '');
        // Clear any stale "running" indicator the swap left behind (the killed
        // turn never emitted turn_state:false), then surface the resume card.
        this.emit('turn_state', { projectId: opid, active: false });
        this.emit('turn_orphaned', {
          projectId: opid,
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

  // ---- prompt queue: line up follow-up messages while a turn runs; the head is
  //      sent automatically when the turn completes (ahead of any autopilot). ----
  private get queueFile(): string { return join(this.opts.stateDir, 'queues.json'); }
  private loadQueues(): Record<string, QueueItem[]> {
    try {
      const m = JSON.parse(readFileSync(this.queueFile, 'utf8')) as Record<string, QueueItem[]>;
      return m && typeof m === 'object' ? m : {};
    } catch { return {}; }
  }
  private saveQueues(map: Record<string, QueueItem[]>): void {
    const tmp = `${this.queueFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.queueFile);
  }
  private emitQueue(pid: string, map?: Record<string, QueueItem[]>): void {
    const m = map ?? this.loadQueues();
    this.emit('queue', { projectId: pid, items: m[pid] ?? [] });
  }

  queues(): Record<string, QueueItem[]> { return this.loadQueues(); }

  enqueue(pid: string, item: { text: string; model?: string; effort?: string }): QueueItem {
    if (!this.projects().get(pid)) throw new Error(`unknown project ${pid}`);
    const text = (item.text ?? '').trim();
    if (!text) throw new Error('empty message');
    const map = this.loadQueues();
    const q: QueueItem = { id: randomUUID(), text, model: item.model, effort: item.effort, at: Date.now() };
    (map[pid] ??= []).push(q);
    this.saveQueues(map);
    this.emitQueue(pid, map);
    return q;
  }

  editQueueItem(pid: string, id: string, patch: { text?: string; model?: string; effort?: string }): void {
    const map = this.loadQueues();
    const it = (map[pid] ?? []).find((x) => x.id === id);
    if (!it) return;
    if (typeof patch.text === 'string' && patch.text.trim()) it.text = patch.text.trim();
    if (patch.model !== undefined) it.model = patch.model || undefined;
    if (patch.effort !== undefined) it.effort = patch.effort || undefined;
    this.saveQueues(map);
    this.emitQueue(pid, map);
  }

  removeQueueItem(pid: string, id: string): void {
    const map = this.loadQueues();
    const before = (map[pid] ?? []).length;
    map[pid] = (map[pid] ?? []).filter((x) => x.id !== id);
    if (map[pid].length !== before) { this.saveQueues(map); this.emitQueue(pid, map); }
  }

  /** If a project has queued messages, pop the head and send it after the turn
   *  settles (ahead of autopilot). Returns true if it claimed this cycle. */
  private maybeDrainQueue(pid: string): boolean {
    const map = this.loadQueues();
    const q = map[pid] ?? [];
    if (q.length === 0) return false;
    const head = q.shift() as QueueItem;
    this.saveQueues(map);
    this.emitQueue(pid, map);
    const existing = this.queueTimers.get(pid);
    if (existing) clearTimeout(existing);
    const reEnqueueHead = () => {
      const m2 = this.loadQueues();
      (m2[pid] ??= []).unshift(head);
      this.saveQueues(m2);
      this.emitQueue(pid, m2);
    };
    const t = setTimeout(() => {
      this.queueTimers.delete(pid);
      if (this.runs.has(pid)) { reEnqueueHead(); return; } // a turn snuck in — don't lose the item
      try {
        this.continueLast(head.text, { model: head.model, effort: head.effort }, pid);
      } catch {
        reEnqueueHead(); // no session yet / busy — put it back
      }
    }, 400);
    this.queueTimers.set(pid, t);
    return true;
  }
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ---- settings: global user preferences (not per-project), e.g. which effort
  //      to auto-fill when a given model is picked in the composer. ----
  private get settingsFile(): string { return join(this.opts.stateDir, 'settings.json'); }
  private loadSettings(): { modelEffort: Record<string, string> } {
    try {
      const s = JSON.parse(readFileSync(this.settingsFile, 'utf8')) as { modelEffort?: Record<string, string> };
      return { modelEffort: s.modelEffort && typeof s.modelEffort === 'object' ? s.modelEffort : {} };
    } catch {
      return { modelEffort: {} };
    }
  }
  private saveSettings(s: { modelEffort: Record<string, string> }): void {
    const tmp = `${this.settingsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.settingsFile);
  }

  getSettings(): { modelEffort: Record<string, string> } { return this.loadSettings(); }

  /** Replace the whole model->effort default map (the panel submits its full
   *  current form on save; empty/missing entries just mean "no default"). */
  setModelEffortDefaults(map: Record<string, string>): void {
    const clean: Record<string, string> = {};
    for (const [model, effort] of Object.entries(map ?? {})) {
      if (typeof effort === 'string' && effort.trim()) clean[model] = effort.trim();
    }
    this.saveSettings({ modelEffort: clean });
    this.emit('settings', { modelEffort: clean });
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

  // ---- conversations (multiple Claude sessions grouped under one project) ----
  private emitConversations(projectId: string): void {
    const reg = this.projects();
    this.emit('conversation', { projectId, conversations: reg.conversations(projectId), currentSessionId: reg.get(projectId)?.lastSessionId ?? null });
  }

  listConversations(projectId: string): Conversation[] { return this.projects().conversations(projectId); }

  /** Make a conversation the active one for its project (and current project). */
  selectConversation(projectId: string, sessionId: string): void {
    const reg = this.projects();
    reg.selectConversation(projectId, sessionId); // throws if unknown project/conversation
    reg.select(projectId);
    const proj = reg.get(projectId);
    if (proj && !this.runs.has(projectId)) {
      writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd: proj.cwd }));
    }
    this.emitConversations(projectId);
  }

  renameConversation(projectId: string, sessionId: string, title: string): void {
    this.projects().renameConversation(projectId, sessionId, title);
    this.emitConversations(projectId);
  }

  /** Forget a conversation; refuses if it's the one currently running a turn. */
  removeConversation(projectId: string, sessionId: string): void {
    const run = this.runs.get(projectId);
    if (run && run.sessionId === sessionId) throw new BusyError();
    const reg = this.projects();
    reg.removeConversation(projectId, sessionId);
    const proj = reg.get(projectId);
    if (proj && !this.runs.has(projectId)) {
      writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: proj.lastSessionId ?? '', cwd: proj.cwd }));
    }
    this.emitConversations(projectId);
  }

  /** Display name for a project id (for push notifications, etc.). */
  projectName(pid: string): string | undefined { return this.projects().get(pid)?.name; }

  /** Whether a project currently has autopilot armed (used to suppress noisy
   *  per-step completion pushes). */
  hasAutopilot(pid: string): boolean { return !!this.loadAutopilot()[pid]; }

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
    const qmap = this.loadQueues();
    if (qmap[id]) { delete qmap[id]; this.saveQueues(qmap); }
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
    // Register the new session as its own conversation (prompt-derived title),
    // grouped under the project, and make it current.
    this.projects().addConversation(pid, sessionId, titleFromPrompt(prompt));
    this.emitConversations(pid);
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
    // Persist an explicitly-chosen model/effort, and reuse the last choice when a
    // continuation doesn't carry one (autopilot, orphan-resume, question answers),
    // so a Fable session doesn't silently revert to the CLI default on continue.
    const reg = this.projects();
    if (runOpts?.model || runOpts?.effort) reg.setPrefs(pid, { model: runOpts.model, effort: runOpts.effort });
    const stored = reg.get(pid);
    const model = runOpts?.model ?? stored?.model;
    const effort = runOpts?.effort ?? stored?.effort;
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
      emit('session_started', { sessionId, cwd, resume, prompt, model, effort });
      emit('turn_state', { active: true });
      void runFn({
        registry: this.registry(),
        log,
        sessionId,
        cwd,
        prompt,
        resume,
        claudePath: this.opts.claudePath,
        model,
        effort,
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
          // Queued follow-ups take priority: on a clean completion, drain the head
          // (ahead of autopilot). A queued message is the user's explicit next
          // step, so it also pre-empts surfacing a question card / autopilot.
          const drained = res.status === 'completed' ? this.maybeDrainQueue(pid) : false;
          // If the model ended its turn asking the user something, surface it as
          // an answerable card (only when not on autopilot/queue, which drive it).
          const onAutopilot = !!this.loadAutopilot()[pid];
          const q = onAutopilot || drained ? null : parseQuestion(res.resultText ?? '');
          if (q) emit('question', { sessionId, question: q.question, options: q.options });
          emit('session_done', { sessionId, ...res });
          if (!drained) this.maybeAutopilot(pid, res);
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
    // what the UI shows as the live model. Ignore subagent messages (they carry
    // parent_tool_use_id and may run a different model) so the indicator tracks
    // the MAIN turn's model instead of flip-flopping with each subagent reply.
    const fromSubagent = e.parent_tool_use_id != null;
    const model = typeof msg?.model === 'string' ? msg.model : undefined;
    if (model && !fromSubagent && pid && this.lastModelByPid.get(pid) !== model) {
      this.lastModelByPid.set(pid, model);
      emit('active_model', { model }); // envelope ts (emit time) carries ordering
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
