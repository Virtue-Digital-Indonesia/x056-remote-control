import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The conversation's own transcript, entry by entry, for the panel's terminal
 * view: every prompt, text block, tool call with its input, tool result,
 * advisor call and system line, exactly as the CLI recorded it.
 *
 * Paged by byte offset so a 600 MB transcript is never read whole:
 *   - tail (no cursor): the last `limit` entries
 *   - `before`: older entries ending at that offset (scrolling up)
 *   - `after`:  entries appended since that offset (live tailing)
 * Only complete lines are returned; a line still being written stays for the
 * next poll. Long strings are cut (the full entry is one `readRawEntry` away)
 * and inline image data is replaced by its size -- a screenshot is megabytes
 * of base64 that a terminal cannot show anyway.
 */

export interface RawEntry { at: number; line: unknown; truncated?: boolean }
export interface RawPage { size: number; start: number; end: number; entries: RawEntry[]; done: boolean }

const STRING_CAP = 2000;
const SCAN_CAP = 32 * 1024 * 1024; // never read more than this per page

export function readRawPage(file: string, opts: { before?: number; after?: number; limit?: number } = {}): RawPage {
  const limit = Math.max(1, Math.min(opts.limit ?? 300, 1000));
  if (!existsSync(file)) return { size: 0, start: 0, end: 0, entries: [], done: true };
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (opts.after !== undefined) return forward(fd, size, Math.max(0, Math.min(opts.after, size)), limit);
    return backward(fd, size, Math.max(0, Math.min(opts.before ?? size, size)), limit);
  } finally { closeSync(fd); }
}

/** One entry in full, for "show all" on a cut line. */
export function readRawEntry(file: string, offset: number, maxBytes = 4 * 1024 * 1024): unknown {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    if (!Number.isInteger(offset) || offset < 0 || offset >= size) throw new Error('No entry at that offset');
    const buf = Buffer.alloc(Math.min(maxBytes, size - offset));
    const n = readSync(fd, buf, 0, buf.length, offset);
    const nl = buf.subarray(0, n).indexOf(10);
    if (nl < 0) throw new Error('Entry is larger than the limit or still being written');
    return JSON.parse(buf.subarray(0, nl).toString('utf8'));
  } finally { closeSync(fd); }
}

function forward(fd: number, size: number, from: number, limit: number): RawPage {
  const entries: RawEntry[] = [];
  let pos = from;
  const chunk = Buffer.alloc(Math.min(4 * 1024 * 1024, Math.max(1, size - from)));
  let carry = Buffer.alloc(0), carryAt = from, scanned = 0;
  while (pos < size && entries.length < limit && scanned < SCAN_CAP) {
    const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
    if (n <= 0) break;
    scanned += n;
    let buf = Buffer.concat([carry, chunk.subarray(0, n)]);
    let start = 0;
    for (let i = 0; i < buf.length && entries.length < limit; i++) {
      if (buf[i] !== 10) continue;
      push(entries, buf.subarray(start, i), carryAt + start);
      start = i + 1;
    }
    carryAt += start; carry = Buffer.from(buf.subarray(start)); buf = Buffer.alloc(0);
    pos += n;
  }
  // `carryAt` is where the first unreturned (or unfinished) line begins.
  return { size, start: from, end: carryAt, entries, done: carryAt >= size };
}

function backward(fd: number, size: number, end: number, limit: number): RawPage {
  // A line being written at EOF has no newline yet; it is not ours to show.
  const probe = Buffer.alloc(1);
  const effectiveEnd = end > 0 && readSync(fd, probe, 0, 1, end - 1) === 1 && probe[0] !== 10 ? lastNewline(fd, end) : end;
  // `buf` holds bytes [pos, effectiveEnd). Its first line is complete only
  // once pos reaches 0; until then it may continue into the previous chunk.
  let pos = effectiveEnd, buf = Buffer.alloc(0), scanned = 0;
  const complete = () => { let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++; return pos === 0 ? n : n - 1; };
  while (pos > 0 && scanned < SCAN_CAP && complete() < limit) {
    const len = Math.min(1024 * 1024, pos);
    const chunk = Buffer.alloc(len);
    readSync(fd, chunk, 0, len, pos - len);
    pos -= len; scanned += len;
    buf = Buffer.concat([chunk, buf]);
  }
  const lines: { at: number; bytes: Buffer }[] = [];
  let lineStart = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 10) continue;
    lines.push({ at: pos + lineStart, bytes: buf.subarray(lineStart, i) });
    lineStart = i + 1;
  }
  if (pos > 0 && lines.length) lines.shift(); // partial: began before what we read
  const kept = lines.slice(-limit);
  const entries: RawEntry[] = [];
  for (const l of kept) push(entries, l.bytes, l.at);
  const first = kept.length ? kept[0].at : effectiveEnd;
  return { size, start: first, end: effectiveEnd, entries, done: first === 0 };
}

function lastNewline(fd: number, end: number): number {
  let pos = end;
  const buf = Buffer.alloc(64 * 1024);
  while (pos > 0) {
    const len = Math.min(buf.length, pos);
    readSync(fd, buf, 0, len, pos - len);
    const i = buf.subarray(0, len).lastIndexOf(10);
    if (i >= 0) return pos - len + i + 1;
    pos -= len;
  }
  return 0;
}

function push(out: RawEntry[], bytes: Buffer, at: number): void {
  const text = bytes.toString('utf8').trim();
  if (!text.startsWith('{')) return;
  let line: unknown;
  try { line = JSON.parse(text); } catch { return; }
  const state = { cut: false };
  out.push({ at, line: shrink(line, state), ...(state.cut ? { truncated: true } : {}) });
}

/** Cut long strings and drop inline image bytes, recording whether anything went. */
export function shrink(v: unknown, state: { cut: boolean }, depth = 0): unknown {
  if (typeof v === 'string') {
    if (v.length <= STRING_CAP) return v;
    state.cut = true;
    return v.slice(0, STRING_CAP) + `… [+${v.length - STRING_CAP} chars]`;
  }
  if (Array.isArray(v)) return depth > 12 ? '[…]' : v.map((x) => shrink(x, state, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 12) return '[…]';
    const o = v as Record<string, unknown>;
    if (o.type === 'base64' && typeof o.data === 'string') { state.cut = true; return { ...o, data: `[image data, ${o.data.length} base64 chars]` }; }
    if (typeof o.image_url === 'string' && o.image_url.startsWith('data:')) { state.cut = true; return { ...o, image_url: `[inline image, ${o.image_url.length} chars]` }; }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, shrink(x, state, depth + 1)]));
  }
  return v;
}
