import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { findTranscript } from './history.js';
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
  }

  private get stateFile(): string {
    return join(this.opts.stateDir, 'state.json');
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

  start(prompt: string, cwd?: string): string {
    if (this.running) throw new BusyError();
    const dir = this.resolveCwd(cwd ?? this.opts.workspaceRoot);
    const sessionId = randomUUID();
    this.launch(sessionId, prompt, dir, false);
    return sessionId;
  }

  continueLast(prompt: string): string {
    if (this.running) throw new BusyError();
    const st = this.loadState();
    if (!st.lastSessionId) throw new Error('no previous session — start one first');
    const dir = this.resolveCwd(st.cwd ?? this.opts.workspaceRoot);
    this.launch(st.lastSessionId, prompt, dir, true);
    return st.lastSessionId;
  }

  private launch(sessionId: string, prompt: string, cwd: string, resume: boolean): void {
    this.running = true;
    this.currentSessionId = sessionId;
    try {
      const runFn = this.opts.runSessionFn ?? runSession;
      const registry = AccountRegistry.load(join(this.opts.stateDir, 'accounts.json'));
      const log = new EmittingLog(join(this.opts.stateDir, 'events.jsonl'), (k, d) => this.emit(k, d));
      let stateSaved = resume;
      const saveStateOnce = () => {
        if (!stateSaved) {
          writeFileSync(this.stateFile, JSON.stringify({ lastSessionId: sessionId, cwd }));
          stateSaved = true;
        }
      };
      this.emit('session_started', { sessionId, cwd, resume, prompt });
      void runFn({
        registry,
        log,
        sessionId,
        cwd,
        prompt,
        resume,
        claudePath: this.opts.claudePath,
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
        });
    } catch (err) {
      this.running = false;
      this.currentSessionId = null;
      throw err;
    }
  }

  private tapToEvents(e: RawEvent): void {
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
  } {
    return {
      running: this.running,
      currentSessionId: this.currentSessionId,
      lastSessionId: this.loadState().lastSessionId ?? null,
      lastResult: this.lastResult,
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
