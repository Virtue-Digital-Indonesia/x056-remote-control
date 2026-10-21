/**
 * What the owner sees in the Bot chat (docs/bot-owner-view-contract.md).
 *
 * The Bot's conversation carries a lot of traffic that is not a conversation
 * with the owner: agents messaging the Bot, digests, scheduled tasks, relay
 * checkpoints. This module is the ONE implementation of the rule, over history
 * ROWS, for the clients that read rows (iOS, and the panel after a reload).
 * The panel's live DOM walk (rc-chat.js botRowVisibility / botRowKind) is the
 * same rule over elements; test/bot-view.test.ts holds the shared table.
 *
 * The chat is read in turns. A turn starts at each user row that is not a
 * steer, and takes that row's sender kind:
 *   'bot_event'  the gateway's digest            -> hides everything
 *   'bot_brief'  the morning brief               -> shows only its last reply
 *   'advisor'    an advisor follow-up            -> hides only its trigger
 *   'agent'      conversation, mcp, delegate, automation (including the Bot's
 *                own message_self and scheduled tasks) -> hides everything
 *   ''           the owner, a recap, anything else      -> shows everything
 * Rows before the first user row belong to a '' turn (or `initialTurn`).
 *
 * Every row has one kind:
 *   keep     an owner message, an error banner, a "needs you" notice, a steer
 *            by the owner: always shown
 *   system   a relay checkpoint, a non-urgent Bot notice: always hidden
 *   steer    an AI's steer into a running turn: hidden, and it never starts a turn
 *   trigger  the user row that starts a turn
 *   reply    an assistant message
 *   tool     an action row
 *   other    anything else (advisor card, other notices, model mark, summary)
 * Decided in this order, first match wins: keep, system, steer, then by turn.
 *
 * Nothing is deleted: a hidden row still comes back, marked `botView: 'hide'`,
 * so the owner can reveal it and the audit trail stays whole.
 */
import type { HistoryEntry } from '../src/provider.js';

export type BotTurnKind = '' | 'bot_event' | 'bot_brief' | 'advisor' | 'agent';
export type BotRowKind = 'keep' | 'system' | 'steer' | 'trigger' | 'reply' | 'tool' | 'other';

/** Sender kinds that are an agent talking to the Bot, not the owner. */
const AGENT_KINDS = new Set(['conversation', 'mcp', 'delegate', 'automation']);
/** A steer from any of these is not the owner's. */
const NOT_OWNER_STEER = new Set([...AGENT_KINDS, 'advisor', 'bot_event', 'bot_brief']);

export const CHECKPOINT = /^(?:Not sent yet(?: \(relay checkpoint\))?[:.]|Relay checkpoint[:.])/i;

/** Turn origins whose result the owner is meant to see (read-state gating). */
export const VISIBLE_ORIGINS: ReadonlySet<string> = new Set(['human', 'brief', 'recap']);

export function turnKindOf(row: Pick<HistoryEntry, 'sender'>): BotTurnKind {
  const k = row.sender?.kind;
  if (k === 'bot_event' || k === 'bot_brief' || k === 'advisor') return k;
  return k && AGENT_KINDS.has(k) ? 'agent' : '';
}

export function botRowKind(row: HistoryEntry): BotRowKind {
  if (row.ownerMessage) return 'keep';
  if (row.role === 'error') return 'keep';
  if (row.role === 'notice' && row.messageId?.startsWith('bot-notice:')) return row.needsYou ? 'keep' : 'system';
  if (row.role === 'user') {
    if (!row.steered) return 'trigger';
    return NOT_OWNER_STEER.has(row.sender?.kind ?? '') ? 'steer' : 'keep';
  }
  if (CHECKPOINT.test((row.text ?? '').trim())) return 'system';
  if (row.role === 'assistant') return 'reply';
  if (row.role === 'action') return 'tool';
  return 'other';
}

/** `lastReply`: for a 'reply', whether it is the last reply of its turn (only the brief asks). */
export function botRowVisibility(kind: BotRowKind, turn: BotTurnKind, lastReply?: boolean): 'show' | 'hide' {
  if (kind === 'keep') return 'show';
  if (kind === 'system' || kind === 'steer') return 'hide';
  if (turn === 'bot_event' || turn === 'agent') return 'hide';
  if (turn === 'bot_brief') return kind === 'reply' && lastReply !== false ? 'show' : 'hide';
  if (turn === 'advisor') return kind === 'trigger' ? 'hide' : 'show';
  return 'show';
}

/**
 * Annotate Bot-chat history rows with `botView` (and `botTurn` / `botLabel`).
 * Returns copies; rows keep their order and none is dropped.
 * `initialTurn`: the kind of the turn the first row belongs to, when the
 * page starts mid-turn.
 */
export function botRowView(rows: HistoryEntry[], initialTurn: BotTurnKind = ''): HistoryEntry[] {
  const out: HistoryEntry[] = rows.map((r) => ({ ...r }));
  const kinds = out.map(botRowKind);
  let turn: BotTurnKind = initialTurn;
  let start = 0;
  const turnEnd = (to: number) => {
    // The brief's own reply is its last reply row; earlier ones are commentary before its tools.
    if (turn !== 'bot_brief') return;
    let last = -1;
    for (let i = to - 1; i >= start; i--) if (kinds[i] === 'reply') { last = i; break; }
    for (let i = start; i < to; i++) if (kinds[i] === 'reply') out[i].botView = i === last ? 'show' : 'hide';
    if (last >= 0) out[last].botLabel = 'brief';
  };
  for (let i = 0; i < out.length; i++) {
    if (kinds[i] === 'trigger') { turnEnd(i); turn = turnKindOf(out[i]); start = i; }
    out[i].botView = botRowVisibility(kinds[i], turn, true);
    if (turn) out[i].botTurn = turn;
  }
  turnEnd(out.length);
  return out;
}

// ---- owner messages: message_owner calls in the Bot's transcript ----

const OWNER_TOOL = /(?:^|__)message_owner$/;
const NOTIFY_TOOL = /(?:^|__)notify_user$/;

/**
 * Turn the Bot's message_owner (and notify_user, its alias) tool calls into
 * the owner's messages: `{role: 'assistant', ownerMessage: true, needsYou,
 * messageId: 'bot-owner:<toolUseId>'}`. The call is in the transcript, so the
 * message survives a reload. Done in the history ROUTE, never in the adapter,
 * so what an agent reads back from this conversation (findMessageReply)
 * never contains one.
 */
export function ownerMessageRows(rows: HistoryEntry[]): HistoryEntry[] {
  // notify_user calls from before the alias also left a journal notice: do not show both.
  const noticed = rows.filter((r) => r.role === 'notice' && r.messageId?.startsWith('bot-notice:')).map((r) => r.text);
  return rows.map((row) => {
    if (row.role !== 'action' || !row.toolName || !row.toolUseId) return row;
    const notify = NOTIFY_TOOL.test(row.toolName);
    if (!notify && !OWNER_TOOL.test(row.toolName)) return row;
    let input: Record<string, unknown>;
    try { input = JSON.parse(row.detail ?? '{}') as Record<string, unknown>; } catch { return row; }
    let text = '';
    let needsYou = false;
    let options: string[] = [];
    if (notify) {
      const title = typeof input.title === 'string' ? input.title.trim() : '';
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (noticed.some((n) => n.includes(`: ${title}\n${body}`))) return row;
      text = body ? `${title}\n\n${body}` : title;
      needsYou = input.urgent === true;
    } else {
      text = typeof input.text === 'string' ? input.text.trim() : '';
      needsYou = input.needs_you === true;
      if (Array.isArray(input.options)) options = input.options.filter((o): o is string => typeof o === 'string' && !!o.trim()).map((o) => o.trim());
    }
    if (!text) return row;
    const message: HistoryEntry = { ...row, role: 'assistant', text, ownerMessage: true, needsYou, ...(options.length ? { options } : {}), messageId: 'bot-owner:' + row.toolUseId };
    for (const k of ['detail', 'toolName', 'toolUseId', 'sub', 'artifacts'] as const) delete message[k];
    return message;
  });
}

/** The Bot's history as the owner's clients get it: owner messages, then the verdicts. */
export function botHistory(rows: HistoryEntry[], initialTurn: BotTurnKind = ''): HistoryEntry[] {
  return botRowView(ownerMessageRows(rows), initialTurn);
}

/**
 * A page of history that starts mid-turn does not know what started the turn:
 * the trigger is in an older page. Look back (a few pages at most) for the
 * first real user row and return its kind. `readOlder` reads the page before `cursor`.
 */
export function botInitialTurn(
  rows: HistoryEntry[], cursor: number, done: boolean,
  readOlder: (before: number) => { rows: HistoryEntry[]; cursor: number; done: boolean },
  maxPages = 3,
): BotTurnKind {
  const first = rows.findIndex((r) => botRowKind(r) === 'trigger');
  if (first === 0 || done) return '';
  let at = cursor, finished: boolean = done;
  for (let page = 0; page < maxPages && !finished; page++) {
    const older = readOlder(at);
    const kind = lastTrigger(older.rows);
    if (kind !== null) return kind;
    at = older.cursor; finished = older.done;
  }
  return '';
}

/** The kind of the newest turn-starting row in `rows`, or null when there is none. */
function lastTrigger(rows: HistoryEntry[]): BotTurnKind | null {
  for (let i = rows.length - 1; i >= 0; i--) if (botRowKind(rows[i]) === 'trigger') return turnKindOf(rows[i]);
  return null;
}
