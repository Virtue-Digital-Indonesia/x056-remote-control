import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexAdapter, rolloutHeads } from '../src/adapters/codex.js';

// Count what the adapter actually reads. The panel polls the sub-agent list
// every 5s while a turn runs; a Codex thread with 39 children once cost
// 359MB of synchronous reads and 41 store scans PER POLL, which blocked the
// gateway's event loop for longer than the poll interval (every request hung).
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const counts = { open: 0, readdir: 0, bytes: 0 };
  return {
    ...real,
    __counts: counts,
    openSync: (...a: Parameters<typeof real.openSync>) => { counts.open++; return real.openSync(...a); },
    readdirSync: (...a: Parameters<typeof real.readdirSync>) => { counts.readdir++; return (real.readdirSync as (...x: unknown[]) => unknown)(...a); },
    readSync: (...a: Parameters<typeof real.readSync>) => { const n = (real.readSync as (...x: unknown[]) => number)(...a); counts.bytes += n; return n; },
    readFileSync: (...a: Parameters<typeof real.readFileSync>) => { const r = (real.readFileSync as (...x: unknown[]) => string | Buffer)(...a); counts.bytes += r.length; return r; },
  };
});
const counts = (fs as unknown as { __counts: { open: number; readdir: number; bytes: number } }).__counts;
const snap = () => ({ ...counts });
const delta = (a: { open: number; readdir: number; bytes: number }) => ({ open: counts.open - a.open, readdir: counts.readdir - a.readdir, bytes: counts.bytes - a.bytes });
const nextTick = () => new Promise<void>((r) => setImmediate(r));

const P = '01a079f6-0814-79e2-b4da-020eb5b255eb';
const C1 = '01a079f6-3bec-76c2-9d84-80d6a1b6be7d';
const C2 = '01a079f6-4444-7000-8000-000000000002';

function meta(id: string, parent?: string) {
  return JSON.stringify({
    type: 'session_meta', timestamp: '2026-09-07T03:42:55.468Z',
    payload: {
      session_id: parent ?? id, id, timestamp: '2026-09-07T03:42:55.468Z', cwd: '/tmp', originator: 'x056',
      base_instructions: 'x'.repeat(16 * 1024),
      ...(parent ? { parent_thread_id: parent, thread_source: 'subagent', source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 1, agent_nickname: 'Ampere', agent_role: null } } } } : { source: 'vscode', thread_source: 'user' }),
    },
  });
}
const line = (payload: unknown, timestamp = '2026-09-07T03:42:59.900Z') => JSON.stringify({ type: 'event_msg', timestamp, payload });
const tokens = line({ type: 'token_count', info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 7, total_tokens: 127 } } });
const complete = line({ type: 'task_complete', turn_id: 'tr', last_agent_message: '42', started_at: 1788752575, completed_at: 1788752579 });

function home(threads: { id: string; parent?: string; body?: string[] }[]) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'codex-home-'));
  const day = join(dir, 'sessions', '2026', '09', '07');
  fs.mkdirSync(day, { recursive: true });
  const file = (id: string) => join(day, `rollout-2026-09-07T03-42-55-${id}.jsonl`);
  for (const t of threads) fs.writeFileSync(file(t.id), [meta(t.id, t.parent), ...(t.body ?? [])].join('\n') + '\n');
  return { dir, file };
}

describe('codex sub-agent reads are incremental', () => {
  it('a second status call on an unchanged child reads nothing', () => {
    const h = home([{ id: P }, { id: C1, parent: P, body: [tokens, complete] }]);
    const first = codexAdapter.subagentStatus!([h.dir], P, C1)!;
    expect(first).toMatchObject({ done: true, result: '42', usage: { input: 120, output: 7, cached: 40 } });
    const before = snap();
    expect(codexAdapter.subagentStatus!([h.dir], P, C1)).toEqual(first);
    expect(delta(before).bytes).toBe(0);
  });

  it('completion appended after the first poll is seen, reading only the appended bytes', () => {
    const h = home([{ id: P }, { id: C1, parent: P }]);
    expect(codexAdapter.subagentStatus!([h.dir], P, C1)).toMatchObject({ done: false });
    const appended = tokens + '\n' + complete + '\n';
    fs.appendFileSync(h.file(C1), appended);
    const before = snap();
    const st = codexAdapter.subagentStatus!([h.dir], P, C1)!;
    expect(st).toMatchObject({ done: true, result: '42', endedAt: 1788752579000, usage: { input: 120, output: 7, cached: 40 } });
    // Not the 16KB session_meta again -- just what arrived since.
    expect(delta(before).bytes).toBeLessThanOrEqual(appended.length);
  });

  it('a line that arrives in two writes is parsed once it is whole', () => {
    const h = home([{ id: P }, { id: C1, parent: P }]);
    codexAdapter.subagentStatus!([h.dir], P, C1);
    const cut = Math.floor(complete.length / 2);
    fs.appendFileSync(h.file(C1), complete.slice(0, cut));
    expect(codexAdapter.subagentStatus!([h.dir], P, C1)).toMatchObject({ done: false });
    fs.appendFileSync(h.file(C1), complete.slice(cut) + '\n');
    expect(codexAdapter.subagentStatus!([h.dir], P, C1)).toMatchObject({ done: true, result: '42' });
  });

  it('a rollout that shrank is rescanned from the start', () => {
    const h = home([{ id: P }, { id: C1, parent: P, body: [complete] }]);
    expect(codexAdapter.subagentStatus!([h.dir], P, C1)).toMatchObject({ done: true });
    fs.writeFileSync(h.file(C1), meta(C1, P) + '\n');
    const st = codexAdapter.subagentStatus!([h.dir], P, C1)!;
    expect(st.done).toBe(false);
    expect(st.result).toBeUndefined();
  });

  it('scans the store once per request, and reads each first line once for good', async () => {
    const h = home([{ id: P }, { id: C1, parent: P }]);
    expect(rolloutHeads([h.dir]).map((x) => x.id).sort()).toEqual([C1, P].sort());
    const before = snap();
    // The controller, listSubagents and every subagentStatus all ask for the
    // heads inside ONE synchronous handler: that must be one readdir, not 41.
    rolloutHeads([h.dir]); codexAdapter.listSubagents!([h.dir], P); rolloutHeads([h.dir]);
    expect(delta(before)).toMatchObject({ readdir: 0, open: 0 });
    // The next request re-lists the directory but never re-reads a known
    // first line: a session_meta is immutable once written.
    await nextTick();
    const b2 = snap();
    expect(codexAdapter.listSubagents!([h.dir], P).map((s) => s.agentId)).toEqual([C1]);
    expect(delta(b2).open).toBe(0);
    expect(delta(b2).readdir).toBeGreaterThan(0);
    // A child spawned since still shows up, costing exactly its own first line.
    fs.writeFileSync(h.file(C2), meta(C2, P) + '\n');
    await nextTick();
    const b3 = snap();
    expect(codexAdapter.listSubagents!([h.dir], P).map((s) => s.agentId).sort()).toEqual([C1, C2].sort());
    expect(delta(b3).open).toBe(1);
  });
});
