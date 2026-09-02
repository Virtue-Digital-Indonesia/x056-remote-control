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
  /** Evicted after this long with no output. Background work does not outlive it. */
  idleTtlMs?: number;
  /** Live processes to keep at once; the least recently active is evicted first. */
  maxSessions?: number;
  /** How long after its last output a session still counts as working. */
  workingGraceMs?: number;
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
  /**
   * When this process last wrote ANYTHING — not when its last turn ended.
   *
   * These are different, and the difference killed a session: after `result` the
   * entry is no longer busy, but a finishing background task can wake the model
   * and it keeps working. Evicting on turn-recency alone SIGKILLed a process
   * mid-task 0.6s after its last write.
   */
  lastOutput: number;
  /** Where events go when no turn is in flight (UI only, never the classifier). */
  idleSink?: (e: RawEvent) => void;
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
  private readonly workingGraceMs: number;
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: PersistentOptions = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60_000;
    // Raised from 4 after five conversations were live at once and the sixth
    // start evicted a working one. The cap is not the fix — `working()` is —
    // but a cap below the number of conversations in play guarantees churn.
    this.maxSessions = opts.maxSessions ?? 6;
    this.workingGraceMs = opts.workingGraceMs ?? 2 * 60_000;
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

  /**
   * Is this process doing something?
   *
   * NOT the same as "a turn is in flight". After `result` the entry is not busy,
   * but a background task can wake the model and it keeps working — and killing
   * it then destroys exactly the work persistence exists to protect. Recent
   * output is the evidence; the grace window covers the gaps between writes
   * while a tool runs.
   */
  private working(e: Live): boolean {
    return e.busy || (this.now() - e.lastOutput) < this.workingGraceMs;
  }

  /** Live sessions, for the panel and for tests. */
  stats(): { sessions: number; busy: number; working: number } {
    let busy = 0;
    let working = 0;
    for (const l of this.live.values()) { if (l.busy) busy++; if (this.working(l)) working++; }
    return { sessions: this.live.size, busy, working };
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
      this.evictOverCap(entry);
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

    const entry: Live = { key, child, sessionId: o.sessionId, busy: false, lastUsed: this.now(), lastOutput: this.now(), buf: '', exited: false };
    child.stdout?.on('data', (d: Buffer) => this.onData(entry, d));
    child.on('error', (err) => this.settle(entry, { code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => this.settle(entry, { code, signal }));
    this.startSweeper();
    return { entry };
  }

  /** Parse NDJSON, forward to the turn in flight, and end it at `result`. */
  private onData(entry: Live, d: Buffer): void {
    // ANY output means this process is doing something, turn or no turn. This is
    // what keeps eviction from killing a session that only looks idle.
    entry.lastOutput = this.now();
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
      // Between turns the turn sink is gone, but the process can still be
      // working — a finishing background task wakes the model, and everything it
      // then does used to vanish: no activity, no UI, the conversation simply
      // stopped moving while the transcript kept growing. The idle sink carries
      // it to the panel. It deliberately does NOT reach the failover classifier,
      // which is scoped to a turn that has already ended.
      const sink = entry.sink ?? entry.idleSink;
      try { sink?.(e); } catch { /* a sink must never break the stream */ }
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
    entry.sink = undefined;   // the turn's classifier stops here…
    entry.busy = false;       // …but idleSink stays, and so does the process
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
    // Nothing will resolve `done` for a process that has already gone: `settle`
    // has run, and it fires `finish` — which is only attached below. A handle
    // returned here would leave the caller waiting forever.
    if (entry.exited) return deadHandle(`persistent session died before its turn started: ${o.sessionId}`);
    entry.busy = true;
    entry.lastUsed = this.now();
    entry.lastOutput = this.now();
    entry.sink = o.onEvent;
    // Refreshed each turn: the newest caller is the one whose UI is listening.
    if (o.onIdleEvent) entry.idleSink = o.onIdleEvent;
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

  /** Drop sessions silent for longer than the TTL. A working one is never cut. */
  private sweep(): void {
    const cutoff = this.now() - this.idleTtlMs;
    for (const entry of [...this.live.values()]) {
      // Measured from the last OUTPUT, not the last turn: a session quietly
      // running a long background job is not idle.
      if (!this.working(entry) && entry.lastOutput < cutoff) this.destroy(entry);
    }
  }

  /**
   * `exempt` is the entry whose turn is about to start. It has produced no
   * output yet, so it looks like the least recently used thing in the pool —
   * and when everything else is busy it is the ONLY eviction candidate. That
   * killed a session at 06:45:30 before its first byte: destroyed between
   * `spawn` and `runOn`, it had no `finish` to resolve, so the turn hung with
   * no process behind it and never ended.
   */
  private evictOverCap(exempt?: Live): void {
    while (this.live.size > this.maxSessions) {
      let oldest: Live | undefined;
      for (const e of this.live.values()) {
        if (e === exempt) continue;
        // `busy` alone was not enough: the session this killed had finished its
        // turn 29 seconds earlier and was still writing to its transcript.
        if (this.working(e)) continue;
        if (!oldest || e.lastOutput < oldest.lastOutput) oldest = e;
      }
      // Everything is working: run over the cap rather than destroy live work.
      // The cap bounds memory, and losing a running task costs more than a
      // process does.
      if (!oldest) return;
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
