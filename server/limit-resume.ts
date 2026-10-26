import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { capReset } from '../src/detector.js';
import type { LimitKind, RawEvent, Verdict } from '../src/types.js';
import type { MessageSender } from '../src/message-sender.js';
import type { FileReference } from './file-store.js';
import { writeState } from './workspace-store.js';

/**
 * Usage-limit auto-continue (docs/limit-resume-contract.md, R4-R7).
 *
 * A conversation that stops at "You've hit your session limit" must carry on by
 * itself: on another account at once when one can take it, else after the
 * reset. Two ways it stops:
 *
 *   - OUT OF TURN (R4): the gateway's turn had already ended when a background
 *     agent woke the model and the agent or the woken reply got the 429. Those
 *     events go to the pool's idle sink, never to the failover classifier, so
 *     before this nothing marked the account, failed over or scheduled
 *     anything, and the panel announced the limit text as a "finished" reply.
 *   - PARKED (R5): an in-turn limit with every account out.
 *
 * Either way a record lands here (`<stateDir>/limit-resume.json`, one per
 * conversation or delegate, a newer one replacing it -- except a `resend`,
 * which holds a message that never ran and is never replaced), and the
 * scheduler sends it through the ordinary send path when an account can take it.
 */

export type ResumeKind = 'continue' | 'resend' | 'autopilot' | 'delegate';

export interface FailedTask { id: string; description: string }

export interface LimitResumeRecord {
  id: string;
  projectId: string;
  sessionId: string;
  provider: 'claude' | 'codex';
  kind: ResumeKind;
  /** Epoch seconds when the limit resets (R1-R3), estimated or not. */
  until: number;
  estimated: boolean;
  createdAt: string;
  /** Epoch seconds it fires: at once when an account could take it at creation, else until + 60 s. */
  fireAt: number;
  attempts: number;
  /** Created to fire at once (an account could take it). */
  immediate?: boolean;
  /** What hit the limit, for the continue text. */
  account?: string;
  /** The ORIGINAL turn's origin (human, cron, relay, ...): the continue's
   *  ending notifies, and recaps, as that turn would have. */
  origin?: string;
  /** The account the original message asked for, and its reserve choice:
   *  a resend keeps them, and eligibility is judged with them. */
  routeAccount?: string;
  useReserve?: boolean;
  /** Epoch seconds of the first guard refusal or failed send in the current
   *  run of them: retried every RETRY_S, given up RETRY_FOR_S after this. */
  retryingSince?: number;
  limitKind?: LimitKind;
  limitAt?: number;
  failedTasks?: FailedTask[];
  /** `resend` (and a delegate's): the turn that never started, as it was. */
  prompt?: string;
  sender?: MessageSender;
  model?: string;
  effort?: string;
  speed?: string;
  attachments?: FileReference[];
  requestId?: string;
  /** `resend` of a conversation's very first turn: no session exists to resume yet. */
  fresh?: boolean;
  /** The parked turn was the owner's (or an agent's) while autopilot ran:
   *  autopilot is un-paused before it is sent, so the run goes on after it. */
  resumeAutopilot?: boolean;
  delegate?: { parentSessionId: string; delegateId: string; mode: 'continue' | 'resend' };
}

export type ScheduleInput = Omit<LimitResumeRecord, 'id' | 'createdAt' | 'fireAt' | 'attempts'> & { now?: boolean };

export interface ResumeHost {
  /** Epoch seconds. */
  now(): number;
  /** An account can take this conversation's turn right now (its own routing context). */
  eligible(rec: LimitResumeRecord): boolean;
  /** The earliest future reset for the provider, else a 30 min estimate (R3). */
  nextReset(rec: LimitResumeRecord): { until: number; estimated: boolean };
  /** Why the record must not fire any more: gone, archived, a pending question, a stopped delegate. */
  skipReason(rec: LimitResumeRecord): string | undefined;
  /** Why it cannot be sent JUST NOW (state recovery, membership being
   *  reconciled): it is retried later, never dropped. */
  blocked?(rec: LimitResumeRecord): string | undefined;
  /** The record ended without being sent (skipped, gave up, loop brake): a
   *  delegate must not stay `waiting_for_reset` forever. `detail` is the why. */
  ended?(rec: LimitResumeRecord, reason: EndReason, detail: string): void;
  /** A `resend` was kept over a newer record for the same conversation: the
   *  newer message goes into the queue behind it, never lost. */
  kept?(kept: LimitResumeRecord, newer: LimitResumeRecord): void;
  /** Send it through the ordinary path (a busy conversation queues it). Throws when it cannot. */
  deliver(rec: LimitResumeRecord, text: string): void;
  log(row: Record<string, unknown>): void;
  emit(kind: string, data: Record<string, unknown>): void;
}

export type EndReason = 'skipped' | 'gave_up' | 'braked';

/** "No eligible account" re-parks before giving up (guard refusals and failed
 *  sends do not count: they retry for RETRY_FOR_S), and continues allowed
 *  without a human message in between. */
export const MAX_ATTEMPTS = 6;
export const MAX_AUTO_CONTINUES = 3;
export const TICK_MS = 30_000;
/** A record that waits for a reset fires this long after it. */
export const FIRE_AFTER_RESET_S = 60;
export const NO_RESET_FALLBACK_S = 30 * 60;
/** A record that could not be sent just now (blocked, delivery failed) is retried this much later, */
export const RETRY_S = 5 * 60;
/** ...for this long from the first refusal, then given up with the real reason. */
export const RETRY_FOR_S = 24 * 3600;
/** How much of a resend's prompt a "not sent" notice quotes. */
export const PROMPT_QUOTE = 120;
const ZONE = 'Asia/Jakarta';

const keyOf = (r: Pick<LimitResumeRecord, 'sessionId' | 'delegate'>) => r.delegate ? `delegate:${r.delegate.parentSessionId}:${r.delegate.delegateId}` : r.sessionId;
/** A message that never ran, kept as it was: it is never replaced by a newer record. */
export const isResend = (r: Pick<LimitResumeRecord, 'kind' | 'delegate'>) => r.kind === 'resend' || r.delegate?.mode === 'resend';

interface FileShape { records: LimitResumeRecord[]; streaks: Record<string, number> }

export class LimitResumeScheduler {
  private readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private kicked: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(stateDir: string, private readonly host: ResumeHost) {
    this.file = join(stateDir, 'limit-resume.json');
  }

  private load(): FileShape {
    if (!existsSync(this.file)) return { records: [], streaks: {} };
    let raw: Partial<FileShape> | null;
    try { raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape> | null; }
    catch (e) { this.setAside((e as Error).message); return { records: [], streaks: {} }; }
    if (!raw || typeof raw !== 'object' || (raw.records !== undefined && !Array.isArray(raw.records))) { this.setAside('not a limit-resume file'); return { records: [], streaks: {} }; }
    return { records: Array.isArray(raw.records) ? raw.records : [], streaks: raw.streaks && typeof raw.streaks === 'object' ? raw.streaks : {} };
  }
  /** A file that does not parse is kept beside it, logged, and the scheduler
   *  starts empty: never wiped silently (its records are someone's messages). */
  private setAside(error: string): void {
    const to = `${this.file}.corrupt-${Date.now()}`;
    try { renameSync(this.file, to); } catch { /* gone meanwhile */ }
    console.warn(`[limit-resume] ${this.file} is unreadable (${error}); set aside as ${to}`);
    this.host.log({ type: 'limit_resume_corrupt', file: this.file, setAside: to, error });
  }
  private save(s: FileShape): void { writeState(this.file, s); }

  list(): LimitResumeRecord[] { return this.load().records; }
  /** A conversation's own record waits (not a delegate's): its queue must not drain into another park. */
  waiting(sessionId: string): boolean { return this.load().records.some((r) => !r.delegate && r.sessionId === sessionId); }
  forDelegate(parentSessionId: string, delegateId: string): LimitResumeRecord | undefined {
    return this.load().records.find((r) => r.delegate?.parentSessionId === parentSessionId && r.delegate.delegateId === delegateId);
  }

  schedule(input: ScheduleInput): LimitResumeRecord {
    const { now: atOnce, ...rest } = input;
    const t = this.host.now();
    const rec: LimitResumeRecord = { ...rest, id: 'lr-' + Math.random().toString(36).slice(2, 10), createdAt: new Date(t * 1000).toISOString(), attempts: 0,
      fireAt: atOnce ? t : Math.max(t, rest.until + FIRE_AFTER_RESET_S), ...(atOnce ? { immediate: true } : {}) };
    const s = this.load();
    // A resend holds a message that never ran: a newer park never replaces it.
    // The newer one goes into the queue behind it (the host's `kept`).
    const prev = s.records.find((r) => keyOf(r) === keyOf(rec));
    if (prev && isResend(prev)) {
      if (!prev.delegate && (rec.kind === 'autopilot' || rec.resumeAutopilot)) { prev.resumeAutopilot = true; this.save(s); }
      this.host.log({ type: 'limit_resume_kept', kept: prev.id, newer: summary(rec) });
      this.host.kept?.(prev, rec);
      return prev;
    }
    s.records = [...s.records.filter((r) => keyOf(r) !== keyOf(rec)), rec];
    this.save(s);
    this.host.log({ type: 'limit_resume_scheduled', ...summary(rec) });
    if (rec.fireAt <= t) this.kick();
    return rec;
  }

  /** Drops a record without firing it. */
  clear(key: string, reason: string): boolean {
    const s = this.load();
    const hit = s.records.filter((r) => keyOf(r) === key);
    if (!hit.length) return false;
    s.records = s.records.filter((r) => keyOf(r) !== key);
    this.save(s);
    for (const r of hit) this.host.log({ type: 'limit_resume_skipped', reason, ...summary(r) });
    return true;
  }
  clearDelegate(parentSessionId: string, delegateId: string, reason: string): boolean { return this.clear(`delegate:${parentSessionId}:${delegateId}`, reason); }
  /** A conversation's own record and its delegates' (the conversation was deleted). */
  clearConversation(sessionId: string, reason: string): void {
    for (const k of new Set(this.load().records.map(keyOf))) if (k === sessionId || k.startsWith(`delegate:${sessionId}:`)) this.clear(k, reason);
  }

  /** A human message: the owner is the next step, and the loop brake starts over
   *  for the conversation and its delegates. */
  humanMessage(sessionId: string): void {
    this.clear(sessionId, 'human');
    const s = this.load();
    let changed = false;
    for (const k of Object.keys(s.streaks)) if (k === sessionId || k.startsWith(`delegate:${sessionId}:`)) { delete s.streaks[k]; changed = true; }
    if (changed) this.save(s);
  }

  start(): void {
    if (this.timer || this.stopped) return;
    const loop = () => { this.timer = setTimeout(() => { try { this.tick(); } catch (e) { console.warn('[limit-resume] tick failed:', (e as Error).message); } loop(); }, TICK_MS); this.timer.unref?.(); };
    loop();
    // A record whose time passed while the gateway was down fires now.
    this.kick();
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.kicked) clearTimeout(this.kicked);
    this.timer = this.kicked = null;
  }
  private kick(): void {
    if (this.kicked || this.stopped) return;
    this.kicked = setTimeout(() => { this.kicked = null; try { this.tick(); } catch (e) { console.warn('[limit-resume] tick failed:', (e as Error).message); } }, 0);
    this.kicked.unref?.();
  }

  /** Fires every record that is due, and early any record waiting for a reset
   *  that an account can take now (one freed up, or its reset passed). Not one
   *  in the guard retry: that keeps its 5 min spacing. Public for tests and
   *  the boot pass. */
  tick(): void {
    const t = this.host.now();
    for (const r of this.load().records) {
      if (r.fireAt <= t) { this.fire(r.id); continue; }
      let early = false;
      if (r.retryingSince == null) { try { early = this.host.eligible(r); } catch { early = false; } }
      if (early) this.fire(r.id);
    }
  }

  private fire(id: string): void {
    const s = this.load();
    const rec = s.records.find((r) => r.id === id);
    if (!rec) return;
    const key = keyOf(rec), t = this.host.now();
    const drop = () => { s.records = s.records.filter((r) => r.id !== id); };
    const skip = this.host.skipReason(rec);
    if (skip) {
      drop(); this.save(s);
      this.host.log({ type: 'limit_resume_skipped', reason: skip, ...summary(rec) });
      // A message that never ran is never dropped silently (a deleted
      // conversation has nobody to tell).
      if (skip !== 'gone' && quoted(rec)) this.host.emit('limit_resume', { state: 'skipped', ...target(rec), reason: skip, prompt: quoted(rec) });
      this.host.ended?.(rec, 'skipped', skip);
      return;
    }
    // Not now (state recovery at boot, membership being reconciled): later, never dropped.
    const blocked = this.host.blocked?.(rec);
    if (blocked) { this.retry(s, rec, t, blocked, 'blocked'); return; }
    if (!this.host.eligible(rec)) { const next = this.host.nextReset(rec); this.repark(s, rec, Math.max(t + 1, next.until + FIRE_AFTER_RESET_S), next); return; }
    // Loop brake: the 4th auto-continue without a human message is not sent.
    const used = s.streaks[key] ?? 0;
    if (used >= MAX_AUTO_CONTINUES) {
      drop(); this.save(s);
      this.host.log({ type: 'limit_resume_skipped', reason: 'loop_brake', ...summary(rec) });
      this.host.emit('limit_resume', { state: 'braked', ...target(rec), count: used, ...(quoted(rec) ? { prompt: quoted(rec) } : {}) });
      this.host.ended?.(rec, 'braked', `auto-continue stopped after ${used} tries in a row`);
      return;
    }
    // Off the file BEFORE it is sent: the send may start a turn that parks and schedules anew.
    drop(); this.save(s);
    // Before the reset, it runs on an account other than the limited one.
    const text = rec.kind === 'resend' || rec.delegate?.mode === 'resend' ? rec.prompt ?? '' : continueText(rec, t < rec.until);
    try { this.host.deliver(rec, text); }
    catch (e) {
      // Not sent: it stays (retried in 5 min, up to a day) and the loop brake does not count it.
      const cur = this.load();
      if (cur.records.some((r) => keyOf(r) === key)) return; // a newer one replaced it meanwhile
      cur.records.push(rec);
      this.retry(cur, rec, t, (e as Error).message || 'delivery failed', 'delivery_failed');
      return;
    }
    const after = this.load();
    after.streaks[key] = (after.streaks[key] ?? 0) + 1;
    this.save(after);
    this.host.log({ type: 'limit_resume_fired', ...summary(rec) });
    this.host.emit('limit_resume', { state: 'fired', ...target(rec) });
  }

  /** No account could take it: one more attempt after the next reset, or,
   *  after MAX_ATTEMPTS of these (and only these), give up with one notice. */
  private repark(s: FileShape, rec: LimitResumeRecord, fireAt: number, reset: { until: number; estimated: boolean }): void {
    rec.attempts++;
    // Past the guard: a later refusal starts its own 24 h.
    delete rec.retryingSince;
    if (rec.attempts >= MAX_ATTEMPTS) { this.giveUp(s, rec, `no account could take it after ${rec.attempts} tries`); return; }
    rec.until = reset.until; rec.estimated = reset.estimated;
    rec.fireAt = fireAt;
    this.save(s);
    this.host.log({ type: 'limit_resume_scheduled', reparked: true, ...summary(rec) });
  }

  /** Not now (a guard refusal, a failed send): again in RETRY_S, without
   *  spending an attempt, for up to RETRY_FOR_S; then give up saying why. */
  private retry(s: FileShape, rec: LimitResumeRecord, t: number, error: string, reason: string): void {
    rec.retryingSince ??= t;
    if (t - rec.retryingSince >= RETRY_FOR_S) { this.giveUp(s, rec, error); return; }
    rec.fireAt = t + RETRY_S;
    this.save(s);
    this.host.log({ type: 'limit_resume_skipped', reason, error, reparked: true, ...summary(rec) });
  }

  private giveUp(s: FileShape, rec: LimitResumeRecord, reason: string): void {
    s.records = s.records.filter((r) => r.id !== rec.id); this.save(s);
    this.host.log({ type: 'limit_resume_gave_up', ...summary(rec), reason });
    this.host.emit('limit_resume', { state: 'gave_up', ...target(rec), attempts: rec.attempts, reason, ...(quoted(rec) ? { prompt: quoted(rec) } : {}) });
    this.host.ended?.(rec, 'gave_up', reason);
  }
}

/** The start of a conversation's resend prompt, for a "not sent" notice. A
 *  delegate's resend is its orchestrator's business (it reports BLOCKED). */
function quoted(r: LimitResumeRecord): string | undefined {
  if (r.delegate || r.kind !== 'resend' || !r.prompt) return undefined;
  const p = r.prompt.trim();
  return p.length > PROMPT_QUOTE ? p.slice(0, PROMPT_QUOTE).trimEnd() + '…' : p;
}

function target(r: LimitResumeRecord): Record<string, unknown> {
  return { projectId: r.projectId, sessionId: r.sessionId, kind: r.kind, ...(r.delegate ? { delegateId: r.delegate.delegateId } : {}) };
}
function summary(r: LimitResumeRecord): Record<string, unknown> {
  return { id: r.id, ...target(r), until: r.until, estimated: r.estimated, fireAt: r.fireAt, attempts: r.attempts, ...(r.account ? { account: r.account } : {}), ...(r.retryingSince != null ? { retryingSince: r.retryingSince } : {}) };
}

// ---- the continue message ----

function wib(sec: number, withDate: boolean): string {
  const opts: Intl.DateTimeFormatOptions = { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(withDate ? { month: 'short', day: 'numeric' } : {}) };
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(sec * 1000)).replace(',', '') + ' WIB';
}
const dayOf = (sec: number) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date(sec * 1000));
const KIND_WORD: Record<string, string> = { session: 'session', weekly: 'weekly', model: 'model', unknown: 'usage' };

/** R4's text. `elsewhere`: fired at once, on another account; else after the wait. */
export function continueText(r: Pick<LimitResumeRecord, 'account' | 'limitKind' | 'limitAt' | 'until' | 'failedTasks' | 'createdAt'>, elsewhere = true): string {
  const at = r.limitAt ?? Math.floor(Date.parse(r.createdAt) / 1000);
  const resets = wib(r.until, dayOf(r.until) !== dayOf(at));
  const who = r.account ? `account ${r.account}` : 'the account';
  const lines = [`[Usage limit: ${who} hit its ${KIND_WORD[r.limitKind ?? 'unknown'] ?? 'usage'} limit at ${wib(at, false)} (resets ${resets}). ${elsewhere ? 'This continues on another account.' : 'This continues after the reset.'}]`, 'Continue where you left off.'];
  const tasks = r.failedTasks ?? [];
  if (tasks.length) {
    lines.push('These background agents were stopped by the limit and did not finish; re-run them if they are still needed:');
    for (const t of tasks) lines.push(`- "${t.description.replace(/"/g, "'")}" (${t.id})`);
  }
  return lines.join('\n');
}

// ---- reading the idle stream (R4) ----

const LIMIT_TEXT = /rate_limit|\b429\b|hit your .*limit/i;

/** A background task the limit killed: a top-level `task_notification`
 *  (failed / killed) whose summary names the limit. The stream carries no
 *  description, so it is read from the summary's `Agent "<description>"`. */
export function failedTaskOf(e: RawEvent): FailedTask | undefined {
  if (e.type !== 'system' || e.subtype !== 'task_notification' || e.parent_tool_use_id) return undefined;
  if (e.status !== 'failed' && e.status !== 'killed') return undefined;
  const summary = typeof e.summary === 'string' ? e.summary : '';
  const reason = typeof e.reason === 'string' ? e.reason : '';
  if (!LIMIT_TEXT.test(summary + ' ' + reason)) return undefined;
  const id = typeof e.task_id === 'string' ? e.task_id : '';
  if (!id) return undefined;
  const named = /^Agent "(.+?)" (?:failed|was killed|stopped)/.exec(summary);
  return { id, description: (named?.[1] ?? summary.split(':')[0] ?? 'background task').slice(0, 200) };
}

/** Two limited verdicts of one wake as one: the later reset, the more specific
 *  kind. The same guess as failover's mergeLimits (R2): one live case
 *  suggested a weekly limit's structured resetsAt may be the 5-hour window. */
export function mergeVerdicts(a: Verdict, b: Verdict): Verdict {
  const later = (x?: number, y?: number) => (x == null ? y : y == null ? x : Math.max(x, y));
  const limitKind = a.limitKind && a.limitKind !== 'unknown' ? a.limitKind : b.limitKind ?? a.limitKind;
  const resetsAt = later(a.resetsAt, b.resetsAt), resetsInSeconds = later(a.resetsInSeconds, b.resetsInSeconds);
  return { ...a, ...(limitKind ? { limitKind } : {}), ...(resetsAt != null ? { resetsAt } : {}), ...(resetsInSeconds != null ? { resetsInSeconds } : {}) };
}

/** What one process's idle stream has shown since its conversation's last turn. */
export interface LimitWatch {
  failedTasks: FailedTask[];
  verdict?: Verdict;
  configDir?: string;
  account?: string;
  at?: number;
  /** The origin of the turn whose background work hit the limit. */
  origin?: string;
  /** The 5 s fallback for a woken reply that never writes its result. */
  timer?: ReturnType<typeof setTimeout>;
  done?: boolean;
}

/** The reset a verdict names, in epoch seconds (capped at now + 8 days), or the 30 min estimate. */
export function untilOf(v: Verdict, now: number): { until: number; estimated: boolean } {
  if (v.resetsAt != null) return { until: capReset(v.resetsAt, now), estimated: false };
  if (v.resetsInSeconds != null) return { until: capReset(now + v.resetsInSeconds, now), estimated: false };
  return { until: now + NO_RESET_FALLBACK_S, estimated: true };
}

/** Fix 4: background agents a limit killed while a gateway turn was already
 *  running again -- one line steered into that turn, instead of a continue
 *  that would run after it and restart abandoned work. */
export function stoppedAgentsLine(tasks: FailedTask[]): string {
  return `These background agents were stopped by a usage limit: ${tasks.map((t) => `"${t.description.replace(/"/g, "'")}" (${t.id})`).join(', ')}. Re-run them if still needed.`;
}
