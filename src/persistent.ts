import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcess } from 'node:child_process';
import type { RawEvent } from './types.js';
import type { TurnExit, TurnHandle, TurnOptions } from './turn.js';
import { ClaudeTransport, type Transport, type TransportState } from './persistent-transport.js';
import { ProviderActivity } from './provider-activity.js';

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
  /** Safety grace after output, for eviction/routing/deployment; not UI status. */
  workingGraceMs?: number;
  now?: () => number;
  /** Injected in tests. */
  spawnFn?: (bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** Which CLI wire format this pool speaks. Default: Claude stream-json. */
  transport?: Transport;
}

interface Live {
  key: string;
  child: ChildProcess;
  /** Turns stdout bytes into text without splitting a multi-byte character. */
  decoder?: StringDecoder;
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
  activity: ProviderActivity;
  activityKey?: string;
  /** Results owed to steers that started their OWN turn (injected while no
   *  gateway turn was in flight). The CLI answers stdin messages in order, so
   *  the next N results belong to those steers, not to any gateway turn. */
  pendingSteers: number;
  /** When this entry last STARTED a gateway turn. Distinct from `lastUsed`,
   *  which a stray out-of-turn `result` also bumps -- so lastUsed cannot pick
   *  which of two live processes the operator is actually talking to. */
  lastTurnStart: number;
  /** Where events go when no turn is in flight (UI only, never the classifier). */
  idleSink?: (e: RawEvent) => void;
  /** Transport-private: partial line buffer plus whatever it tracks per process. */
  st: TransportState;
  /** A first prompt held back until the transport's handshake finishes. */
  pendingPrompt?: string;
  /** The options of the turn in flight (the deferred prompt needs model/effort). */
  opts?: TurnOptions;
  /**
   * The handshake can complete SYNCHRONOUSLY inside spawn (a fast CLI, or the
   * test fake), before runOn has attached a sink or a finish. Events that
   * arrive in that window are held here and replayed once the turn is wired;
   * a turn-ending line in that window is remembered so runOn settles at once.
   */
  early: RawEvent[];
  endedEarly: boolean;
  exited: boolean;
  /** Where this turn's events go, and how it is finished. */
  sink?: (e: RawEvent) => void;
  finish?: (exit: TurnExit) => void;
}

/** Turns that failed to even start still have to satisfy the TurnHandle shape. */
function deadHandle(spawnError: string): TurnHandle {
  return { kill: () => {}, interrupt: () => {}, done: Promise.resolve({ code: null, signal: null, spawnError }) };
}


export class PersistentTurns {
  private live = new Map<string, Live>();
  private readonly idleTtlMs: number;
  private readonly maxSessions: number;
  private readonly workingGraceMs: number;
  private readonly now: () => number;
  private readonly transport: Transport;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private retiredSeq = 0;

  constructor(private readonly opts: PersistentOptions = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 30 * 60_000;
    // Raised from 4 after five conversations were live at once and the sixth
    // start evicted a working one. The cap is not the fix — `working()` is —
    // but a cap below the number of conversations in play guarantees churn.
    this.maxSessions = opts.maxSessions ?? 6;
    this.workingGraceMs = opts.workingGraceMs ?? 2 * 60_000;
    this.now = opts.now ?? Date.now;
    this.transport = opts.transport ?? new ClaudeTransport();
  }

  /** Write one line to the process; false if its stdin is already gone. */
  private writeLine(entry: Live, line: string): boolean {
    const sin = entry.child.stdin;
    if (!sin || sin.destroyed || sin.writableEnded) return false;
    try { sin.write(line + '\n'); return true; } catch { return false; }
  }

  /**
   * Anything fixed at spawn time is part of the identity -- and only that. The
   * transport knows what its CLI bakes in (Claude: model and effort are argv;
   * Codex: they are per-turn), so it decides. See Transport.identity.
   */
  private keyFor(o: TurnOptions): string {
    return this.transport.identity(o);
  }

  /**
   * Must this process be protected from eviction or restart?
   *
   * NOT the same as "a turn is in flight". After `result` the entry is not busy,
   * but a background task can wake the model and it keeps working — and killing
   * it then destroys exactly the work persistence exists to protect. Recent
   * output is the evidence; the grace window covers the gaps between writes
   * while a tool runs.
   */
  private working(e: Live): boolean {
    return e.busy || e.activity.snapshot().active || (this.now() - e.lastOutput) < this.workingGraceMs;
  }

  /** Actual provider work; output grace remains exclusively a safety guard. */
  activeSessions() {
    return [...this.live.values()].filter(e => e.busy || e.activity.snapshot().active)
      .map(e => ({ sessionId: e.sessionId, busy: e.busy, ...e.activity.snapshot() }));
  }

  agentRunning(sessionId: string, agentId: string): boolean | undefined {
    const states = [...this.live.values()].filter(e => e.sessionId === sessionId).map(e => e.activity.agentRunning(agentId));
    return states.includes(true) ? true : states.includes(false) ? false : undefined;
  }

  private publishActivity(entry: Live): void {
    const activity = entry.activity.snapshot();
    const key = JSON.stringify(activity);
    if (key === entry.activityKey) return;
    entry.activityKey = key;
    try { entry.opts?.onProviderActivity?.(activity); } catch { /* isolate UI sinks */ }
  }

  /**
   * Conservatively protected sessions. `busy` separates a gateway turn from
   * retained provider activity. Use activeSessions() for displayed work.
   */
  workingSessions(): { sessionId: string; busy: boolean; lastOutput: number }[] {
    const out: { sessionId: string; busy: boolean; lastOutput: number }[] = [];
    for (const e of this.live.values()) {
      if (this.working(e)) out.push({ sessionId: e.sessionId, busy: e.busy, lastOutput: e.lastOutput });
    }
    return out;
  }

  workingAccounts(): {sessionId:string;configDir:string}[] {return [...this.live.values()].filter(e=>this.working(e)&&e.opts).map(e=>({sessionId:e.sessionId,configDir:e.opts!.configDir}));}

  /** Reload provider configuration on the next turn without interrupting work. */
  retireIdleSession(sessionId: string): boolean {
    let pending = false;
    for (const entry of [...this.live.values()].filter(e => e.sessionId === sessionId)) {
      if (this.working(entry)) pending = true;
      else this.destroy(entry);
    }
    return !pending;
  }

  /**
   * Write a user message into a conversation's live process WITHOUT waiting for
   * its turn to end. Verified against CLI 2.1.258: a second user line on stdin
   * mid-turn reaches the model inside that same turn, and the CLI records it as
   * an `attachment.type === 'queued_command'` entry.
   *
   * Returns false when there is no live process -- the caller must fall back to
   * the queue rather than drop the message on the floor.
   */
  injectMessage(sessionId: string, text: string): boolean {
    // One session can have SEVERAL live entries: the key includes model and
    // effort, so switching model mid-conversation spawns a second process while
    // the first stays alive finishing its work. Map order is insertion order,
    // so the first match is the STALE process.
    // Rank instead: a process running a gateway turn is unambiguously the one
    // the operator is talking to; otherwise the one that most recently STARTED
    // a turn -- not `lastUsed`, which the stale process's own background
    // `result` bumps, handing it the steer.
    let target: Live | undefined;
    const better = (a: Live, b: Live) =>
      a.busy !== b.busy ? a.busy : a.lastTurnStart > b.lastTurnStart;
    for (const e of this.live.values()) {
      if (e.sessionId !== sessionId || e.exited) continue;
      if (!target || better(e, target)) target = e;
    }
    if (!target) return false;
    // A transport still in its handshake has nothing to steer into yet.
    const line = this.transport.steerMessage(target.st, text, target.busy);
    if (line === null) return false;
    // A pipe whose far end is gone accepts writes silently, so `write` alone
    // cannot tell delivered from discarded -- and the caller would skip the
    // queue fallback on the strength of it.
    if (!this.writeLine(target, line)) return false;
    // Steering is output-producing work; without this the entry looks idle
    // to the eviction pass and can be culled between the write and the
    // model's first token.
    target.lastOutput = this.now();
    // With a turn in flight the model folds the steer into it -- one result
    // for both. With no turn, the steer IS a turn and emits a result of its
    // own, which would otherwise settle whatever gateway turn came next:
    // `runSession` would return the steer's text as that turn's answer and
    // drain the queue into a process that had not started on it.
    if (!target.busy) { target.pendingSteers++; target.activity.start(); this.publishActivity(target); }
    return true;
  }

  /** Stop a conversation's background work without killing the process, so the
   *  session stays usable. Returns false if nothing was live to interrupt. */
  interruptSession(sessionId: string): boolean {
    let hit = false;
    for (const e of this.live.values()) {
      if (e.sessionId !== sessionId || e.exited) continue;
      if (this.writeLine(e, this.transport.interruptMessage(e.st))) hit = true;
    }
    return hit;
  }

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

    // A conversation that switched model (sonnet -> opus -> sonnet) finds its
    // FIRST process again under this key -- but that process never saw the turns
    // that ran on the other one, and would answer from a stale context. Any
    // sibling of the same conversation that started a turn more recently makes
    // this entry stale: never reuse it; spawn fresh, which resumes from the
    // transcript.
    if (entry && this.isStale(entry)) {
      if (this.working(entry) && !this.transport.singleWriter) {
        // Still doing background work: move it off the key rather than kill it.
        // It stays in the pool (sweep, eviction and shutdown still reach it,
        // interrupt still hits it), is found by no key lookup, and loses every
        // steer to the new process on lastTurnStart. Once quiet it is retired
        // like any other stale sibling.
        this.live.delete(key);
        entry.key = `${key}#retired:${++this.retiredSeq}`;
        this.live.set(entry.key, entry);
      } else {
        this.destroy(entry);
      }
      entry = undefined;
    }

    if (!entry) {
      // A single-writer thread: the new process cannot open it while any other
      // process of this conversation lives -- a helper toggle (new identity)
      // or an account switch left the old one holding it, and every turn after
      // failed in 400 ms. Kill them first; the old one's background work is on
      // a configuration the conversation has left.
      if (this.transport.singleWriter) {
        const conv = o.conversationId ?? o.sessionId;
        for (const e of [...this.live.values()]) if (e.sessionId === conv) this.destroy(e);
      }
      const made = this.spawn(o, key);
      if ('error' in made) return deadHandle(made.error);
      entry = made.entry;
      this.live.set(key, entry);
      this.retireSiblings(entry);
      this.evictOverCap(entry);
    }
    return this.runOn(entry, o);
  }

  /** Has another process of this conversation started a turn after this one? */
  private isStale(entry: Live): boolean {
    for (const e of this.live.values()) {
      if (e !== entry && e.sessionId === entry.sessionId && !e.exited && e.lastTurnStart > entry.lastTurnStart) return true;
    }
    return false;
  }

  /**
   * A new process for a conversation makes its other processes stale: they
   * hold a context the new one is about to move past. Idle ones go now; a
   * working one is left to finish its background work (isStale keeps it from
   * ever being reused).
   */
  private retireSiblings(fresh: Live): void {
    for (const e of [...this.live.values()]) {
      if (e !== fresh && e.sessionId === fresh.sessionId && !this.working(e)) this.destroy(e);
    }
  }

  private spawn(o: TurnOptions, key: string): { entry: Live } | { error: string } {
    const { bin, args, env } = this.transport.spawnSpec(o);
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

    // Looked up by the gateway's conversation id (steer, interrupt, "working"),
    // which for Codex is not what the CLI was handed after the first turn.
    const entry: Live = { key, child, sessionId: o.conversationId ?? o.sessionId, busy: false, lastUsed: this.now(), lastOutput: this.now(), activity: new ProviderActivity(), st: { buf: '', ext: {} }, exited: false, pendingSteers: 0, lastTurnStart: 0, early: [], endedEarly: false };
    child.stdout?.on('data', (d: Buffer) => this.onData(entry, d));
    child.on('error', (err) => this.settle(entry, { code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => this.settle(entry, { code, signal }));
    // Codex needs a handshake before it can take a prompt; Claude is ready at
    // once. Either way the first prompt goes through runOn, which defers it
    // while `ready` is false.
    // The transport sets ext.ready itself (Claude: true now; Codex: true when
    // the thread id arrives). The reply can land synchronously, inside this
    // call, so the return value must not overwrite a `true` ingest already set.
    const { ready } = this.transport.open(entry.st, o, (line) => { this.writeLine(entry, line); });
    if (ready) entry.st.ext.ready = true;
    this.startSweeper();
    return { entry };
  }

  /** Parse NDJSON, forward to the turn in flight, and end it at `result`. */
  private onData(entry: Live, d: Buffer): void {
    // ANY output means this process is doing something, turn or no turn. This is
    // what keeps eviction from killing a session that only looks idle.
    entry.lastOutput = this.now();
    // Only a chunk that ends a line is split. Appending to the partial line and
    // re-splitting the whole buffer on every chunk was quadratic: a Codex
    // thread/resume sent the 802 MB UAT thread's history as ONE line, in 64 KB
    // pieces, and the gateway spent 94% of its CPU re-scanning it -- every
    // request took 4-8 s (profiled live, 2026-09-30). The decoder keeps a
    // multi-byte character that straddles two chunks whole.
    const chunk = (entry.decoder ??= new StringDecoder('utf8')).write(d);
    if (!chunk.includes('\n')) { entry.st.buf += chunk; return; }
    const lines = (entry.st.buf + chunk).split('\n');
    entry.st.buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue;
      const { events, turnEnded, readyNow } = this.transport.ingest(entry.st, line);
      entry.activity.observe(this.transport.id, line, entry.st.ext.threadId);
      if (turnEnded) entry.activity.endTurn();
      // The handshake finished: send the prompt runOn had to hold back.
      if (readyNow && entry.pendingPrompt !== undefined) {
        const prompt = entry.pendingPrompt; entry.pendingPrompt = undefined;
        entry.st.ext.ready = true;
        if (!this.writeLine(entry, this.transport.userMessage(entry.st, entry.opts!, prompt))) {
          this.destroy(entry); return;
        }
      }
      // Between turns the turn sink is gone, but the process can still be
      // working — a finishing background task wakes the model, and everything it
      // then does used to vanish: no activity, no UI, the conversation simply
      // stopped moving while the transcript kept growing. The idle sink carries
      // it to the panel. It deliberately does NOT reach the failover classifier,
      // which is scoped to a turn that has already ended.
      const sink = entry.sink ?? entry.idleSink;
      // ONLY the pre-first-turn window is held. Once any turn has been wired,
      // a between-turn event with no idle sink is dropped exactly as before --
      // replaying it into the NEXT turn would hand that turn's classifier an
      // event from a different one.
      if (!entry.opts && !sink) {
        entry.early.push(...events);
        if (turnEnded) entry.endedEarly = true;
        continue;
      }
      for (const e of events) { try { sink?.(e); } catch { /* a sink must never break the stream */ } }
      // The turn is over here, but the PROCESS is not — that is the point.
      if (turnEnded) {
        entry.lastUsed = this.now();
        // stdin is FIFO, so results come back in the order the messages went
        // in: the first ones belong to the steers that were injected first.
        if (entry.pendingSteers > 0) { entry.pendingSteers--; this.publishActivity(entry); continue; }
        this.settleTurn(entry, { code: 0, signal: null });
        // A turn that ended before the process was ever ready is a failed
        // handshake (Codex could not open its thread). The process is alive
        // but can never take a prompt, and left in the pool it swallowed the
        // NEXT turn: keyed to it, parked as pendingPrompt, waiting for a
        // ready that would never come. Seen live, five minutes of "working".
        if (!entry.st.ext.ready) this.destroy(entry);
      }
      this.publishActivity(entry);
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
    entry.activity.stop();
    this.publishActivity(entry);
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
    entry.lastTurnStart = this.now();
    entry.lastOutput = this.now();
    entry.sink = o.onEvent;
    // Refreshed each turn: the newest caller is the one whose UI is listening.
    if (o.onIdleEvent) entry.idleSink = o.onIdleEvent;
    const done = new Promise<TurnExit>((resolve) => { entry.finish = resolve; });
    entry.opts = o;
    entry.activity.start();

    if (entry.early.length) {
      const held = entry.early; entry.early = [];
      for (const e of held) { try { o.onEvent(e); } catch { /* never break */ } }
    }
    if (entry.endedEarly) {
      // The handshake failed before the turn existed; there is nothing to send,
      // and the process is of no use to the next turn either.
      entry.endedEarly = false;
      this.settleTurn(entry, { code: 0, signal: null });
      this.destroy(entry);
      return { kill: () => this.destroy(entry), interrupt: () => {}, done };
    }

    if (entry.st.ext.ready) {
      if (!this.writeLine(entry, this.transport.userMessage(entry.st, o, o.prompt))) {
        this.destroy(entry);
        return deadHandle('persistent session stdin is closed');
      }
    } else {
      // Handshake still running (Codex opening its thread); onData sends it.
      entry.pendingPrompt = o.prompt;
    }

    return {
      // kill() must really end the process: the failover loop calls it on a
      // usage limit and then resumes this session on ANOTHER account, which
      // cannot happen while the old process still holds the session.
      kill: () => this.destroy(entry),
      interrupt: () => { this.writeLine(entry, this.transport.interruptMessage(entry.st)); },
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
