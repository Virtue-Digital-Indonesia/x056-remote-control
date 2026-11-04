import { describe, expect, it } from 'vitest';
import { findMessageReply, MessageReplyCache, REPLY_MAX_BYTES, type ReplyPage } from '../server/message-reply.js';
import type { HistoryEntry } from '../src/provider.js';

/** Verbatim copy of findMessageReply before the cache: the oracle. */
function uncached(read: (before?: number) => { rows: HistoryEntry[]; cursor: number; done: boolean }, messageId: string) {
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

const MB = 1 << 20;
const START = 2 * MB; // src/adapters/claude.ts TAIL_START_BYTES
const MAX = 128 * MB; // TAIL_MAX_BYTES

/**
 * An in-memory transcript that pages exactly like readFilePage: a window
 * ending at `before` starts at 2 MB and widens x4 (each attempt re-read) until
 * it holds `limit` complete rows, reaches the start or hits 128 MB. A line
 * still being written (`partial`) occupies bytes but parses as nothing.
 */
class FakeTranscript {
  rows: { entry: HistoryEntry; start: number; len: number }[] = [];
  partial: { entry: HistoryEntry; len: number } | null = null;
  bytesRead = 0;
  id = 'ino-1';
  get complete(): number { const last = this.rows[this.rows.length - 1]; return last ? last.start + last.len : 0; }
  get size(): number { return this.complete + (this.partial?.len ?? 0); }
  add(entry: HistoryEntry, len: number): this { this.rows.push({ entry, start: this.complete, len }); return this; }
  /** Start writing a line; `finish()` completes it. */
  begin(entry: HistoryEntry, len: number): this { this.partial = { entry, len }; return this; }
  finish(): this { if (this.partial) { const p = this.partial; this.partial = null; this.add(p.entry, p.len); } return this; }
  read = (before?: number, limit = 500): ReplyPage => {
    const size = this.size;
    const end = before === undefined ? size : Math.max(0, Math.min(before, size));
    if (end <= 0) return { rows: [], cursor: 0, done: true };
    let window = Math.min(START, end);
    for (;;) {
      const start = Math.max(0, end - window);
      this.bytesRead += end - start;
      const inside = this.rows.filter(r => r.start >= start && r.start + r.len <= end);
      const atStart = start === 0;
      if (inside.length >= limit || atStart || window >= MAX) {
        const from = Math.max(0, inside.length - limit);
        const rows = inside.slice(from);
        return { rows: rows.map(r => r.entry), cursor: rows.length ? rows[0].start : start, done: atStart && from === 0 };
      }
      window = Math.min(window * 4, end);
    }
  };
  /** Bytes read by one call. */
  measure<T>(fn: () => T): { out: T; bytes: number } {
    const before = this.bytesRead;
    const out = fn();
    return { out, bytes: this.bytesRead - before };
  }
}

const user = (messageId: string, text = 'prompt'): HistoryEntry => ({ role: 'user', text, sender: { kind: 'mcp', messageId } });
const plainUser = (text = 'human'): HistoryEntry => ({ role: 'user', text });
const reply = (text: string): HistoryEntry => ({ role: 'assistant', text });
const notice = (text: string): HistoryEntry => ({ role: 'notice', text });

/** `n` filler rows (turns of user + assistant + an occasional notice). */
function filler(t: FakeTranscript, n: number, len: number, tag = 'f'): FakeTranscript {
  for (let i = 0; i < n; i++) {
    const k = i % 7;
    t.add(k === 0 ? plainUser(`${tag}${i}`) : k === 6 ? notice(`${tag}${i}`) : reply(`${tag}${i}`), len);
  }
  return t;
}

const cached = (t: FakeTranscript, cache: MessageReplyCache, id: string) =>
  findMessageReply(t.read, id, { cache, key: `k\0${id}`, file: { id: t.id, size: t.size } });

describe('reply lookup cost', () => {
  it('a missing id spans at most the byte cap once, and a repeat poll reads only the tail', () => {
    // ~700 MB of 20 KB rows: the shape that took 13.5 s per call live.
    const t = filler(new FakeTranscript(), 35_000, 20 * 1024);
    const cache = new MessageReplyCache();
    const old = t.measure(() => uncached(t.read, 'queued'));
    expect(old.out).toEqual({ messageId: 'queued', found: false, messages: [], truncated: true });

    const first = t.measure(() => cached(t, cache, 'queued'));
    expect(first.out).toEqual(old.out);
    // Pages stop once they have spanned the cap; the adapter's own widening
    // re-reads (2+8+32 MB per 10 MB page) are on top and cannot be seen here.
    expect(first.bytes).toBeLessThan(old.bytes);
    expect(first.bytes).toBeLessThanOrEqual(REPLY_MAX_BYTES / (10 * MB) * 42 * MB + 42 * MB);

    // A few rows arrive; the next poll reads one minimum window, not the cap.
    filler(t, 5, 20 * 1024, 'g');
    const second = t.measure(() => cached(t, cache, 'queued'));
    expect(second.out).toEqual({ messageId: 'queued', found: false, messages: [], truncated: true });
    expect(second.bytes).toBeLessThanOrEqual(START);

    // Nothing new: still one window at most, never the old region.
    const third = t.measure(() => cached(t, cache, 'queued'));
    expect(third.bytes).toBeLessThanOrEqual(START);

    // The anchor finally lands at the end and is found from the tail.
    t.add(user('queued'), 2048).add(reply('done'), 2048);
    const hit = t.measure(() => cached(t, cache, 'queued'));
    expect(hit.out).toMatchObject({ found: true, messages: [reply('done')] });
    expect(hit.bytes).toBeLessThanOrEqual(START);
  });

  it('a found anchor with a growing reply: later polls read only back to the anchor', () => {
    // Big rows, so 500 rows (what an uncached page asks for) is ~50 MB.
    const t = filler(new FakeTranscript(), 3_000, 100 * 1024);
    t.add(user('wanted'), 4096);
    const cache = new MessageReplyCache();
    const first = t.measure(() => cached(t, cache, 'wanted'));
    expect(first.out).toEqual({ messageId: 'wanted', found: true, messages: [], truncated: false });
    let oldTotal = 0, newTotal = 0;
    for (let i = 0; i < 20; i++) {
      t.add(reply(`part ${i}`), 8 * 1024);
      const old = t.measure(() => uncached(t.read, 'wanted'));
      const now = t.measure(() => cached(t, cache, 'wanted'));
      expect(now.out).toEqual(old.out);
      oldTotal += old.bytes; newTotal += now.bytes;
      expect(now.bytes).toBeLessThanOrEqual(START);
    }
    expect(newTotal * 20).toBeLessThan(oldTotal);
    // Another user row closes the reply: from then on nothing is read.
    t.add(plainUser('next'), 4096).add(reply('unrelated'), 4096);
    const closed = t.measure(() => cached(t, cache, 'wanted'));
    expect(closed.out).toEqual(uncached(t.read, 'wanted'));
    const frozen = t.measure(() => cached(t, cache, 'wanted'));
    expect(frozen.bytes).toBe(0);
    expect(frozen.out).toEqual(closed.out);
    expect(frozen.out.messages.map(m => m.text)).toEqual(Array.from({ length: 20 }, (_, i) => `part ${i}`));
  });

  it('a line half-written at the previous poll is re-read when it completes', () => {
    const t = filler(new FakeTranscript(), 2_000, 4096);
    const cache = new MessageReplyCache();
    t.begin(user('late'), 3000);
    expect(cached(t, cache, 'late')).toEqual(uncached(t.read, 'late'));
    expect(cached(t, cache, 'late').found).toBe(false);
    t.finish().add(reply('answer'), 1000);
    expect(cached(t, cache, 'late')).toEqual({ messageId: 'late', found: true, messages: [reply('answer')], truncated: false });
  });

  it('a replaced or shrunk file drops what was learned', () => {
    const t = filler(new FakeTranscript(), 100, 1024).add(user('a'), 100).add(reply('one'), 100).add(plainUser(), 100);
    const cache = new MessageReplyCache();
    expect(cached(t, cache, 'a').messages).toEqual([reply('one')]);
    const r = filler(new FakeTranscript(), 10, 1024).add(user('a'), 100).add(reply('two'), 100);
    r.id = 'ino-2';
    expect(cached(r, cache, 'a').messages).toEqual([reply('two')]);
    const s = new FakeTranscript().add(user('a'), 10).add(reply('three'), 10);
    s.id = 'ino-2'; // same inode, smaller file: rewritten in place
    expect(cached(s, cache, 'a').messages).toEqual([reply('three')]);
  });

  it('matches the uncached lookup poll after poll', () => {
    type Case = { name: string; build: () => FakeTranscript; id: string; grow: (t: FakeTranscript, i: number) => void };
    const small = 2048;
    const cases: Case[] = [
      { name: 'anchor in the first page', id: 'm', build: () => filler(new FakeTranscript(), 3_000, small).add(user('m'), small), grow: (t, i) => { t.add(reply(`r${i}`), small); } },
      { name: 'anchor five pages back', id: 'm', build: () => filler(filler(new FakeTranscript(), 3_000, small).add(user('m'), small).add(reply('first'), small), 2_300, small, 'later'), grow: (t, i) => { t.add(reply(`r${i}`), small); } },
      { name: 'no anchor, large', id: 'm', build: () => filler(new FakeTranscript(), 8_000, small), grow: (t, i) => { t.add(i === 3 ? user('m') : reply(`r${i}`), small); } },
      { name: 'no anchor, whole file read', id: 'm', build: () => filler(new FakeTranscript(), 300, small), grow: (t, i) => { t.add(reply(`r${i}`), small); } },
      { name: 'reply spans the next user row', id: 'm', build: () => filler(new FakeTranscript(), 1_000, small).add(user('m'), small).add(reply('a'), small), grow: (t, i) => { t.add(i === 2 ? plainUser('next') : reply(`r${i}`), small); } },
      { name: 'other ids around it', id: 'm', build: () => filler(new FakeTranscript(), 1_000, small).add(user('x'), small).add(reply('x1'), small), grow: (t, i) => { t.add(i === 1 ? user('m') : i === 4 ? user('y') : reply(`r${i}`), small); } },
    ];
    for (const c of cases) {
      const t = c.build();
      const cache = new MessageReplyCache();
      for (let i = 0; i < 8; i++) {
        expect(cached(t, cache, c.id), `${c.name} poll ${i}`).toEqual(uncached(t.read, c.id));
        c.grow(t, i);
      }
    }
  });

  it('the cache is bounded and forgets idle entries', () => {
    const cache = new MessageReplyCache(3, 1000);
    const t = new FakeTranscript().add(user('a'), 10);
    for (const id of ['a', 'b', 'c', 'd']) findMessageReply(t.read, id, { cache, key: id, file: { id: t.id, size: t.size }, now: 0 });
    expect(cache.size).toBe(3);
    expect(cache.get('a', 0)).toBeUndefined();
    expect(cache.get('d', 500)).toBeDefined();
    expect(cache.get('d', 2000)).toBeUndefined();
  });
});
