import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RawEvent } from './types.js';
import type { TurnExit, TurnHandle, TurnOptions } from './turn.js';

/**
 * Persistent CLI sessions: one long-lived process per conversation, fed a
 * message per turn, instead of a fresh `claude -p` for every turn.
 *
 * WHY. With a process per turn, "the turn ended" and "the process died" are the
 * same event, so everything the CLI was running in the background — background
 * shells, backgrounded agents, the Workflow tool — is destroyed the moment the
 * model stops talking. Ordinary subagents were never affected (a Task call runs
 * inside the turn and blocks it), but anything genuinely concurrent was.
 *
 * `--input-format stream-json` keeps one process alive across many messages, so
 * a turn ending no longer implies a process ending, and background work carries
 * over to the next turn.
 *
 * WHAT MAKES THIS SAFE TO SLOT IN. `runSession` drives turns entirely through
 * `startTurnFn(opts) -> TurnHandle`, and only ever asks a handle three things:
 * stream me events, tell me when this turn is over, and stop it. None of that
 * requires a process per turn — so this implements the same interface over a
 * shared process, and the failover loop is unchanged. A turn now ends at the
 * `result` event rather than at process exit.
 *
 * FAILOVER still works because tearing the process down is exactly what
 * `kill()` does: on a usage limit the loop kills the handle and re-enters with
 * the next account's configDir, which finds no live process for that pair and
 * spawns one with `--resume <sessionId>`. Verified against the real CLI: a
 * second process resuming the same id recalls the first one's context.
 */

export interface PersistentOptions {
  /** Evicted after this long idle. Background work does not outlive it. */
  idleTtlMs?: number;
  /** Live processes to keep at once; the least recently used is evicted first. */
  maxSessions?: number;
  now?: () => number;
  /** Injected in tests. */
  spawnFn?: (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
}

interface Live {
  key: string;
  child: ChildProcess;
  sessionId: string;
  /** A turn is in flight; the pool must not hand this process to another. */
  busy: boolean;
  lastUsed: number;
  buf: string;
  exited: boolean;
  /** Where this turn's events go, and how it is finished. */
  sink?: (e: RawEvent) => void;
  finish?: (exit: TurnExit) => void;
}

/** Turns that failed to even start still have to satisfy the TurnHandle shape. */
function deadHandle(spawnError: string): TurnHandle {
  return { kill: () => {}, interrupt: () => {}, done: Promise.resolve({ code: null, signal: null, spawnError }) };
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

export class PersistentTurns {
  private live = new Map<string, Live>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: PersistentOptions = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60_000;
    this.maxSessions = opts.maxSessions ?? 4;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Anything baked into argv at spawn time is part of the identity: a turn that
   * wants a different model or system prompt cannot be served by a process
   * already running with the old one, so it keys to a different entry and gets
   * a fresh process.
   */
  private keyFor(o: TurnOptions): string {
    return [o.configDir, o.sessionId, o.model ?? '', o.effort ?? '', o.mcp?.configPath ?? '',
      hash(o.appendSystemPrompt ?? '')].join('\0');
  }

  /** Live sessions, for the panel and for tests. */
  stats(): { sessions: number; busy: number } {
    let busy = 0;
    for (const l of this.live.values()) if (l.busy) busy++;
    return { sessions: this.live.size, busy };
  }

  startTurn(o: TurnOptions): TurnHandle {
    this.sweep();
    const key = this.keyFor(o);
    let entry = this.live.get(key);

    // A process that died between turns is not reusable; drop it and respawn.
    if (entry && entry.exited) { this.live.delete(key); entry = undefined; }
    // Reusing a busy process would interleave two turns into one transcript.
    // The manager serialises turns per conversation, so this is a caller bug —
    // fail loudly rather than corrupt a session.
    if (entry?.busy) return deadHandle(`persistent session already running a turn: ${o.sessionId}`);

    if (!entry) {
      const made = this.spawn(o, key);
      if ('error' in made) return deadHandle(made.error);
      entry = made.entry;
      this.live.set(key, entry);
      this.evictOverCap();
    }
    return this.runOn(entry, o);
  }

  private spawn(o: TurnOptions, key: string): { entry: Live } | { error: string } {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(o.appendSystemPrompt ? ['--append-system-prompt', o.appendSystemPrompt] : []),
      ...(o.mcp ? ['--mcp-config', o.mcp.configPath] : []),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--effort', o.effort] : []),
      ...(o.mode === 'new' ? ['--session-id', o.sessionId] : ['--resume', o.sessionId]),
    ];
    const bin = o.claudePath ?? o.binPath ?? 'claude';
    const env = { ...process.env, CLAUDE_CONFIG_DIR: o.configDir };
    let child: ChildProcess;
    try {
      child = this.opts.spawnFn
        ? this.opts.spawnFn(bin, args, o.cwd, env)
        // Own process group, so kill() takes out the CLI and everything it is
        // running — same reasoning as the one-shot path in turn.ts.
        : spawn(bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
    } catch (err) {
      return { error: (err as Error).message };
    }

    const entry: Live = { key, child, sessionId: o.sessionId, busy: false, lastUsed: this.now(), buf: '', exited: false };
    child.stdout?.on('data', (d: Buffer) => this.onData(entry, d));
    child.on('error', (err) => this.settle(entry, { code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => this.settle(entry, { code, signal }));
    this.startSweeper();
    return { entry };
  }

  /** Parse NDJSON, forward to the turn in flight, and end it at `result`. */
  private onData(entry: Live, d: Buffer): void {
    entry.buf += d.toString();
    const lines = entry.buf.split('\n');
    entry.buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      let e: RawEvent;
      try { e = JSON.parse(line) as RawEvent; } catch { continue; }
      // A control_response answers our interrupt; it is protocol, not session
      // content, and must not reach the failover classifier.
      if ((e as { type?: string }).type === 'control_response') continue;
      try { entry.sink?.(e); } catch { /* a sink must never break the stream */ }
      // The turn is over here, but the PROCESS is not — that is the point.
      if ((e as { type?: string }).type === 'result') {
        entry.lastUsed = this.now();
        this.settleTurn(entry, { code: 0, signal: null });
      }
    }
  }

  /** End the in-flight turn without touching the process. */
  private settleTurn(entry: Live, exit: TurnExit): void {
    const finish = entry.finish;
    entry.finish = undefined;
    entry.sink = undefined;
    entry.busy = false;
    finish?.(exit);
  }

  /** The process itself ended: finish any turn and drop it from the pool. */
  private settle(entry: Live, exit: TurnExit): void {
    if (entry.exited) return;
    entry.exited = true;
    this.live.delete(entry.key);
    this.settleTurn(entry, exit);
  }

  private runOn(entry: Live, o: TurnOptions): TurnHandle {
    entry.busy = true;
    entry.lastUsed = this.now();
    entry.sink = o.onEvent;
    const done = new Promise<TurnExit>((resolve) => { entry.finish = resolve; });

    try {
      entry.child.stdin?.write(JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: o.prompt }] },
      }) + '\n');
    } catch (err) {
      this.destroy(entry);
      return deadHandle((err as Error).message);
    }

    return {
      // kill() must really end the process: the failover loop calls it on a
      // usage limit and then resumes this session on ANOTHER account, which
      // cannot happen while the old process still holds the session.
      kill: () => this.destroy(entry),
      interrupt: () => {
        try {
          entry.child.stdin?.write(JSON.stringify({
            type: 'control_request',
            request_id: `x056-int-${this.now()}`,
            request: { subtype: 'interrupt' },
          }) + '\n');
        } catch { /* process already gone; close will settle the turn */ }
      },
      done,
    };
  }

  private destroy(entry: Live): void {
    this.live.delete(entry.key);
    try {
      if (entry.child.pid) process.kill(-entry.child.pid, 'SIGKILL');
      else entry.child.kill('SIGKILL');
    } catch {
      try { entry.child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // close fires asynchronously; settle now so a caller awaiting done is not
    // left hanging if the process was already dead.
    this.settle(entry, { code: null, signal: 'SIGKILL' });
  }

  /** Drop idle sessions past the TTL. A busy one is never evicted. */
  private sweep(): void {
    const cutoff = this.now() - this.idleTtlMs;
    for (const entry of [...this.live.values()]) {
      if (!entry.busy && entry.lastUsed < cutoff) this.destroy(entry);
    }
  }

  private evictOverCap(): void {
    while (this.live.size > this.maxSessions) {
      let oldest: Live | undefined;
      for (const e of this.live.values()) {
        if (e.busy) continue;
        if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
      }
      if (!oldest) return; // everything is busy — over cap briefly rather than kill live work
      this.destroy(oldest);
    }
  }

  private startSweeper(): void {
    if (this.sweeper || this.opts.spawnFn) return; // tests drive sweep() directly
    this.sweeper = setInterval(() => { try { this.sweep(); } catch { /* never die */ } }, 60_000);
    this.sweeper.unref?.();
  }

  /** Tear everything down (gateway shutdown). */
  shutdown(): void {
    if (this.sweeper) { clearInterval(this.sweeper); this.sweeper = null; }
    for (const entry of [...this.live.values()]) this.destroy(entry);
  }
}
