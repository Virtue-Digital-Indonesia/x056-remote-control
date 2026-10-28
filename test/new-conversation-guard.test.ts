import 'reflect-metadata';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions } from '../src/failover.js';
import { SessionManager } from '../server/manager.js';
import { ApiController } from '../server/api.controller.js';
import { ChatsController } from '../server/chats.controller.js';
import { CronScheduler } from '../server/cron.js';
import { claudeTeamAgents } from '../server/team.js';
import { requireNewConversationChoice } from '../server/new-conversation-guard.js';
import { checkNewConversationChoice } from '../scripts/x056-new-conversation.mjs';
import { TOOLS, callToolResult } from '../scripts/x056-mcp-tools.mjs';

/**
 * The owner's rule (2026-10-28): a conversation MCP creates must name its
 * provider, model, effort and whether the agent team is on.
 */

const dirs: string[] = [];
const managers: SessionManager[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const m of managers.splice(0)) m.onModuleDestroy();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CATALOG = [
  { slug: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
const CLAUDE_FULL = { provider: 'claude', model: 'opus', effort: 'high', team: true };

function fixture(opts: { spaces?: boolean } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-ncg-')); dirs.push(dir);
  const stateDir = join(dir, 'state'), work = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(work, { recursive: true });
  mkdirSync(join(dir, 'cfg-a')); mkdirSync(join(dir, 'cfg-cx'));
  // The Codex account's catalog, as its CLI caches it.
  writeFileSync(join(dir, 'cfg-cx', 'models_cache.json'), JSON.stringify({ models: CATALOG.map((m) => ({ slug: m.slug, display_name: m.slug, visibility: 'list', supported_reasoning_levels: m.efforts.map((effort) => ({ effort })) })) }));
  const reg = AccountRegistry.init(join(stateDir, 'accounts.json'), [
    { name: 'a', configDir: join(dir, 'cfg-a') },
    { name: 'cx', configDir: join(dir, 'cfg-cx'), provider: 'codex' },
  ]);
  reg.markOk('a'); reg.markOk('cx');
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [
    // Its default is Codex: a new conversation used to land there whatever model was asked for.
    { id: 'p1', name: 'Codex default', cwd: work, provider: 'codex', conversations: [{ sessionId: 'x', title: 'X', provider: 'codex' }], lastSessionId: 'x' },
  ] }));
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', sessionId: o.sessionId, finalAccount: o.adapter?.id === 'codex' ? 'cx' : 'a', failovers: 0 }; }) as unknown as typeof import('../src/failover.js').runSession;
  const manager = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn, chatEnabled: true, ...(opts.spaces ? { projectSpacesEnabled: true } : {}) });
  managers.push(manager);
  manager.setProjectAutomationPauser(() => {});
  return { dir, stateDir, work, manager, calls };
}
function controller(f: ReturnType<typeof fixture>, cron: unknown = { list: () => [] }): ApiController {
  const Ctor = ApiController as unknown as new (...args: unknown[]) => ApiController;
  return new Ctor(f.manager, f.stateDir, {}, {}, {}, {}, {}, {}, {}, {}, cron, {}, {}, {}, {});
}
const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };
const message = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(BadRequestException); return (e as Error).message; } throw new Error('expected a refusal'); };
const asyncMessage = async (p: Promise<unknown>) => { try { await p; } catch (e) { expect(e).toBeInstanceOf(BadRequestException); return (e as Error).message; } throw new Error('expected a refusal'); };

describe('the validator', () => {
  it('names each missing field and lists the valid choices', () => {
    expect(message(() => requireNewConversationChoice({}, CATALOG))).toBe(
      'New conversation needs explicit choices: missing provider, model, effort, team. provider: claude|codex. '
      + 'Claude models: fable, opus, sonnet, haiku (or a full claude-* id). Claude efforts: low, medium, high, xhigh, max, ultracode. '
      + 'Codex models (efforts): gpt-6.1-sol (low|medium|high|xhigh|max|ultra), gpt-6-luna (low|medium|high|xhigh|max). team: true|false (agent team).');
    for (const field of ['provider', 'model', 'effort', 'team'] as const) {
      const { [field]: _, ...rest } = CLAUDE_FULL;
      expect(message(() => requireNewConversationChoice(rest, CATALOG))).toContain(`needs explicit choices: missing ${field}.`);
    }
    // Only the chosen provider's lists once a provider is named.
    const claude = message(() => requireNewConversationChoice({ provider: 'claude' }, CATALOG));
    expect(claude).toContain('Claude models: fable, opus, sonnet, haiku');
    expect(claude).not.toContain('Codex models');
  });

  it('refuses empty, auto, a non-boolean team and choices that do not fit the provider', () => {
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, model: '' }, CATALOG))).toContain('missing model');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, model: 'auto', effort: 'Auto' }, CATALOG))).toContain('invalid model "auto" (pick a concrete model); effort "auto" (pick a concrete level)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, team: 'yes' }, CATALOG))).toContain('invalid team (must be true or false)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, provider: 'gemini' }, CATALOG))).toContain('invalid provider "gemini"');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, model: 'gpt-6.1-sol' }, CATALOG))).toContain('invalid model "gpt-6.1-sol" for claude');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, effort: 'ultra' }, CATALOG))).toContain('invalid effort "ultra" for claude');
    const codex = message(() => requireNewConversationChoice({ provider: 'codex', model: 'opus', effort: 'high', team: false }, CATALOG));
    expect(codex).toContain('invalid model "opus" for codex (that is a Claude model)');
    expect(codex).toContain('Codex models (efforts): gpt-6.1-sol');
    expect(codex).not.toContain('Claude models');
    expect(message(() => requireNewConversationChoice({ provider: 'codex', model: 'gpt-9-imaginary', effort: 'high', team: false }, CATALOG))).toContain('invalid model "gpt-9-imaginary" for codex');
    expect(message(() => requireNewConversationChoice({ provider: 'codex', model: 'gpt-6-luna', effort: 'ultra', team: false }, CATALOG))).toContain('invalid effort "ultra" for gpt-6-luna');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, team: undefined }, CATALOG, 'helpers.team'))).toContain('missing helpers.team. ');
  });

  it('accepts concrete choices, full Claude ids and legacy Codex ids that map forward', () => {
    expect(requireNewConversationChoice(CLAUDE_FULL, CATALOG)).toEqual(CLAUDE_FULL);
    expect(requireNewConversationChoice({ provider: 'claude', model: 'claude-opus-5-5', effort: 'ultracode', team: false }, CATALOG).model).toBe('claude-opus-5-5');
    expect(requireNewConversationChoice({ provider: 'claude', model: 'opus[1m]', effort: 'max', team: false }, CATALOG).model).toBe('opus[1m]');
    // gpt-6-sol is hidden from the picker once its successor is offered; it maps to gpt-6.1-sol.
    expect(requireNewConversationChoice({ provider: 'codex', model: 'gpt-6-sol', effort: 'ultra', team: true }, CATALOG).provider).toBe('codex');
    // No catalog cached anywhere yet: a Codex-shaped id and a generic effort pass.
    expect(requireNewConversationChoice({ provider: 'codex', model: 'gpt-7', effort: 'high', team: false }, []).model).toBe('gpt-7');
    expect(message(() => requireNewConversationChoice({ provider: 'codex', model: 'mystery', effort: 'high', team: false }, []))).toContain('no catalog cached yet');
  });

  it('the bridge-side check (no catalog) checks presence and leaves Codex membership to the gateway', () => {
    expect(checkNewConversationChoice({ provider: 'codex', model: 'gpt-anything', effort: 'whatever', team: false }).ok).toBe(true);
    const out = checkNewConversationChoice({ provider: 'codex' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toContain('Codex models and efforts: the live catalog (GET /api/models); the gateway checks them.');
  });
});

describe('send_message to a NEW conversation (/api/conversations/send without sessionId)', () => {
  it('is refused without each field, or with a model or effort that does not fit, and nothing is created', async () => {
    const f = fixture(), api = controller(f);
    const base = { projectId: 'p1', prompt: 'start', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: false } };
    for (const drop of ['provider', 'model', 'effort'] as const) {
      const { [drop]: _, ...body } = base;
      expect(await asyncMessage(api.conversationSend(body))).toContain(`missing ${drop}.`);
    }
    expect(await asyncMessage(api.conversationSend({ ...base, helpers: {} }))).toContain('missing helpers.team.');
    expect(await asyncMessage(api.conversationSend({ ...base, helpers: undefined }))).toContain('helpers.team: true|false (agent team).');
    expect(await asyncMessage(api.conversationSend({ ...base, model: 'gpt-6.1-sol' }))).toContain('invalid model "gpt-6.1-sol" for claude');
    expect(await asyncMessage(api.conversationSend({ ...base, effort: 'ultra' }))).toContain('invalid effort "ultra" for claude');
    expect(await asyncMessage(api.conversationSend({ ...base, provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultracode' }))).toContain('invalid effort "ultracode" for gpt-6.1-sol');
    expect(f.manager.listConversations('p1').map((c) => c.sessionId)).toEqual(['x']);
    expect(f.manager.listMcpApprovals()).toEqual([]);
  });

  it('auto mode: runs on the chosen provider and model, saves the effort, and the team is on for the first turn', async () => {
    const f = fixture(), api = controller(f);
    f.manager.setMcpSendMode('auto');
    const out = await api.conversationSend({ projectId: 'p1', prompt: 'build it', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true } });
    expect(out.mode).toBe('auto');
    const sid = (out as { sessionId: string }).sessionId;
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'opus', effort: 'high', subagents: claudeTeamAgents() });
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === sid)).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true } });
  });

  it('approval mode: the choice is stored on the approval and replayed when approved', async () => {
    const f = fixture(), api = controller(f);
    const out = await api.conversationSend({ projectId: 'p1', prompt: 'fresh thread', provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', helpers: { team: false } });
    expect(out.mode).toBe('approval');
    const approval = f.manager.listMcpApprovals()[0];
    expect(approval).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', helpers: { team: false } });
    expect(f.calls).toHaveLength(0);
    const decided = f.manager.decideMcpApproval(approval.id, true)!;
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('codex');
    expect(f.calls[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(f.calls[0].codexConfig).toBeUndefined();
    const conv = f.manager.listConversations('p1').find((c) => c.sessionId === decided.resultSessionId)!;
    expect(conv).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(conv.helpers?.team).toBeFalsy();
  });

  it('a Claude model in a Codex project is no longer dropped: approval replays provider claude', async () => {
    const f = fixture(), api = controller(f);
    await api.conversationSend({ projectId: 'p1', prompt: 'fresh thread', provider: 'claude', model: 'sonnet', effort: 'medium', helpers: { team: true } });
    const approval = f.manager.listMcpApprovals()[0];
    expect(approval).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'medium' });
    f.manager.decideMcpApproval(approval.id, true);
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'sonnet', effort: 'medium', subagents: claudeTeamAgents() });
  });

  it('a send to an EXISTING conversation needs none of it', async () => {
    const f = fixture(), api = controller(f);
    f.manager.setMcpSendMode('auto');
    const out = await api.conversationSend({ projectId: 'p1', sessionId: 'x', prompt: 'carry on' });
    expect(out).toMatchObject({ mode: 'auto', sessionId: 'x' });
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('codex');
  });

  it('with project spaces on, provider claude in a Work whose default is Codex (with a Codex default account) makes a Claude conversation', async () => {
    const f = fixture({ spaces: true });
    const space = f.manager.createProjectSpace({ requestId: 'ncg-space-0001', name: 'Guarded' });
    const created = f.manager.createSpaceWorkspace(space.id, { requestId: 'ncg-work-0001', name: 'Codex work', folder: 'codex-work', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'cx' });
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === created.sessionId)?.provider).toBe('codex');
    f.manager.setMcpSendMode('auto');
    const out = await controller(f).conversationSend({ projectId: created.projectId, prompt: 'a Claude task', provider: 'claude', model: 'opus', effort: 'max', helpers: { team: true } });
    const sid = (out as { sessionId: string }).sessionId;
    expect(sid).not.toBe(created.sessionId);
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'opus', effort: 'max', subagents: claudeTeamAgents() });
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === sid)).toMatchObject({ provider: 'claude', model: 'opus', effort: 'max', helpers: { team: true } });
  });
});

describe('create_chat (/api/chats)', () => {
  it('an MCP call must choose; the panel call (no marker) is unchanged; the team is applied', () => {
    const f = fixture(), chats = new ChatsController(f.manager);
    expect(message(() => chats.create({ requestId: 'ncg-chat-0001', provider: 'claude', mcp: true }))).toContain('missing model, effort, team.');
    expect(message(() => chats.create({ requestId: 'ncg-chat-0001', provider: 'codex', model: 'opus', effort: 'high', team: false, mcp: true }))).toContain('invalid model "opus" for codex');
    expect(f.manager.listProjects().projects.filter((p) => p.kind === 'chat')).toHaveLength(0);
    // The panel's dialog sends no marker and keeps working with partial choices.
    const panel = chats.create({ requestId: 'ncg-chat-panel', provider: 'claude' });
    expect(panel.kind).toBe('chat');
    const chat = chats.create({ requestId: 'ncg-chat-0002', provider: 'claude', model: 'opus', effort: 'high', team: true, mcp: true, from: 'x' });
    expect(chat.provider).toBe('claude');
    expect(f.manager.listConversations(chat.id)[0]).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true } });
    // A retry with the same requestId is the same Chat.
    expect(chats.create({ requestId: 'ncg-chat-0002', provider: 'claude', model: 'opus', effort: 'high', team: true, mcp: true }).id).toBe(chat.id);
  });
});

describe('schedule_task into a new conversation (/api/cron)', () => {
  function cronFor(f: ReturnType<typeof fixture>) {
    return new CronScheduler({ stateDir: f.stateDir, defaultTz: 'UTC',
      deliver: (pid, sid, prompt, choice) => f.manager.deliverMcpMessage(pid, sid, prompt, { sender: { kind: 'automation' },
        ...(choice ? { provider: choice.provider, model: choice.model, effort: choice.effort, helpers: { team: choice.team } } : {}) }) });
  }

  it('requires the four fields, stores them and the first run creates the conversation with them; later runs land in it', async () => {
    const f = fixture(), cron = cronFor(f), api = controller(f, cron);
    const base = { schedule: '0 9 * * *', projectId: 'p1', prompt: 'daily check', tz: 'UTC' };
    expect(message(() => api.addCron(base))).toContain('missing provider, model, effort, team.');
    expect(message(() => api.addCron({ ...base, provider: 'claude', model: 'gpt-6.1-sol', effort: 'high', team: false }))).toContain('invalid model "gpt-6.1-sol" for claude');
    expect(cron.list()).toHaveLength(0);
    // Into an existing conversation: unchanged, nothing required.
    expect(api.addCron({ ...base, sessionId: 'x' }).choice).toBeUndefined();
    const job = api.addCron({ ...base, provider: 'claude', model: 'opus', effort: 'high', team: true });
    expect(job.choice).toEqual({ provider: 'claude', model: 'opus', effort: 'high', team: true });
    cron.remove(cron.list().find((j) => j.sessionId === 'x')!.id);
    cron.tick(new Date('2030-01-01T09:00:00Z'));
    await waitFor(() => f.calls.length === 1);
    const bound = cron.list()[0].sessionId!;
    expect(bound).toBeTruthy();
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'opus', effort: 'high', subagents: claudeTeamAgents() });
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === bound)).toMatchObject({ provider: 'claude', helpers: { team: true } });
    await waitFor(() => !f.manager.snapshot().running);
    cron.tick(new Date('2030-01-02T09:00:00Z'));
    await waitFor(() => f.calls.length === 2);
    expect(f.calls[1].sessionId).toBe(bound);
  });

  it('a legacy job from before the rule (no choice stored) still runs, on the project default', async () => {
    const f = fixture();
    writeFileSync(join(f.stateDir, 'cron.json'), JSON.stringify([{ id: 'legacy01', schedule: '0 9 * * *', tz: 'UTC', projectId: 'p1', prompt: 'old job', enabled: true, createdAt: 1, runCount: 0 }]));
    const cron = cronFor(f);
    expect(cron.list()[0].choice).toBeUndefined();
    cron.tick(new Date('2030-01-01T09:00:00Z'));
    await waitFor(() => f.calls.length === 1);
    expect(cron.list()[0]).toMatchObject({ lastResult: 'delivered', runCount: 1 });
    expect(f.calls[0].adapter?.id).toBe('codex');
  });
});

describe('the MCP tools', () => {
  const schema = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>; required: string[] };
  const description = (name: string) => TOOLS.find((t) => t.name === name)!.description;

  it('list the fields, and say a new conversation requires them', () => {
    expect(schema('send_message').properties.provider.enum).toEqual(['claude', 'codex']);
    expect(schema('send_message').properties.helpers.properties).toHaveProperty('team');
    expect(description('send_message')).toContain('A NEW conversation (no sessionId) REQUIRES all four of: provider');
    expect(schema('create_chat').required).toEqual(expect.arrayContaining(['provider', 'model', 'effort', 'team']));
    for (const k of ['provider', 'model', 'effort', 'team']) expect(schema('schedule_task').properties).toHaveProperty(k);
    expect(description('schedule_task')).toContain('REQUIRES provider, model, effort and team');
  });

  it('the bridge refuses before the HTTP call with the same message', async () => {
    const api = vi.fn(async (path: string) => path === '/api/projects' ? { projects: [{ id: 'p1', kind: 'project' }] } : path === '/api/models' ? { codex: [{ slug: 'gpt-6.1-sol', efforts: ['low', 'high'] }] } : { mode: 'auto', sessionId: 'n', queued: false, messageId: 'm' });
    await expect(callToolResult(api, 'send_message', { projectId: 'p1', message: 'hi', provider: 'codex' })).rejects.toThrow(
      'New conversation needs explicit choices: missing model, effort, helpers.team. provider: claude|codex. Codex models (efforts): gpt-6.1-sol (low|high). helpers.team: true|false (agent team).');
    await expect(callToolResult(api, 'create_chat', { requestId: 'ncg-bridge-0001' })).rejects.toThrow('missing provider, model, effort, team');
    await expect(callToolResult(api, 'schedule_task', { projectId: 'p1', schedule: '0 9 * * *', prompt: 'x' })).rejects.toThrow('missing provider, model, effort, team');
    expect(api.mock.calls.some(([p]) => p === '/api/conversations/send' || p === '/api/chats' || p === '/api/cron')).toBe(false);
    // A full choice goes through, carrying the provider; an existing conversation needs nothing.
    await callToolResult(api, 'send_message', { projectId: 'p1', message: 'hi', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true } });
    const sendCall = (api.mock.calls as unknown as [string, RequestInit][]).find(([p]) => p === '/api/conversations/send')!;
    const body = JSON.parse(sendCall[1].body as string);
    expect(body).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true } });
    await callToolResult(api, 'send_message', { projectId: 'p1', sessionId: 's', message: 'more' });
    const chatApi = vi.fn(async () => ({ id: 'c1' }));
    await callToolResult(chatApi, 'create_chat', { requestId: 'ncg-bridge-0002', provider: 'claude', model: 'opus', effort: 'high', team: false });
    expect(JSON.parse((chatApi.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ mcp: true, team: false, provider: 'claude' });
  });

  it('a send into a Chat project without sessionId continues its conversation, so the bridge does not demand choices', async () => {
    const api = vi.fn(async (path: string) => path === '/api/projects' ? { projects: [{ id: 'c1', kind: 'chat' }] } : { mode: 'auto', sessionId: 'c1s', queued: false, messageId: 'm' });
    await callToolResult(api, 'send_message', { projectId: 'c1', message: 'hi' });
    expect(api.mock.calls.some(([p]) => p === '/api/conversations/send')).toBe(true);
  });
});
