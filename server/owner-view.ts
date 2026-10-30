/**
 * Owner view in every normal (non-Bot) conversation (docs/owner-view-all-contract.md).
 *
 * A turn another conversation, MCP, a delegate or a scheduled task started is
 * hidden from the owner by default (trigger, tools, replies) unless it was
 * marked for the owner: a reply carrying `<<<FOR_OWNER>>>` or an ASK block.
 * The server records that one fact per turn (OwnerViewStore, keyed by the
 * trigger's sender.messageId) and annotates history rows with it. The Bot chat
 * keeps its own rule in server/bot-view.ts.
 */
import { join } from 'node:path';
import type { HistoryEntry } from '../src/provider.js';
import type { MessageSender } from '../src/message-sender.js';
import { readState, writeState } from './workspace-store.js';
import { isQuestionActionRow } from './bot-view.js';

const AGENT_KINDS = new Set(['conversation', 'mcp', 'delegate', 'automation']);
const KEEP = 500;

export type OwnerReason = 'marker' | 'ask';

export class OwnerViewStore {
  constructor(private stateDir: string) {}
  private file(sessionId: string) {
    return join(this.stateDir, 'owner-view', sessionId.replace(/[^\w.-]/g, '_') + '.json');
  }
  private read(sessionId: string): Record<string, { reason: OwnerReason; at: number }> {
    const raw = readState<unknown>(this.file(sessionId), {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, { reason: OwnerReason; at: number }> : {};
  }
  markShown(sessionId: string, messageId: string, reason: OwnerReason): void {
    if (!sessionId || !messageId) return;
    const all = this.read(sessionId);
    all[messageId] = { reason, at: Date.now() };
    const kept = Object.entries(all)
      .sort((a, b) => (Number(a[1]?.at) || 0) - (Number(b[1]?.at) || 0))
      .slice(-KEEP);
    writeState(this.file(sessionId), Object.fromEntries(kept));
  }
  shown(sessionId: string): Set<string> {
    return new Set(Object.keys(this.read(sessionId)));
  }
}

/** A user row that starts a turn another agent (not the owner, not the conversation itself) sent. */
export function isAgentTrigger(row: Pick<HistoryEntry, 'role' | 'steered' | 'sender'>, sessionId: string): boolean {
  if (row.role !== 'user' || row.steered) return false;
  return isAgentSender(row.sender, sessionId);
}

export function isAgentSender(sender: MessageSender | undefined, sessionId: string): boolean {
  if (!sender || !AGENT_KINDS.has(sender.kind)) return false;
  return !(sender.sessionId && sender.sessionId === sessionId);
}

export function ownerSenderLabel(sender: MessageSender | undefined): string {
  if (!sender) return '';
  if (sender.conversationTitle) return sender.conversationTitle;
  if (sender.projectName) return sender.projectName;
  switch (sender.kind) {
    case 'conversation': return 'Another conversation';
    case 'automation': return 'Scheduled task';
    case 'delegate': return 'Delegates';
    case 'mcp': return 'MCP';
    default: return 'External sender';
  }
}

export interface OwnerInitialTurn {
  kind: 'agent' | '';
  messageId?: string;
  sender?: string;
  /** The turn was marked for the owner (resolved by the caller from the store). */
  forOwner?: boolean;
}

export function ownerRowView(
  rows: HistoryEntry[],
  opts: { sessionId: string; shown?: ReadonlySet<string>; initialTurn?: OwnerInitialTurn },
): HistoryEntry[] {
  const shown = opts.shown ?? new Set<string>();
  const out: HistoryEntry[] = rows.map((r) => ({ ...r }));
  const init = opts.initialTurn;
  let agent = init?.kind === 'agent';
  let marked = agent && (init?.forOwner === true || (!!init?.messageId && shown.has(init.messageId)));
  let who = agent ? init?.sender ?? '' : '';
  for (const row of out) {
    let view: 'show' | 'hide';
    if (row.role === 'user' && !row.steered) {
      agent = isAgentTrigger(row, opts.sessionId);
      const id = row.sender?.messageId;
      marked = agent && (row.forOwner === true || (!!id && shown.has(id)));
      who = agent ? ownerSenderLabel(row.sender) : '';
      if (marked) row.forOwner = true;
      view = agent && !marked ? 'hide' : 'show';
    } else if (row.role === 'error' || isQuestionActionRow(row)) {
      // Error banners and an agent's question edit/dismiss/answer line always show.
      view = 'show';
    } else if (row.role === 'user') { // a steer
      if (!isAgentSender(row.sender, opts.sessionId)) view = 'show';
      else view = !agent ? 'hide' : marked ? 'show' : 'hide';
    } else {
      view = agent && !marked ? 'hide' : 'show';
    }
    row.ownerView = view;
    if (agent) { row.ownerTurn = 'agent'; if (who) row.ownerSender = who; }
  }
  return out;
}

/**
 * A page that starts mid-turn does not know what started the turn: look back
 * (a few pages at most) for the newest turn-starting user row.
 */
export function ownerInitialTurn(
  rows: HistoryEntry[], cursor: number, done: boolean, sessionId: string,
  readOlder: (before: number) => { rows: HistoryEntry[]; cursor: number; done: boolean },
  maxPages = 3,
): OwnerInitialTurn {
  const isStart = (r: HistoryEntry) => r.role === 'user' && !r.steered;
  if (rows.findIndex(isStart) === 0 || done) return { kind: '' };
  const describe = (list: HistoryEntry[]): OwnerInitialTurn | null => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!isStart(list[i])) continue;
      return isAgentTrigger(list[i], sessionId)
        ? { kind: 'agent', messageId: list[i].sender?.messageId, sender: ownerSenderLabel(list[i].sender), ...(list[i].forOwner ? { forOwner: true } : {}) }
        : { kind: '' };
    }
    return null;
  };
  let at = cursor, finished: boolean = done;
  for (let page = 0; page < maxPages && !finished; page++) {
    const older = readOlder(at);
    const found = describe(older.rows);
    if (found) return found;
    at = older.cursor; finished = older.done;
  }
  return { kind: '' };
}
