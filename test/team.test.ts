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
import { claudeTeamAgents, codexTeamConfig, teamInstructions } from '../server/team.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'x056-team-')); dirs.push(d); return d; };
const turn = (over: Partial<TurnOptions> = {}): TurnOptions => ({ configDir: '/cfg/a', cwd: '/w', sessionId: 's-00000001', conversationId: 's-00000001', mode: 'new', prompt: 'hi', ...over } as TurnOptions);

describe('the team tree', () => {
  it('gives Claude explorer, worker and researcher on Opus at medium effort, read-only where it should be', () => {
    const agents = JSON.parse(claudeTeamAgents());
    expect(Object.keys(agents)).toEqual(['explorer', 'worker', 'researcher']);
    for (const a of Object.values(agents) as { model: string; effort: string; description: string; prompt: string }[]) {
      expect(a).toMatchObject({ model: 'opus', effort: 'medium' });
      expect(a.description.length).toBeGreaterThan(40);
      expect(a.prompt.length).toBeGreaterThan(40);
    }
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
    }
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
    return { mgr: new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn }), calls, dir };
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
    return { mgr: new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn }), calls, dir };
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
