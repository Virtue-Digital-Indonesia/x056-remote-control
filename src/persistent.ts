import { StringDecoder } from 'node:string_decoder';
import { spawn, type ChildProcess } from 'node:child_process';
import type { RawEvent } from './types.js';
import type { TurnExit, TurnHandle, TurnOptions } from './turn.js';
import { StderrTail } from './turn.js';
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
  /** A turn ran on the conversation's working process although it asked for
   *  another identity (startTurn). Logged: it should be rare once the manager
   *  pins the identity itself. */
  onHeld?: (info: { sessionId: string; wanted: string; kept: string }) => void;
  /** How often a held prompt checks whether the reply it waits on still
   *  exists (see startDeferWatch). Tests shorten it. */
  deferPollMs?: number;
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
  /** Where events go when no turn is in flight (UI only, never the classifier).
   *  The source names the account the process was SPAWNED on: `opts` is the
   *  latest turn's, which a held turn may have routed elsewhere. */
  idleSink?: (e: RawEvent, src?: IdleSource) => void;
  /** The account (config dir) this process was spawned on. */
  configDir: string;
  /** An out-of-turn usage limit hit this process's account (markLimitHit): it
   *  takes no new turn, and a prompt held for its reply moves to a fresh one. */
  limitHit?: boolean;
  /** The held turn moved to this handle (moveHeld); kill and interrupt follow it. */
  moved?: TurnHandle;
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
  /** The tail of the process's stderr, reset at each turn start. */
  stderr: StderrTail;
  exited: boolean;
  /**
   * The main session is mid-reply: it has streamed since its last `result`.
   * Between gateway turns this is a background task's notification waking
   * the model. A prompt written now could be folded into that reply or
   * answered after it, so its result count is unknowable; runOn holds it.
   */
  queryOpen?: boolean;
  /** A turn's prompt held until the reply in progress ends (see queryOpen),
   *  with the turn's own sink; `cancelled` once Stop was pressed meanwhile. */
  deferred?: { line: string; sink: (e: RawEvent) => void; cancelled?: boolean };
  /** Where this turn's events go, and how it is finished. */
  sink?: (e: RawEvent) => void;
  finish?: (exit: TurnExit) => void;
}

/** Where an out-of-turn event came from (see Live.idleSink). */
export interface IdleSource { configDir: string }

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
      .map(e => ({ sessionId: e.sessionId, busy: e.busy, ...e.activity.snapshot(), shells: e.activity.counts().shells }));
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
   * Resolves false when there is no live process, or the transport refused
   * the steer (Codex answers turn/steer with an error once the turn it names
   * is over) -- the caller must fall back to the queue rather than drop the
   * message on the floor.
   *
   * `requireTurn`: only into a gateway turn in flight. Without it a process
   * that is alive but idle takes the text as a turn of its own, which no
   * gateway run tracks -- right for the panel's steer into background work,
   * wrong for an AI sender, whose message must then queue.
   */
  async injectMessage(sessionId: string, text: string, opts: { requireTurn?: boolean } = {}): Promise<boolean> {
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
    if (opts.requireTurn && !target.busy) return false;
    // A transport still in its handshake has nothing to steer into yet.
    const line = this.transport.steerMessage(target.st, text, target.busy);
    if (line === null) return false;
    const ack = this.transport.steerAck?.(target.st);
    // With a turn in flight the model folds the steer into it -- one result
    // for both. With no turn, the steer IS a turn and emits a result of its
    // own, which would otherwise settle whatever gateway turn came next:
    // `runSession` would return the steer's text as that turn's answer and
    // drain the queue into a process that had not started on it. Counted
    // BEFORE the write: a reply (a refused turn/start ends "a turn" in
    // ingest) can arrive inside it, and must find the slot already taken.
    const idle = !target.busy;
    if (idle) target.pendingSteers++;
    // A pipe whose far end is gone accepts writes silently, so `write` alone
    // cannot tell delivered from discarded -- and the caller would skip the
    // queue fallback on the strength of it.
    if (!this.writeLine(target, line)) { if (idle) target.pendingSteers--; return false; }
    // Steering is output-producing work; without this the entry looks idle
    // to the eviction pass and can be culled between the write and the
    // model's first token.
    target.lastOutput = this.now();
    if (idle) { target.activity.start(); this.publishActivity(target); }
    return ack ? await ack : true;
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

    // A process whose account hit a usage limit out of turn takes no new turn:
    // the held rule below would run it there whatever account this turn was
    // routed to, its 429 would bench THAT account, and the conversation would
    // never leave the limited one (the held-process trap, contract item 6).
    for (const e of [...this.live.values()]) {
      if (e.sessionId === (o.conversationId ?? o.sessionId) && e.limitHit && !e.busy) this.destroy(e);
    }
    if (entry?.exited) entry = undefined;

    // One conversation, one process while it works. Model and effort are
    // Claude argv, so a turn on a different one keys elsewhere; spawning it
    // while the first process still ran background agents gave the
    // conversation two writers on one transcript: the old one, woken by its
    // own agent, never saw the user's message and told them "another
    // instance of this conversation" had it (seen live 2026-10-09). The turn
    // runs on the working process instead, on that process's model; the
    // manager holds the picker's change for the same reason (heldIdentity).
    // Codex is single-writer and keeps its own rule below.
    if (!this.transport.singleWriter) {
      const active = this.activeProcess(o.conversationId ?? o.sessionId);
      if (active) {
        if (active.busy) return deadHandle(`persistent session already running a turn: ${o.sessionId}`);
        // Its own key too: an active process is never parked as stale
        // below and replaced, for the same reason.
        if (active !== entry) this.opts.onHeld?.({ sessionId: active.sessionId, wanted: key, kept: active.key });
        return this.runOn(active, o);
      }
    }

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

  /**
   * The conversation's process that is doing work right now: a gateway turn,
   * background tasks still running, or a reply in progress. Not the output
   * grace of working(): a turn that just ended on a model the user then
   * changed must respawn on the new one. Newest turn first.
   */
  /**
   * A held prompt is released by the awaited reply's `result` (onData). This
   * covers the cases with no such result: the expected wake never came
   * (waking expired) or the reply went silent past the grace. Then the
   * prompt goes out now, or, Stopped meanwhile, the turn just ends.
   */
  private startDeferWatch(entry: Live): void {
    const timer = setInterval(() => {
      const held = entry.deferred;
      if (!held || entry.exited) { clearInterval(timer); return; }
      if (this.replying(entry)) return;
      clearInterval(timer);
      if (entry.limitHit) { this.moveHeld(entry); return; }
      entry.deferred = undefined;
      if (held.cancelled) { this.settleTurn(entry, { code: 0, signal: null }); return; }
      if (!this.writeLine(entry, held.line)) { this.destroy(entry); return; }
      entry.sink = held.sink;
      entry.queryOpen = true;
      entry.lastOutput = this.now();
      entry.activity.start();
      this.publishActivity(entry);
    }, this.opts.deferPollMs ?? 1000);
    timer.unref?.();
  }

  /** Mid-reply, and not a flag left behind: a reply in progress writes,
   *  and one silent past the grace is taken as over. */
  private replying(e: Live): boolean {
    return (!!e.queryOpen && this.now() - e.lastOutput < this.workingGraceMs) || e.activity.waking();
  }

  private activeProcess(conversationId: string): Live | undefined {
    let best: Live | undefined;
    for (const e of this.live.values()) {
      if (e.sessionId !== conversationId || e.exited || e.limitHit) continue;
      if (!(e.busy || this.replying(e) || e.activity.snapshot().active)) continue;
      // A process a newer sibling has moved past is parked work, not the
      // conversation: its context lacks that sibling's turns (see isStale).
      if (this.isStale(e)) continue;
      if (!best || e.busy || (!best.busy && e.lastTurnStart > best.lastTurnStart)) best = e;
    }
    return best;
  }

  /** The model, effort and advisor the conversation's working process runs
   *  with, so the manager can run a turn on it as it is (see startTurn). */
  heldIdentity(conversationId: string): { model?: string; effort?: string; advisor?: string } | undefined {
    if (this.transport.singleWriter) return undefined;
    const e = this.activeProcess(conversationId);
    return e?.opts ? { model: e.opts.model, effort: e.opts.effort, advisor: e.opts.advisor } : undefined;
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
        // stderr piped and forwarded: its last line explains a turn the
        // stream did not (see StderrTail).
        : spawn(bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (err) {
      return { error: (err as Error).message };
    }

    // Looked up by the gateway's conversation id (steer, interrupt, "working"),
    // which for Codex is not what the CLI was handed after the first turn.
    const entry: Live = { key, child, configDir: o.configDir, sessionId: o.conversationId ?? o.sessionId, busy: false, lastUsed: this.now(), lastOutput: this.now(), activity: new ProviderActivity(() => this.now()), st: { buf: '', ext: {} }, exited: false, pendingSteers: 0, lastTurnStart: 0, early: [], endedEarly: false, stderr: new StderrTail() };
    child.stdout?.on('data', (d: Buffer) => this.onData(entry, d));
    child.stderr?.on('data', (d: Buffer) => entry.stderr.push(d));
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
      // A sink may end the process (an out-of-turn limit): the rest is not ours.
      if (entry.exited) return;
      if (!line.trim().startsWith('{')) continue;
      const { events, turnEnded, readyNow } = this.transport.ingest(entry.st, line);
      entry.activity.observe(this.transport.id, line, entry.st.ext.threadId);
      if (turnEnded) entry.activity.endTurn();
      // The main session's reply is in progress from its first message until
      // its result. Subagent traffic (parent_tool_use_id) is not the main reply.
      if (this.transport.id === 'claude') {
        for (const e of events) {
          if ((e.type === 'assistant' || e.type === 'stream_event') && !(e as { parent_tool_use_id?: unknown }).parent_tool_use_id) entry.queryOpen = true;
        }
        if (turnEnded) entry.queryOpen = false;
      }
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
      const src: IdleSource = { configDir: entry.configDir };
      for (const e of events) { try { if (entry.sink) entry.sink(e); else entry.idleSink?.(e, src); } catch { /* a sink must never break the stream */ } }
      if (entry.exited) return;
      // The turn is over here, but the PROCESS is not — that is the point.
      if (turnEnded) {
        entry.lastUsed = this.now();
        // stdin is FIFO, so results come back in the order the messages went
        // in: the first ones belong to the steers that were injected first.
        if (entry.pendingSteers > 0) { entry.pendingSteers--; this.publishActivity(entry); continue; }
        // The reply that was in progress when this turn started has ended
        // (runOn held the prompt). Its result was not this turn's: send the
        // prompt now and hand the turn its sink. Stopped meanwhile: the turn
        // ends here and the prompt is never sent.
        const held = entry.deferred;
        // The reply it waited for hit a usage limit: never into this process.
        if (held && entry.limitHit) { this.moveHeld(entry); return; }
        if (held) {
          entry.deferred = undefined;
          if (!held.cancelled) {
            if (!this.writeLine(entry, held.line)) { this.destroy(entry); return; }
            entry.sink = held.sink;
            entry.queryOpen = true;
            entry.activity.start();
            this.publishActivity(entry);
            continue;
          }
        }
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
    // What the CLI said on stderr during this turn, for a failure the stream
    // did not explain (TurnExit.stderr).
    const line = entry.finish ? entry.stderr.lastLine() : undefined;
    if (line && !exit.stderr) exit = { ...exit, stderr: line };
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
    // Read before lastOutput is refreshed below, which would make any old
    // flag look like a reply in progress.
    const midReply = this.replying(entry);
    if (!midReply) entry.queryOpen = false;
    entry.busy = true;
    entry.lastUsed = this.now();
    entry.lastTurnStart = this.now();
    entry.lastOutput = this.now();
    entry.sink = o.onEvent;
    // Refreshed each turn: the newest caller is the one whose UI is listening.
    if (o.onIdleEvent) entry.idleSink = o.onIdleEvent;
    const done = new Promise<TurnExit>((resolve) => { entry.finish = resolve; });
    // Only this turn's stderr can explain this turn.
    if (!midReply) entry.stderr.reset();
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
      const line = this.transport.userMessage(entry.st, o, o.prompt);
      if (midReply) {
        // A background task woke the model and its reply is still running.
        // Written now, the prompt is folded into that reply (one result) or
        // answered after it (two), and the first result would end this turn
        // with the wrong answer while the real one arrived out of turn. So it
        // waits for that reply's result (onData); the reply itself keeps
        // going to the idle sink, as background work.
        entry.deferred = { line, sink: o.onEvent };
        entry.sink = undefined;
        this.startDeferWatch(entry);
      } else if (!this.writeLine(entry, line)) {
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
      kill: () => { if (entry.moved) entry.moved.kill(); else this.destroy(entry); },
      interrupt: () => {
        if (entry.moved) { entry.moved.interrupt(); return; }
        // Stop before the held prompt went out: it never will.
        if (entry.deferred) entry.deferred.cancelled = true;
        this.writeLine(entry, this.transport.interruptMessage(entry.st));
      },
      done,
    };
  }

  /**
   * An out-of-turn usage limit hit `configDir` while it ran this conversation.
   * Its processes on that account take no new turn (startTurn, activeProcess)
   * and a prompt held for their reply goes to a fresh process. A process busy
   * with a turn it already started is left to that turn's own classifier.
   */
  markLimitHit(conversationId: string, configDir: string): number {
    let n = 0;
    for (const e of this.live.values()) {
      if (e.sessionId !== conversationId || e.exited || e.configDir !== configDir || (e.busy && !e.deferred)) continue;
      e.limitHit = true; n++;
    }
    return n;
  }

  /** Ends the conversation's limit-hit processes (markLimitHit), so the next
   *  turn routes to an eligible account and spawns there with --resume. Their
   *  remaining background tasks are on the limited account and would 429 at
   *  their next call anyway. */
  destroyLimitHit(conversationId: string): number {
    let n = 0;
    for (const e of [...this.live.values()]) {
      if (e.sessionId !== conversationId || e.exited || !e.limitHit) continue;
      n++;
      if (!this.moveHeld(e)) this.destroy(e);
    }
    return n;
  }

  /**
   * A turn whose prompt was held for a reply (runOn, `deferred`) on a process
   * that then hit a usage limit. The prompt never reached that process, so the
   * turn runs on a fresh one, spawned on the account it was routed to: written
   * into the limited process it would 429 and bench the routed account.
   */
  private moveHeld(entry: Live): boolean {
    const held = entry.deferred, o = entry.opts, finish = entry.finish;
    if (!held || !o || !finish) return false;
    entry.deferred = undefined; entry.finish = undefined; entry.sink = undefined; entry.busy = false;
    this.destroy(entry);
    if (held.cancelled) { finish({ code: 0, signal: null }); return true; }
    // The conversation exists (its process did), so this resumes it.
    const next = this.startTurn({ ...o, onEvent: held.sink, mode: 'resume' });
    entry.moved = next;
    void next.done.then(finish);
    return true;
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
