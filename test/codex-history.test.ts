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
