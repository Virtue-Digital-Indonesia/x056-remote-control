import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRawEntry, readRawPage } from '../server/raw-transcript.js';

const line = (i: number, pad = 0) => JSON.stringify({ i, type: 'assistant', text: 'x'.repeat(pad) }) + '\n';
function file(n: number, pad = 0, partial = true): string {
  const f = join(mkdtempSync(join(tmpdir(), 'x056-raw-')), 't.jsonl');
  writeFileSync(f, Array.from({ length: n }, (_, i) => line(i, pad)).join('') + (partial ? '{"i":999,"type":"assist' : ''));
  return f;
}
const ids = (p: { entries: { line: unknown }[] }) => p.entries.map((e) => (e.line as { i: number }).i);

describe('raw transcript pages', () => {
  it('tails complete lines only; a half-written last line waits for the next poll', () => {
    const p = readRawPage(file(10), { limit: 4 });
    expect(ids(p)).toEqual([6, 7, 8, 9]);
    expect(p.done).toBe(false);
  });

  it('pages back to the start with `before`, with no gaps or repeats, across 1 MB chunks', () => {
    const f = file(12, 300_000); // ~3.6 MB, lines cross every read chunk
    const seen: number[] = [];
    let p = readRawPage(f, { limit: 5 });
    seen.unshift(...ids(p));
    while (!p.done) { p = readRawPage(f, { before: p.start, limit: 5 }); seen.unshift(...ids(p)); }
    expect(seen).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect((readRawPage(f, { limit: 1 }).entries[0].line as { text: string }).text).toMatch(/\[\+298000 chars\]$/);
  });

  it('live-tails with `after`: the partial line appears once it is finished', () => {
    const f = file(3);
    const first = readRawPage(f, { limit: 10 });
    expect(ids(first)).toEqual([0, 1, 2]);
    expect(ids(readRawPage(f, { after: first.end }))).toEqual([]);
    appendFileSync(f, 'ant"}\n' + line(1000));
    const next = readRawPage(f, { after: first.end });
    expect(ids(next)).toEqual([999, 1000]);
    expect(ids(readRawPage(f, { after: next.end }))).toEqual([]);
  });

  it('cuts long strings and inline images, and reads any entry in full', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'x056-raw-')), 't.jsonl');
    writeFileSync(f, JSON.stringify({ message: { content: [{ type: 'image', source: { type: 'base64', data: 'A'.repeat(50_000) } }, { type: 'text', text: 'y'.repeat(5000) }] } }) + '\n');
    const e = readRawPage(f).entries[0];
    expect(e.truncated).toBe(true);
    expect(JSON.stringify(e.line)).toContain('[image data, 50000 base64 chars]');
    const full = readRawEntry(f, e.at) as { message: { content: { text?: string }[] } };
    expect(full.message.content[1].text).toHaveLength(5000);
  });
});
