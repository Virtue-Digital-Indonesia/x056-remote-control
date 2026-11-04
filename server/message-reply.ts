import { existsSync, statSync } from 'node:fs';
import type { HistoryEntry, ProviderAdapter } from '../src/provider.js';
import { findTranscript } from '../src/adapters/claude.js';
import { findRollout } from '../src/adapters/codex.js';

/** One backward page: rows ending just before `before`, oldest first, and the
 *  byte offset of the first row (the next page ends there). */
export interface ReplyPage { rows: HistoryEntry[]; cursor: number; done: boolean }
/** `limit` is optional so a plain `before => ...` reader still fits. */
export type ReplyReader = (before?: number, limit?: number) => ReplyPage;
export interface ReplyResult {
  messageId: string;
  found: boolean;
  messages: { role: HistoryEntry['role']; text: string; ts?: string; sender?: HistoryEntry['sender'] }[];
  truncated: boolean;
}

const PAGE_ROWS = 500;
const MAX_PAGES = 10;
/** Transcript bytes the pages of ONE call may span. Measured as the covered
 *  span (end of page minus its cursor): the adapters widen a window 2 -> 8 ->
 *  32 -> 128 MB and re-read it each time, which the callback cannot see, so a
 *  single page can still read more than its span (see the adapters). */
export const REPLY_MAX_BYTES = 64 * 1024 * 1024;
/** Rows a warm poll asks for beyond what followed the anchor last time. The
 *  adapter widens its window until it holds `limit` rows, so every row asked
 *  for beyond the anchor may cost a wider (re-read) window: keep it small. */
const WARM_SLACK = 4;
/** Later pages of a warm poll (and the first of a warm not-found one): only
 *  the few rows appended since the last poll are new. Grows x4 per page. */
const WARM_ROWS = 8;

/** What one call learned about a transcript, kept between polls. */
interface ReplyEntry {
  fileId: string;
  /** File size at the last call: rows that started before it were parsed. */
  size: number;
  usedAt: number;
  kind: 'found' | 'missing';
  /** found: the anchor's byte offset is at or after this. */
  anchorCursor?: number;
  /** found: raw rows that followed the anchor last time. */
  tail?: number;
  /** found: another user row already follows the anchor, so appends can no
   *  longer change the answer. */
  frozen?: ReplyResult;
  /** missing: older history was never scanned (the first call gave up). */
  truncated?: boolean;
}

/** Bounded LRU with idle expiry. One entry per (transcript, messageId). */
export class MessageReplyCache {
  private readonly entries = new Map<string, ReplyEntry>();
  constructor(readonly max = 200, readonly idleMs = 15 * 60_000) {}
  get size(): number { return this.entries.size; }
  get(key: string, now = Date.now()): ReplyEntry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (now - e.usedAt > this.idleMs) { this.entries.delete(key); return undefined; }
    this.entries.delete(key);
    this.entries.set(key, e);
    return e;
  }
  set(key: string, e: ReplyEntry): void {
    this.entries.delete(key);
    this.entries.set(key, e);
    for (const [k, v] of this.entries) {
      if (this.entries.size <= this.max && e.usedAt - v.usedAt <= this.idleMs) break;
      this.entries.delete(k);
    }
  }
  delete(key: string): void { this.entries.delete(key); }
  clear(): void { this.entries.clear(); }
}

export const replyCache = new MessageReplyCache();

interface ScanResult {
  /** Raw rows collected, oldest first. */
  rows: HistoryEntry[];
  /** Index in `rows` of the newest user row carrying the messageId, or -1. */
  anchor: number;
  /** The oldest page's cursor. */
  cursor: number;
  /** The scan reached the file start. */
  done: boolean;
  /** `stop(cursor)` said enough. */
  stopped: boolean;
}

/** Page backwards until the anchor appears, the file starts, `stop` says the
 *  rest was seen before, or a cap (pages, spanned bytes) is hit. */
function scan(read: ReplyReader, messageId: string, o: {
  limit: (page: number) => number; size?: number; maxBytes: number; stop?: (cursor: number) => boolean;
}): ScanResult {
  let before: number | undefined;
  let rows: HistoryEntry[] = [];
  let spent = 0;
  let cursor = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = read(before, o.limit(page));
    rows = [...result.rows, ...rows];
    cursor = result.cursor;
    let anchor = rows.length - 1;
    while (anchor >= 0 && !(rows[anchor].role === 'user' && rows[anchor].sender?.messageId === messageId)) anchor--;
    if (anchor >= 0) return { rows, anchor, cursor, done: result.done, stopped: false };
    if (result.done) return { rows, anchor: -1, cursor, done: true, stopped: false };
    if (o.stop?.(result.cursor)) return { rows, anchor: -1, cursor, done: false, stopped: true };
    if (result.cursor === before) break;
    const end = before ?? o.size;
    if (end !== undefined) spent += Math.max(0, end - result.cursor);
    if (spent >= o.maxBytes) break;
    before = result.cursor;
  }
  return { rows, anchor: -1, cursor, done: false, stopped: false };
}

/** The reply to `rows[anchor]`: assistant rows up to the next user row. */
function replyOf(rows: HistoryEntry[], anchor: number, messageId: string): { result: ReplyResult; nextUser: number } {
  const nextUser = rows.findIndex((r, i) => i > anchor && r.role === 'user');
  const replies = rows.slice(anchor + 1, nextUser < 0 ? undefined : nextUser).filter(r => r.role === 'assistant');
  let remaining = 100_000;
  const messages = replies.slice(0, 100).map(({ role, text, ts, sender }) => {
    const limited = text.slice(0, remaining);
    remaining -= limited.length;
    return { role, text: limited, ...(ts ? { ts } : {}), ...(sender ? { sender } : {}) };
  }).filter(r => r.text);
  return { result: { messageId, found: true, messages, truncated: replies.length > 100 || replies.reduce((n, r) => n + r.text.length, 0) > 100_000 }, nextUser };
}

const missing = (messageId: string, truncated: boolean): ReplyResult => ({ messageId, found: false, messages: [], truncated });

export interface ReplyCacheOptions {
  cache: MessageReplyCache;
  /** Transcript identity + messageId. */
  key: string;
  /** The transcript as it is now: `id` changes when the file is replaced. */
  file: { id: string; size: number };
  maxBytes?: number;
  now?: number;
}

/** Bound transcript work and output. A missing anchor never means an empty reply
 * is complete: queued messages and slash commands may not have one yet.
 *
 * Without `cache` every call scans from the end as it always did (10 pages of
 * 500 rows, plus a spanned-bytes cap). With it, repeat polls for the same
 * messageId are incremental: a found anchor is re-read only from the end back
 * to the anchor, an answer that a later user row has closed is returned
 * without reading, and a missing anchor costs only the bytes appended since
 * the previous call (new anchors only ever arrive at the end). */
export function findMessageReply(read: ReplyReader, messageId: string, opts?: ReplyCacheOptions): ReplyResult {
  const maxBytes = opts?.maxBytes ?? REPLY_MAX_BYTES;
  if (!opts) return cold(read, messageId, maxBytes).result;
  const { cache, key, file } = opts;
  const now = opts.now ?? Date.now();
  let entry = cache.get(key, now);
  // A replaced or shrunk file invalidates every offset we hold.
  if (entry && (entry.fileId !== file.id || file.size < entry.size)) { cache.delete(key); entry = undefined; }

  if (entry?.kind === 'found' && entry.frozen) {
    entry.size = file.size; entry.usedAt = now;
    return entry.frozen;
  }

  if (entry?.kind === 'found') {
    const anchorCursor = entry.anchorCursor ?? 0;
    const first = Math.min(PAGE_ROWS, (entry.tail ?? 0) + 1 + WARM_SLACK);
    const s = scan(read, messageId, {
      limit: page => (page === 0 ? first : Math.min(PAGE_ROWS, WARM_ROWS * 4 ** (page - 1))), size: file.size, maxBytes,
      // Every row at or after the anchor's page is in hand by now; no anchor
      // there means the file is not the one we indexed.
      stop: cursor => cursor <= anchorCursor,
    });
    if (s.anchor >= 0) return remember(cache, key, file, now, s, messageId, Math.max(anchorCursor, s.cursor));
    cache.delete(key);
    // Fall through to a cold scan.
  } else if (entry?.kind === 'missing') {
    const oldSize = entry.size;
    const s = scan(read, messageId, {
      limit: page => Math.min(PAGE_ROWS, WARM_ROWS * 4 ** page), size: file.size, maxBytes,
      // Strictly below: a line half-written at the old size was skipped as
      // unparseable then, and starts before it.
      stop: cursor => cursor < oldSize,
    });
    if (s.anchor >= 0) return remember(cache, key, file, now, s, messageId, s.cursor);
    const truncated = s.done ? false : s.stopped ? !!entry.truncated : true;
    cache.set(key, { fileId: file.id, size: file.size, usedAt: now, kind: 'missing', truncated });
    return missing(messageId, truncated);
  }

  const c = cold(read, messageId, maxBytes, file.size);
  if (c.scan.anchor >= 0) return remember(cache, key, file, now, c.scan, messageId, c.scan.cursor);
  cache.set(key, { fileId: file.id, size: file.size, usedAt: now, kind: 'missing', truncated: c.result.truncated });
  return c.result;
}

function cold(read: ReplyReader, messageId: string, maxBytes: number, size?: number): { result: ReplyResult; scan: ScanResult } {
  const s = scan(read, messageId, { limit: () => PAGE_ROWS, size, maxBytes });
  if (s.anchor >= 0) return { result: replyOf(s.rows, s.anchor, messageId).result, scan: s };
  return { result: missing(messageId, !s.done), scan: s };
}

function remember(cache: MessageReplyCache, key: string, file: { id: string; size: number }, now: number, s: ScanResult, messageId: string, anchorCursor: number): ReplyResult {
  const { result, nextUser } = replyOf(s.rows, s.anchor, messageId);
  // Closed by a later user row: appends land after it and cannot change the
  // reply. Not when that row repeats the same messageId, since the newest
  // copy is the anchor and a later read would pick it.
  const closed = nextUser >= 0 && s.rows[nextUser].sender?.messageId !== messageId;
  cache.set(key, {
    fileId: file.id, size: file.size, usedAt: now, kind: 'found', anchorCursor,
    tail: s.rows.length - 1 - s.anchor, ...(closed ? { frozen: result } : {}),
  });
  return result;
}

/** Codex's findRollout lists the whole sessions tree; the path of a thread
 *  never moves, so keep it while the file exists. */
const rolloutPaths = new Map<string, string>();
function locate(adapter: ProviderAdapter, configDirs: string[], providerSessionId: string): string | null {
  if (adapter.id === 'claude') return findTranscript(configDirs, providerSessionId);
  if (adapter.id !== 'codex') return null;
  const key = configDirs.join('\0') + '\0' + providerSessionId;
  const hit = rolloutPaths.get(key);
  if (hit !== undefined && existsSync(hit)) return hit;
  rolloutPaths.delete(key);
  const found = findRollout(configDirs, providerSessionId);
  if (found) {
    if (rolloutPaths.size >= 500) rolloutPaths.delete(rolloutPaths.keys().next().value as string);
    rolloutPaths.set(key, found);
  }
  return found;
}

/** The route's entry point: the adapter's pager, cached per transcript file
 *  (path + device + inode) and messageId. An unlocatable file is read uncached. */
export function lookupMessageReply(adapter: ProviderAdapter, configDirs: string[], providerSessionId: string, messageId: string, cache: MessageReplyCache = replyCache): ReplyResult {
  if (!adapter.readHistoryPage) throw new Error('Provider does not support reply lookup');
  const read: ReplyReader = (before, limit = PAGE_ROWS) => adapter.readHistoryPage!(configDirs, providerSessionId, limit, before);
  const path = locate(adapter, configDirs, providerSessionId);
  let file: { id: string; size: number } | undefined;
  if (path) {
    try { const st = statSync(path); file = { id: `${st.dev}:${st.ino}`, size: st.size }; } catch { file = undefined; }
  }
  if (!file) return findMessageReply(read, messageId);
  return findMessageReply(read, messageId, { cache, key: `${adapter.id}\0${path}\0${messageId}`, file });
}
