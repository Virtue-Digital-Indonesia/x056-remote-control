import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_RE, type ApnsEnv, type ApnsReply } from './apns.js';

/**
 * Live Activities: a running turn on the iPhone's Lock Screen and Dynamic
 * Island. The app starts one (when it sends a message, or "Follow on Lock
 * Screen") and registers the activity's own push token here. From then on
 * the gateway keeps it current with ActivityKit pushes, because a locked
 * phone's app is suspended and cannot read the event stream itself.
 *
 * One registration per activity. A turn's events update it: started, each
 * tool step, a question, autopilot's count, then the end, after which the
 * registration is dropped. Between autopilot steps it stays up: the run is
 * one piece of work on the Lock Screen.
 */

/** What the Lock Screen shows. The keys match
 *  `TurnActivityAttributes.ContentState` in the iOS app (ios/Shared). */
export interface TurnContent {
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped';
  /** Tool calls this turn (or this autopilot run). */
  steps: number;
  /** Unix seconds. */
  startedAt: number;
  /** The step in progress, as the chat labels it ("Running: npm test"). */
  activity?: string;
  endedAt?: number;
  autopilotLeft?: number;
  autopilotCount?: number;
  /** The end in words: the failure, the question, why it stopped. */
  detail?: string;
}

export interface LiveActivity {
  token: string;
  env: ApnsEnv;
  projectId: string;
  sessionId: string;
  at: number;
  content: TurnContent;
}

export type ActivitySender = (token: string, env: ApnsEnv, payload: Record<string, unknown>, priority: 5 | 10) => Promise<ApnsReply>;

/** How long an ended activity stays on the Lock Screen. */
const LINGER_S = 20 * 60;
/** Step updates are low priority and at most this often per activity. */
const MIN_GAP_MS = 8000;
/** Registrations whose turn never reported back are dropped after a day. */
const STALE_MS = 24 * 3600_000;

export class LiveActivities {
  private items: LiveActivity[];
  private readonly lastPush = new Map<string, number>();
  private readonly trailing = new Map<string, ReturnType<typeof setTimeout>>();
  /** Armed autopilot per conversation, from its events. */
  private readonly autopilot = new Map<string, { left: number; count?: number }>();
  /** Conversations with a turn running now. */
  private readonly running = new Set<string>();

  constructor(
    private readonly stateDir: string,
    private readonly send: ActivitySender,
    private readonly now: () => number = Date.now,
    private readonly minGapMs = MIN_GAP_MS,
  ) {
    this.items = this.load().filter((a) => this.now() - a.at < STALE_MS);
  }

  private get file(): string { return join(this.stateDir, 'push', 'live-activities.json'); }

  list(): LiveActivity[] { return this.items.map((a) => ({ ...a, token: '…' + a.token.slice(-8) })); }

  /** The app's activity for a conversation, with what it already shows. */
  register(body: { token?: unknown; env?: unknown; projectId?: unknown; sessionId?: unknown; content?: Partial<TurnContent> }): void {
    const token = String(body.token ?? '').toLowerCase();
    if (!TOKEN_RE.test(token)) throw new Error('invalid activity token');
    const env = body.env === 'sandbox' ? 'sandbox' : body.env === 'production' ? 'production' : null;
    if (!env) throw new Error('env must be production or sandbox');
    if (typeof body.projectId !== 'string' || !body.projectId || typeof body.sessionId !== 'string' || !body.sessionId) throw new Error('projectId and sessionId required');
    const seed = body.content ?? {};
    const content: TurnContent = {
      status: 'running',
      steps: Number.isFinite(seed.steps) ? Math.max(0, Math.floor(seed.steps!)) : 0,
      startedAt: Number.isFinite(seed.startedAt) ? seed.startedAt! : this.secs(),
      ...(typeof seed.activity === 'string' ? { activity: seed.activity.slice(0, 200) } : {}),
    };
    this.items = this.items.filter((a) => a.token !== token);
    this.items.push({ token, env, projectId: body.projectId, sessionId: body.sessionId, at: this.now(), content: this.withAutopilot(body.sessionId, content) });
    this.save();
  }

  /** The app ended it (dismissed, or the conversation was closed out). */
  unregister(token: string): void {
    const t = token.toLowerCase();
    this.drop((a) => a.token === t);
  }

  /** Gateway events in; pushes out for the conversations that have one. */
  observe(kind: string, data: Record<string, unknown>): void {
    const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!sid) return;
    if (kind === 'autopilot') this.trackAutopilot(sid, data);
    if (kind === 'session_started') this.running.add(sid);
    if (kind === 'session_done' || kind === 'session_error') this.running.delete(sid);
    const mine = this.items.filter((a) => a.sessionId === sid);
    if (!mine.length) return;
    for (const a of mine) this.apply(a, kind, data);
  }

  private apply(a: LiveActivity, kind: string, d: Record<string, unknown>): void {
    const c = a.content;
    switch (kind) {
      case 'session_started': {
        // A new turn. Within an autopilot run the steps keep counting.
        const run = this.autopilot.get(a.sessionId);
        a.content = this.withAutopilot(a.sessionId, {
          status: 'running',
          steps: run && c.status === 'running' ? c.steps : 0,
          startedAt: run && c.status === 'running' ? c.startedAt : this.secs(),
        });
        return this.push(a, 10);
      }
      case 'activity': {
        if (d.parentToolUseId) return; // a subagent's own tools
        if (d.status === 'start') {
          c.steps += 1;
          c.activity = String(d.label ?? d.tool ?? 'Working').slice(0, 200);
        } else if (d.status === 'error') {
          c.activity = 'Failed: ' + String(d.label ?? d.tool ?? 'a step').slice(0, 190);
        }
        c.status = 'running';
        return this.push(a, 5);
      }
      case 'question': {
        c.status = 'waiting';
        c.activity = undefined;
        c.detail = String(d.question ?? 'It asked you something').slice(0, 300);
        return this.push(a, 10);
      }
      case 'autopilot': {
        if (d.active === true) {
          a.content = this.withAutopilot(a.sessionId, c);
          return this.push(a, 5);
        }
        // The run is over (stopped, done, out of steps, paused). If no turn
        // is running the activity ends now; else that turn's end does it.
        if (!this.running.has(a.sessionId)) {
          return this.finish(a, d.reason === 'stopped' ? 'stopped' : c.status === 'running' ? 'done' : c.status, c.detail ?? this.autopilotReason(d));
        }
        c.autopilotLeft = undefined;
        c.autopilotCount = undefined;
        return this.push(a, 5);
      }
      case 'session_done': {
        const status = d.status === 'failed' || d.status === 'parked' ? 'failed' : d.status === 'stopped' ? 'stopped' : 'done';
        const reason = typeof d.reason === 'string' ? d.reason : undefined;
        // Autopilot will send the next step: keep the activity up.
        const run = this.autopilot.get(a.sessionId);
        if (status === 'done' && run && run.left > 0) {
          c.activity = 'Next step in a moment';
          return this.push(a, 5);
        }
        // A turn that ended by asking something ends as waiting for you.
        if (status === 'done' && c.status === 'waiting') return this.finish(a, 'waiting', c.detail);
        return this.finish(a, status, status === 'done' ? undefined : reason);
      }
      case 'session_error':
        return this.finish(a, 'failed', typeof d.message === 'string' ? d.message : undefined);
      default:
        return;
    }
  }

  private finish(a: LiveActivity, status: TurnContent['status'], detail?: string): void {
    const c = a.content;
    c.status = status === 'running' ? 'done' : status;
    c.endedAt = this.secs();
    c.activity = undefined;
    if (detail) c.detail = detail.slice(0, 300);
    else if (c.status === 'done' || c.status === 'stopped') c.detail = undefined;
    this.cancelTrailing(a.token);
    void this.deliver(a, {
      aps: { timestamp: this.secs(), event: 'end', 'content-state': c, 'dismissal-date': this.secs() + LINGER_S },
    }, 10);
    this.drop((x) => x.token === a.token);
  }

  /** An update now, or (low priority, too soon after the last) once the gap
   *  has passed, with whatever the content is by then. */
  private push(a: LiveActivity, priority: 5 | 10): void {
    this.save();
    const last = this.lastPush.get(a.token) ?? 0;
    const wait = last + this.minGapMs - this.now();
    if (priority === 5 && wait > 0) {
      if (!this.trailing.has(a.token)) {
        const t = setTimeout(() => {
          this.trailing.delete(a.token);
          const cur = this.items.find((x) => x.token === a.token);
          if (cur) this.update(cur, 5);
        }, wait);
        t.unref?.();
        this.trailing.set(a.token, t);
      }
      return;
    }
    this.cancelTrailing(a.token);
    this.update(a, priority);
  }

  private update(a: LiveActivity, priority: 5 | 10): void {
    void this.deliver(a, { aps: { timestamp: this.secs(), event: 'update', 'content-state': a.content } }, priority);
  }

  private async deliver(a: LiveActivity, payload: Record<string, unknown>, priority: 5 | 10): Promise<void> {
    this.lastPush.set(a.token, this.now());
    let reply: ApnsReply;
    try { reply = await this.send(a.token, a.env, payload, priority); } catch { return; }
    // 410: the activity ended on the phone. 400 BadDeviceToken: a token from
    // the other APNs environment, or one that never was.
    if (reply.status === 410 || (reply.status === 400 && reply.reason === 'BadDeviceToken')) this.unregister(a.token);
  }

  private trackAutopilot(sid: string, d: Record<string, unknown>): void {
    if (d.active === true) {
      const left = typeof d.remaining === 'number' ? d.remaining : this.autopilot.get(sid)?.left ?? 0;
      const count = typeof d.count === 'number' ? d.count : this.autopilot.get(sid)?.count;
      this.autopilot.set(sid, { left, ...(count ? { count } : {}) });
    } else {
      this.autopilot.delete(sid);
    }
  }

  private withAutopilot(sid: string, c: TurnContent): TurnContent {
    const run = this.autopilot.get(sid);
    return run ? { ...c, autopilotLeft: run.left, ...(run.count ? { autopilotCount: run.count } : {}) } : c;
  }

  private autopilotReason(d: Record<string, unknown>): string | undefined {
    const r = typeof d.reason === 'string' ? d.reason : '';
    if (!r || r === 'done' || r === 'complete' || r === 'completed') return undefined;
    return r === 'stopped' ? 'Autopilot stopped' : r;
  }

  private cancelTrailing(token: string): void {
    const t = this.trailing.get(token);
    if (t) { clearTimeout(t); this.trailing.delete(token); }
  }

  private drop(match: (a: LiveActivity) => boolean): void {
    const before = this.items.length;
    for (const a of this.items.filter(match)) { this.cancelTrailing(a.token); this.lastPush.delete(a.token); }
    this.items = this.items.filter((a) => !match(a));
    if (this.items.length !== before) this.save();
  }

  private secs(): number { return Math.floor(this.now() / 1000); }

  private load(): LiveActivity[] {
    if (!existsSync(this.file)) return [];
    try {
      const v = JSON.parse(readFileSync(this.file, 'utf8')) as LiveActivity[];
      return Array.isArray(v) ? v.filter((a) => a && typeof a.token === 'string' && a.content) : [];
    } catch { return []; }
  }

  private save(): void {
    mkdirSync(join(this.stateDir, 'push'), { recursive: true });
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.items), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
