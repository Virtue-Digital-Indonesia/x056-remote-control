import type { HistoryEntry } from '../src/provider.js';

/** Bound transcript work and output. A missing anchor never means an empty reply
 * is complete: queued messages and slash commands may not have one yet. */
export function findMessageReply(
  read: (before?: number) => { rows: HistoryEntry[]; cursor: number; done: boolean },
  messageId: string,
) {
  let before: number | undefined;
  let rows: HistoryEntry[] = [];
  for (let page = 0; page < 10; page++) {
    const result = read(before);
    rows = [...result.rows.filter(r => r.role === 'user' || r.role === 'assistant'), ...rows];
    let anchor = rows.length - 1;
    while (anchor >= 0 && !(rows[anchor].role === 'user' && rows[anchor].sender?.messageId === messageId)) anchor--;
    if (anchor >= 0) {
      const nextUser = rows.findIndex((r, i) => i > anchor && r.role === 'user');
      const replies = rows.slice(anchor + 1, nextUser < 0 ? undefined : nextUser).filter(r => r.role === 'assistant');
      let remaining = 100_000;
      const messages = replies.slice(0, 100).map(({ role, text, ts, sender }) => {
        const limited = text.slice(0, remaining);
        remaining -= limited.length;
        return { role, text: limited, ...(ts ? { ts } : {}), ...(sender ? { sender } : {}) };
      }).filter(r => r.text);
      return { messageId, found: true, messages, truncated: replies.length > 100 || replies.reduce((n, r) => n + r.text.length, 0) > 100_000 };
    }
    if (result.done) return { messageId, found: false, messages: [], truncated: false };
    if (result.cursor === before) break;
    before = result.cursor;
  }
  return { messageId, found: false, messages: [], truncated: true };
}
