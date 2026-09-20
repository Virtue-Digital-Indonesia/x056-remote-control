import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readState, writeState } from './workspace-store.js';
import type { HistoryEntry } from '../src/provider.js';

/** Small gateway-owned supplement: provider transcripts need not record rejected
 * turns, and may lag behind dispatch. Never writes into a provider transcript. */
export class ConversationJournal {
  constructor(private state: string) {}
  private path(pid: string, sid: string) {
    return join(this.state, 'conversation-journal', createHash('sha256').update(pid + '\0' + sid).digest('hex') + '.json');
  }
  record(kind: string, data: Record<string, unknown>, ts: string) {
    if (!data.projectId || !data.sessionId) return;
    let row: HistoryEntry;
    if (kind === 'session_started' && typeof data.displayPrompt === 'string' && !data.displayPrompt.trimStart().startsWith('/')) {
      row = { role: 'user', text: data.displayPrompt, ts, messageId: String(data.messageId || ''), sender: data.sender as HistoryEntry['sender'] };
    } else if (kind === 'session_error' || kind === 'message_rejected' || (kind === 'session_done' && data.status === 'failed')) {
      row = { role: 'error', messageId: data.requestId ? 'error:' + data.requestId : undefined, text: String(data.message || data.reason || 'Turn failed'), ts };
    } else if (kind === 'session_done' && data.status === 'stopped') {
      row = { role: 'notice', messageId: data.requestId ? 'stopped:' + data.requestId : undefined, text: String(data.reason || 'Turn stopped.'), ts };
    } else return;
    const file = this.path(String(data.projectId), String(data.sessionId));
    const rows = readState<HistoryEntry[]>(file, []);
    if (row.messageId && rows.some(r => r.messageId === row.messageId)) return;
    rows.push(row);
    const retained = rows.slice(-200);
    let chars = retained.reduce((n,r) => n + r.text.length, 0);
    while (retained.length > 1 && chars > 2_000_000) chars -= retained.shift()!.text.length;
    writeState(file, retained);
  }
  merge(pid: string, sid: string, transcript: HistoryEntry[], newest: boolean): HistoryEntry[] {
    const rows = transcript.map(r => ({ ...r }));
    const dated = rows.map(r => Date.parse(r.ts || '')).filter(Number.isFinite);
    const oldest = dated.length ? Math.min(...dated) : -Infinity;
    const latest = newest ? Infinity : dated.length ? Math.max(...dated) : -Infinity;
    const used = new Set<HistoryEntry>();
    for (const entry of readState<HistoryEntry[]>(this.path(pid, sid), [])) {
      const at = Date.parse(entry.ts || '');
      const match = entry.role === 'user' && rows.find(r => !used.has(r) && r.role === 'user' && (
        (entry.sender?.messageId && r.sender?.messageId === entry.sender.messageId) ||
        (r.text.trim() === entry.text.trim() && Math.abs(Date.parse(r.ts || '') - at) < 120000)
      ));
      if (match) { match.messageId = entry.messageId; used.add(match); }
      else if (at >= oldest && at <= latest) rows.push(entry);
    }
    return rows.sort((a,b) => Date.parse(a.ts || '') - Date.parse(b.ts || ''));
  }
}
