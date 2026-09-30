import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptStatsReader } from '../server/transcript-stats.js';
import { buildTurns, claudeSubagentStatus, inTurn } from '../server/agent-tree.js';
import { ConversationJournal } from '../server/conversation-journal.js';
import { listSubagents } from '../src/adapters/subagents.js';

/**
 * "Done" must be truthful. Shapes below are copied from real transcripts
 * (a background Agent call, its launch ack, and the <task-notification> the
 * CLI delivers three ways when it ends).
 */

const dir = () => mkdtempSync(join(tmpdir(), 'x056-truth-'));
const line = (o: unknown) => JSON.stringify(o) + '\n';

const agentCall = (id: string, description: string, ts = '2026-09-30T10:00:00.000Z') => line({
  type: 'assistant', timestamp: ts,
  message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { description, run_in_background: true } }] },
});
const ack = (id: string, agentId: string, ts = '2026-09-30T10:00:01.000Z') => line({
  type: 'user', timestamp: ts,
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: `Async agent launched successfully. (This tool result is internal metadata.)\nagentId: ${agentId} (internal ID)\nThe agent is working in the background.` }] }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'x' },
});
const note = (o: { toolUseId?: string; agentId: string; status: string; result?: string; summary?: string }) =>
  `<task-notification>\n<task-id>${o.agentId}</task-id>\n${o.toolUseId ? `<tool-use-id>${o.toolUseId}</tool-use-id>\n` : ''}<status>${o.status}</status>\n<summary>${o.summary ?? 'Agent "x" finished'}</summary>\n${o.result !== undefined ? `<result>${o.result}</result>\n` : ''}</task-notification>`;
const enqueue = (text: string, ts: string) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: ts, content: text });
const attachment = (text: string, ts: string) => line({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification' } });
const userNote = (text: string, ts: string) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const syncCall = (id: string) => line({ type: 'assistant', timestamp: '2026-09-30T10:00:00Z', message: { content: [{ type: 'tool_use', id, name: 'Task', input: { description: 'sync' } }] } });
const syncResult = (id: string, text: string, isError = false) => line({
  type: 'user', timestamp: '2026-09-30T10:05:00Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] },
});

function fold(body: string) {
  const d = dir();
  const f = join(d, 't.jsonl');
  writeFileSync(f, body);
  return { d, f, tasks: new TranscriptStatsReader(d).statsFor(f).tasks };
}

describe('Claude task outcomes: async agents end at their notification, not their ack', () => {
  it('an async launch ack is NOT done; it records the agentId and no result', () => {
    const { tasks } = fold(agentCall('toolu_a', 'Explore') + ack('toolu_a', 'aaa111'));
    expect(tasks.toolu_a).toMatchObject({ done: false, async: true, agentId: 'aaa111' });
    expect(tasks.toolu_a.result).toBeUndefined();
    expect(tasks.toolu_a.outcome).toBeUndefined();
  });

  it('a completed notification makes it done, with the result and the enqueue time as its end', () => {
    const n = note({ toolUseId: 'toolu_a', agentId: 'aaa111', status: 'completed', result: 'Found 3 callers.' });
    // The same event lands three times: enqueue, attachment, user message.
    const { tasks } = fold(agentCall('toolu_a', 'Explore') + ack('toolu_a', 'aaa111')
      + enqueue(n, '2026-09-30T10:03:00.000Z') + attachment(n, '2026-09-30T10:03:00.500Z') + userNote(n, '2026-09-30T10:03:02.000Z'));
    expect(tasks.toolu_a).toMatchObject({ done: true, outcome: 'done', result: 'Found 3 callers.', endedAt: '2026-09-30T10:03:00.000Z' });
  });

  it('a notification arriving in a LATER scan completes it', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, agentCall('toolu_a', 'Explore') + ack('toolu_a', 'aaa111'));
    const r = new TranscriptStatsReader(d);
    expect(r.statsFor(f).tasks.toolu_a.done).toBe(false);
    writeFileSync(f, agentCall('toolu_a', 'Explore') + ack('toolu_a', 'aaa111') + userNote(note({ toolUseId: 'toolu_a', agentId: 'aaa111', status: 'completed', result: 'ok' }), '2026-09-30T10:09:00Z'));
    expect(r.statsFor(f).tasks.toolu_a).toMatchObject({ done: true, outcome: 'done' });
  });

  it('failed and killed are failed; stopped is stopped, matched by task-id when there is no tool-use-id', () => {
    const { tasks } = fold(
      agentCall('toolu_f', 'a') + ack('toolu_f', 'fff') + agentCall('toolu_k', 'b') + ack('toolu_k', 'kkk') + agentCall('toolu_s', 'c') + ack('toolu_s', 'sss')
      + userNote(note({ toolUseId: 'toolu_f', agentId: 'fff', status: 'failed', summary: 'Agent "a" failed: API error' }), '2026-09-30T10:01:00Z')
      + userNote(note({ toolUseId: 'toolu_k', agentId: 'kkk', status: 'killed', summary: 'Agent "b" was stopped by user' }), '2026-09-30T10:02:00Z')
      + enqueue(note({ agentId: 'sss', status: 'stopped', summary: 'No completion record was found' }), '2026-09-30T10:03:00Z'),
    );
    expect(tasks.toolu_f).toMatchObject({ done: true, outcome: 'failed', isError: true });
    expect(tasks.toolu_k).toMatchObject({ done: true, outcome: 'failed' });
    expect(tasks.toolu_s).toMatchObject({ done: true, outcome: 'stopped', endedAt: '2026-09-30T10:03:00Z' });
  });

  it('a completed notification with neither result nor summary ended without a result', () => {
    const n = '<task-notification>\n<task-id>aaa111</task-id>\n<tool-use-id>toolu_a</tool-use-id>\n<status>completed</status>\n</task-notification>';
    expect(fold(agentCall('toolu_a', 'x') + ack('toolu_a', 'aaa111') + userNote(n, '2026-09-30T10:01:00Z')).tasks.toolu_a).toMatchObject({ done: true, outcome: 'ended' });
  });

  it('a later notification of a resumed agent moves it again; a running one reopens it', () => {
    const { tasks } = fold(agentCall('toolu_a', 'x') + ack('toolu_a', 'aaa111')
      + userNote(note({ toolUseId: 'toolu_a', agentId: 'aaa111', status: 'completed', result: 'first' }), '2026-09-30T10:01:00Z')
      + userNote(note({ toolUseId: 'toolu_a', agentId: 'aaa111', status: 'running' }), '2026-09-30T10:02:00Z'));
    expect(tasks.toolu_a).toMatchObject({ done: false, outcome: 'running' });
    expect(tasks.toolu_a.endedAt).toBeUndefined();
  });

  it('ignores a notification merely QUOTED in another tool result or in the model\'s prose', () => {
    const n = note({ toolUseId: 'toolu_a', agentId: 'aaa111', status: 'completed', result: 'fake' });
    const { tasks } = fold(agentCall('toolu_a', 'x') + ack('toolu_a', 'aaa111')
      + line({ type: 'user', timestamp: '2026-09-30T10:01:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_grep', content: n }] } })
      + line({ type: 'assistant', timestamp: '2026-09-30T10:01:30Z', message: { content: [{ type: 'text', text: n }] } })
      + line({ type: 'attachment', timestamp: '2026-09-30T10:01:40Z', attachment: { type: 'edited_text_file', snippet: n } }));
    expect(tasks.toolu_a.done).toBe(false);
  });

  it('a sync Task: result = done, is_error = failed, "[Request interrupted" = stopped, empty = ended', () => {
    const { tasks } = fold(
      syncCall('t1') + syncResult('t1', 'All good.')
      + syncCall('t2') + syncResult('t2', 'boom', true)
      + syncCall('t3') + syncResult('t3', '[Request interrupted by user for tool use]', true)
      + syncCall('t4') + syncResult('t4', ''),
    );
    expect(tasks.t1).toMatchObject({ done: true, outcome: 'done' });
    expect(tasks.t2).toMatchObject({ done: true, outcome: 'failed' });
    expect(tasks.t3).toMatchObject({ done: true, outcome: 'stopped' });
    expect(tasks.t4).toMatchObject({ done: true, outcome: 'ended' });
  });
});

describe('claudeSubagentStatus', () => {
  const async_ = { done: false, async: true };
  it('the live process wins, even over no record or a parent turn that ended', () => {
    expect(claudeSubagentStatus(undefined, true, false, false)).toBe('running');
    expect(claudeSubagentStatus({ done: false }, true, false, false)).toBe('running');
  });
  it('an async agent awaiting its notification runs while fresh, without a gateway turn', () => {
    expect(claudeSubagentStatus(async_, undefined, false, true)).toBe('running');
    expect(claudeSubagentStatus(async_, undefined, false, false)).toBe('stopped');
  });
  it('a finished record is final', () => {
    for (const o of ['done', 'failed', 'stopped', 'ended'] as const) expect(claudeSubagentStatus({ done: true, outcome: o }, false, true, true)).toBe(o);
    expect(claudeSubagentStatus({ done: true, isError: true }, undefined, false, false)).toBe('failed');
  });
  it('a sync Task with no result: running inside a live turn, else stopped; no record at all is unknown', () => {
    expect(claudeSubagentStatus({ done: false }, undefined, true, true)).toBe('running');
    expect(claudeSubagentStatus({ done: false }, undefined, false, true)).toBe('stopped');
    expect(claudeSubagentStatus(undefined, undefined, false, false)).toBe('unknown');
  });
});

describe('turns', () => {
  const rows = [
    { role: 'user', ts: '2026-09-30T10:00:00.000Z', text: 'first ask', messageId: 'm1' },
    { role: 'assistant', ts: '2026-09-30T10:00:30.000Z', text: 'reply' },
    { role: 'user', ts: '2026-09-30T10:10:00.000Z', text: 'second\n\n[Agent team this turn: explorer · sonnet · high]', messageId: '' },
    { role: 'advisor', ts: '2026-09-30T10:12:00.000Z', text: 'pick' },
  ];

  it('a turn ends where the next begins; the last is open while a turn runs', () => {
    const t = buildTurns(rows, [], true);
    expect(t).toEqual([
      { n: 1, messageId: 'm1', startedAt: '2026-09-30T10:00:00.000Z', endedAt: '2026-09-30T10:10:00.000Z', prompt: 'first ask', running: false },
      { n: 2, startedAt: '2026-09-30T10:10:00.000Z', endedAt: null, prompt: 'second', running: true },
    ]);
  });

  it('the last turn ends at the first recorded end after it, else a later fallback, else stays open', () => {
    expect(buildTurns(rows, ['2026-09-30T10:05:00.000Z', '2026-09-30T10:15:00.000Z'], false)[1].endedAt).toBe('2026-09-30T10:15:00.000Z');
    expect(buildTurns(rows, [], false, '2026-09-30T10:12:00.000Z')[1].endedAt).toBe('2026-09-30T10:12:00.000Z');
    // The fallback may be the prompt's own row: that is not an end.
    expect(buildTurns(rows, [], false, '2026-09-30T10:10:00.000Z')[1].endedAt).toBeNull();
  });

  it('keeps at most the last `limit`, numbered within the window, prompts cut to ~140 chars', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ role: 'user', ts: new Date(Date.UTC(2026, 8, 30, 0, i)).toISOString(), text: 'x'.repeat(300) }));
    const t = buildTurns(many, [], false);
    expect(t).toHaveLength(50);
    expect(t[0]).toMatchObject({ n: 1, startedAt: many[10].ts });
    expect(t[0].prompt.length).toBe(140);
  });

  it('the journal records turn ends beside its rows, never as a chat row', () => {
    const state = dir();
    const j = new ConversationJournal(state);
    j.record('session_started', { projectId: 'p', sessionId: 's', displayPrompt: 'go', messageId: 'm1' }, '2026-09-30T10:00:00.000Z');
    j.record('session_done', { projectId: 'p', sessionId: 's', status: 'completed' }, '2026-09-30T10:04:00.000Z');
    const src = j.turnSource('p', 's');
    expect(src.ends).toEqual(['2026-09-30T10:04:00.000Z']);
    expect(src.rows.map((r) => r.role)).toEqual(['user']);
    expect(j.merge('p', 's', [], true).map((r) => r.role)).toEqual(['user']);
    expect(buildTurns(src.rows, src.ends, false)[0].endedAt).toBe('2026-09-30T10:04:00.000Z');
    expect(readdirSync(join(state, 'conversation-journal')).filter((f) => f.endsWith('.ends.json'))).toHaveLength(1);
  });
});

describe('inTurn', () => {
  const turn = { startedAt: '2026-09-30T10:00:00.000Z', endedAt: '2026-09-30T10:10:00.000Z' };
  const ms = (iso: string) => Date.parse(iso);
  it('includes work that started and ended inside the turn', () => {
    expect(inTurn({ startedAt: '2026-09-30T10:01:00Z', endedAt: '2026-09-30T10:02:00Z', status: 'done' }, turn)).toBe(true);
  });
  it('includes work begun earlier that ended during it, and a background agent still running', () => {
    expect(inTurn({ startedAt: ms('2026-09-30T09:00:00Z'), endedAt: ms('2026-09-30T10:05:00Z'), status: 'done' }, turn)).toBe(true);
    expect(inTurn({ startedAt: '2026-09-30T09:00:00Z', status: 'running' }, turn)).toBe(true);
  });
  it('excludes work that ended before the turn, or started after it ended', () => {
    expect(inTurn({ startedAt: '2026-09-30T09:00:00Z', endedAt: '2026-09-30T09:30:00Z', status: 'done' }, turn)).toBe(false);
    expect(inTurn({ startedAt: '2026-09-30T10:10:00Z', status: 'running' }, turn)).toBe(false);
  });
  it('falls back to updatedAt when there is no end, and an open turn has no upper bound', () => {
    expect(inTurn({ startedAt: '2026-09-30T09:00:00Z', updatedAt: ms('2026-09-30T10:00:00Z'), status: 'stopped' }, turn)).toBe(true);
    expect(inTurn({ startedAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z', status: 'done' }, { startedAt: turn.startedAt, endedAt: null })).toBe(true);
  });
});

describe('subagent meta', () => {
  it('carries the spawner\'s agentId for a nested subagent', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'x056-sub-'));
    const d = join(cfg, 'projects', '-p', 'sess', 'subagents');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'agent-child.jsonl'), '\n');
    writeFileSync(join(d, 'agent-child.meta.json'), JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_x', parentAgentId: 'af6973ae32a000a18', spawnDepth: 2 }));
    writeFileSync(join(d, 'agent-top.jsonl'), '\n');
    writeFileSync(join(d, 'agent-top.meta.json'), JSON.stringify({ agentType: 'Explore', spawnDepth: 1 }));
    const byId = Object.fromEntries(listSubagents([cfg], 'sess').map((s) => [s.agentId, s]));
    expect(byId.child.parentAgentId).toBe('af6973ae32a000a18');
    expect(byId.top.parentAgentId).toBeUndefined();
  });
});
