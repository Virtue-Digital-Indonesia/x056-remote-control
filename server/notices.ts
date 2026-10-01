/**
 * Notices: the ONE place that decides whether a gateway event is worth a
 * person's attention, how loudly, and in what words. Push (server/push.ts),
 * the panel's bell, the sidebar dots and the desktop fallback all read the
 * `notice` this returns, so a phone and the panel never describe the same
 * event differently.
 *
 * Tiers:
 *   urgent  needs you: a question, a send waiting for approval, a delegate that
 *           needs a human, no account able to take a turn, a failed turn, a
 *           failed scheduled task. Pushed even when the turn was automated.
 *   normal  worth a buzz when you are away: a long turn you started finished,
 *           an autopilot run ended, a parked turn, a restart interrupted work.
 *   quiet   bell + dot only: short turns, relays, cron, delegate wakes,
 *           advisor follow-ups, delegate progress, a failover that worked.
 *   none    nothing at all: stopped turns, autopilot steps, per-conversation
 *           orphans (collapsed into one restart notice).
 */
import { stripTeamLine } from '../src/message-sender.js';

export type NoticeTier = 'urgent' | 'normal' | 'quiet' | 'none';
/** What a device's settings switch on or off. `needs_you` cannot be turned off. */
export type NoticeCategory = 'needs_you' | 'finished' | 'automation';
export type TurnOrigin = 'human' | 'relay' | 'cron' | 'autopilot' | 'advisor' | 'delegate';

export interface Notice {
  tier: NoticeTier;
  category: NoticeCategory;
  /** The gateway event kind this came from. */
  kind: string;
  title: string;
  body: string;
  link: string;
  /** Notification tag: one per conversation (a newer one replaces the older),
   *  or one per urgent item so an answer request is never overwritten. */
  tag: string;
  /** Stable dedup id: replays and duplicate terminal events share it. */
  id?: string;
  projectId?: string;
  sessionId?: string;
}

export interface NoticeContext {
  /** The conversation's own title (for a chat: the chat's title). */
  conversationTitle?: string;
  projectName?: string;
  /** 'chat' when the project IS the conversation. */
  projectKind?: string;
  provider?: string;
  link?: string;
  /** Event timestamp (ISO): the dedup id of last resort. */
  at?: string;
  /** Zone used to show reset times. */
  timeZone?: string;
}

/** A turn a human started counts as worth a push only past this. */
export const LONG_TURN_MS = 45_000;
export const TITLE_MAX = 60;
export const EXCERPT_MAX = 110;
export const QUESTION_MAX = 140;
export const DEFAULT_NOTICE_TZ = 'Asia/Jakarta';

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'ChatGPT' };

export function originOf(sender?: { kind?: string } | null): TurnOrigin {
  switch (sender?.kind) {
    case undefined: case null: case '': return 'human';
    case 'automation': return 'cron';
    case 'conversation': case 'mcp': return 'relay';
    case 'autopilot': return 'autopilot';
    case 'advisor': return 'advisor';
    case 'delegate': return 'delegate';
    default: return 'relay';
  }
}

/** Cut at a word boundary with an ellipsis; never mid-word unless one word is
 *  longer than the whole budget. */
export function cutWords(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const room = s.slice(0, max - 1);
  // A word that ends exactly at the cut is whole; otherwise back up to a space.
  const space = s[max - 1] === ' ' ? room.length : room.lastIndexOf(' ');
  const head = (space > max * 0.5 ? room.slice(0, space) : room).replace(/[\s,;:.\-–—(]+$/, '');
  return head + '…';
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A reply as a sentence a lock screen can hold: no markdown, no protocol
 *  blocks, no memory preamble. A reply that ends by asking something leads
 *  with that question. */
export function replyExcerpt(text: string, max = EXCERPT_MAX): string {
  let s = stripTeamLine(String(text || ''));
  s = s
    .replace(/<<<ASK[\s\S]*?(>>>|$)/g, ' ')
    .replace(/<(system-reminder|memory|x056[-\w]*)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\[x056 message sender v1\][^\n]*/g, ' ')
    .replace(/\[(Shared memory|Memory context|Referenced conversations|Attached saved files)[\s\S]*?\n\]/g, ' ')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ')
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s*(---+|\*\*\*+)\s*$/gm, ' ');
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  // Lead-ins that say nothing on their own.
  while (lines.length > 1 && /^(done|ok(ay)?|all set|here(?:'s| is) (?:what|the)[^.]*:?|summary:?)\.?!?$/i.test(lines[0])) lines.shift();
  const flat = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  if (/\?\s*$/.test(flat)) {
    const sentences = flat.match(/[^.!?]+[.!?]+/g) ?? [flat];
    const q = sentences[sentences.length - 1].trim();
    if (q.length < flat.length) return cutWords(q + ' ' + flat.slice(0, flat.length - q.length).trim(), max);
  }
  return cutWords(flat, max);
}

const GENERIC = /^(new chat|new conversation|conversation|untitled|chat)$/i;
const generic = (t?: string) => !t || !t.trim() || GENERIC.test(t.trim());

/** The conversation, never "New chat" alone. */
export function noticeTitle(ctx: NoticeContext): string {
  const own = ctx.conversationTitle?.trim();
  const project = ctx.projectName?.trim();
  if (!generic(own)) return cutWords(own!, TITLE_MAX);
  if (project && !generic(project)) return cutWords(`New chat · ${project}`, TITLE_MAX);
  return own || 'New chat';
}

/** "{project} · {provider}" when the project is something other than the
 *  conversation itself (a Work project); nothing for a chat. */
function bodyPrefix(ctx: NoticeContext): string {
  if (ctx.projectKind === 'chat') return '';
  const parts = [ctx.projectName?.trim(), ctx.provider ? PROVIDER_LABEL[ctx.provider] ?? ctx.provider : ''].filter(Boolean);
  return parts.length ? parts.join(' · ') : '';
}
function withPrefix(ctx: NoticeContext, body: string): string {
  const p = bodyPrefix(ctx);
  return p ? `${p}\n${body}` : body;
}

export function formatReset(until: number | undefined, tz = DEFAULT_NOTICE_TZ, now = Date.now()): string {
  if (!until || !Number.isFinite(until)) return '';
  const ms = until < 1e12 ? until * 1000 : until;
  const opts: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  if (ms - now > 20 * 3600_000) opts.weekday = 'short';
  try { return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms)).replace(',', ''); }
  catch { return new Date(ms).toISOString().slice(11, 16); }
}

/** Why a turn failed, in plain words. */
export function failureReason(data: Record<string, unknown>, tz?: string): string {
  const raw = String(data.reason || data.message || data.error || '').trim();
  const account = typeof data.finalAccount === 'string' ? data.finalAccount : typeof data.account === 'string' ? data.account : '';
  if (/usage limit|rate[ -]?limit|limit (reached|hit)|hit (your|the|its) limit|out of (credits|usage)|quota|insufficient credit/i.test(raw)) {
    return `Account limit reached${account ? ` on account ${account}` : ''}`;
  }
  if (/\b401\b|unauthori[sz]ed|oauth|sign[ -]?in|log ?in|authenticat|token (has )?expired|session expired/i.test(raw)) {
    return `Sign-in expired${account ? ` for account ${account}` : ''}`;
  }
  if (!raw) {
    if (Number(data.failovers) > 0) return 'Switched accounts too often in an hour, so it stopped';
    return 'Turn failed';
  }
  const first = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? raw;
  return cutWords(`Turn failed: ${first.replace(/^(error|turn failed):\s*/i, '')}`, EXCERPT_MAX);
}

const STOPPED = new Set(['stopped', 'cancelled', 'canceled']);

/**
 * The notice for one gateway event, or null when the event is not one people
 * are told about at all. `none` is returned (rather than null) for events that
 * ARE notable kinds but are deliberately silent, so callers can tell "decided
 * quiet" from "not a notice".
 */
export function noticeFor(kind: string, data: Record<string, unknown>, ctx: NoticeContext = {}): Notice | null {
  const pid = typeof data.projectId === 'string' ? data.projectId : undefined;
  const sid = typeof data.sessionId === 'string' ? data.sessionId : undefined;
  const link = ctx.link || '/';
  const title = noticeTitle(ctx);
  const turnId = String(data.notificationId || data.requestId || ctx.at || '');
  const convTag = `x056-conv-${sid || pid || 'general'}`;
  const make = (tier: NoticeTier, category: NoticeCategory, body: string, id?: string, over: Partial<Notice> = {}): Notice => ({
    tier, category, kind, title, body, link,
    tag: tier === 'urgent' ? `x056-urgent-${id || sid || pid || 'general'}` : convTag,
    ...(id ? { id } : {}),
    ...(pid ? { projectId: pid } : {}),
    ...(sid ? { sessionId: sid } : {}),
    ...over,
  });
  const none = () => make('none', 'finished', '');

  switch (kind) {
    case 'question': {
      const q = typeof data.question === 'string' && data.question.trim() ? cutWords(data.question, QUESTION_MAX) : 'The assistant asked you something.';
      return make('urgent', 'needs_you', withPrefix(ctx, q), `question:${sid}:${data.at || turnId}`);
    }

    case 'mcp_approval': {
      if (data.status !== 'pending') return null;
      const sender = (data.sender ?? {}) as { kind?: string; conversationTitle?: string };
      const who = PROVIDER_LABEL[ctx.provider || ''] ?? (ctx.provider || 'An assistant');
      const from = sender.conversationTitle || ctx.conversationTitle;
      const target = String(data.targetLabel || 'a new conversation');
      const preview = cutWords(String(data.message || ''), 80);
      const body = `${from ? `${who} in ${from}` : who} wants to message ${target}: “${preview}”`;
      const id = `approval:${data.id}`;
      return make('urgent', 'needs_you', body, id, { title: from ? noticeTitle(ctx) : 'Message waiting for approval', tag: `x056-urgent-${id}` });
    }

    case 'session_done':
    case 'session_error':
    case 'conversation_settled': {
      const status = kind === 'session_error' ? 'failed' : String(data.status || '');
      if (data.notificationSuppressed || STOPPED.has(status) || data.reason === 'Stopped by user.') return none();
      const origin = (data.origin as TurnOrigin | undefined) ?? 'human';
      const id = `turn:${sid}:${turnId}`;
      if (status === 'completed') {
        // The settled event is the one that counts; a raw completed
        // session_done is either still pending or owned by something else
        // (a question, autopilot).
        if (kind !== 'conversation_settled' || data.completionPending) return null;
        if (origin === 'autopilot') return none();
        const dur = Number(data.durationMs);
        const head = Number.isFinite(dur) && dur > 0 ? formatDuration(dur) : '';
        const excerpt = replyExcerpt(String(data.resultText || ''));
        const body = withPrefix(ctx, [head, excerpt || 'Finished.'].filter(Boolean).join(' · '));
        if (origin !== 'human') return make('quiet', 'automation', body, id);
        return make(Number.isFinite(dur) && dur >= LONG_TURN_MS ? 'normal' : 'quiet', 'finished', body, id);
      }
      if (status === 'parked') {
        // Parked with no reason = no account could take the turn: every one is
        // at its limit or signed out. That needs a person.
        if (!data.reason) {
          const at = formatReset(Number(data.parkedUntil), ctx.timeZone);
          return make('urgent', 'needs_you', withPrefix(ctx, `Account limit reached on every account${at ? ` — resets ${at}` : ''}`), id);
        }
        return make('normal', 'finished', withPrefix(ctx, `Parked: ${cutWords(String(data.reason), EXCERPT_MAX)}`), id);
      }
      if (status === 'failed') {
        const tier: NoticeTier = origin === 'advisor' || origin === 'autopilot' ? 'normal' : 'urgent';
        return make(tier, tier === 'urgent' ? 'needs_you' : 'finished', withPrefix(ctx, failureReason(data, ctx.timeZone)), id);
      }
      return null;
    }

    case 'supervisor': {
      const type = String(data.type || '');
      if (type === 'waiting_for_reset') {
        const at = formatReset(Number(data.until), ctx.timeZone);
        const acct = typeof data.account === 'string' ? ` ${data.account}` : '';
        return make('urgent', 'needs_you', withPrefix(ctx, `Account${acct} is at its limit and no other can take the turn${at ? ` — waiting for the reset at ${at}` : ''}`), `wait:${sid}:${data.until}`);
      }
      if (type === 'failover') {
        const from = typeof data.from === 'string' ? ` ${data.from}` : '';
        return make('quiet', 'automation', withPrefix(ctx, `Account${from} hit a limit; continued on another account`), `failover:${sid}:${ctx.at || ''}`);
      }
      return null;
    }

    case 'autopilot': {
      if (data.active !== false) return null;
      const reason = String(data.reason || '');
      if (!reason || STOPPED.has(reason)) return none();
      const steps = Number(data.steps);
      const n = Number.isFinite(steps) && steps > 0 ? ` after ${steps} step${steps === 1 ? '' : 's'}` : '';
      const body = reason === 'done' ? `Autopilot finished${n}`
        : reason === 'exhausted' ? 'Autopilot stopped: step budget used'
        : reason === 'failed' ? 'Autopilot paused: a turn failed'
        : reason === 'parked' ? 'Autopilot paused: no account could take the next step'
        : `Autopilot paused: ${cutWords(reason, 80)}`;
      return make('normal', 'finished', withPrefix(ctx, body), `autopilot:${sid}:${reason}:${data.notificationId || ctx.at || ''}`);
    }

    case 'delegate_report': {
      const role = String(data.role || 'A delegate');
      const first = String(data.text || '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
      const body = withPrefix(ctx, cutWords(`${role}: ${first || 'reported back'}`, QUESTION_MAX));
      const id = `delegate:${data.delegateId || role}:${data.at || ctx.at || ''}`;
      if (data.gate === 'needs_human') return make('urgent', 'needs_you', body, id);
      return make('quiet', 'automation', body, id);
    }

    case 'cron_failed': {
      const name = cutWords(String(data.name || 'A scheduled task'), 50);
      const reason = cutWords(String(data.reason || 'unknown error'), 90);
      // A job with no conversation is named as the task, not as a "New chat".
      return make('urgent', 'needs_you', withPrefix(ctx, `${name} failed: ${reason}`), `cron:${data.jobId}:${data.at || ctx.at || ''}`,
        generic(ctx.conversationTitle) ? { title: cutWords(ctx.projectName ? `Scheduled task · ${ctx.projectName}` : 'Scheduled task', TITLE_MAX) } : {});
    }

    case 'turn_orphaned':
      return none();

    case 'restart_interrupted': {
      const n = Number(data.count) || 0;
      if (n <= 0) return null;
      return make('normal', 'needs_you', n === 1 ? '1 conversation was interrupted by a restart. Open it to resume.' : `${n} conversations were interrupted by a restart. Open them to resume.`,
        `restart:${data.bootAt}`, { title: 'x056 restarted', tag: 'x056-restart', link: '/' });
    }
  }
  return null;
}

/** Which kinds noticeFor can answer, so the emitter skips the rest cheaply. */
export const NOTICE_KINDS = new Set(['question', 'mcp_approval', 'session_done', 'session_error', 'conversation_settled', 'supervisor', 'autopilot', 'delegate_report', 'cron_failed', 'turn_orphaned', 'restart_interrupted']);
