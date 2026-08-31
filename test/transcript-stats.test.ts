import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptStatsReader, estimateCost } from '../server/transcript-stats.js';

const dir = () => mkdtempSync(join(tmpdir(), 'x056-ts-'));

const assistant = (model: string, u: Partial<Record<string, number>>) => JSON.stringify({
  type: 'assistant',
  message: { model, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u }, content: [] },
}) + '\n';

const taskCall = (id: string, description: string) => JSON.stringify({
  type: 'assistant', timestamp: '2026-01-01T00:00:00Z',
  message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id, name: 'Task', input: { description } }] },
}) + '\n';

const taskResult = (id: string, text: string, isError = false) => JSON.stringify({
  type: 'user', timestamp: '2026-01-01T00:05:00Z',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] },
}) + '\n';

describe('token totals', () => {
  it('sums usage per model, keeping cache reads separate from input', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-opus-5', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 5000 })
      + assistant('claude-sonnet-5', { output_tokens: 50, cache_creation_input_tokens: 200 }));
    const s = new TranscriptStatsReader(d).statsFor(f);
    expect(s.usage).toMatchObject({ input: 10, output: 150, cacheRead: 5000, cacheWrite: 200, messages: 2 });
    expect(s.usage.byModel['claude-opus-5'].output).toBe(100);
    expect(s.usage.byModel['claude-sonnet-5'].cacheWrite).toBe(200);
  });

  it('only reads what was appended since the last look', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 100 }));
    const r = new TranscriptStatsReader(d);
    expect(r.statsFor(f).usage.output).toBe(100);
    appendFileSync(f, assistant('claude-opus-5', { output_tokens: 25 }));
    // 125, not 225: the first 100 must not be counted twice.
    expect(r.statsFor(f).usage.output).toBe(125);
  });

  it('rescans from scratch when the file SHRANK — those bytes are gone', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 100 }).repeat(3));
    const r = new TranscriptStatsReader(d);
    expect(r.statsFor(f).usage.output).toBe(300);
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 7 }));
    expect(r.statsFor(f).usage.output).toBe(7);
  });

  it('survives a restart with its totals intact', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 42 }));
    new TranscriptStatsReader(d).statsFor(f);
    expect(new TranscriptStatsReader(d).statsFor(f).usage.output).toBe(42);
  });

  it('ignores a line that is not JSON rather than aborting the scan', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, 'not json\n' + assistant('claude-opus-5', { output_tokens: 9 }));
    expect(new TranscriptStatsReader(d).statsFor(f).usage.output).toBe(9);
  });
});

describe('Task outcomes', () => {
  it('marks a subagent done once the parent records its tool_result', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, taskCall('toolu_1', 'Mine the codebase') + taskResult('toolu_1', 'Here are the facts.'));
    const t = new TranscriptStatsReader(d).statsFor(f).tasks['toolu_1'];
    expect(t).toMatchObject({ done: true, description: 'Mine the codebase', result: 'Here are the facts.' });
    expect(t.startedAt).toBe('2026-01-01T00:00:00Z');
    expect(t.endedAt).toBe('2026-01-01T00:05:00Z');
  });

  it('leaves one with no result NOT done — that is the running/interrupted case', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, taskCall('toolu_1', 'still going'));
    expect(new TranscriptStatsReader(d).statsFor(f).tasks['toolu_1'].done).toBe(false);
  });

  it('flags a result the tool reported as an error', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, taskCall('toolu_1', 'x') + taskResult('toolu_1', 'boom', true));
    expect(new TranscriptStatsReader(d).statsFor(f).tasks['toolu_1']).toMatchObject({ done: true, isError: true });
  });

  it('completes a task whose result arrives in a LATER scan', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, taskCall('toolu_1', 'x'));
    const r = new TranscriptStatsReader(d);
    expect(r.statsFor(f).tasks['toolu_1'].done).toBe(false);
    appendFileSync(f, taskResult('toolu_1', 'done now'));
    expect(r.statsFor(f).tasks['toolu_1']).toMatchObject({ done: true, result: 'done now' });
  });

  it('does not record tool_results belonging to other tools', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, taskResult('toolu_bash', 'some file contents'));
    expect(new TranscriptStatsReader(d).statsFor(f).tasks).toEqual({});
  });
});

describe('cost estimation', () => {
  const usage = (byModel: Record<string, Partial<Record<string, number>>>) => ({
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0,
    byModel: Object.fromEntries(Object.entries(byModel).map(([m, t]) => [m, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...t }])),
  });

  it('prices output at the model rate', () => {
    expect(estimateCost(usage({ 'claude-opus-5': { output: 1e6 } })).usd).toBeCloseTo(75);
    expect(estimateCost(usage({ 'claude-sonnet-5': { output: 1e6 } })).usd).toBeCloseTo(15);
  });

  it('charges cache reads at a tenth of input', () => {
    expect(estimateCost(usage({ 'claude-opus-5': { cacheRead: 1e6 } })).usd).toBeCloseTo(1.5);
  });

  it('names an unpriced model instead of blanking the whole figure', () => {
    // One unknown model used to return null, hiding the cost of everything else.
    const c = estimateCost(usage({ 'claude-opus-5': { output: 1e6 }, 'claude-fable-5': { output: 1e6 } }));
    expect(c.usd).toBeCloseTo(75);
    expect(c.unpriced).toEqual(['claude-fable-5']);
  });

  it('ignores a pseudo-model carrying no tokens, like <synthetic>', () => {
    const c = estimateCost(usage({ 'claude-opus-5': { output: 1e6 }, '<synthetic>': {} }));
    expect(c.unpriced).toEqual([]);
    expect(c.usd).toBeCloseTo(75);
  });
});

describe('nested subagents', () => {
  // The common shape, not an edge case: in a real security scan here, 80 of 90
  // subagents were depth 2 or 3, and their tool_result sits in the transcript of
  // the SUBAGENT that spawned them. Reading only the parent reported every one
  // of them as never having returned.
  it('finds a nested Task result in the spawning subagent, not the parent', () => {
    const d = dir();
    const parent = join(d, 'parent.jsonl');
    const child = join(d, 'child.jsonl');
    // The parent spawned `outer`; `outer` in turn spawned `inner` and saw it finish.
    writeFileSync(parent, taskCall('toolu_outer', 'do the survey'));
    writeFileSync(child, taskCall('toolu_inner', 'explore one corner') + taskResult('toolu_inner', 'corner mapped'));

    const r = new TranscriptStatsReader(d);
    const ps = r.statsFor(parent);
    const cs = r.statsFor(child);

    // The parent alone cannot answer for the nested one.
    expect(ps.tasks['toolu_inner']).toBeUndefined();
    // Merging every transcript's tasks — what the endpoint does — can.
    const merged = { ...ps.tasks, ...cs.tasks };
    expect(merged['toolu_inner']).toMatchObject({ done: true, result: 'corner mapped' });
    expect(merged['toolu_outer'].done).toBe(false);
  });
});
