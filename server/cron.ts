import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Scheduled prompts: send a message to a conversation on a cron schedule.
 *
 * Written rather than pulled in as a dependency — a 5-field matcher is ~40 lines
 * and this gateway has four runtime deps, none of which is a scheduler.
 *
 * TIMEZONE IS THE WHOLE PROBLEM HERE. This container runs UTC while the operator
 * thinks in Asia/Jakarta, so "every day at 9" means two different moments
 * depending on who is asked. Each job therefore stores an IANA zone and is
 * matched against the wall clock IN THAT ZONE, via Intl — not against the
 * container's. A job with no zone gets the gateway default, not UTC, because
 * silently running seven hours early is the failure people actually hit.
 */

export const CRON = Symbol('x056-cron');

export interface CronJob {
  id: string;
  /** 5-field cron: minute hour day-of-month month day-of-week. */
  schedule: string;
  /** IANA zone the schedule is expressed in. */
  tz: string;
  projectId: string;
  /** Target conversation. Omitted → start a new conversation each run. */
  sessionId?: string;
  prompt: string;
  /** Free-form note for the panel; what this job is for. */
  label?: string;
  enabled: boolean;
  createdAt: number;
  createdBy?: string;
  lastRunAt?: number;
  lastResult?: string;
  runCount: number;
}

export interface CronDeps {
  stateDir: string;
  /** Deliver a prompt; queues if the conversation is mid-turn. */
  deliver(projectId: string, sessionId: string | undefined, prompt: string): { sessionId: string; queued: boolean };
  /** Default zone for jobs that don't name one. */
  defaultTz?: string;
  /** Injectable for tests. */
  now?: () => Date;
}

/** One cron field → the set of numbers it matches within [min,max]. */
function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const bounds = rangePart.split('-');
      lo = Number(bounds[0]);
      hi = bounds.length > 1 ? Number(bounds[1]) : lo;
      // A bare "5/15" means "from 5 to the end, every 15" — not just 5.
      if (bounds.length === 1 && stepPart) hi = max;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`bad range in "${part}"`);
      if (lo < min || hi > max || lo > hi) throw new Error(`"${part}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface ParsedCron { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domRestricted: boolean; dowRestricted: boolean }

export function parseCron(expr: string): ParsedCron {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('schedule must have 5 fields: minute hour day-of-month month day-of-week');
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    // 7 and 0 both mean Sunday, as in every other cron.
    dow: new Set([...parseField(fields[4].replace(/7/g, '0'), 0, 6)]),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/** The wall-clock fields of `date` as seen in `tz`. */
export function wallClock(date: Date, tz: string): { minute: number; hour: number; dom: number; month: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short',
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(get('minute')),
    // Intl renders midnight as "24" in some locales/zones with hour12:false.
    hour: Number(get('hour')) % 24,
    dom: Number(get('day')),
    month: Number(get('month')),
    dow: DOW[get('weekday')] ?? 0,
  };
}

export function cronMatches(parsed: ParsedCron, date: Date, tz: string): boolean {
  const t = wallClock(date, tz);
  if (!parsed.minute.has(t.minute) || !parsed.hour.has(t.hour) || !parsed.month.has(t.month)) return false;
  // Standard cron quirk: when BOTH day fields are restricted they OR together,
  // so "0 9 1 * 1" is the 1st of the month *or* any Monday.
  if (parsed.domRestricted && parsed.dowRestricted) return parsed.dom.has(t.dom) || parsed.dow.has(t.dow);
  if (parsed.domRestricted) return parsed.dom.has(t.dom);
  if (parsed.dowRestricted) return parsed.dow.has(t.dow);
  return true;
}

export function isValidTz(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export class CronScheduler {
  private jobs: CronJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Minute keys already fired, so a tick landing twice in one minute — or a
   *  restart mid-minute — cannot double-send. */
  private fired = new Set<string>();
  private readonly defaultTz: string;
  private readonly now: () => Date;

  constructor(private readonly deps: CronDeps) {
    this.defaultTz = deps.defaultTz ?? process.env.X056_CRON_TZ ?? 'Asia/Jakarta';
    this.now = deps.now ?? (() => new Date());
    this.load();
  }

  private get file(): string { return join(this.deps.stateDir, 'cron.json'); }

  private load(): void {
    try { this.jobs = JSON.parse(readFileSync(this.file, 'utf8')) as CronJob[]; } catch { this.jobs = []; }
    if (!Array.isArray(this.jobs)) this.jobs = [];
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.jobs, null, 2));
  }

  list(): CronJob[] { return this.jobs.map((j) => ({ ...j })); }

  get defaultTimezone(): string { return this.defaultTz; }

  add(input: {
    schedule: string; projectId: string; prompt: string;
    sessionId?: string; tz?: string; label?: string; createdBy?: string;
  }): CronJob {
    parseCron(input.schedule); // throws on a bad expression, before anything is stored
    const tz = input.tz ?? this.defaultTz;
    if (!isValidTz(tz)) throw new Error(`unknown timezone: ${tz}`);
    if (!input.projectId) throw new Error('projectId is required');
    if (!input.prompt?.trim()) throw new Error('prompt is required');
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      schedule: input.schedule.trim().replace(/\s+/g, ' '),
      tz,
      projectId: input.projectId,
      sessionId: input.sessionId,
      prompt: input.prompt,
      label: input.label,
      enabled: true,
      createdAt: this.now().getTime(),
      createdBy: input.createdBy,
      runCount: 0,
    };
    this.jobs.push(job);
    this.save();
    return { ...job };
  }

  remove(id: string): boolean {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length === before) return false;
    this.save();
    return true;
  }

  setEnabled(id: string, enabled: boolean): CronJob | null {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.enabled = enabled;
    this.save();
    return { ...job };
  }

  /** Run every job whose schedule matches this minute. Never throws: one bad
   *  job must not stop the others or kill the interval. */
  tick(at: Date = this.now()): CronJob[] {
    const ran: CronJob[] = [];
    for (const job of this.jobs) {
      if (!job.enabled) continue;
      let parsed: ParsedCron;
      try { parsed = parseCron(job.schedule); } catch { continue; }
      if (!cronMatches(parsed, at, job.tz)) continue;
      const key = `${job.id}@${Math.floor(at.getTime() / 60000)}`;
      if (this.fired.has(key)) continue;
      this.fired.add(key);
      try {
        const out = this.deps.deliver(job.projectId, job.sessionId, job.prompt);
        job.lastResult = out.queued ? 'queued' : 'delivered';
        // Bind a job that had no conversation to the one it just created, so a
        // daily job accumulates in one thread instead of littering new ones.
        if (!job.sessionId && out.sessionId) job.sessionId = out.sessionId;
      } catch (err) {
        job.lastResult = `failed: ${(err as Error).message}`;
      }
      job.lastRunAt = at.getTime();
      job.runCount += 1;
      ran.push({ ...job });
    }
    if (ran.length) this.save();
    if (this.fired.size > 500) this.fired = new Set([...this.fired].slice(-200));
    return ran;
  }

  start(): void {
    if (this.timer) return;
    // 20s, not 60s: a 60s interval drifts and can skip a minute entirely. The
    // per-minute `fired` key makes the extra ticks harmless.
    this.timer = setInterval(() => { try { this.tick(); } catch { /* never die */ } }, 20_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
