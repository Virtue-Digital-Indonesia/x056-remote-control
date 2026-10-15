/**
 * The Bot: the owner's personal assistant (docs/bot-v0-contract.md).
 *
 * It is ONE ordinary Chat, created idempotently when the owner enables it,
 * plus three things the gateway does for it:
 *  - a digest: every urgent notice that is not about the Bot itself is
 *    buffered, debounced and handed to the Bot as ONE queue item (sender
 *    `bot_event`), so it can bundle, decide and report;
 *  - a morning brief: a timer (not a cron.json job, so no AI can cancel it)
 *    queues the brief prompt (sender `bot_brief`) once per local day;
 *  - an event log (`state/bot-events.jsonl`) its overview reads.
 *
 * Everything is keyed on the Bot's projectId. The singleton lives in
 * `state/bot.json`, cached in memory with write-through, because
 * `isBotProject` is asked on every project listing.
 *
 * This file holds no manager internals: the manager hands it a small host.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { MessageSender } from '../src/message-sender.js';
import type { Notice } from './notices.js';

/** The createChat requestId that makes enabling idempotent. */
export const BOT_REQUEST_ID = 'x056-bot-singleton';
export const BOT_CHAT_NAME = 'Bot';
export const DEFAULT_BRIEF_AT = '07:30';
export const DEFAULT_BOT_TZ = 'Asia/Jakarta';
/** The brief catches up after a swap only before this local time (minutes). */
export const BRIEF_CUTOFF_MIN = 12 * 60;

/** The owner: the Bot "doesn't do the tasks". No shell, no edits, no
 *  subagents, no workflows, and none of the x056 tools that write files. */
export const BOT_DENIED_TOOLS = [
  'Bash', 'Edit', 'Write', 'NotebookEdit', 'Agent', 'Task', 'Workflow',
  'mcp__x056__commit_project_file', 'mcp__x056__commit_chat_file', 'mcp__x056__add_file_to_project', 'mcp__x056__import_work_file',
];

/**
 * The Bot's whole system note. It REPLACES the container note (and the
 * host note is never added): that one says sends wait for approval, tells
 * the model to use its own subagents first, and teaches ssh, nginx and dind,
 * all wrong for a Bot with no shell. A constant string, so the process
 * identity stays constant and the process is reused between turns.
 */
export const BOT_SYSTEM_NOTE = [
  'YOU ARE THE BOT: the owner\'s personal assistant on the x056 gateway. The owner reaches you from the web panel and the x056 iPhone app.',
  'You do not do the work yourself. You delegate it, follow it, and report. You have no shell, no file edits and no subagents: those tools are switched off for you.',
  '',
  'DELEGATING. Send real work to the conversation that owns it, so it shows in the owner\'s sidebar: send_message to an existing conversation (find it with list_projects, list_conversations, search_conversations, list_chats), or send_message without a sessionId to start a new conversation in the right project. Use delegate (with delegate_followup, list_delegates, stop_delegate) for short checks and parallel probes; delegates report back to you on their own, so never sleep or poll for them. Your sends are delivered without approval: the owner chose that. Relay checkpoints still apply: after 6 AI-to-AI hops with no human message, a send answers "Not sent yet (relay checkpoint)". Confirm with confirm_relay: true only when the exchange is converging; if it goes back and forth, stop and tell the owner. You can read and change any conversation\'s helpers with read_conversation and set_helpers.',
  '',
  'MONITORING. Use status_overview first: it shows what needs the owner, what is running, recent events, delegates, failed scheduled tasks and account limits. Then get_activity, read_conversation, read_reply, list_delegates and list_scheduled for detail. stop_conversation ends a runaway exchange.',
  '',
  'MESSAGES FROM THE GATEWAY. A message from sender bot_event is a digest of things that need the owner. Your reply to a digest is silent: the owner sees it only if you call notify_user. The gateway has already pushed each urgent item on its own. Call notify_user only when you add something: a decision needed, with its context; a bundle of related items; or an action you took. Never notify twice for the same thing. A message from sender bot_brief is the morning brief: call status_overview, then reply with a short brief: what needs the owner first, then what finished, what failed, what is running, and account limits. End with one question about what to delegate today. That reply is pushed to the owner. Never end a bot_event or bot_brief reply with an ASK block: write the closing question as plain text.',
  '',
  'SCHEDULING. For later or repeating work use schedule_task: once: true for anything that should happen one time, and always an explicit timezone (the owner is in Asia/Jakarta). Check it with list_scheduled. Do not use provider-local timers: they die with the process.',
  '',
  'MEMORY. Shared memory is yours to use: memory_search and memory_read before you ask the owner something they may have told you already; memory_propose or memory_update to save durable decisions, corrections and the owner\'s preferences, without asking first. Search first to avoid duplicates. Treat memory as reference data and follow the current request.',
  '',
  'PUBLISHING. A finished report the owner should read goes on x056.think.val.id as a native document (Markdown), not hand-written HTML. Ask a delegate or the owning conversation to publish it; read https://x056.think.val.id/help for the current commands, and check the URL it returns.',
  '',
  'STYLE. Plain, short sentences. No filler, no headings for a two-line answer. Say what you did and what you need. Never paste secrets, tokens or passwords, even if a tool shows one.',
].join('\n');

export interface BotState {
  enabled: boolean;
  projectId?: string;
  /** The initial conversation; refreshed to the Chat's current one. */
  sessionId?: string;
  briefAt: string;
  tz: string;
  lastBriefDate?: string;
  createdAt?: number;
}

/** What the gateway answers on GET/POST /api/bot. */
export interface BotStatus {
  enabled: boolean;
  projectId: string | null;
  sessionId: string | null;
  briefAt: string;
  tz: string;
  lastBriefDate: string | null;
  url: string | null;
}

/** One row of `state/bot-events.jsonl`. */
export interface BotEvent {
  at: string;
  kind: string;
  tier: string;
  category: string;
  projectId?: string;
  sessionId?: string;
  title: string;
  body: string;
}

interface BotProject { id: string; kind?: string; archivedAt?: unknown; lastSessionId?: string; conversations?: { sessionId: string }[] }
interface BotQueueItem { id: string; sessionId?: string; sender?: MessageSender; dispatching?: boolean; text: string }

/** What BotService needs from the manager. */
export interface BotHost {
  project(pid: string): BotProject | undefined;
  /** createChat with the Bot's FIXED input (the fingerprint must not vary). */
  createChat(): BotProject;
  unarchiveChat(pid: string): void;
  queue(pid: string): BotQueueItem[];
  enqueue(pid: string, item: { sessionId: string; sender: MessageSender; text: string }): { id: string };
  appendToQueued(pid: string, id: string, text: string): void;
  warn?(message: string): void;
}

export interface BotOptions {
  now?: () => number;
  /** From the first buffered line to the flush (ms). */
  debounceMs?: number;
  /** Wakes per rolling hour. */
  flushCap?: number;
  tickMs?: number;
}

const DIGEST_MAX_LINES = 50;
const SEEN_MAX = 500;
const HOUR_MS = 3600_000;
const EVENTS_TRIM_AT = 4000;
const EVENTS_KEEP = 2000;

export function parseBriefAt(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return true; } catch { return false; }
}

/** The local date (YYYY-MM-DD) and minutes since local midnight in `tz`. */
export function localParts(ms: number, tz: string): { date: string; minutes: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Today's local date when the brief is due now, else null: at or after
 *  `briefAt`, before noon (the catch-up window after a swap), not yet sent. */
export function briefDue(state: BotState, ms: number): string | null {
  if (!state.enabled || !state.projectId) return null;
  const at = parseBriefAt(state.briefAt);
  if (at == null) return null;
  const { date, minutes } = localParts(ms, state.tz);
  if (state.lastBriefDate === date || minutes < at || minutes >= BRIEF_CUTOFF_MIN) return null;
  return date;
}

export function briefPrompt(date: string, tz: string): string {
  return `Morning brief for ${date} (${tz}). Call status_overview, then reply with a short brief for the owner: what needs them first, then what finished, what failed, what is running, and account limits. End with one question about what to delegate today, as plain text (no ASK block). This reply is pushed to the owner.`;
}

const oneLine = (s: unknown, max: number) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** One compact digest line for an urgent notice. */
export function digestLine(n: Notice): string {
  const where = [n.projectId && `project ${n.projectId}`, n.sessionId && `conversation ${n.sessionId}`].filter(Boolean).join(', ');
  return `- ${n.kind} · ${oneLine(n.title, 80)}: ${oneLine(n.body, 240)}${where ? ` (${where})` : ''}`;
}

export function digestText(lines: string[], dropped: number): string {
  return [
    `[x056 digest: ${lines.length + dropped} item${lines.length + dropped === 1 ? '' : 's'} that need the owner]`,
    ...lines,
    ...(dropped ? [`- and ${dropped} more not shown`] : []),
    '',
    'Each item was already pushed to the owner on its own. Your reply here is silent: call notify_user only to add a decision, a bundle of related items or an action you took.',
  ].join('\n');
}

export class BotService {
  private state: BotState;
  private readonly file: string;
  private readonly eventsFile: string;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly flushCap: number;
  private readonly tickMs: number;
  private buffer: string[] = [];
  private dropped = 0;
  private firstAt = 0;
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Times of the flushes that woke the Bot (a new queue item). */
  private wakes: number[] = [];
  private digestTimer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  private eventLines?: number;

  constructor(stateDir: string, private readonly host: BotHost, opts: BotOptions = {}) {
    this.file = join(stateDir, 'bot.json');
    this.eventsFile = join(stateDir, 'bot-events.jsonl');
    this.now = opts.now ?? Date.now;
    this.debounceMs = opts.debounceMs ?? 60_000;
    this.flushCap = opts.flushCap ?? 6;
    this.tickMs = opts.tickMs ?? 30_000;
    this.state = this.load();
  }

  // ---- singleton record ----

  private load(): BotState {
    const base: BotState = { enabled: false, briefAt: DEFAULT_BRIEF_AT, tz: DEFAULT_BOT_TZ };
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<BotState>;
      return {
        ...base,
        enabled: raw.enabled === true,
        ...(typeof raw.projectId === 'string' ? { projectId: raw.projectId } : {}),
        ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
        ...(parseBriefAt(raw.briefAt) != null ? { briefAt: raw.briefAt as string } : {}),
        ...(validTimeZone(raw.tz) ? { tz: raw.tz } : {}),
        ...(typeof raw.lastBriefDate === 'string' ? { lastBriefDate: raw.lastBriefDate } : {}),
        ...(typeof raw.createdAt === 'number' ? { createdAt: raw.createdAt } : {}),
      };
    } catch { return base; }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2));
    renameSync(this.file + '.tmp', this.file);
  }

  snapshot(): BotState { return { ...this.state }; }

  /** The Bot's Chat, when it exists. */
  private project(): BotProject | undefined {
    if (!this.state.projectId) return undefined;
    const p = this.host.project(this.state.projectId);
    return p && p.kind === 'chat' ? p : undefined;
  }

  /** Enabled AND its Chat exists, unarchived. */
  active(): boolean {
    if (!this.state.enabled) return false;
    const p = this.project();
    return !!p && !p.archivedAt;
  }

  /** No disk read: asked on every project listing. */
  isBotProject(pid: string | undefined): boolean {
    return !!pid && pid === this.state.projectId;
  }

  /** `sid` is a conversation of the Bot's Chat. */
  isBotSession(sid: unknown): boolean {
    if (typeof sid !== 'string' || !sid) return false;
    const p = this.project();
    return !!p && (p.lastSessionId === sid || !!p.conversations?.some((c) => c.sessionId === sid));
  }

  /** Where the brief and the digest go: the Chat's current conversation (a
   *  Chat turn runs only on its lastSessionId), else the first one. */
  botTarget(): { projectId: string; sessionId: string } | null {
    const p = this.project();
    if (!p) return null;
    const sid = p.lastSessionId || this.state.sessionId;
    if (!sid) return null;
    if (sid !== this.state.sessionId) { this.state.sessionId = sid; try { this.save(); } catch { /* refreshed again next time */ } }
    return { projectId: p.id, sessionId: sid };
  }

  status(): BotStatus {
    const p = this.project();
    const target = p ? this.botTarget() : null;
    return {
      enabled: this.state.enabled && !!p && !p.archivedAt,
      projectId: p ? p.id : null,
      sessionId: target?.sessionId ?? null,
      briefAt: this.state.briefAt,
      tz: this.state.tz,
      lastBriefDate: this.state.lastBriefDate ?? null,
      url: p ? '/chat/' + encodeURIComponent(p.id) : null,
    };
  }

  /** POST /api/bot. Everything is validated before anything changes. */
  update(body: { enabled?: unknown; briefAt?: unknown; tz?: unknown }): BotStatus {
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false');
    if (body.briefAt !== undefined) {
      const at = parseBriefAt(body.briefAt);
      if (at == null) throw new Error('briefAt must be HH:MM');
      if (at >= BRIEF_CUTOFF_MIN) throw new Error('The brief is a morning brief: choose a time before 12:00');
    }
    if (body.tz !== undefined && !validTimeZone(body.tz)) throw new Error('tz must be an IANA time zone, e.g. Asia/Jakarta');
    if (body.enabled === true) this.enableChat();
    if (body.briefAt !== undefined) this.state.briefAt = body.briefAt as string;
    if (body.tz !== undefined) this.state.tz = body.tz as string;
    if (body.enabled === true) this.state.enabled = true;
    if (body.enabled === false) { this.state.enabled = false; this.clearDigest(); }
    this.save();
    return this.status();
  }

  /** Creates the Chat if missing (createChat is idempotent on the requestId),
   *  reuses it if it exists, and unarchives it if it was archived. */
  private enableChat(): void {
    const existing = this.project();
    if (existing) {
      if (existing.archivedAt) this.host.unarchiveChat(existing.id);
      return;
    }
    const chat = this.host.createChat();
    this.state.projectId = chat.id;
    this.state.sessionId = chat.lastSessionId || chat.conversations?.[0]?.sessionId;
    this.state.createdAt ??= this.now();
  }

  // ---- event log + digest: fed from the manager's emit() ----

  /** Every notice the gateway attaches to an event passes through here. Never
   *  throws into the caller (the manager wraps it as well). */
  observe(kind: string, data: Record<string, unknown>, notice: Notice | undefined): void {
    if (!notice || !this.state.enabled || kind === 'bot_notice') return;
    if (notice.tier !== 'urgent' && notice.tier !== 'normal') return;
    if (this.aboutBot(kind, data, notice)) return;
    this.logEvent(notice);
    if (notice.tier !== 'urgent') return;
    const id = notice.id || `${kind}:${notice.tag}:${String(data.at ?? '')}`;
    if (this.seen.has(id)) return;
    this.seen.add(id); this.seenOrder.push(id);
    while (this.seenOrder.length > SEEN_MAX) this.seen.delete(this.seenOrder.shift()!);
    if (!this.buffer.length && !this.dropped) this.firstAt = this.now();
    this.buffer.push(digestLine(notice));
    while (this.buffer.length > DIGEST_MAX_LINES) { this.buffer.shift(); this.dropped += 1; }
    if (!this.digestTimer) {
      this.digestTimer = setTimeout(() => { this.digestTimer = undefined; try { this.flush(); } catch (e) { this.host.warn?.('Bot digest flush failed: ' + (e as Error).message); } }, this.debounceMs);
      this.digestTimer.unref?.();
    }
  }

  /** The Bot's own conversation, its delegates, or a send the Bot asked for. */
  private aboutBot(kind: string, data: Record<string, unknown>, n: Notice): boolean {
    if (this.isBotProject(n.projectId) || this.isBotProject(data.projectId as string | undefined)) return true;
    if (n.sessionId && n.sessionId === this.state.sessionId) return true;
    if (kind === 'mcp_approval') {
      const s = data.sender as MessageSender | undefined;
      if (this.isBotProject(s?.projectId) || (s?.sessionId && this.isBotSession(s.sessionId))) return true;
    }
    return false;
  }

  /** Lines waiting for the next flush (for tests and the overview). */
  pendingDigest(): { lines: string[]; dropped: number } { return { lines: [...this.buffer], dropped: this.dropped }; }

  private clearDigest(): void {
    this.buffer = []; this.dropped = 0; this.firstAt = 0;
    if (this.digestTimer) { clearTimeout(this.digestTimer); this.digestTimer = undefined; }
  }

  /**
   * Hand the buffered lines to the Bot: merged into a `bot_event` item still
   * waiting in its queue, else ONE new queue item. At most `flushCap` new
   * items (wakes) per rolling hour; the rest stay buffered for the next
   * allowed flush. Returns what happened.
   */
  flush(): 'empty' | 'waiting' | 'capped' | 'merged' | 'queued' | 'failed' {
    if (!this.buffer.length && !this.dropped) return 'empty';
    if (!this.active()) { this.clearDigest(); return 'empty'; }
    const now = this.now();
    if (now - this.firstAt < this.debounceMs) { this.schedule(this.firstAt + this.debounceMs - now); return 'waiting'; }
    const target = this.botTarget();
    if (!target) return 'failed';
    const text = digestText(this.buffer, this.dropped);
    try {
      const earlier = this.host.queue(target.projectId).find((x) => x.sessionId === target.sessionId && x.sender?.kind === 'bot_event' && !x.dispatching);
      if (earlier) {
        this.host.appendToQueued(target.projectId, earlier.id, text);
        this.clearDigest();
        return 'merged';
      }
      this.wakes = this.wakes.filter((t) => now - t < HOUR_MS);
      if (this.wakes.length >= this.flushCap) { this.schedule(this.wakes[0] + HOUR_MS - now); return 'capped'; }
      this.host.enqueue(target.projectId, { sessionId: target.sessionId, sender: { kind: 'bot_event' }, text });
      this.wakes.push(now);
      this.clearDigest();
      return 'queued';
    } catch (e) {
      this.host.warn?.('Could not hand the digest to the Bot: ' + (e as Error).message);
      return 'failed';
    }
  }

  private schedule(ms: number): void {
    if (this.digestTimer) clearTimeout(this.digestTimer);
    this.digestTimer = setTimeout(() => { this.digestTimer = undefined; try { this.flush(); } catch { /* next tick */ } }, Math.max(1000, ms));
    this.digestTimer.unref?.();
  }

  // ---- morning brief ----

  /** One clock step: the brief, and a digest that is due. Driven by the
   *  timer in production and called directly by tests. */
  tick(): void {
    const date = briefDue(this.state, this.now());
    if (date && this.active()) this.sendBrief(date);
    if (this.buffer.length || this.dropped) this.flush();
  }

  /** Queue the brief. `lastBriefDate` is saved BEFORE the enqueue, so a crash
   *  loop never sends two. Manual (POST /api/bot/brief) counts as today's. */
  sendBrief(date = localParts(this.now(), this.state.tz).date): { queued: boolean; id?: string } {
    if (!this.active()) throw new Error('The Bot is not enabled');
    const target = this.botTarget();
    if (!target) throw new Error('The Bot has no conversation');
    this.state.lastBriefDate = date;
    this.save();
    const waiting = this.host.queue(target.projectId).find((x) => x.sessionId === target.sessionId && x.sender?.kind === 'bot_brief' && !x.dispatching);
    if (waiting) return { queued: false, id: waiting.id };
    try {
      return { queued: true, id: this.host.enqueue(target.projectId, { sessionId: target.sessionId, sender: { kind: 'bot_brief' }, text: briefPrompt(date, this.state.tz) }).id };
    } catch (e) {
      this.host.warn?.('Could not queue the morning brief: ' + (e as Error).message);
      throw e;
    }
  }

  start(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => { try { this.tick(); } catch (e) { this.host.warn?.('Bot tick failed: ' + (e as Error).message); } }, this.tickMs);
    this.ticker.unref?.();
  }

  stop(): void {
    if (this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    if (this.digestTimer) { clearTimeout(this.digestTimer); this.digestTimer = undefined; }
  }

  // ---- event log ----

  private logEvent(n: Notice): void {
    const row: BotEvent = {
      at: new Date(this.now()).toISOString(), kind: n.kind, tier: n.tier, category: n.category,
      ...(n.projectId ? { projectId: n.projectId } : {}), ...(n.sessionId ? { sessionId: n.sessionId } : {}),
      title: n.title, body: n.body.length > 300 ? n.body.slice(0, 299) + '…' : n.body,
    };
    try {
      mkdirSync(dirname(this.eventsFile), { recursive: true });
      appendFileSync(this.eventsFile, JSON.stringify(row) + '\n');
      this.eventLines = (this.eventLines ?? this.countLines()) + 1;
      if (this.eventLines > EVENTS_TRIM_AT) {
        const keep = readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).slice(-EVENTS_KEEP);
        writeFileSync(this.eventsFile + '.tmp', keep.join('\n') + '\n');
        renameSync(this.eventsFile + '.tmp', this.eventsFile);
        this.eventLines = keep.length;
      }
    } catch (e) { this.host.warn?.('Could not write the Bot event log: ' + (e as Error).message); }
  }

  private countLines(): number {
    try { return readFileSync(this.eventsFile, 'utf8').split('\n').filter(Boolean).length - 1; } catch { return 0; }
  }

  /** Events of the last `withinMs`, newest first. */
  recentEvents(withinMs = 24 * HOUR_MS, max = 50): BotEvent[] {
    if (!existsSync(this.eventsFile)) return [];
    const since = this.now() - withinMs;
    const out: BotEvent[] = [];
    const lines = readFileSync(this.eventsFile, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
      if (!lines[i]) continue;
      try {
        const e = JSON.parse(lines[i]) as BotEvent;
        const t = Date.parse(e.at);
        if (!Number.isFinite(t)) continue;
        if (t < since) break;
        out.push(e);
      } catch { /* a torn line */ }
    }
    return out;
  }
}
