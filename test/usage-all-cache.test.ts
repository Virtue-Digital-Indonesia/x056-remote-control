import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectCosts, projectCostsIo, usageAllReport } from '../server/project-costs.js';
import { TranscriptStatsReader, estimateCost, type TokenUsage } from '../server/transcript-stats.js';
import { archivedIdentity } from '../server/archived-usage.js';
import { subagentDir, subagentFiles, transcriptIndex } from '../src/adapters/subagents.js';
import { ProjectRegistry } from '../server/projects.js';
import { SessionManager } from '../server/manager.js';

/**
 * GET /api/usage/all's caches (2026-11-04): one registry per call, the
 * subagent listing by name, a realpath memo and a per-conversation cache.
 * The figures must equal what the uncached computation (the pre-cache
 * projectCosts, kept below as `reference`) gives on the same tree.
 */

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const S4 = '44444444-4444-4444-8444-444444444444';
const S5 = '55555555-5555-4555-8555-555555555555';

const line = (model: string, input: number, output: number) => JSON.stringify({
  type: 'assistant',
  message: { model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] },
}) + '\n';

afterEach(() => vi.restoreAllMocks());

function tree() {
  const d = mkdtempSync(join(tmpdir(), 'usage-all-'));
  const shared = join(d, 'shared', 'projects');
  const a = join(shared, '-proj-a'), b = join(shared, '-proj-b'), c = join(shared, '-proj-c');
  for (const p of [a, b, c]) mkdirSync(p, { recursive: true });
  // Three accounts, one projects/ tree.
  const configDirs = ['c1', 'c2', 'c3'].map((n) => { const dir = join(d, n); mkdirSync(dir); symlinkSync(shared, join(dir, 'projects')); return dir; });
  writeFileSync(join(a, `${S1}.jsonl`), line('claude-opus-5', 100, 10));
  mkdirSync(join(a, S1, 'subagents'), { recursive: true });
  writeFileSync(join(a, S1, 'subagents', 'agent-x1.jsonl'), line('claude-sonnet-5', 20, 2));
  writeFileSync(join(a, S1, 'subagents', 'agent-x1.meta.json'), '{"agentType":"explorer"}');
  writeFileSync(join(a, S1, 'subagents', 'agent-x2.jsonl'), line('claude-sonnet-5', 30, 3));
  writeFileSync(join(a, `${S2}.jsonl`), line('claude-sonnet-5', 40, 4));
  mkdirSync(join(a, S2)); // a session dir with no subagents/
  // A relinked conversation: transcript and its session dir are symlinks into another project dir.
  writeFileSync(join(c, `${S4}.jsonl`), line('claude-opus-5', 50, 5));
  mkdirSync(join(c, S4, 'subagents'), { recursive: true });
  writeFileSync(join(c, S4, 'subagents', 'agent-r1.jsonl'), line('claude-opus-5', 60, 6));
  symlinkSync(join(c, `${S4}.jsonl`), join(b, `${S4}.jsonl`));
  symlinkSync(join(c, S4), join(b, S4));
  const state = join(d, 'state'); mkdirSync(state);
  const stats = new TranscriptStatsReader(state);
  // Archived evidence for a subagent of S2 whose transcript is gone.
  const usage: TokenUsage = { input: 70, output: 7, cacheRead: 0, cacheWrite: 0, messages: 1, byModel: { 'claude-opus-5': { input: 70, output: 7, cacheRead: 0, cacheWrite: 0 } } };
  stats.archives.preserve(join(a, S2, 'subagents', 'agent-gone.jsonl'), { usage, partial: false, size: 100, scanned: 100 }, 4, 'test', '2026-11-01T00:00:00.000Z');
  const projects = [
    { id: 'p1', name: 'One', conversations: [{ sessionId: S1, title: 'one' }, { sessionId: S2, title: 'two' }] },
    { id: 'p2', name: 'Two', conversations: [{ sessionId: S3, title: 'missing' }, { sessionId: S4, title: 'relinked' }, { sessionId: S5, title: 'unsent', lastMessageAt: null }] },
  ];
  const context = (_pid: string, sid: string) => ({ adapter: { id: 'claude' }, providerSessionId: sid, configDirs });
  return { d, a, c, configDirs, stats, projects, context };
}

/** The uncached computation, as projectCosts did it before the caches. */
function reference(projects: ReturnType<typeof tree>['projects'], context: ReturnType<typeof tree>['context'], stats: TranscriptStatsReader) {
  const seen = new Set<string>(), live = new Set<string>(), owners = new Map<string, number>();
  const rows = projects.flatMap((p) => p.conversations.map((c) => ({ key: `${p.id}/${c.sessionId}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, byModel: {} } as TokenUsage, agentUsd: 0, agentCount: 0, archivedRecords: 0, missing: false, unstarted: (c as { lastMessageAt?: null }).lastMessageAt === null, parent: '', sources: [] as { file: string; agent: boolean }[] })));
  const add = (to: TokenUsage, from: TokenUsage) => {
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'messages'] as const) to[k] += from[k];
    for (const [m, v] of Object.entries(from.byModel)) { const t = to.byModel[m] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; for (const k of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) t[k] += v[k]; }
  };
  let pending = 0;
  for (const row of rows) {
    const [pid, sid] = row.key.split('/');
    const { providerSessionId: id, configDirs } = context(pid, sid);
    row.parent = id; owners.set(id, (owners.get(id) || 0) + 1);
    const files: { file: string; agent: boolean }[] = [];
    const own = transcriptIndex(configDirs).get(id);
    if (own) files.push({ file: own, agent: false }); else if (!row.unstarted) row.missing = true;
    files.push(...[...subagentFiles(configDirs, id).values()].map((file) => ({ file, agent: true })));
    for (const s of files) {
      let file: string; try { file = realpathSync(s.file); } catch { row.missing = true; continue; }
      const logical = archivedIdentity(s.file)?.identity;
      if (logical) { if (live.has(logical)) continue; live.add(logical); }
      if (seen.has(file)) continue; seen.add(file); row.sources.push({ ...s, file });
    }
  }
  for (const row of rows) for (const s of row.sources) {
    const st = stats.cached(s.file); const size = statSync(s.file).size;
    if (size - (st?.scanned ?? 0) > 0) pending++;
    if (s.agent) row.agentCount++;
    if (!st) continue;
    add(row.usage, st.usage);
    if (s.agent) row.agentUsd += estimateCost(st.usage).usd;
  }
  const archivedSeen = new Set<string>();
  for (const row of rows) if (owners.get(row.parent) === 1) for (const x of stats.archives.forParent(row.parent)) {
    if (live.has(x.identity) || archivedSeen.has(x.identity)) continue;
    archivedSeen.add(x.identity); add(row.usage, x.usage); row.archivedRecords++; row.missing = true;
    if (x.agent) { row.agentCount++; row.agentUsd += estimateCost(x.usage).usd; }
  }
  return { rows: rows.map((r) => ({ key: r.key, usd: estimateCost(r.usage).usd, input: r.usage.input, output: r.usage.output, agentCount: r.agentCount, agentUsd: r.agentUsd, archivedRecords: r.archivedRecords, missing: r.missing })), pending };
}

const shape = (r: ReturnType<typeof projectCosts>) => ({
  rows: r.conversations.map((c) => ({ key: `${c.projectId}/${c.sessionId}`, usd: c.cost.usd, input: c.usage.input, output: c.usage.output, agentCount: c.agentCount, agentUsd: c.agentCost.usd, archivedRecords: c.archivedRecords, missing: c.missing })),
  pending: r.pending,
});

describe('usage/all caches', () => {
  it('gives the same figures as the uncached computation, relinked and archived conversations included', () => {
    const f = tree();
    const first = projectCosts(f.projects, f.context, new Set(), f.stats, 5000);
    expect(first.pending).toBe(0);
    const ref = reference(f.projects, f.context, f.stats);
    expect(shape(first).pending).toBe(ref.pending);
    for (const [i, row] of shape(first).rows.entries()) {
      const want = ref.rows[i];
      expect({ ...row, usd: 0, agentUsd: 0 }).toEqual({ ...want, usd: 0, agentUsd: 0 });
      expect(row.usd).toBeCloseTo(want.usd, 12);
      expect(row.agentUsd).toBeCloseTo(want.agentUsd, 12);
    }
    const byKey = Object.fromEntries(shape(first).rows.map((r) => [r.key, r]));
    expect(byKey[`p1/${S1}`]).toMatchObject({ agentCount: 2, input: 150, missing: false });
    expect(byKey[`p1/${S2}`]).toMatchObject({ agentCount: 1, archivedRecords: 1, input: 110, missing: true });
    expect(byKey[`p2/${S3}`]).toMatchObject({ missing: true, input: 0 });
    expect(byKey[`p2/${S4}`]).toMatchObject({ agentCount: 1, input: 110, missing: false });
    expect(first.totals.input).toBe(370);
    // Warm, and served from the conversation cache: still identical.
    const second = projectCosts(f.projects, f.context, new Set(), f.stats, 5000);
    expect(shape(second)).toEqual(shape(first));
    expect(second.totals).toEqual(first.totals);
  });

  it('does no per-file realpath or stat for an idle conversation on the next call, but does for a running or active one', () => {
    const f = tree();
    projectCosts(f.projects, f.context, new Set(), f.stats, 5000);
    projectCostsIo.realpath = 0; projectCostsIo.fileStat = 0;
    projectCosts(f.projects, f.context, new Set(), f.stats, 5000);
    expect(projectCostsIo).toEqual({ realpath: 0, fileStat: 0 });
    // S1 has two subagent files: a running row re-stats them (the memo still spares the realpath).
    projectCosts(f.projects, f.context, new Set([`p1/${S1}`]), f.stats, 5000);
    expect(projectCostsIo).toEqual({ realpath: 0, fileStat: 2 });
    projectCostsIo.fileStat = 0;
    projectCosts(f.projects, f.context, new Set(), f.stats, 5000, { active: new Set([`p2/${S4}`]) });
    expect(projectCostsIo.fileStat).toBe(1);
    // Past the refresh window everything is re-stat'd once.
    projectCostsIo.fileStat = 0;
    projectCosts(f.projects, f.context, new Set(), f.stats, 5000, { now: Date.now() + 11 * 60_000 });
    expect(projectCostsIo.fileStat).toBe(3);
  });

  it('picks up a growing transcript and a new subagent file', () => {
    const f = tree();
    const k = `p1/${S1}`, row = (r: ReturnType<typeof projectCosts>) => r.conversations.find((c) => `${c.projectId}/${c.sessionId}` === k)!;
    expect(row(projectCosts(f.projects, f.context, new Set(), f.stats, 5000)).usage.input).toBe(150);
    appendFileSync(join(f.a, `${S1}.jsonl`), line('claude-opus-5', 1000, 0));
    expect(row(projectCosts(f.projects, f.context, new Set(), f.stats, 5000)).usage.input).toBe(1150);
    writeFileSync(join(f.a, S1, 'subagents', 'agent-x3.jsonl'), line('claude-sonnet-5', 5, 0));
    const r = row(projectCosts(f.projects, f.context, new Set(), f.stats, 5000));
    expect(r).toMatchObject({ agentCount: 3 });
    expect(r.usage.input).toBe(1155);
    const ref = reference(f.projects, f.context, f.stats).rows.find((x) => x.key === k)!;
    expect(ref).toMatchObject({ agentCount: 3, input: 1155 });
  });

  it('subagentDir walks the shared tree once, not once per account', () => {
    const f = tree();
    expect(subagentDir(f.configDirs, S1)).toBe(join(f.configDirs[0], 'projects', '-proj-a', S1, 'subagents'));
    // Readdir order decides between the link and its target; both are the same dir.
    expect(realpathSync(subagentDir(f.configDirs, S4)!)).toBe(realpathSync(join(f.c, S4, 'subagents')));
    expect(subagentDir(f.configDirs, S4)!.startsWith(join(f.configDirs[0], 'projects'))).toBe(true);
    expect(subagentDir(f.configDirs, S3)).toBeNull();
  });

  it('loads the archive once per write, not once per conversation', () => {
    const f = tree();
    const parent = f.stats.archives.forParent(S2);
    expect(parent).toHaveLength(1);
    expect(f.stats.archives.forParent(S2)).toBe(parent); // memoized
    const usage: TokenUsage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, messages: 1, byModel: { 'claude-opus-5': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } };
    f.stats.archives.preserve(join(f.a, S2, 'subagents', 'agent-gone2.jsonl'), { usage, partial: false, size: 10, scanned: 10 }, 4, 'test', '2026-11-01T00:00:00.000Z');
    expect(f.stats.archives.forParent(S2)).toHaveLength(2);
  });

  it('parses projects.json a constant number of times per route call, however many conversations', () => {
    const run = (n: number) => {
      const root = mkdtempSync(join(tmpdir(), 'usage-all-reg-')), stateDir = join(root, 'state');
      const reg = ProjectRegistry.load(join(stateDir, 'projects.json')), p = reg.create('Work', root);
      for (let i = 0; i < n; i++) reg.addConversation(p.id, `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `c${i}`, 'claude');
      writeFileSync(join(stateDir, 'accounts.json'), JSON.stringify({ accounts: [{ name: 'a', provider: 'claude', configDir: join(root, 'acct-a') }, { name: 'd', provider: 'codex', configDir: join(root, 'acct-d') }] }));
      const manager = new SessionManager({ stateDir, workspaceRoot: root });
      const stats = new TranscriptStatsReader(stateDir);
      const load = vi.spyOn(ProjectRegistry, 'load');
      const out = usageAllReport({ projects: manager.listProjects().projects, context: manager.historyContexts(), running: new Set(), stats, budget: 100 });
      const calls = load.mock.calls.length;
      load.mockRestore();
      expect(out.conversations).toHaveLength(n);
      return calls;
    };
    const small = run(2), large = run(12);
    expect(large).toBe(small);
    expect(small).toBeLessThanOrEqual(2);
  });

  it('historyContexts answers what historyContext does, from one registry load', () => {
    const root = mkdtempSync(join(tmpdir(), 'usage-all-ctx-')), stateDir = join(root, 'state');
    const reg = ProjectRegistry.load(join(stateDir, 'projects.json')), p = reg.create('Work', root);
    reg.addConversation(p.id, 'a', 'A', 'claude'); reg.addConversation(p.id, 'b', 'B', 'codex');
    writeFileSync(join(stateDir, 'accounts.json'), JSON.stringify({ accounts: [{ name: 'a', provider: 'claude', configDir: join(root, 'acct-a') }, { name: 'd', provider: 'codex', configDir: join(root, 'acct-d') }] }));
    const manager = new SessionManager({ stateDir, workspaceRoot: root });
    const load = vi.spyOn(ProjectRegistry, 'load');
    const ctx = manager.historyContexts();
    const got = ['a', 'b', 'a'].map((s) => ctx(p.id, s));
    expect(load).toHaveBeenCalledTimes(1);
    for (const [i, s] of ['a', 'b', 'a'].entries()) {
      const one = manager.historyContext(p.id, s);
      expect({ ...got[i], adapter: got[i].adapter.id }).toEqual({ ...one, adapter: one.adapter.id });
    }
    expect(got[1].adapter.id).toBe('codex');
  });
});
