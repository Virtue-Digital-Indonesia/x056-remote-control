import { appendFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
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
    expect(estimateCost(usage({ 'claude-opus-5': { output: 1e6 } })).usd).toBeCloseTo(25);
    expect(estimateCost(usage({ 'claude-opus-5-5': { output: 1e6 } })).usd).toBeCloseTo(20);
    expect(estimateCost(usage({ 'claude-sonnet-5': { output: 1e6 } })).usd).toBeCloseTo(10);
  });

  it('charges cache reads at the model-specific rate', () => {
    expect(estimateCost(usage({ 'claude-opus-5': { cacheRead: 1e6 } })).usd).toBeCloseTo(0.5);
    expect(estimateCost(usage({ 'claude-opus-5-5': { cacheRead: 1e6 } })).usd).toBeCloseTo(0.2);
  });

  it('prices Sonnet 5.5 across all token categories at current rates', () => {
    const c = estimateCost(usage({ 'claude-sonnet-5-5': { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 } }));
    expect(c.usd).toBeCloseTo(14.6);
    expect(c.unpriced).toEqual([]);
  });

  it('prices Haiku 5.5 at its base rates, and its long-prompt tier above 100K', () => {
    const all = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 };
    expect(estimateCost(usage({ 'claude-haiku-5-5': all })).usd).toBeCloseTo(0.735);
    const long = estimateCost(usage({ 'claude-haiku-5-5-20261001 (long prompt)': all }));
    expect(long.usd).toBeCloseTo(3.675);
    expect(long.unpriced).toEqual([]);
  });

  it('files a Haiku 5.5 entry over 100K prompt tokens under the long-prompt key', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-haiku-5-5', { input_tokens: 40_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 10_000, output_tokens: 3 }) // exactly 100K: base
      + assistant('claude-haiku-5-5', { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 5 }) // 100,001: long
      + assistant('claude-opus-5-5', { cache_read_input_tokens: 500_000, output_tokens: 7 })); // no tier listed: plain
    const s = new TranscriptStatsReader(d).statsFor(f);
    expect(s.usage.byModel['claude-haiku-5-5']).toEqual({ input: 40_000, output: 3, cacheRead: 50_000, cacheWrite: 10_000 });
    expect(s.usage.byModel['claude-haiku-5-5 (long prompt)']).toEqual({ input: 1, output: 5, cacheRead: 100_000, cacheWrite: 0 });
    expect(s.usage.byModel['claude-opus-5-5'].output).toBe(7);
    expect(s.usage.output).toBe(15);
    const c = estimateCost(s.usage);
    expect(c.unpriced).toEqual([]);
    expect(c.usd).toBeCloseTo((40_000 * 0.1 + 3 * 0.5 + 50_000 * 0.01 + 10_000 * 0.125 + 1 * 0.5 + 5 * 2.5 + 100_000 * 0.05 + 500_000 * 0.2 + 7 * 20) / 1e6, 10);
  });

  it('distinguishes GPT-6.1 Sol cache reads from GPT-6 Sol', () => {
    expect(estimateCost(usage({ 'gpt-6.1-sol': { cacheRead: 1e6 } })).usd).toBeCloseTo(0.1);
    expect(estimateCost(usage({ 'gpt-6-sol': { cacheRead: 1e6 } })).usd).toBeCloseTo(0.2);
  });

  it('names an unpriced model instead of blanking the whole figure', () => {
    // One unknown model used to return null, hiding the cost of everything else.
    const c = estimateCost(usage({ 'claude-opus-5': { output: 1e6 }, 'claude-unknown-9': { output: 1e6 } }));
    expect(c.usd).toBeCloseTo(25);
    expect(c.unpriced).toEqual(['claude-unknown-9']);
  });

  it('handles a NEW model id without pricing it as free', () => {
    // A future Opus release must remain unpriced. A family match on opus/sonnet/
    // haiku must not accidentally price it, and it must be named rather than
    // silently contributing $0 to a total.
    const c = estimateCost(usage({ 'claude-opus-5': { output: 1e6 }, 'claude-opus-99': { output: 5e5 } }));
    expect(c.usd).toBeCloseTo(25);
    expect(c.unpriced).toEqual(['claude-opus-99']);
  });

  it('ignores a pseudo-model carrying no tokens, like <synthetic>', () => {
    const c = estimateCost(usage({ 'claude-opus-5': { output: 1e6 }, '<synthetic>': {} }));
    expect(c.unpriced).toEqual([]);
    expect(c.usd).toBeCloseTo(25);
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

describe('reading the cache without scanning', () => {
  // A cross-conversation total must not cold-scan 52 transcripts (587MB, ~10s).
  it('returns null for a transcript never scanned, rather than scanning it', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 100 }));
    const r = new TranscriptStatsReader(d);
    expect(r.cached(f)).toBeNull();          // untouched — no work done
    expect(r.statsFor(f).usage.output).toBe(100);
    expect(r.cached(f)!.usage.output).toBe(100); // now free
  });

  it('refuses a cached entry describing bytes that are gone', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 100 }).repeat(3));
    const r = new TranscriptStatsReader(d);
    r.statsFor(f);
    writeFileSync(f, assistant('claude-opus-5', { output_tokens: 1 })); // rotated
    expect(r.cached(f)).toBeNull();
  });

  it('returns null for a file that does not exist', () => {
    expect(new TranscriptStatsReader(dir()).cached('/nope/missing.jsonl')).toBeNull();
  });
});

describe('reading a whole transcript, across calls', () => {
  // The totals are for the WHOLE file. A capped scan that ignored the first
  // 600MB of a 627MB transcript answered a different question than the one
  // asked — but 627MB takes 10.3s at 61MB/s, which cannot happen in one
  // request. So it is read in budgeted pieces that resume where they stopped.
  const many = (n: number) => assistant('claude-opus-5', { output_tokens: 10 }).repeat(n);

  it('reaches the exact total over several budgeted calls', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, many(3000));
    const r = new TranscriptStatsReader(d);
    let s = r.statsFor(f, 1); // floored to 64KB — several calls for this file
    expect(s.partial).toBe(true);
    expect(s.usage.output).toBeLessThan(30000);
    let guard = 0;
    while (s.partial && guard++ < 500) s = r.statsFor(f, 1);
    expect(s.partial).toBe(false);
    expect(s.usage.output).toBe(30000); // every one of the 3000 messages
    expect(s.scanned).toBe(s.size);
  });

  it('counts from byte 0 even on a file past the old 32MB tail cap', () => {
    // The fixture has to CROSS that cap, or tail-capping is a no-op on it and
    // the test proves nothing — which is exactly what an earlier version of
    // this test did.
    const d = dir();
    const f = join(d, 't.jsonl');
    const filler = many(5000); // ~1MB per block
    writeFileSync(f, assistant('claude-haiku-4-5', { output_tokens: 7 }));
    for (let i = 0; i < 40; i++) appendFileSync(f, filler);
    expect(statSync(f).size).toBeGreaterThan(32 * 1024 * 1024);

    const r = new TranscriptStatsReader(d);
    let s = r.statsFor(f);
    let guard = 0;
    while (s.partial && guard++ < 200) s = r.statsFor(f);
    expect(s.partial).toBe(false);
    // The very first entry of the file, which a tail-only scan never sees.
    expect(s.usage.byModel['claude-haiku-4-5'].output).toBe(7);
    expect(s.scanned).toBe(s.size);
  }, 30000);

  it('keeps reading a file that grew while it was still catching up', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, many(1000));
    const r = new TranscriptStatsReader(d);
    r.statsFor(f, 1);
    appendFileSync(f, many(1000));
    let s = r.statsFor(f, 1);
    let guard = 0;
    while (s.partial && guard++ < 500) s = r.statsFor(f, 1);
    expect(s.usage.output).toBe(20000);
  });

  it('discards a cache written under the old tail-capped meaning', () => {
    const d = dir();
    const f = join(d, 't.jsonl');
    writeFileSync(f, many(10));
    // v1 shape: a bare map, and totals that began mid-file.
    writeFileSync(join(d, 'transcript-stats.json'), JSON.stringify({ [f]: { usage: { output: 999999 }, tasks: {}, partial: true, scanned: 1, size: 1, offset: 1 } }));
    expect(new TranscriptStatsReader(d).statsFor(f).usage.output).toBe(100);
  });
});


describe('Codex cumulative token accounting', () => {
  const event = (type:string,payload:unknown) => JSON.stringify({type,payload})+'\n';
  const tokens = (input:number,cached:number,output:number) => event('event_msg',{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:output/2}}});
  it('deduplicates cumulative snapshots, separates cache, and persists model across scans', () => {
    const d=dir(),f=join(d,'codex.jsonl');
    writeFileSync(f,event('turn_context',{model:'gpt-6-astra'})+tokens(1000,600,100)+tokens(1000,600,100));
    let r=new TranscriptStatsReader(d);
    expect(r.statsFor(f).usage).toMatchObject({input:400,cacheRead:600,output:100,messages:1});
    appendFileSync(f,tokens(1500,800,150));
    expect(r.cached(f)?.partial).toBe(true);
    r=new TranscriptStatsReader(d);
    expect(r.statsFor(f).usage.byModel['gpt-6-astra']).toEqual({input:700,cacheRead:800,output:150,cacheWrite:0});
    appendFileSync(f,event('turn_context',{model:'gpt-5.6-terra'})+tokens(1800,900,200));
    expect(r.statsFor(f).usage.byModel['gpt-5.6-terra']).toEqual({input:200,cacheRead:100,output:50,cacheWrite:0});
  });
  it('starts a new accounting segment when cumulative counters reset', () => {
    const d=dir(),f=join(d,'codex.jsonl');writeFileSync(f,tokens(100,40,10)+tokens(20,5,2));
    expect(new TranscriptStatsReader(d).statsFor(f).usage).toMatchObject({input:75,cacheRead:45,output:12});
  });
  it('uses current exact model rates including Fable 5.1 cache discounts', () => {
    const u={input:0,output:0,cacheRead:0,cacheWrite:0,messages:0,byModel:{'claude-fable-5-1':{input:0,output:0,cacheRead:1e6,cacheWrite:0},'gpt-6-astra':{input:1e6,output:1e6,cacheRead:1e6,cacheWrite:0}}};
    expect(estimateCost(u)).toEqual({usd:61.25,unpriced:[]});
  });
});

it('prices GPT-6 replacements without changing the listed rates of older models', () => {
  const byModel = Object.fromEntries(['gpt-6-sol','gpt-6-luna','gpt-5.6-sol','gpt-5.6-luna'].map(model => [model, { input:1e6, output:1e6, cacheRead:0, cacheWrite:0 }]));
  expect(estimateCost({input:4e6,output:4e6,cacheRead:0,cacheWrite:0,messages:4,byModel})).toEqual({usd:38,unpriced:[]});
});
