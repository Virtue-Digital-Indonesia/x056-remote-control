import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { ClaudeTransport } from '../src/persistent-transport.js';
import { CodexTransport } from '../src/persistent-codex.js';
import { configOverrides } from '../src/adapters/codex.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import type { TurnOptions } from '../src/turn.js';
import { SessionManager } from '../server/manager.js';
import { helpersOf } from '../server/projects.js';
import { JevService, JEV_POLICY, checkFork, type JevDecision } from '../server/jev.js';
import { advisorTurnLine, claudeTeamAgents, codexTeamConfig, teamInstructions, teamTurnLine } from '../server/team.js';
import { readMessageSender, stripTeamLine, withMessageSender, withTeamLine } from '../src/message-sender.js';
import { withMemoryContext } from '../src/memory-context.js';
import { withAskInstructions } from '../src/question.js';
import { cleanMemorySource } from '../server/memory-sources.js';
import { readSessionHistory } from '../server/history.js';
import { codexAdapter } from '../src/adapters/codex.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'x056-team-')); dirs.push(d); return d; };
const turn = (over: Partial<TurnOptions> = {}): TurnOptions => ({ configDir: '/cfg/a', cwd: '/w', sessionId: 's-00000001', conversationId: 's-00000001', mode: 'new', prompt: 'hi', ...over } as TurnOptions);

describe('the team tree', () => {
  it('gives Claude explorer, worker and researcher on Opus at three efforts, read-only where it should be', () => {
    const agents = JSON.parse(claudeTeamAgents());
    expect(Object.keys(agents)).toEqual(['explorer', 'explorer-low', 'explorer-high', 'worker', 'worker-low', 'worker-high', 'researcher', 'researcher-low', 'researcher-high']);
    for (const [name, a] of Object.entries(agents) as [string, { model: string; effort: string; description: string; prompt: string; disallowedTools?: string[] }][]) {
      const [role, effort = 'medium'] = name.split('-');
      expect(a).toMatchObject({ model: 'opus', effort });
      expect(a.description.length).toBeGreaterThan(40);
      // A variant is its role, with the same prompt and the same tool limits.
      expect(a.prompt).toBe(agents[role].prompt);
      expect(a.disallowedTools).toEqual(agents[role].disallowedTools);
    }
    expect(agents['worker-high'].description).toMatch(/high effort/);
    // Constant: it is process identity, so a per-turn value would respawn.
    expect(claudeTeamAgents()).toBe(claudeTeamAgents());
    // Denylist, not allowlist: an allowlist would strip quick_decision and codegraph.
    expect(agents.explorer.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(agents.researcher.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(agents.worker.disallowedTools).toBeUndefined();
    expect(agents.explorer.tools).toBeUndefined();
  });

  it('tells the main session about its team, the fork layer only when there is one, and the advisor per provider', () => {
    const claude = teamInstructions('claude', { advisor: true, forks: true });
    expect(claude).toMatch(/AGENT TEAM MODE/);
    expect(claude).toMatch(/"explorer".*"worker".*"researcher"/s);
    expect(claude).toMatch(/quick_decision/);
    expect(claude).toMatch(/Consult the advisor/);
    expect(teamInstructions('claude', { advisor: false, forks: false })).not.toMatch(/quick_decision|advisor/);
    expect(teamInstructions('codex', { advisor: true, forks: true })).toMatch(/spawn_agent: agent_type "explorer"/);
    // When, not just how: a brief that only named the roles was ignored.
    for (const provider of ['claude', 'codex'] as const) {
      const brief = teamInstructions(provider, { advisor: false, forks: false });
      expect(brief).toMatch(/Spawn instead of doing it yourself when/);
      expect(brief).toMatch(/even if earlier turns in this conversation worked alone/);
      expect(brief).toMatch(/Before the first command of a multi-step task/);
      // The per-turn pick is read from the message, else medium.
      expect(brief).toMatch(/"\[Agent team this turn: \.\.\.\]" line[\s\S]*otherwise[^.]*medium/);
    }
  });

  // Codex overrides our brief with its own "do not spawn unless the user
  // explicitly asks"; the ask must ride in every team turn's message, picker or not.
  it('Codex: an explicit ask on every team turn, with room for a solo turn', () => {
    const line = teamTurnLine('codex')!;
    expect(line).toMatch(/^\[Agent team this turn: I am asking you to delegate/);
    expect(line).toMatch(/small enough to do alone/);
    expect(line).not.toMatch(/picked by/);
    expect(line.includes('\n')).toBe(false);
    expect(teamTurnLine('claude')).toBeUndefined();
    expect(stripTeamLine(withTeamLine('deploy it', line))).toBe('deploy it');
  });

  it('names this turn\'s team model and effort in one line, per provider', () => {
    expect(teamTurnLine('codex', { model: 'gpt-6-astra', effort: 'high' }, 'jev'))
      .toMatch(/^\[Agent team this turn: I am asking you to delegate .*passing model "gpt-6-astra" and reasoning_effort "high" on every spawn_agent call \(picked by Jev\)\. If the turn is small enough to do alone .*say why in one line\.\]$/);
    expect(teamTurnLine('codex', { effort: 'xhigh' }, 'openai')).toMatch(/passing reasoning_effort "xhigh" on every spawn_agent call \(picked by OpenAI Decisions\)/);
    expect(teamTurnLine('claude', { model: 'sonnet', effort: 'high' }, 'jev'))
      .toBe('[Agent team this turn: call the Agent tool with model "sonnet" and subagent_type explorer-high, worker-high or researcher-high. Picked by Jev.]');
    // Medium is the plain names.
    expect(teamTurnLine('claude', { model: 'opus', effort: 'medium' }, 'openai'))
      .toBe('[Agent team this turn: call the Agent tool with model "opus" and subagent_type explorer, worker or researcher. Picked by OpenAI Decisions.]');
    expect(teamTurnLine('claude', { model: 'haiku', effort: 'low' })).toMatch(/explorer-low, worker-low or researcher-low/);
    // Every name the line gives exists in the definitions.
    const agents = JSON.parse(claudeTeamAgents());
    for (const e of ['low', 'medium', 'high']) for (const n of teamTurnLine('claude', { model: 'opus', effort: e })!.match(/(explorer|worker|researcher)(-\w+)?/g)!) expect(agents[n]).toBeDefined();
  });

  it('keeps the line out of every prompt the gateway reads back, and the sender marker last', () => {
    const sender = { kind: 'conversation' as const, projectId: 'p', sessionId: 's', messageId: 'm1' };
    const line = teamTurnLine('claude', { model: 'sonnet', effort: 'high' });
    const sent = withTeamLine(withMessageSender(withMemoryContext(withAskInstructions('fix the login bug'), 'ctx'), sender), line);
    expect(sent).toContain(line);
    expect(readMessageSender(sent).sender).toEqual(sender);
    expect(cleanMemorySource(sent)).toBe('fix the login bug');
    const plain = withTeamLine('fix it', line);
    expect(plain).toBe('fix it\n\n' + line);
    expect(stripTeamLine(plain)).toBe('fix it');
    // A slash command reaches the CLI byte for byte.
    expect(withTeamLine('/compact', line)).toBe('/compact');
    // History rows (what decisionContext's previousRequest is read from).
    const configDir = mkdtempSync(join(tmpdir(), 'x056-team-hist-')); dirs.push(configDir);
    mkdirSync(join(configDir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(configDir, 'projects', '-p', 'sid-team.jsonl'), [{ type: 'user', message: { role: 'user', content: sent } }, { type: 'user', message: { role: 'user', content: plain } }].map((l) => JSON.stringify(l)).join('\n') + '\n');
    const rows = readSessionHistory([configDir], 'sid-team');
    expect(rows.map((r) => r.text)).toEqual(['fix the login bug', 'fix it']);
    for (const r of rows) expect(cleanMemorySource(r.text)).not.toContain('Agent team this turn');
    const codexLine = teamTurnLine('codex', { model: 'gpt-6-astra', effort: 'high' });
    const cx = mkdtempSync(join(tmpdir(), 'x056-team-cx-')); dirs.push(cx);
    const day = join(cx, 'sessions', '2026', '09', '30'); mkdirSync(day, { recursive: true });
    writeFileSync(join(day, 'rollout-2026-09-30T00-00-00-t-team.jsonl'), JSON.stringify({ timestamp: '2026-09-30T00:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: withTeamLine('map the auth flow', codexLine) } }) + '\n');
    expect(codexAdapter.readHistory!([cx], 't-team', 10).map((r) => r.text)).toEqual(['map the auth flow']);
  });

  it('puts the agents on Claude argv and keys the process on them', () => {
    const t = new ClaudeTransport();
    const on = turn({ subagents: claudeTeamAgents() });
    const args = t.spawnSpec(on).args;
    expect(args[args.indexOf('--agents') + 1]).toBe(claudeTeamAgents());
    expect(t.spawnSpec(turn()).args).not.toContain('--agents');
    expect(t.identity(on)).not.toBe(t.identity(turn()));
  });

  it('puts the subagent effort in the Codex thread config, beside the MCP wiring', () => {
    const t = new CodexTransport();
    const lines: string[] = [];
    const st = { buf: '', ext: {} } as unknown as Parameters<CodexTransport['open']>[0];
    t.open(st, turn({ codexConfig: codexTeamConfig(), mcp: { configPath: '/m.json', command: 'node', args: ['x.mjs'], env: {} } }), (l) => lines.push(l));
    const start = lines.map((l) => JSON.parse(l)).find((m) => m.method === 'thread/start');
    expect(start.params.config).toMatchObject({ agents: { default_subagent_reasoning_effort: 'medium' }, mcp_servers: { x056: { command: 'node' } } });
    expect(t.identity(turn({ codexConfig: codexTeamConfig() }))).not.toBe(t.identity(turn()));
    // The one-shot exec path takes the same config as -c overrides.
    expect(configOverrides(codexTeamConfig())).toEqual(['-c', 'agents.default_subagent_reasoning_effort="medium"']);
  });
});

describe('helpers combine', () => {
  function fixture() {
    const dir = temp(), stateDir = join(dir, 'state');
    mkdirSync(join(stateDir, 'secrets'), { recursive: true });
    writeFileSync(join(stateDir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' }));
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    // A key makes Jev the DEFAULT picker; keep that off the network.
    (mgr as unknown as { jevService: JevService }).jevService = new JevService(stateDir, (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch);
    return { mgr, calls, dir };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('keeps the lean across other changes, and medium clears it', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, {}, p.id);
    await waitFor(() => calls.length === 1);
    const conv = () => mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.helpers;
    expect(mgr.patchHelpers(p.id, sid, { router: 'jev', lean: 'high' })).toEqual({ router: 'jev', lean: 'high' });
    expect(mgr.patchHelpers(p.id, sid, { advisor: true })).toEqual({ router: 'jev', lean: 'high', advisor: true });
    expect(mgr.patchHelpers(p.id, sid, { lean: 'medium' })).toEqual({ router: 'jev', advisor: true });
    expect(conv()).toEqual({ router: 'jev', advisor: true });
    expect(() => mgr.patchHelpers(p.id, sid, { lean: 'max' as never })).toThrow(/lean must be low, medium or high/);
    expect(() => mgr.setHelpers(p.id, sid, { lean: 'medium' as never })).toThrow(/lean must be/);
  });

  it('reads the legacy single field and replaces it on the first combined save', () => {
    expect(helpersOf({ decisionMaker: 'advisor' })).toEqual({ advisor: true });
    expect(helpersOf({ decisionMaker: 'jev' })).toEqual({ router: 'jev' });
    expect(helpersOf({ decisionMaker: 'jev', helpers: { team: true } })).toEqual({ team: true });
    expect(helpersOf(undefined)).toEqual({});
  });

  it('runs the advisor, Jev and the team on the same turn', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'opus', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(calls[0].subagents).toBeUndefined();
    const decide = vi.spyOn(mgr.jev(), 'decide').mockResolvedValue({ at: 't', sessionId: sid, provider: 'claude', notes: ['effort -> medium'], latencyMs: 1, effort: 'medium' } as JevDecision);
    expect(mgr.setHelpers(p.id, sid, { advisor: true, router: 'jev', team: true })).toEqual({ advisor: true, router: 'jev', team: true });
    const conv = mgr.listConversations(p.id).find((c) => c.sessionId === sid)!;
    expect(conv.helpers).toEqual({ advisor: true, router: 'jev', team: true });
    expect(conv.decisionMaker).toBeUndefined();
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(calls[1]).toMatchObject({ advisor: 'opus', effort: 'medium', subagents: claudeTeamAgents() });
    expect(calls[1].appendSystemPrompt).toMatch(/AGENT TEAM MODE[\s\S]*quick_decision[\s\S]*Consult the advisor/);
    await waitFor(() => !mgr.snapshot().running);
    // Off again: nothing of the team is left on the turn.
    mgr.setHelpers(p.id, sid, {});
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3);
    expect(calls[2].subagents).toBeUndefined();
    expect(calls[2].advisor).toBeUndefined();
    expect(calls[2].appendSystemPrompt).not.toMatch(/AGENT TEAM/);
  });

  it('names the picked team model/effort in the turn prompt only when the team and a picker are on', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'opus', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    const team = { model: 'sonnet', effort: 'high', base: { model: 'opus', effort: 'medium' }, pickedModel: 'sonnet', pickedEffort: 'high', modelConfidence: 0.7, effortConfidence: 0.6 };
    const decide = vi.spyOn(mgr.jev(), 'decide').mockImplementation(async (s) => ({ at: 't', sessionId: s, provider: 'claude', notes: [], latencyMs: 1, team } as JevDecision));
    // A key means a fork backend, so the line also names quick_decision.
    const line = teamTurnLine('claude', team, 'jev', { forks: true })!;
    expect(line).toMatch(/Picked by Jev\. Use quick_decision for small either-or forks/);
    const forkOnly = teamTurnLine('claude', undefined, 'jev', { forks: true })!;
    // Picker and team on: the line rides in the message; identity stays fixed.
    mgr.setHelpers(p.id, sid, { router: 'jev', team: true });
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2);
    expect(decide.mock.calls[0][1].team).toMatchObject({ baseModel: 'opus', baseEffort: 'medium' });
    expect(Object.keys(decide.mock.calls[0][1].team!.efforts)).toEqual(['low', 'medium', 'high']);
    expect(calls[1].prompt).toContain(line);
    expect(calls[1].subagents).toBe(claudeTeamAgents());
    expect(calls[1].appendSystemPrompt).not.toContain(line);
    await waitFor(() => !mgr.snapshot().running);
    // Picker without the team: no team questions, no line.
    mgr.setHelpers(p.id, sid, { router: 'jev' });
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3);
    expect(decide.mock.calls[1][1].team).toBeUndefined();
    expect(calls[2].prompt).not.toContain('Agent team this turn');
    await waitFor(() => !mgr.snapshot().running);
    // Team without a picker, or a failed pick: today's fixed medium, so no
    // pick in the line -- only the fork hint, which every Claude team turn
    // with a fork backend carries ('none' explicitly: with a keyed Jev,
    // absent now means the Jev default).
    mgr.setHelpers(p.id, sid, { team: true, router: 'none' });
    mgr.continueSession(p.id, sid, 'fourth', {});
    await waitFor(() => calls.length === 4);
    expect(calls[3].prompt).toContain(forkOnly);
    expect(calls[3].prompt).not.toContain('Picked by');
    await waitFor(() => !mgr.snapshot().running);
    decide.mockImplementation(async (s) => ({ at: 't', sessionId: s, provider: 'claude', notes: [], latencyMs: 1, error: 'Jev unreachable' } as JevDecision));
    mgr.setHelpers(p.id, sid, { router: 'jev', team: true });
    mgr.continueSession(p.id, sid, 'fifth', {});
    await waitFor(() => calls.length === 5);
    expect(calls[4].prompt).toContain(forkOnly);
    expect(calls[4].prompt).not.toContain('Picked by');
    // The hint is stripped on read-back like the rest of the line.
    expect(cleanMemorySource(calls[4].prompt)).toBe('fifth');
  });

  it('Claude fork hint: only with the team on AND a fork backend', () => {
    expect(teamTurnLine('claude')).toBeUndefined();
    expect(teamTurnLine('claude', undefined, 'jev', { forks: true })).toBe('[Agent team this turn: delegate the legwork to explorer, worker and researcher as the team brief says. Use quick_decision for small either-or forks (which file, which tool, retry or stop).]');
    // Codex already uses the fork layer; its line is unchanged.
    expect(teamTurnLine('codex', undefined, 'jev', { forks: true })).toBe(teamTurnLine('codex'));
  });

  // Claude Code's advisor is model-driven; a per-turn line says when to use it.
  it('Claude advisor: one line on every advisor turn, stripped wherever prompts are read back', async () => {
    expect(advisorTurnLine('codex')).toBeUndefined();
    const line = advisorTurnLine('claude')!;
    expect(line).toMatch(/^\[Advisor on: consult it before committing to an approach on multi-step work, when stuck, and before declaring done\.\]$/);
    const sender = { kind: 'conversation' as const, projectId: 'p', sessionId: 's', messageId: 'm1' };
    const both = withTeamLine(withTeamLine(withMessageSender(withMemoryContext('fix it', 'ctx'), sender), teamTurnLine('claude', { model: 'opus', effort: 'high' })), line);
    expect(readMessageSender(both).sender).toEqual(sender);
    expect(cleanMemorySource(both)).toBe('fix it');
    expect(stripTeamLine('fix it\n\n' + line)).toBe('fix it');
    expect(stripTeamLine(withTeamLine(withTeamLine('fix it', line), teamTurnLine('codex')))).toBe('fix it');
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'opus', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(calls[0].prompt).not.toContain('[Advisor on:');
    mgr.setHelpers(p.id, sid, { advisor: true, router: 'none' });
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(calls[1].prompt).toContain(line);
    expect(calls[1].appendSystemPrompt).not.toContain('[Advisor on:');
    expect(cleanMemorySource(calls[1].prompt)).toBe('second');
    // A slash command reaches the CLI byte for byte, team line or not.
    mgr.setHelpers(p.id, sid, { advisor: true, team: true, router: 'none' });
    mgr.continueSession(p.id, sid, '/compact', {});
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    expect(calls[2].prompt).toBe('/compact');
    // History rows: the line never reaches what the gateway reads back.
    const configDir = mkdtempSync(join(tmpdir(), 'x056-adv-hist-')); dirs.push(configDir);
    mkdirSync(join(configDir, 'projects', '-p'), { recursive: true });
    writeFileSync(join(configDir, 'projects', '-p', 'sid-adv.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: calls[1].prompt } }) + '\n');
    expect(readSessionHistory([configDir], 'sid-adv').map((r) => r.text)).toEqual(['second']);
  });

  // Fable mains need a Fable advisor; an Opus one is silently dropped.
  it('chooses the advisor from the model the turn runs on, after the pick', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'opus', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    const decide = vi.spyOn(mgr.jev(), 'decide').mockImplementation(async (s) => ({ at: 't', sessionId: s, provider: 'claude', notes: ['model -> fable'], latencyMs: 1, model: 'fable' } as JevDecision));
    mgr.setHelpers(p.id, sid, { advisor: true, router: 'jev' });
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(calls[1]).toMatchObject({ model: 'fable', advisor: 'fable' });
    // A pick that keeps the saved Opus keeps the Opus advisor.
    decide.mockImplementation(async (s) => ({ at: 't', sessionId: s, provider: 'claude', notes: [], latencyMs: 1 } as JevDecision));
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    expect(calls[2]).toMatchObject({ model: 'opus', advisor: 'opus' });
  });

  // Codex overrides the brief unless the USER asks, so with the team on every
  // Codex turn carries the explicit ask -- with no picker too. Claude does not.
  it('asks a Codex conversation to delegate on every team turn, picker or not', async () => {
    const dir = temp(), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'd', configDir: '/cfg/d', provider: 'codex' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'd', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const p = mgr.createProject('CX', dir, 'codex');
    const sid = mgr.start('first', undefined, undefined, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(calls[0].prompt).not.toContain('Agent team this turn');
    mgr.setHelpers(p.id, sid, { team: true });
    mgr.continueSession(p.id, sid, 'deploy it', {});
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(calls[1].prompt).toContain(teamTurnLine('codex')!);
    expect(calls[1].appendSystemPrompt).not.toContain('I am asking you to delegate');
  });

  it('refuses a picker with no key, and forks without the team or a backend', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, {}, p.id);
    await waitFor(() => calls.length === 1);
    expect(() => mgr.setHelpers(p.id, sid, { router: 'decisions' })).toThrow(/No OpenAI API key/);
    await expect(mgr.forkDecision(p.id, sid, { question: 'q', options: ['a', 'b'] })).rejects.toThrow(/agent team is off/);
    mgr.setHelpers(p.id, sid, { team: true });
    await expect(mgr.forkDecision(p.id, sid, { question: 'q', options: ['a'] })).rejects.toThrow(/2 to 6/);
    vi.spyOn(mgr.jev(), 'configured').mockReturnValue(false);
    await expect(mgr.forkDecision(p.id, sid, { question: 'q', options: ['a', 'b'] })).rejects.toThrow(/Neither Jev nor OpenAI Decisions/);
  });
});

describe('Jev forks', () => {
  const answer = (choice: string, confidence: number) => (async () => new Response(JSON.stringify({ answers: { fork: { choice, confidence } }, usage: { input_tokens: 300, output_tokens: 5 } }), { status: 200 })) as unknown as typeof fetch;
  const keyed = () => { const d = temp(); mkdirSync(join(d, 'secrets')); writeFileSync(join(d, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' })); return d; };
  const input = checkFork({ question: 'Which file first?', options: ['src/auth.ts', 'README.md'] });

  it('is SHARP at the threshold and SPLIT below it, recorded and metered', async () => {
    const dir = keyed();
    const sharp = await new JevService(dir, answer('src/auth.ts', JEV_POLICY.forkSharp)).fork('s-00000001', input);
    expect(sharp).toMatchObject({ verdict: 'sharp', choice: 'src/auth.ts', backend: 'jev', inputTokens: 300 });
    const split = await new JevService(dir, answer('README.md', 0.5)).fork('s-00000001', input);
    expect(split.verdict).toBe('split');
    const jev = new JevService(dir);
    expect(jev.forks('s-00000001').map((f) => f.verdict)).toEqual(['sharp', 'split']);
    expect(jev.status().totalCalls).toBe(2);
  });

  it('never throws: a keyless, failing or off-list answer is a SPLIT with the reason', async () => {
    expect(await new JevService(temp()).fork('s-00000002', input)).toMatchObject({ verdict: 'split', error: 'No Jev API key configured' });
    expect(await new JevService(keyed(), answer('package.json', 0.99)).fork('s-00000002', input)).toMatchObject({ verdict: 'split', error: 'Jev gave no usable answer' });
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    expect((await new JevService(keyed(), down).fork('s-00000002', input)).error).toMatch(/Jev unreachable/);
  });

  it('checks what an agent sends', () => {
    expect(() => checkFork({ question: '', options: ['a', 'b'] })).toThrow(/question is required/);
    expect(() => checkFork({ question: 'q', options: ['a', 'a'] })).toThrow(/2 to 6/);
    expect(() => checkFork({ question: 'q', options: ['1', '2', '3', '4', '5', '6', '7'] })).toThrow(/2 to 6/);
    expect(checkFork({ question: ' q ', options: [' a ', 'b', ''] })).toEqual({ question: 'q', options: ['a', 'b'], context: undefined });
  });
});

describe('helpers ride along with a send', () => {
  function fixture() {
    const dir = temp(), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    // A key makes Jev the DEFAULT picker; keep that off the network.
    (mgr as unknown as { jevService: JevService }).jevService = new JevService(stateDir, (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch);
    return { mgr, calls, dir };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('turns helpers on for an existing conversation before its next turn, changing only those named', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'opus' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setHelpers(p.id, sid, { advisor: true });
    mgr.deliverMcpMessage(p.id, sid, 'Please split this up', { helpers: { team: true } });
    await waitFor(() => calls.length === 2);
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.helpers).toEqual({ advisor: true, team: true });
    expect(calls[1]).toMatchObject({ advisor: 'opus', subagents: claudeTeamAgents() });
    expect(() => mgr.deliverMcpMessage(p.id, sid, 'x', { helpers: { router: 'jev', bogus: true } as never })).toThrow(/unknown helper bogus/);
  });

  it('a new conversation starts with them', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const out = mgr.deliverMcpMessage(p.id, undefined, 'Start a team', { helpers: { team: true } });
    await waitFor(() => calls.length === 1);
    expect(calls[0].subagents).toBe(claudeTeamAgents());
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === out.sessionId)?.helpers).toEqual({ team: true });
  });

  it('in approval mode they apply only if the send is approved', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, {}, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    const denied = mgr.requestMcpSend(p.id, sid, 'x', { helpers: { advisor: true } });
    mgr.decideMcpApproval(denied.id, false);
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.helpers).toBeUndefined();
    const approved = mgr.requestMcpSend(p.id, sid, 'y', { helpers: { advisor: true } });
    mgr.decideMcpApproval(approved.id, true);
    await waitFor(() => calls.length === 2);
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.helpers).toEqual({ advisor: true });
  });

  it('a delegate reads and messages through x056 with no identity of its own, on its orchestrator\'s relay chain', async () => {
    const dir = temp(), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = ((o: RunSessionOptions) => { calls.push(o); return new Promise(() => {}); }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn, mcp: { command: 'node', args: ['x056-mcp.mjs'], env: { X056_URL: 'http://gw' } } } as never);
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('orchestrate', undefined, {}, p.id);
    await waitFor(() => calls.length === 1);
    expect(calls[0].mcp?.env).toMatchObject({ X056_SELF_PROJECT_ID: p.id, X056_SELF_SESSION_ID: sid });
    mgr.startDelegate(p.id, sid, { role: 'backend', brief: 'A' });
    await waitFor(() => calls.length === 2);
    const env = calls[1].mcp!.env;
    expect(env).toMatchObject({ X056_URL: 'http://gw', X056_RELAY_FROM: sid, X056_DELEGATE_OF: p.id + '/' + sid });
    expect(env.X056_SELF_PROJECT_ID).toBeUndefined();
    expect(env.X056_SELF_SESSION_ID).toBeUndefined();
  });
});
