import { join } from 'node:path';
import type { LimitKind, RawEvent, Verdict } from '../src/types.js';
import type { MessageSender } from '../src/message-sender.js';
import type { FileReference } from './file-store.js';
import { readState, writeState } from './workspace-store.js';

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
 * conversation or delegate, a newer one replacing it), and the scheduler sends
 * it through the ordinary send path when an account can take it.
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
  /** The record ended without being sent (gave up, loop brake): a delegate
   *  must not stay `waiting_for_reset` forever. */
  ended?(rec: LimitResumeRecord, reason: 'gave_up' | 'braked'): void;
  /** Send it through the ordinary path (a busy conversation queues it). Throws when it cannot. */
  deliver(rec: LimitResumeRecord, text: string): void;
  log(row: Record<string, unknown>): void;
  emit(kind: string, data: Record<string, unknown>): void;
}

/** Re-parks before giving up, and continues allowed without a human message in between. */
export const MAX_ATTEMPTS = 6;
export const MAX_AUTO_CONTINUES = 3;
export const TICK_MS = 30_000;
/** A record that waits for a reset fires this long after it. */
export const FIRE_AFTER_RESET_S = 60;
export const NO_RESET_FALLBACK_S = 30 * 60;
/** A record that could not be sent just now (blocked, delivery failed) is retried this much later. */
export const RETRY_S = 5 * 60;
const ZONE = 'Asia/Jakarta';

const keyOf = (r: Pick<LimitResumeRecord, 'sessionId' | 'delegate'>) => r.delegate ? `delegate:${r.delegate.parentSessionId}:${r.delegate.delegateId}` : r.sessionId;

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
    const raw = readState<Partial<FileShape>>(this.file, {});
    return { records: Array.isArray(raw.records) ? raw.records : [], streaks: raw.streaks && typeof raw.streaks === 'object' ? raw.streaks : {} };
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

  /** Fires every record that is due. Public for tests and the boot pass. */
  tick(): void {
    const t = this.host.now();
    for (const due of this.load().records.filter((r) => r.fireAt <= t)) this.fire(due.id);
  }

  private fire(id: string): void {
    const s = this.load();
    const rec = s.records.find((r) => r.id === id);
    if (!rec) return;
    const key = keyOf(rec), t = this.host.now();
    const drop = () => { s.records = s.records.filter((r) => r.id !== id); };
    const skip = this.host.skipReason(rec);
    if (skip) { drop(); this.save(s); this.host.log({ type: 'limit_resume_skipped', reason: skip, ...summary(rec) }); return; }
    // Not now (state recovery at boot, membership being reconciled): later, never dropped.
    const blocked = this.host.blocked?.(rec);
    if (blocked) { this.repark(s, rec, t + RETRY_S, false, blocked); return; }
    if (!this.host.eligible(rec)) { const next = this.host.nextReset(rec); this.repark(s, rec, Math.max(t + 1, next.until + FIRE_AFTER_RESET_S), next); return; }
    // Loop brake: the 4th auto-continue without a human message is not sent.
    const used = s.streaks[key] ?? 0;
    if (used >= MAX_AUTO_CONTINUES) {
      drop(); this.save(s);
      this.host.log({ type: 'limit_resume_skipped', reason: 'loop_brake', ...summary(rec) });
      this.host.emit('limit_resume', { state: 'braked', ...target(rec), count: used });
      this.host.ended?.(rec, 'braked');
      return;
    }
    // Off the file BEFORE it is sent: the send may start a turn that parks and schedules anew.
    drop(); this.save(s);
    // Before the reset, it runs on an account other than the limited one.
    const text = rec.kind === 'resend' || rec.delegate?.mode === 'resend' ? rec.prompt ?? '' : continueText(rec, t < rec.until);
    try { this.host.deliver(rec, text); }
    catch (e) {
      // Not sent: it stays (one more attempt) and the loop brake does not count it.
      const cur = this.load();
      if (cur.records.some((r) => keyOf(r) === key)) return; // a newer one replaced it meanwhile
      cur.records.push(rec);
      this.repark(cur, rec, t + RETRY_S, false, (e as Error).message, 'delivery_failed');
      return;
    }
    const after = this.load();
    after.streaks[key] = (after.streaks[key] ?? 0) + 1;
    this.save(after);
    this.host.log({ type: 'limit_resume_fired', ...summary(rec) });
    this.host.emit('limit_resume', { state: 'fired', ...target(rec) });
  }

  /** One more attempt later, or, after MAX_ATTEMPTS, give up with one notice. */
  private repark(s: FileShape, rec: LimitResumeRecord, fireAt: number, reset: { until: number; estimated: boolean } | false, error?: string, reason = 'blocked'): void {
    rec.attempts++;
    if (rec.attempts >= MAX_ATTEMPTS) {
      s.records = s.records.filter((r) => r.id !== rec.id); this.save(s);
      this.host.log({ type: 'limit_resume_gave_up', ...summary(rec), ...(error ? { error } : {}) });
      this.host.emit('limit_resume', { state: 'gave_up', ...target(rec), attempts: rec.attempts });
      this.host.ended?.(rec, 'gave_up');
      return;
    }
    if (reset) { rec.until = reset.until; rec.estimated = reset.estimated; }
    rec.fireAt = fireAt;
    this.save(s);
    this.host.log(error ? { type: 'limit_resume_skipped', reason, error, reparked: true, ...summary(rec) } : { type: 'limit_resume_scheduled', reparked: true, ...summary(rec) });
  }
}

function target(r: LimitResumeRecord): Record<string, unknown> {
  return { projectId: r.projectId, sessionId: r.sessionId, kind: r.kind, ...(r.delegate ? { delegateId: r.delegate.delegateId } : {}) };
}
function summary(r: LimitResumeRecord): Record<string, unknown> {
  return { id: r.id, ...target(r), until: r.until, estimated: r.estimated, fireAt: r.fireAt, attempts: r.attempts, ...(r.account ? { account: r.account } : {}) };
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
  /** The 5 s fallback for a woken reply that never writes its result. */
  timer?: ReturnType<typeof setTimeout>;
  done?: boolean;
}

/** The reset a verdict names, in epoch seconds, or the 30 min estimate. */
export function untilOf(v: Verdict, now: number): { until: number; estimated: boolean } {
  if (v.resetsAt != null) return { until: v.resetsAt, estimated: false };
  if (v.resetsInSeconds != null) return { until: now + v.resetsInSeconds, estimated: false };
  return { until: now + NO_RESET_FALLBACK_S, estimated: true };
}
