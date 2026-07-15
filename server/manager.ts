import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { findTranscript } from './history.js';
import { getAdapter } from '../src/adapters/registry.js';
import { ProjectRegistry, type Project, type Conversation } from './projects.js';
import { adoptFromInteractive, listInteractiveSessions, type AvailableSession } from './discover.js';
import { runSession, type RunControl, type SessionResult } from '../src/failover.js';
import type { TurnOptions } from '../src/turn.js';
import type { ProviderAdapter, ProviderId } from '../src/provider.js';
import type { RawEvent } from '../src/types.js';
import { parseQuestion, stripAsk, stripAskInstructions } from '../src/question.js';

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
  /** Spawns the interactive `claude auth login` for onboarding a new account,
   *  wired to a pseudo-terminal so the CLI prints its URL and reads the pasted
   *  code. Overridable in tests with a fake that emits a URL and writes creds. */
  loginSpawnFn?: (configDir: string, claudePath?: string) => ChildProcess;
  /** The gateway's MCP bridge wiring, handed to every spawned turn so sessions
   *  get tools to read/message other conversations and projects (built by the
   *  server entrypoint, which knows the token + port; absent in tests). */
  mcp?: TurnOptions['mcp'];
}

/** A pending account login, keyed by an opaque id the panel holds. */
interface PendingLogin {
  configDir: string;
  child: ChildProcess;
  buf: string;
  timer: ReturnType<typeof setTimeout>;
  /** Set to an existing account's name when this is a re-login (refreshing that
   *  account's own credentials in place), absent when onboarding a new account. */
  relogin?: string;
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
  /** The conversation this follow-up is for; it drains into THIS session, and
   *  the panel shows it only under that conversation. Absent on legacy items. */
  sessionId?: string;
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
  projectId: string;
  cwd: string;
  control?: RunControl;
  account?: string; // the account this turn is currently running on (from turn_started)
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

/** The human-facing identity a `claude` login stores in <configDir>/.claude.json. */
function readAccountIdentity(configDir: string): { displayName?: string; email?: string } {
  try {
    const o = (JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { displayName?: string; emailAddress?: string };
    }).oauthAccount;
    return { displayName: o?.displayName, email: o?.emailAddress };
  } catch {
    return {};
  }
}

/** Pull the first OAuth URL out of the login CLI's (ANSI-laden) output. */
function extractLoginUrl(text: string): string | null {
  const clean = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\r\n]+/g, ' ');
  const m = /https?:\/\/[^\s"']+/.exec(clean);
  return m ? m[0] : null;
}

/** Default onboarding spawn: drive the interactive `claude auth login` under a
 *  PTY (via `script`) so it prints its URL and reads the pasted code on stdin.
 *  COLUMNS is set wide so the long URL isn't hard-wrapped across lines. */
function defaultLoginSpawn(configDir: string, claudePath?: string): ChildProcess {
  const bin = claudePath ?? 'claude';
  return spawn('script', ['-qec', `${bin} auth login --claudeai`, '/dev/null'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, COLUMNS: '1000', TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
  // One concurrent turn per CONVERSATION (keyed by sessionId). A project can have
  // several conversations running at once — each is an independent chat — so the
  // key is the session, not the project. Helpers below answer the project-level
  // questions (is any conversation in this project running?).
  private runs = new Map<string, ActiveRun>();
  private sessionBusy(sessionId: string): boolean { return this.runs.has(sessionId); }
  private projectBusy(pid: string): boolean {
    for (const r of this.runs.values()) if (r.projectId === pid) return true;
    return false;
  }
  private runningSessionsForProject(pid: string): string[] {
    const out: string[] = [];
    for (const r of this.runs.values()) if (r.projectId === pid) out.push(r.sessionId);
    return out;
  }
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
      // Keyed by sessionId, not project — two conversations in the same project
      // can be in-flight at once, and each needs its own crash-recovery marker.
      writeFileSync(join(this.inflightDir, `${sessionId}.json`), JSON.stringify({
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

  private clearMarker(sessionId: string): void {
    rmSync(join(this.inflightDir, `${sessionId}.json`), { force: true });
  }

  // ---- autopilot: gateway-driven continuation so long/background work survives
  //      turn boundaries and restarts (the gateway keeps driving; the ephemeral
  //      claude process doesn't have to). ----
  private get autopilotFile(): string {
    return join(this.opts.stateDir, 'autopilot.json');
  }
  // Autopilot is armed per CONVERSATION (keyed by sessionId), each entry
  // carrying its projectId so the loop can resume that exact session. A project
  // can have several conversations, only some on autopilot — arming one must not
  // arm the others.
  private loadAutopilot(): Record<string, { remaining: number; prompt: string; stopPhrase: string; projectId: string }> {
    try {
      const m = JSON.parse(readFileSync(this.autopilotFile, 'utf8')) as Record<string, { remaining: number; prompt: string; stopPhrase: string; projectId?: string }>;
      // Migrate legacy project-keyed entries (no projectId field) to session-keyed:
      // the key WAS the projectId, so resume the project's current conversation.
      const out: Record<string, { remaining: number; prompt: string; stopPhrase: string; projectId: string }> = {};
      for (const [key, v] of Object.entries(m)) {
        if (v.projectId) { out[key] = v as typeof out[string]; continue; }
        const proj = this.projects().get(key); // legacy key = projectId
        const sid = proj?.lastSessionId;
        if (proj && sid) out[sid] = { ...v, projectId: key };
      }
      return out;
    } catch {
      return {};
    }
  }
  private saveAutopilot(map: Record<string, { remaining: number; prompt: string; stopPhrase: string; projectId: string }>): void {
    const tmp = `${this.autopilotFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2));
    renameSync(tmp, this.autopilotFile);
  }

  private readonly autopilotTimers = new Map<string, ReturnType<typeof setTimeout>>(); // keyed by sessionId
  private readonly DEFAULT_AUTOPILOT_PROMPT =
    'Continue working on the task, one concrete step at a time. Do the work directly and synchronously — never background it. When the entire task is fully complete, reply with exactly: AUTOPILOT_DONE';
  private get autopilotInterval(): number { return this.opts.autopilotIntervalMs ?? 3000; }

  /** Turn on gateway-driven continuation for ONE conversation. */
  setAutopilot(projectId: string, sessionId: string, opts: { count: number; prompt?: string; stopPhrase?: string }): void {
    if (!this.projects().get(projectId)) throw new Error(`unknown project ${projectId}`);
    if (!sessionId) throw new Error('no conversation selected');
    const map = this.loadAutopilot();
    map[sessionId] = {
      remaining: Math.max(1, Math.min(500, Math.floor(opts.count))),
      prompt: opts.prompt?.trim() || this.DEFAULT_AUTOPILOT_PROMPT,
      stopPhrase: opts.stopPhrase?.trim() || 'AUTOPILOT_DONE',
      projectId,
    };
    this.saveAutopilot(map);
    this.emit('autopilot', { projectId, sessionId, active: true, remaining: map[sessionId].remaining });
  }

  stopAutopilot(sessionId: string): void {
    const map = this.loadAutopilot();
    const pid = map[sessionId]?.projectId;
    if (map[sessionId]) { delete map[sessionId]; this.saveAutopilot(map); }
    const t = this.autopilotTimers.get(sessionId);
    if (t) { clearTimeout(t); this.autopilotTimers.delete(sessionId); }
    this.emit('autopilot', { projectId: pid, sessionId, active: false, remaining: 0, reason: 'stopped' });
  }

  /** Stop autopilot for every conversation of a project (used when it's removed). */
  private stopAutopilotForProject(projectId: string): void {
    for (const [sid, ap] of Object.entries(this.loadAutopilot())) {
      if (ap.projectId === projectId) this.stopAutopilot(sid);
    }
  }

  autopilotStatus(): Record<string, { remaining: number; projectId: string }> {
    const map = this.loadAutopilot();
    const out: Record<string, { remaining: number; projectId: string }> = {};
    for (const [sid, v] of Object.entries(map)) out[sid] = { remaining: v.remaining, projectId: v.projectId };
    return out;
  }

  /** After a completed turn, decide whether the gateway should auto-continue
   *  THIS conversation — each conversation drives its own autopilot loop. */
  private maybeAutopilot(pid: string, sessionId: string, res: SessionResult): void {
    const map = this.loadAutopilot();
    const ap = map[sessionId];
    if (!ap) return;
    // Only continue on a clean completion; park/error pauses (state kept so the
    // user or a later trigger can resume) but stops the auto-loop.
    if (res.status !== 'completed') {
      this.emit('autopilot', { projectId: pid, sessionId, active: false, remaining: ap.remaining, reason: res.status });
      return;
    }
    if (typeof res.resultText === 'string' && res.resultText.includes(ap.stopPhrase)) {
      delete map[sessionId]; this.saveAutopilot(map);
      this.emit('autopilot', { projectId: pid, sessionId, active: false, remaining: 0, reason: 'done' });
      return;
    }
    if (ap.remaining <= 0) {
      delete map[sessionId]; this.saveAutopilot(map);
      this.emit('autopilot', { projectId: pid, sessionId, active: false, remaining: 0, reason: 'exhausted' });
      return;
    }
    // This continuation consumes one of the allotted steps.
    ap.remaining -= 1;
    map[sessionId] = ap; this.saveAutopilot(map);
    this.emit('autopilot', { projectId: pid, sessionId, active: true, remaining: ap.remaining });
    this.scheduleAutopilot(sessionId, ap.prompt);
  }

  private scheduleAutopilot(sessionId: string, prompt: string): void {
    const existing = this.autopilotTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    // Deferred so the finished run is out of the map before we continue.
    const t = setTimeout(() => {
      this.autopilotTimers.delete(sessionId);
      const ap = this.loadAutopilot()[sessionId];
      if (!ap) return; // stopped meanwhile
      if (this.sessionBusy(sessionId)) return; // this conversation is running; skip this tick
      try {
        this.continueSession(ap.projectId, sessionId, prompt);
      } catch {
        // e.g. session gone — drop autopilot for safety
        this.stopAutopilot(sessionId);
      }
    }, this.autopilotInterval);
    this.autopilotTimers.set(sessionId, t);
  }

  /** On startup, revive any conversation whose autopilot was mid-flight when the
   *  process died — this is what makes long autonomous work survive restarts. */
  private resumeAutopilots(): void {
    const map = this.loadAutopilot();
    let stagger = 1000;
    for (const [sessionId, ap] of Object.entries(map)) {
      if (ap.remaining <= 0) continue;
      const t = setTimeout(() => {
        this.autopilotTimers.delete(sessionId);
        if (!this.loadAutopilot()[sessionId] || this.sessionBusy(sessionId)) return;
        try { this.continueSession(ap.projectId, sessionId, ap.prompt); } catch { this.stopAutopilot(sessionId); }
      }, stagger);
      this.autopilotTimers.set(sessionId, t);
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

  enqueue(pid: string, item: { text: string; model?: string; effort?: string; sessionId?: string }): QueueItem {
    const proj = this.projects().get(pid);
    if (!proj) throw new Error(`unknown project ${pid}`);
    const text = (item.text ?? '').trim();
    if (!text) throw new Error('empty message');
    // Bind the item to a conversation: the one the panel named, else the
    // project's current one. Draining resumes THIS session, so a follow-up
    // queued in "Handoff" can never be misrouted into "Main".
    const sessionId = item.sessionId ?? proj.lastSessionId ?? this.loadState().lastSessionId;
    const map = this.loadQueues();
    const q: QueueItem = { id: randomUUID(), text, model: item.model, effort: item.effort, at: Date.now(), sessionId };
    (map[pid] ??= []).push(q);
    this.saveQueues(map);
    this.emitQueue(pid, map);
    // Normally the queue drains when that conversation's turn completes. But if
    // the conversation is IDLE when an item lands (queued on a stale "running"
    // flag, or its turn already ended), nothing would trigger a send — kick a
    // drain now. Only when there's a session to resume into and no drain timer is
    // already pending for it (so we don't race completion into a double-shift).
    if (sessionId && !this.sessionBusy(sessionId) && !this.queueTimers.has(sessionId)) this.maybeDrainQueue(pid, sessionId);
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

  /** If a conversation has queued messages, pop ITS head and resume THAT session
   *  after its turn settles (ahead of autopilot). Returns true if it claimed a
   *  drain this cycle. Items for other conversations are left untouched. */
  private maybeDrainQueue(pid: string, sessionId: string): boolean {
    const map = this.loadQueues();
    const q = map[pid] ?? [];
    const headIdx = q.findIndex((x) => (x.sessionId ?? pid) === sessionId);
    if (headIdx < 0) return false;
    const head = q.splice(headIdx, 1)[0];
    this.saveQueues(map);
    this.emitQueue(pid, map);
    const existing = this.queueTimers.get(sessionId);
    if (existing) clearTimeout(existing);
    const reEnqueueHead = () => {
      const m2 = this.loadQueues();
      (m2[pid] ??= []).unshift(head);
      this.saveQueues(m2);
      this.emitQueue(pid, m2);
    };
    const t = setTimeout(() => {
      this.queueTimers.delete(sessionId);
      if (this.sessionBusy(sessionId)) { reEnqueueHead(); return; } // its turn snuck back in — don't lose the item
      try {
        this.continueSession(pid, sessionId, head.text, { model: head.model, effort: head.effort });
      } catch {
        reEnqueueHead(); // still busy / gone — put it back
      }
    }, 400);
    this.queueTimers.set(sessionId, t);
    return true;
  }
  private readonly queueTimers = new Map<string, ReturnType<typeof setTimeout>>(); // keyed by sessionId

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

  // ---- accounts: onboarding (panel-driven login), removal, and "who's next" ----
  private pendingLogins = new Map<string, PendingLogin>();
  // In-flight Codex device-auth logins: the CLI polls in the background until the
  // user enters the code in their browser, then writes auth.json. Keyed by loginId.
  private pendingCodexLogins = new Map<string, { configDir: string; child: ChildProcess; buf: string }>();
  private get accountsDir(): string { return join(this.opts.stateDir, 'accounts'); }

  /** Public snapshot of accounts for the panel, tagging the one the NEXT turn
   *  would run on so the UI can show "this prompt will use X". */
  accountsInfo(): { name: string; configDir: string; nextUp: boolean }[] {
    const reg = this.registry();
    const next = reg.peekActive(Math.floor(Date.now() / 1000))?.name ?? reg.activeName();
    return reg.list().map((a) => ({ name: a.name, configDir: a.configDir, nextUp: a.name === next }));
  }

  /** name of the account the next turn would run on (or null if all limited). */
  nextUpAccount(): string | null {
    return this.registry().peekActive(Math.floor(Date.now() / 1000))?.name ?? null;
  }

  private nextAccountName(): string {
    const reg = this.registry();
    for (let i = 0; i < 26; i++) { const n = String.fromCharCode(97 + i); if (!reg.has(n)) return n; }
    return `acct-${randomUUID().slice(0, 8)}`;
  }

  /** Register an EXISTING, already-authenticated Codex account by its CODEX_HOME
   *  (a dir where `codex login` has written auth.json). A bridge until in-panel
   *  Codex login lands — mirrors how the first Claude accounts were pre-authed
   *  dirs registered by the setup wizard. Refuses a dir with no codex auth, and
   *  won't add the same ChatGPT account twice. */
  registerCodexAccount(codexHome: string): { name: string; email?: string; displayName?: string } {
    const dir = resolve(codexHome);
    const codex = getAdapter('codex');
    if (!existsSync(join(dir, 'auth.json'))) {
      throw new Error(`no auth.json in ${dir} — run \`CODEX_HOME=${dir} codex login\` first`);
    }
    const identity = codex.readIdentity(dir);
    const reg = this.registry();
    if (identity.email) {
      for (const a of reg.list()) {
        if (a.provider === 'codex' && codex.readIdentity(a.configDir).email === identity.email) {
          throw new Error(`${identity.email} is already added as account "${a.name}"`);
        }
      }
    }
    const name = this.nextAccountName();
    reg.add(name, dir, 'codex');
    this.emitAccounts();
    return { name, email: identity.email, displayName: identity.displayName };
  }

  /** Start an in-panel ChatGPT (Codex) device-auth login. Spawns
   *  `codex login --device-auth` under a fresh CODEX_HOME and scrapes the sign-in
   *  URL + one-time code it prints. Unlike the Claude flow there's no code to
   *  paste BACK — the user enters the code in their browser and codex polls in
   *  the background; codexLoginStatus() reports when it lands. */
  async startCodexLogin(): Promise<{ loginId: string; url: string; code: string }> {
    const loginId = randomUUID();
    const configDir = join(this.accountsDir, `codex-pending-${loginId}`);
    mkdirSync(configDir, { recursive: true });
    const child = spawn('codex', ['login', '--device-auth'], {
      env: { ...process.env, CODEX_HOME: configDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.pendingCodexLogins.set(loginId, { configDir, child, buf: '' });
    return new Promise((resolvePromise, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try { child.kill(); } catch { /* already gone */ }
        try { rmSync(configDir, { recursive: true, force: true }); } catch { /* best effort */ }
        this.pendingCodexLogins.delete(loginId);
        reject(new Error(msg));
      };
      const deadline = setTimeout(() => fail('timed out starting codex login — try again'), 25_000);
      const onData = (d: Buffer) => {
        const p = this.pendingCodexLogins.get(loginId);
        if (!p || settled) return;
        p.buf += d.toString();
        const clean = p.buf.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
        const url = /https?:\/\/\S*device\S*/.exec(clean)?.[0] ?? extractLoginUrl(clean);
        const code = /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(clean)?.[0];
        if (url && code) {
          settled = true;
          clearTimeout(deadline);
          resolvePromise({ loginId, url, code });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', () => fail('codex login exited before printing a code'));
    });
  }

  /** Poll whether an in-progress Codex device-auth login has completed. On
   *  success codex has written auth.json; finalize by registering the account
   *  (under a permanent home in accountsDir). */
  codexLoginStatus(loginId: string): { done: boolean; account?: { name: string; email?: string; displayName?: string } } {
    const p = this.pendingCodexLogins.get(loginId);
    if (!p) throw new Error('no such login (it may have timed out — start again)');
    if (!existsSync(join(p.configDir, 'auth.json'))) return { done: false };
    // auth.json exists → login is complete. Claim it (stop a concurrent poll from
    // double-registering) and stop the now-finished CLI.
    this.pendingCodexLogins.delete(loginId);
    try { p.child.kill(); } catch { /* already exiting */ }
    const codex = getAdapter('codex');
    const identity = codex.readIdentity(p.configDir);
    const reg = this.registry();
    if (identity.email) {
      for (const a of reg.list()) {
        if (a.provider === 'codex' && codex.readIdentity(a.configDir).email === identity.email) {
          try { rmSync(p.configDir, { recursive: true, force: true }); } catch { /* best effort */ }
          throw new Error(`${identity.email} is already added as account "${a.name}"`);
        }
      }
    }
    const name = this.nextAccountName();
    let dir = p.configDir;
    try { const finalDir = join(this.accountsDir, name); renameSync(p.configDir, finalDir); dir = finalDir; } catch { /* keep the pending dir */ }
    reg.add(name, dir, 'codex');
    this.emitAccounts();
    return { done: true, account: { name, email: identity.email, displayName: identity.displayName } };
  }

  /** Abandon an in-progress Codex login (user cancelled / navigated away). */
  cancelCodexLogin(loginId: string): void {
    const p = this.pendingCodexLogins.get(loginId);
    if (!p) return;
    try { p.child.kill(); } catch { /* already gone */ }
    if (p.configDir.startsWith(this.accountsDir + sep)) { try { rmSync(p.configDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    this.pendingCodexLogins.delete(loginId);
  }

  private emitAccounts(): void { this.emit('accounts', {}); }

  /** Spawn `claude auth login` on a PTY against `configDir` and resolve once it
   *  prints the OAuth URL. Shared by onboarding (fresh pending dir) and re-login
   *  (an existing account's own dir) — `relogin` tags which one, so cancellation
   *  knows whether the dir is disposable or must be preserved. */
  private spawnPendingLogin(loginId: string, configDir: string, relogin?: string): Promise<{ loginId: string; url: string }> {
    const child = (this.opts.loginSpawnFn ?? defaultLoginSpawn)(configDir, this.opts.claudePath);
    const pending: PendingLogin = {
      configDir, child, buf: '', relogin,
      timer: setTimeout(() => this.cancelAccountLogin(loginId), 10 * 60_000), // abandon after 10 min
    };
    this.pendingLogins.set(loginId, pending);
    return new Promise((resolvePromise, reject) => {
      const settleUrl = () => {
        const url = extractLoginUrl(pending.buf);
        if (url) { cleanup(); resolvePromise({ loginId, url }); return true; }
        return false;
      };
      const onData = (d: Buffer) => { pending.buf += d.toString('utf8'); settleUrl(); };
      const urlTimeout = setTimeout(() => { cleanup(); this.cancelAccountLogin(loginId); reject(new Error('timed out waiting for the login URL')); }, 20_000);
      const onExit = () => { cleanup(); this.pendingLogins.delete(loginId); reject(new Error('login process exited before producing a URL')); };
      const cleanup = () => {
        clearTimeout(urlTimeout);
        child.stdout?.off('data', onData); child.stderr?.off('data', onData); child.off('exit', onExit);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', onExit);
    });
  }

  /** Start onboarding a new account: spawn `claude auth login` on a PTY in a
   *  fresh config dir and return the URL the user must visit. The process is
   *  kept alive (keyed by loginId) until they paste back the code. */
  async startAccountLogin(): Promise<{ loginId: string; url: string }> {
    const loginId = randomUUID();
    const configDir = join(this.accountsDir, `pending-${loginId}`);
    mkdirSync(configDir, { recursive: true });
    return this.spawnPendingLogin(loginId, configDir);
  }

  /** Re-authenticate an EXISTING account in place (its own config dir) — for
   *  when the CLI reports "Not logged in" mid-turn (an expired/revoked OAuth
   *  session). Unlike startAccountLogin, this never creates a new account: on
   *  success the same account's credentials are simply refreshed. */
  async startAccountRelogin(name: string): Promise<{ loginId: string; url: string }> {
    const acct = this.registry().get(name); // throws if unknown
    // submitAccountLoginCode's "did the login finish?" check is "does
    // .credentials.json exist now that didn't before" — true for onboarding's
    // brand-new empty dir, but for a relogin the account's OWN (broken)
    // .credentials.json is already sitting right there. Without moving it aside
    // first, that check is satisfied instantly, before the CLI has even
    // exchanged the pasted code — reporting success while the OLD, still-dead
    // token stays in place. Restored automatically if this attempt is
    // cancelled, times out, or fails.
    const credPath = join(acct.configDir, '.credentials.json');
    const backupPath = this.reloginBackupPath(acct.configDir);
    if (existsSync(credPath)) renameSync(credPath, backupPath);
    return this.spawnPendingLogin(randomUUID(), acct.configDir, name);
  }

  private reloginBackupPath(configDir: string): string {
    return join(configDir, '.credentials.json.relogin-backup');
  }

  /** Put the pre-relogin credentials back — used whenever an in-progress
   *  relogin doesn't end in a verified success, so the account is never left
   *  with no credentials at all (or, worse, someone else's). */
  private restoreReloginBackup(configDir: string): void {
    const credPath = join(configDir, '.credentials.json');
    const backupPath = this.reloginBackupPath(configDir);
    if (existsSync(backupPath)) { try { renameSync(backupPath, credPath); } catch { /* best effort */ } }
  }

  /** Finish onboarding or re-login: feed the pasted code to the waiting login
   *  process, wait for it to write credentials, verify identity, and either
   *  register a brand-new account (onboarding) or just clear the existing one's
   *  broken state (re-login) — never both. */
  async submitAccountLoginCode(loginId: string, code: string): Promise<{ name: string; email?: string; displayName?: string }> {
    const pending = this.pendingLogins.get(loginId);
    if (!pending) throw new Error('no such login (it may have timed out — start again)');
    const { configDir, child } = pending;
    child.stdin?.write(code.trim() + '\n');
    // Wait for the CLI to exchange the code for credentials (or fail). For a
    // relogin, startAccountRelogin already moved the OLD .credentials.json
    // aside, so "the file exists now" genuinely means THIS attempt wrote it.
    try {
      await new Promise<void>((resolvePromise, reject) => {
        const deadline = setTimeout(() => reject(new Error('timed out exchanging the code — check it and try again')), 45_000);
        const poll = setInterval(() => {
          if (existsSync(join(configDir, '.credentials.json'))) { clearTimeout(deadline); clearInterval(poll); resolvePromise(); }
        }, 300);
        child.on('exit', () => {
          setTimeout(() => {
            clearTimeout(deadline); clearInterval(poll);
            if (existsSync(join(configDir, '.credentials.json'))) resolvePromise();
            else reject(new Error('login did not complete — the code may be wrong or expired'));
          }, 300);
        });
      });
    } catch (err) {
      if (pending.relogin) this.restoreReloginBackup(configDir); // don't leave the account with NO credentials at all
      throw err;
    }
    clearTimeout(pending.timer);
    this.pendingLogins.delete(loginId);
    try { child.kill(); } catch { /* already gone */ }

    const identity = readAccountIdentity(configDir);
    const reg = this.registry();

    if (pending.relogin) {
      // Re-authenticating an existing account: refuse if the code just logged
      // into a DIFFERENT Anthropic account than the one being fixed (a mixup
      // would otherwise silently rename what "this account" means going forward).
      if (identity.email) {
        for (const a of reg.list()) {
          if (a.name !== pending.relogin && readAccountIdentity(a.configDir).email === identity.email) {
            this.restoreReloginBackup(configDir); // revert — don't leave a mismatched identity active under this name
            throw new Error(`that's ${identity.email}, already added here as a different account — log in with the account this one was originally connected to`);
          }
        }
      }
      try { rmSync(this.reloginBackupPath(configDir), { force: true }); } catch { /* best effort */ }
      reg.markOk(pending.relogin);
      this.emitAccounts();
      return { name: pending.relogin, email: identity.email, displayName: identity.displayName };
    }

    // Onboarding a brand-new account — guard against a duplicate of one already registered.
    if (identity.email) {
      for (const a of reg.list()) {
        if (readAccountIdentity(a.configDir).email === identity.email) {
          this.discardPending(configDir);
          throw new Error(`that account (${identity.email}) is already added`);
        }
      }
    }

    // Move pending dir → its permanent home, wire the shared transcript tree so
    // a resumed session survives a failover to this account, then register.
    const name = this.nextAccountName();
    const finalDir = join(this.accountsDir, name);
    renameSync(configDir, finalDir);
    this.wireSharedProjects(finalDir);
    reg.add(name, finalDir);
    this.emitAccounts();
    return { name, email: identity.email, displayName: identity.displayName };
  }

  cancelAccountLogin(loginId: string): void {
    const pending = this.pendingLogins.get(loginId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingLogins.delete(loginId);
    try { pending.child.kill(); } catch { /* already gone */ }
    // A re-login's configDir IS the existing account's real, permanent directory
    // — never delete it, even if the attempt is abandoned or times out. Put its
    // pre-relogin credentials back rather than leaving it with none at all.
    if (pending.relogin) this.restoreReloginBackup(pending.configDir);
    else this.discardPending(pending.configDir);
  }

  private discardPending(dir: string): void {
    if (dir.startsWith(this.accountsDir + sep)) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  /** Point a new account's projects/ at the shared transcript tree (account a's),
   *  migrating any content the fresh login created there first. */
  private wireSharedProjects(configDir: string): void {
    const shared = join(this.registry().list()[0].configDir, 'projects');
    mkdirSync(shared, { recursive: true });
    const own = join(configDir, 'projects');
    if (existsSync(own)) {
      try {
        const st = readdirSync(own);
        for (const entry of st) { try { cpSync(join(own, entry), join(shared, entry), { recursive: true, force: false }); } catch { /* keep existing */ } }
      } catch { /* nothing to migrate */ }
      rmSync(own, { recursive: true, force: true });
    }
    try { symlinkSync(shared, own); } catch { /* a concurrent create is fine */ }
  }

  /** Forget an account. Blocked for the last account, and for one a turn is
   *  ACTUALLY running on right now (an in-flight failover may still reach for
   *  it) — unresolved runs (no turn_started account seen yet) count as blocking
   *  every account, conservatively, until we know which one they landed on.
   *  Turns on OTHER accounts, in other projects/conversations, don't apply — you
   *  no longer have to stop all of them just to remove one unrelated account. */
  removeAccount(name: string): void {
    const inUse = Array.from(this.runs.values()).some((r) => r.account === undefined || r.account === name);
    if (inUse) throw new BusyError();
    const acct = this.registry().get(name); // throws if unknown
    this.registry().remove(name); // throws on last-account
    // Drop the config dir only if WE created it (under state/accounts); a
    // bind-mounted A/B dir is the user's and left untouched.
    if (acct.configDir.startsWith(this.accountsDir + sep)) {
      try { rmSync(acct.configDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    this.emitAccounts();
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
  listProjects(): { current: string | null; projects: (Project & { running: boolean; runningSessionIds: string[] })[] } {
    const reg = this.projects();
    return {
      current: reg.currentId(),
      // runningSessionIds tells the panel WHICH conversations are running in each
      // project — several can run at once — so it can put a spinner on exactly
      // those and reconcile each conversation's busy state independently.
      projects: reg.list().map((p) => {
        const running = this.runningSessionsForProject(p.id);
        return { ...p, running: running.length > 0, runningSessionIds: running };
      }),
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
    if (proj && !this.projectBusy(projectId)) {
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
    if (this.sessionBusy(sessionId)) throw new BusyError();
    this.stopAutopilot(sessionId); // don't leave its autopilot armed against a removed conversation
    const reg = this.projects();
    reg.removeConversation(projectId, sessionId);
    const proj = reg.get(projectId);
    if (proj && !this.projectBusy(projectId)) {
      writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: proj.lastSessionId ?? '', cwd: proj.cwd }));
    }
    this.emitConversations(projectId);
  }

  /** Display name for a project id (for push notifications, etc.). */
  projectName(pid: string): string | undefined { return this.projects().get(pid)?.name; }

  /** Whether a project currently has autopilot armed (used to suppress noisy
   *  per-step completion pushes). */
  hasAutopilot(sessionId: string): boolean { return !!this.loadAutopilot()[sessionId]; }

  createProject(name: string, cwd?: string, provider: ProviderId = 'claude'): Project {
    const dir = this.resolveCwd(cwd ?? this.opts.workspaceRoot);
    const proj = this.projects().create(name, dir, provider);
    return proj;
  }

  /** The adapter a turn runs on. Keyed by the CONVERSATION, not the project: a
   *  conversation is bound to the provider it was created with (its transcript is
   *  that CLI's format), so changing a project's provider must never re-point an
   *  existing conversation at the other one. Falls back to the project's default
   *  (for a not-yet-created conversation) and then Claude. */
  private adapterFor(projectId?: string, sessionId?: string): ProviderAdapter {
    const pid = projectId ?? this.projects().currentId() ?? undefined;
    if (pid && sessionId) return getAdapter(this.projects().conversationProvider(pid, sessionId));
    const proj = pid ? this.projects().get(pid) : this.projects().current();
    return getAdapter(proj?.provider ?? 'claude');
  }

  /** What's needed to reload a conversation's history: its adapter, the CLI's
   *  own session/thread id to look it up by (NOT necessarily the gateway's
   *  internal conversation key — Codex assigns its own), and the config dirs of
   *  accounts on THAT provider (a transcript can only be under one of them). */
  historyContext(projectId: string, sessionId: string): { adapter: ProviderAdapter; providerSessionId: string; configDirs: string[] } {
    const provider = this.projects().conversationProvider(projectId, sessionId);
    const providerSessionId = this.projects().providerSessionId(projectId, sessionId) ?? sessionId;
    const configDirs = this.registry().list().filter((a) => a.provider === provider).map((a) => a.configDir);
    return { adapter: getAdapter(provider), providerSessionId, configDirs };
  }

  /** Change the provider NEW conversations in a project start on. Existing
   *  conversations keep theirs (a Claude thread can't resume on GPT). */
  setProjectProvider(projectId: string, provider: ProviderId): void {
    this.projects().setProvider(projectId, provider);
    this.emit('projects', { id: projectId, provider });
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
    if (this.sessionBusy(sessionId)) throw new BusyError();
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
    if (!this.projectBusy(id)) {
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
    if (this.projectBusy(id)) throw new BusyError();
    const reg = this.projects();
    if (!reg.get(id)) throw new Error(`unknown project ${id}`);
    this.stopAutopilotForProject(id);
    const qmap = this.loadQueues();
    if (qmap[id]) { delete qmap[id]; this.saveQueues(qmap); }
    reg.remove(id);
    const cur = reg.currentId();
    const curProj = cur ? reg.get(cur) : null;
    if (curProj && !this.projectBusy(curProj.id)) {
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
    // A brand-new conversation always gets a fresh sessionId, so it can start
    // even while OTHER conversations in the same project are running.
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
    const proj = this.projects().get(pid);
    const sessionId = proj?.lastSessionId ?? this.loadState().lastSessionId;
    if (!sessionId) throw new Error('no previous session — start one first');
    return this.continueSession(pid, sessionId, prompt, opts);
  }

  /** Resume a SPECIFIC conversation (not just the project's current one). Blocks
   *  only if THAT conversation already has a turn running — a sibling
   *  conversation running in the same project is fine. */
  continueSession(pid: string, sessionId: string, prompt: string, opts?: TurnRunOptions): string {
    if (this.sessionBusy(sessionId)) throw new BusyError();
    const proj = this.projects().get(pid);
    const dir = this.resolveCwd(proj?.cwd ?? this.loadState().cwd ?? this.opts.workspaceRoot);
    this.launch(pid, sessionId, prompt, dir, true, opts);
    return sessionId;
  }

  private launch(pid: string, sessionId: string, prompt: string, cwd: string, resume: boolean, runOpts?: TurnRunOptions): void {
    const reg = this.projects();
    const adapter = this.adapterFor(pid, sessionId);
    // A model id is only meaningful to the CLI that defines it — "opus" means
    // nothing to `codex -m` and "gpt-5.6-sol" nothing to `claude --model`. A
    // stale client (or a pref persisted before this guard existed — it really
    // happened: a codex project stored model "fable") could still send a
    // mismatched id, so validate server-side rather than trusting the panel:
    // drop a model that doesn't belong to this conversation's provider, and an
    // effort level the provider doesn't have ("ultra" is codex-only).
    const modelFitsProvider = (m: string | undefined): boolean => {
      if (!m) return true;
      const isGpt = /^(gpt-|codex-)/i.test(m);
      return adapter.id === 'codex' ? isGpt : !isGpt;
    };
    const effortFitsProvider = (e: string | undefined): boolean => !e || adapter.id === 'codex' || e !== 'ultra';
    const optModel = modelFitsProvider(runOpts?.model) ? runOpts?.model : undefined;
    const optEffort = effortFitsProvider(runOpts?.effort) ? runOpts?.effort : undefined;
    // Persist an explicitly-chosen (valid) model/effort, and reuse the last
    // choice when a continuation doesn't carry one (autopilot, orphan-resume,
    // question answers), so a Fable session doesn't silently revert to the CLI
    // default on continue.
    if (optModel || optEffort) reg.setPrefs(pid, { model: optModel, effort: optEffort });
    const stored = reg.get(pid);
    const storedModel = modelFitsProvider(stored?.model) ? stored?.model : undefined;
    const storedEffort = effortFitsProvider(stored?.effort) ? stored?.effort : undefined;
    const model = optModel ?? storedModel;
    const effort = optEffort ?? storedEffort;
    // Resuming a provider-assigned session (Codex) needs the CLI's own id, not
    // our conversation key; look up what the first turn captured. (For Claude
    // this is just the sessionId, so it's a harmless no-op.)
    const providerSessionId = resume ? reg.providerSessionId(pid, sessionId) : undefined;
    const run: ActiveRun = { sessionId, projectId: pid, cwd };
    this.runs.set(sessionId, run);
    // Every event from this run carries its projectId AND sessionId so the panel
    // can route it to the right conversation — a project can have several
    // conversations running at once, and each conversation's activity/messages
    // must land only in its own view, not whatever's currently on screen.
    const emit = (kind: string, data: Record<string, unknown>) => this.emit(kind, { sessionId, ...data, projectId: pid });
    try {
      const runFn = this.opts.runSessionFn ?? runSession;
      const log = new EmittingLog(join(this.opts.stateDir, 'events.jsonl'), (k, d) => {
        // Track which account this turn is on (updated on start + each failover),
        // so a targeted force-switch can tell "same account" from "different".
        if (k === 'supervisor' && d && d.type === 'turn_started' && typeof d.account === 'string') run.account = d.account;
        emit(k, d);
      });
      let stateSaved = resume;
      const saveStateOnce = () => {
        if (!stateSaved) {
          // NOT this.projects().setLastSession(pid, sessionId) — start() already
          // called addConversation() synchronously before launch(), which made
          // this the project's current conversation. Doing it again here, on the
          // first streamed event, used to silently overwrite a conversation
          // switch the user made in the meantime (a new conversation's first
          // chunk arriving would yank lastSessionId back to it). This only
          // touches the legacy crash-recovery snapshot.
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
        providerSessionId,
        adapter,
        claudePath: this.opts.claudePath,
        model,
        effort,
        appendSystemPrompt: CONTAINER_SYSTEM_NOTE,
        mcp: this.opts.mcp,
        forceSwitchSignal: false,
        control: (c) => { run.control = c; },
        tap: (e: RawEvent) => {
          saveStateOnce();
          this.tapToEvents(e, emit, adapter, pid);
        },
      })
        .then((res) => {
          this.lastResults.set(pid, res);
          // Remember the CLI's own session id (Codex thread id) so the next
          // continuation of this conversation resumes the same underlying session.
          if (res.providerSessionId) this.projects().setProviderSessionId(pid, sessionId, res.providerSessionId);
          // Queued follow-ups for THIS conversation take priority: on a clean
          // completion, drain its head (ahead of autopilot). A queued message is
          // the user's explicit next step, so it also pre-empts a question card.
          const drained = res.status === 'completed' ? this.maybeDrainQueue(pid, sessionId) : false;
          // If the model ended its turn asking the user something, surface it as
          // an answerable card (only when not on autopilot/queue, which drive it).
          const onAutopilot = !!this.loadAutopilot()[sessionId];
          const q = onAutopilot || drained ? null : parseQuestion(res.resultText ?? '');
          if (q) emit('question', { sessionId, question: q.question, options: q.options });
          emit('session_done', { sessionId, ...res });
          if (!drained) this.maybeAutopilot(pid, sessionId, res);
        })
        .catch((err: unknown) => {
          emit('session_error', { sessionId, message: (err as Error).message });
        })
        .finally(() => {
          this.runs.delete(sessionId);
          this.clearMarker(sessionId);
          emit('turn_state', { active: false });
        });
    } catch (err) {
      this.runs.delete(sessionId);
      this.clearMarker(sessionId);
      emit('turn_state', { active: false });
      throw err;
    }
  }

  private tapToEvents(e: RawEvent, emit: (kind: string, data: Record<string, unknown>) => void, adapter: ProviderAdapter, pid?: string): void {
    // Surface tool calls + subagent spawns as activity so the UI can show a
    // live "working / N running tasks" state instead of appearing to hang. The
    // adapter knows its own provider's stream shape.
    for (const a of adapter.toActivity(e)) {
      emit('activity', a as unknown as Record<string, unknown>);
    }
    // The model resolved for this turn (e.g. "claude-fable-5"), shown as the live
    // model. The adapter returns undefined for subagent/irrelevant events so the
    // indicator tracks the MAIN turn instead of flip-flopping.
    const model = adapter.activeModel?.(e);
    if (model && pid && this.lastModelByPid.get(pid) !== model) {
      this.lastModelByPid.set(pid, model);
      emit('active_model', { model }); // envelope ts (emit time) carries ordering
    }
    for (const raw of adapter.assistantText?.(e) ?? []) {
      const shown = stripAsk(raw); // hide the raw <<<ASK>>> marker from the chat
      if (shown.length > 0) emit('assistant_text', { text: shown });
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
    const curSid = (pid ? this.projects().get(pid)?.lastSessionId : undefined) ?? this.loadState().lastSessionId ?? null;
    return {
      running: this.runs.size > 0,
      runningProjects: [...new Set([...this.runs.values()].map((r) => r.projectId))],
      // the current project's current conversation, if it's actually running
      currentSessionId: curSid && this.sessionBusy(curSid) ? curSid : null,
      lastSessionId: curSid,
      lastResult: (pid ? this.lastResults.get(pid) : undefined) ?? null,
      currentProjectId: pid,
    };
  }

  /** Point the current project at an already-present transcript (adoption).
   *  Conservatively blocked while the project has any turn running. */
  setCurrent(sessionId: string, cwd: string): void {
    const pid = this.projects().currentId();
    if (pid && this.projectBusy(pid)) throw new BusyError();
    const dir = this.resolveCwd(cwd);
    const configDirs = this.registry().list().map((a) => a.configDir);
    if (!findTranscript(configDirs, sessionId)) {
      throw new Error(`no transcript for session ${sessionId} in any account's projects tree`);
    }
    writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd: dir }));
    if (pid) this.projects().setLastSession(pid, sessionId);
    this.emit('session_adopted', { sessionId, cwd: dir, projectId: pid });
  }

  /** Choose the account the NEXT turn will run on (idle). Sets the registry's
   *  preferred account; the next pickActive() returns it when it's usable —
   *  which a still-'limited' account never is, no matter what `active` says
   *  (pickActive re-checks usability every turn). `force` clears that mark
   *  first, for when the user has confirmed (e.g. checked Anthropic's own
   *  usage page) the limit already reset in reality but our own tracked
   *  cooldown — an estimate, or just outrun by reality — hasn't caught up.
   *  Deliberately never touches 'unauthenticated': that needs an actual
   *  re-login, forcing it would just fail the same way again immediately. */
  setActiveAccount(name: string, force?: boolean): void {
    const acct = this.registry().get(name); // throws if unknown
    if (force && acct.state.kind === 'limited') this.registry().markOk(name);
    this.registry().setActive(name);
    this.emitAccounts();
  }

  /** Force an account switch on an in-flight turn. With targetAccount, ends the
   *  current turn and resumes it on THAT account (leaving the old one available,
   *  not benched); refuses when it's already the account in use. Without a
   *  target, does the legacy automatic rotate (benches the account being left).
   *  `force` clears a still-'limited' target the same way setActiveAccount does
   *  (see there) — otherwise the resumed turn's own pickActive() would silently
   *  skip right back past it. Returns false when there's no in-flight turn or
   *  the target is invalid/same. */
  forceSwitch(projectId?: string, sessionId?: string, targetAccount?: string, force?: boolean): boolean {
    let run: ActiveRun | undefined;
    if (sessionId) run = this.runs.get(sessionId);
    else {
      const pid = projectId ?? this.projects().currentId();
      run = pid ? [...this.runs.values()].find((r) => r.projectId === pid) : undefined;
    }
    if (!run?.control) return false;
    if (targetAccount) {
      const target = this.registry().list().find((a) => a.name === targetAccount);
      if (!target) return false;
      if (run.account && run.account === targetAccount) return false; // already on it — nothing to switch
      if (force && target.state.kind === 'limited') this.registry().markOk(targetAccount);
      this.registry().setActive(targetAccount); // the resumed turn will pick this one
      this.emitAccounts();
      run.control.forceSwitch({ bench: false });
    } else {
      run.control.forceSwitch();
    }
    return true;
  }

  /** Is a specific conversation currently running a turn? */
  isSessionRunning(sessionId: string): boolean { return this.sessionBusy(sessionId); }

  /** Abort a CONVERSATION's in-flight turn (user pressed Stop). Also stops the
   *  project's autopilot so it doesn't immediately auto-continue. The killed turn
   *  settles through the normal completion path (session_done/error). Stops only
   *  the named conversation — sibling conversations in the same project keep
   *  running. */
  stopTurn(projectId?: string, sessionId?: string): boolean {
    const run = sessionId
      ? this.runs.get(sessionId)
      : (() => { const pid = projectId ?? this.projects().currentId(); return pid ? [...this.runs.values()].find((r) => r.projectId === pid) : undefined; })();
    if (!run?.control) return false;
    this.stopAutopilot(run.sessionId); // stop THIS conversation's autopilot, not the project's
    run.control.abort();
    return true;
  }
}
