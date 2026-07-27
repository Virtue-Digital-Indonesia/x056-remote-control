import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';

// Rollout lines in the REAL shape captured from an authenticated codex-cli
// 0.144.4 run: {timestamp, type:"event_msg", payload:{type:"user_message"|
// "task_complete", ...}}, filed at sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>.jsonl.
function rolloutDir(threadId: string, lines: unknown[]): string {
  const configDir = mkdtempSync(join(tmpdir(), 'x056-cxhist-'));
  const day = join(configDir, 'sessions', '2026', '07', '15');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-07-15T01-51-33-${threadId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return configDir;
}

describe('codexAdapter.readHistory', () => {
  it('extracts user prompts and the final agent message per turn, skipping lifecycle/internal event types', () => {
    const tid = 't-1';
    const dir = rolloutDir(tid, [
      { timestamp: '2026-07-15T01:51:33.000Z', type: 'session_meta', payload: { session_id: tid } },
      { timestamp: '2026-07-15T01:51:33.500Z', type: 'turn_context', payload: {} },
      { timestamp: '2026-07-15T01:51:34.000Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'x' } },
      { timestamp: '2026-07-15T01:51:34.100Z', type: 'event_msg', payload: { type: 'user_message', message: 'say hi' } },
      { timestamp: '2026-07-15T01:51:34.900Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [] } },
      { timestamp: '2026-07-15T01:51:35.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'hello!' } },
    ]);
    expect(codexAdapter.readHistory!([dir], tid, 100)).toEqual([
      { role: 'user', text: 'say hi', ts: '2026-07-15T01:51:34.100Z' },
      { role: 'assistant', text: 'hello!', ts: '2026-07-15T01:51:35.000Z' },
    ]);
  });

  it('reconstructs MULTIPLE turns from one rollout (it is append-only across resumes/continuations)', () => {
    const tid = 't-2';
    const dir = rolloutDir(tid, [
      { timestamp: '2026-07-15T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'remember X056-BANANA-42' } },
      { timestamp: '2026-07-15T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'STORED' } },
      { timestamp: '2026-07-15T00:05:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'what was the codeword?' } },
      { timestamp: '2026-07-15T00:05:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'X056-BANANA-42' } },
    ]);
    expect(codexAdapter.readHistory!([dir], tid, 100).map((r) => r.text)).toEqual([
      'remember X056-BANANA-42', 'STORED', 'what was the codeword?', 'X056-BANANA-42',
    ]);
  });

  it('captures EVERY streamed agent_message (commentary + final), deduping the task_complete echo of the final', () => {
    // Real-world turns stream several phase:"commentary" updates before the
    // final answer, and task_complete.last_agent_message REPEATS the final
    // (verified live: 20 of 20 in a real rollout). Reading only task_complete
    // dropped all the commentary — the reported "chats disappear on reload".
    const tid = 't-commentary';
    const dir = rolloutDir(tid, [
      { timestamp: 't1', type: 'event_msg', payload: { type: 'user_message', message: 'improve the module' } },
      { timestamp: 't2', type: 'event_msg', payload: { type: 'agent_message', message: 'Mapping the architecture first.', phase: 'commentary' } },
      { timestamp: 't3', type: 'event_msg', payload: { type: 'agent_message', message: 'Found three hotspots; fixing.', phase: 'commentary' } },
      { timestamp: 't4', type: 'event_msg', payload: { type: 'agent_message', message: 'Done — all three fixed.', phase: 'final_answer' } },
      { timestamp: 't5', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Done — all three fixed.' } },
    ]);
    expect(codexAdapter.readHistory!([dir], tid, 100).map((r) => r.text)).toEqual([
      'improve the module',
      'Mapping the architecture first.',
      'Found three hotspots; fixing.',
      'Done — all three fixed.', // once — the task_complete echo is deduped
    ]);
  });

  it('still emits a task_complete text that is NOT an echo (safety net for final-only builds)', () => {
    const tid = 't-tc-only';
    const dir = rolloutDir(tid, [
      { timestamp: 't1', type: 'event_msg', payload: { type: 'user_message', message: 'quick one' } },
      { timestamp: 't2', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'the answer' } },
    ]);
    expect(codexAdapter.readHistory!([dir], tid, 100).map((r) => r.text)).toEqual(['quick one', 'the answer']);
  });

  it('drops a task_complete with last_agent_message: null instead of emitting an empty assistant row (the crashed-turn case)', () => {
    const tid = 't-crashed';
    const dir = rolloutDir(tid, [
      { timestamp: '2026-07-15T01:51:34.100Z', type: 'event_msg', payload: { type: 'user_message', message: 'find improvements' } },
      { timestamp: '2026-07-15T01:51:38.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: null } },
    ]);
    // The user's message still shows — that's what actually happened — but there's
    // no fabricated assistant reply for a turn that produced none.
    expect(codexAdapter.readHistory!([dir], tid, 100)).toEqual([
      { role: 'user', text: 'find improvements', ts: '2026-07-15T01:51:34.100Z' },
    ]);
  });

  it('strips the appended ASK protocol from the user prompt and a raw <<<ASK>>> block from the assistant reply', () => {
    const tid = 't-ask';
    const dir = rolloutDir(tid, [
      { timestamp: '2026-07-15T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'do the thing\n\n〈x056 question protocol〉\nKeep working autonomously...' } },
      { timestamp: '2026-07-15T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Here is my plan.\n\n<<<ASK\nquestion: Proceed?\n>>>' } },
    ]);
    expect(codexAdapter.readHistory!([dir], tid, 100)).toEqual([
      { role: 'user', text: 'do the thing', ts: '2026-07-15T00:00:00.000Z' },
      { role: 'assistant', text: 'Here is my plan.', ts: '2026-07-15T00:00:01.000Z' },
    ]);
  });

  it('returns [] when no rollout matches the thread id in any given config dir', () => {
    const dir = rolloutDir('other-thread', [{ timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'x' } }]);
    expect(codexAdapter.readHistory!([dir], 'missing-thread', 100)).toEqual([]);
  });

  it('honors the limit by returning the last N entries', () => {
    const tid = 't-many';
    const lines: unknown[] = [];
    for (let i = 0; i < 10; i++) lines.push({ timestamp: `t${i}`, type: 'event_msg', payload: { type: 'user_message', message: `msg ${i}` } });
    const dir = rolloutDir(tid, lines);
    expect(codexAdapter.readHistory!([dir], tid, 3).map((r) => r.text)).toEqual(['msg 7', 'msg 8', 'msg 9']);
  });

  it('finds the rollout across MULTIPLE config dirs (a conversation may have failed over between codex accounts)', () => {
    const other = rolloutDir('unrelated', [{ timestamp: 't', type: 'event_msg', payload: { type: 'user_message', message: 'noise' } }]);
    const tid = 't-multi';
    const real = rolloutDir(tid, [
      { timestamp: '2026-07-15T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
      { timestamp: '2026-07-15T00:00:01.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'hello' } },
    ]);
    expect(codexAdapter.readHistory!([other, real], tid, 100)).toEqual([
      { role: 'user', text: 'hi', ts: '2026-07-15T00:00:00.000Z' },
      { role: 'assistant', text: 'hello', ts: '2026-07-15T00:00:01.000Z' },
    ]);
  });
});

describe('codexAdapter.readHistoryPage (scroll-back)', () => {
  function rollout(threadId: string, lines: unknown[]): string {
    const configDir = mkdtempSync(join(tmpdir(), 'x056-cxpage-'));
    const day = join(configDir, 'sessions', '2026', '07', '15');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-07-15T01-51-33-${threadId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    return configDir;
  }
  function convo(turns: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < turns; i++) {
      out.push({ timestamp: `t${i}a`, type: 'event_msg', payload: { type: 'user_message', message: `q${i}` } });
      out.push({ timestamp: `t${i}b`, type: 'event_msg', payload: { type: 'agent_message', message: `a${i}`, phase: 'final_answer' } });
      // the usual duplicate echo — must stay deduped even across a page boundary
      out.push({ timestamp: `t${i}c`, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `a${i}` } });
    }
    return out;
  }

  it('walks the whole rollout backwards page by page, with no gaps or repeats', () => {
    const tid = 'cx-walk';
    const dir = rollout(tid, convo(40));
    const seen: string[] = [];
    let before: number | undefined; let done = false; let guard = 0;
    while (!done && guard++ < 60) {
      const page = codexAdapter.readHistoryPage!([dir], tid, 9, before);
      seen.unshift(...page.rows.map((r) => r.text));
      before = page.cursor; done = page.done;
    }
    expect(done).toBe(true);
    const expected: string[] = [];
    for (let i = 0; i < 40; i++) { expected.push(`q${i}`); expected.push(`a${i}`); }
    expect(seen).toEqual(expected);
  });

  it('does not resurrect the task_complete echo when a page boundary splits the pair', () => {
    const tid = 'cx-dedup';
    const dir = rollout(tid, convo(12));
    // Page at every possible size; the echo must never appear twice anywhere.
    for (const limit of [1, 2, 3, 5, 7]) {
      const seen: string[] = [];
      let before: number | undefined; let done = false; let guard = 0;
      while (!done && guard++ < 100) {
        const page = codexAdapter.readHistoryPage!([dir], tid, limit, before);
        seen.unshift(...page.rows.map((r) => r.text));
        before = page.cursor; done = page.done;
      }
      const dupes = seen.filter((t, i) => i > 0 && seen[i - 1] === t);
      expect({ limit, dupes }).toEqual({ limit, dupes: [] });
      expect(seen.length).toBe(24); // 12 prompts + 12 answers, echo never counted
    }
  });

  it('reports done for a short rollout and for an unknown thread', () => {
    const tid = 'cx-short';
    const dir = rollout(tid, convo(2));
    const page = codexAdapter.readHistoryPage!([dir], tid, 50);
    expect(page.rows.map((r) => r.text)).toEqual(['q0', 'a0', 'q1', 'a1']);
    expect(page.done).toBe(true);
    expect(codexAdapter.readHistoryPage!([dir], 'nope', 10)).toEqual({ rows: [], cursor: 0, done: true });
  });
});

describe('codexAdapter.readHistoryPage on a rollout bigger than one window', () => {
  // The windowed read only kicks in past TAIL_START_BYTES (1MB); below that the
  // whole file fits one window and page boundaries never land mid-file. These
  // use bulky messages so windows genuinely split, which is the case that
  // exercises the dedup context prefix.
  const PAD = 'p'.repeat(120_000);
  function bigRollout(turns: number): { dir: string; tid: string } {
    const tid = 'cx-big';
    const dir = mkdtempSync(join(tmpdir(), 'x056-cxbig-'));
    const day = join(dir, 'sessions', '2026', '07', '15');
    mkdirSync(day, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < turns; i++) {
      lines.push(JSON.stringify({ timestamp: `t${i}a`, type: 'event_msg', payload: { type: 'user_message', message: `q${i} ${PAD}` } }));
      lines.push(JSON.stringify({ timestamp: `t${i}b`, type: 'event_msg', payload: { type: 'agent_message', message: `a${i} ${PAD}`, phase: 'final_answer' } }));
      lines.push(JSON.stringify({ timestamp: `t${i}c`, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: `a${i} ${PAD}` } }));
    }
    writeFileSync(join(day, `rollout-2026-07-15T01-51-33-${tid}.jsonl`), lines.join('\n') + '\n');
    return { dir, tid };
  }

  it('stays correct across many page sizes (some land a boundary between an answer and its echo)', () => {
    const { dir, tid } = bigRollout(30);
    for (let limit = 1; limit <= 10; limit++) {
      const seen: string[] = [];
      let before: number | undefined; let done = false; let guard = 0;
      while (!done && guard++ < 400) {
        const page = codexAdapter.readHistoryPage!([dir], tid, limit, before);
        seen.unshift(...page.rows.map((r) => r.text.split(' ')[0]));
        before = page.cursor; done = page.done;
      }
      const expected: string[] = [];
      for (let i = 0; i < 30; i++) { expected.push(`q${i}`); expected.push(`a${i}`); }
      expect({ limit, seen }).toEqual({ limit, seen: expected });
    }
  }, 60000);

  it('pages a multi-megabyte rollout with no gaps, repeats, or resurrected echoes', () => {
    const { dir, tid } = bigRollout(40); // ~14MB, well past the 1MB window
    const seen: string[] = [];
    let before: number | undefined; let done = false; let guard = 0;
    while (!done && guard++ < 200) {
      const page = codexAdapter.readHistoryPage!([dir], tid, 4, before);
      expect(before === undefined || page.cursor < before).toBe(true); // always makes progress
      seen.unshift(...page.rows.map((r) => r.text.split(' ')[0]));
      before = page.cursor; done = page.done;
    }
    expect(done).toBe(true);
    const expected: string[] = [];
    for (let i = 0; i < 40; i++) { expected.push(`q${i}`); expected.push(`a${i}`); }
    expect(seen).toEqual(expected);
  });
});
