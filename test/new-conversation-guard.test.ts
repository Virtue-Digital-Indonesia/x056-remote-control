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
 * provider, model, effort and whether the agent team is on, and (Efran,
 * 2026-11-04) its title.
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
const CLAUDE_FULL = { provider: 'claude', model: 'opus', effort: 'high', team: true, title: 'Login rework' };

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
      'New conversation needs explicit choices: missing provider, model, effort, team, title. provider: claude|codex. '
      + 'Claude models: fable, opus, sonnet, haiku (or a full claude-* id). Claude efforts: low, medium, high, xhigh, max, ultracode. '
      + 'Codex models (efforts): gpt-6.1-sol (low|medium|high|xhigh|max|ultra), gpt-6-luna (low|medium|high|xhigh|max). team: true|false (agent team). '
      + 'title: the conversation\'s title, 1-120 characters on one line (kept; never auto-retitled).');
    for (const field of ['provider', 'model', 'effort', 'team', 'title'] as const) {
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
    // The title: present, a string, not blank, one line, at most 120 characters.
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: '' }, CATALOG))).toContain('missing title.');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: '   ' }, CATALOG))).toContain('invalid title (empty after trimming)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: 'a'.repeat(121) }, CATALOG))).toContain('invalid title (at most 120 characters)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: 'two\nlines' }, CATALOG))).toContain('invalid title (one line, no control characters)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: 'tab\there' }, CATALOG))).toContain('invalid title (one line, no control characters)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: 42 }, CATALOG))).toContain('invalid title (must be a string)');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: undefined }, CATALOG, 'team', 'name'))).toContain('missing name. ');
    expect(message(() => requireNewConversationChoice({ ...CLAUDE_FULL, title: undefined }, CATALOG, 'team', 'name'))).toContain('name: the conversation\'s title, 1-120 characters');
  });

  it('accepts concrete choices, full Claude ids and legacy Codex ids that map forward', () => {
    expect(requireNewConversationChoice(CLAUDE_FULL, CATALOG)).toEqual(CLAUDE_FULL);
    // Trimmed; exactly 120 characters is allowed.
    expect(requireNewConversationChoice({ ...CLAUDE_FULL, title: '  Login rework  ' }, CATALOG).title).toBe('Login rework');
    expect(requireNewConversationChoice({ ...CLAUDE_FULL, title: 'a'.repeat(120) }, CATALOG).title).toHaveLength(120);
    expect(requireNewConversationChoice({ provider: 'claude', model: 'claude-opus-5-5', effort: 'ultracode', team: false, title: 'T' }, CATALOG).model).toBe('claude-opus-5-5');
    expect(requireNewConversationChoice({ provider: 'claude', model: 'opus[1m]', effort: 'max', team: false, title: 'T' }, CATALOG).model).toBe('opus[1m]');
    // gpt-6-sol is hidden from the picker once its successor is offered; it maps to gpt-6.1-sol.
    expect(requireNewConversationChoice({ provider: 'codex', model: 'gpt-6-sol', effort: 'ultra', team: true, title: 'T' }, CATALOG).provider).toBe('codex');
    // No catalog cached anywhere yet: a Codex-shaped id and a generic effort pass.
    expect(requireNewConversationChoice({ provider: 'codex', model: 'gpt-7', effort: 'high', team: false, title: 'T' }, []).model).toBe('gpt-7');
    expect(message(() => requireNewConversationChoice({ provider: 'codex', model: 'mystery', effort: 'high', team: false }, []))).toContain('no catalog cached yet');
  });

  it('the bridge-side check (no catalog) checks presence and leaves Codex membership to the gateway', () => {
    expect(checkNewConversationChoice({ provider: 'codex', model: 'gpt-anything', effort: 'whatever', team: false, title: 'T' }).ok).toBe(true);
    const out = checkNewConversationChoice({ provider: 'codex' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.message).toContain('Codex models and efforts: the live catalog (GET /api/models); the gateway checks them.');
  });
});

describe('send_message to a NEW conversation (/api/conversations/send without sessionId)', () => {
  it('is refused without each field, or with a model or effort that does not fit, and nothing is created', async () => {
    const f = fixture(), api = controller(f);
    const base = { projectId: 'p1', prompt: 'start', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: false }, title: 'Fresh start' };
    for (const drop of ['provider', 'model', 'effort', 'title'] as const) {
      const { [drop]: _, ...body } = base;
      expect(await asyncMessage(api.conversationSend(body))).toContain(`missing ${drop}.`);
    }
    expect(await asyncMessage(api.conversationSend({ ...base, helpers: {} }))).toContain('missing helpers.team.');
    expect(await asyncMessage(api.conversationSend({ ...base, helpers: undefined }))).toContain('helpers.team: true|false (agent team).');
    expect(await asyncMessage(api.conversationSend({ ...base, model: 'gpt-6.1-sol' }))).toContain('invalid model "gpt-6.1-sol" for claude');
    expect(await asyncMessage(api.conversationSend({ ...base, effort: 'ultra' }))).toContain('invalid effort "ultra" for claude');
    expect(await asyncMessage(api.conversationSend({ ...base, provider: 'codex', model: 'gpt-6.1-sol', effort: 'ultracode' }))).toContain('invalid effort "ultracode" for gpt-6.1-sol');
    expect(await asyncMessage(api.conversationSend({ ...base, title: '  ' }))).toContain('invalid title (empty after trimming)');
    expect(await asyncMessage(api.conversationSend({ ...base, title: 'x'.repeat(121) }))).toContain('invalid title (at most 120 characters)');
    expect(await asyncMessage(api.conversationSend({ ...base, title: 'line one\nline two' }))).toContain('invalid title (one line, no control characters)');
    expect(f.manager.listConversations('p1').map((c) => c.sessionId)).toEqual(['x']);
    expect(f.manager.listMcpApprovals()).toEqual([]);
  });

  it('auto mode: runs on the chosen provider and model, saves the effort, and the team is on for the first turn', async () => {
    const f = fixture(), api = controller(f);
    f.manager.setMcpSendMode('auto');
    const out = await api.conversationSend({ projectId: 'p1', prompt: 'build it', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true }, title: '  Build the login page  ' });
    expect(out.mode).toBe('auto');
    const sid = (out as { sessionId: string }).sessionId;
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'opus', effort: 'high', subagents: claudeTeamAgents() });
    expect(f.calls[0]).not.toHaveProperty('title');
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === sid)).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true }, title: 'Build the login page', titleOrigin: 'manual' });
  });

  it('approval mode: the choice is stored on the approval and replayed when approved', async () => {
    const f = fixture(), api = controller(f);
    const out = await api.conversationSend({ projectId: 'p1', prompt: 'fresh thread', provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', helpers: { team: false }, title: 'Fresh thread' });
    expect(out.mode).toBe('approval');
    const approval = f.manager.listMcpApprovals()[0];
    expect(approval).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', helpers: { team: false }, title: 'Fresh thread' });
    expect(f.calls).toHaveLength(0);
    const decided = f.manager.decideMcpApproval(approval.id, true)!;
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('codex');
    expect(f.calls[0]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(f.calls[0].codexConfig).toBeUndefined();
    const conv = f.manager.listConversations('p1').find((c) => c.sessionId === decided.resultSessionId)!;
    expect(conv).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', title: 'Fresh thread', titleOrigin: 'manual' });
    expect(conv.helpers?.team).toBeFalsy();
  });

  it('a Claude model in a Codex project is no longer dropped: approval replays provider claude', async () => {
    const f = fixture(), api = controller(f);
    await api.conversationSend({ projectId: 'p1', prompt: 'fresh thread', provider: 'claude', model: 'sonnet', effort: 'medium', helpers: { team: true }, title: 'Claude in Codex' });
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

  it('a title sent with an EXISTING conversation is ignored: never a rename', async () => {
    const f = fixture(), api = controller(f);
    f.manager.setMcpSendMode('auto');
    const out = await api.conversationSend({ projectId: 'p1', sessionId: 'x', prompt: 'carry on', title: 'Renamed by an agent' });
    expect(out).toMatchObject({ mode: 'auto', sessionId: 'x' });
    await waitFor(() => f.calls.length === 1);
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === 'x')?.title).toBe('X');
    // Approval mode does not carry it either.
    const f2 = fixture(), api2 = controller(f2);
    await api2.conversationSend({ projectId: 'p1', sessionId: 'x', prompt: 'carry on', title: 'Renamed by an agent' });
    expect(f2.manager.listMcpApprovals()[0]).not.toHaveProperty('title');
  });

  it('automatic titling never replaces the given title; a prompt-derived one stays replaceable', async () => {
    const f = fixture(), api = controller(f);
    f.manager.setMcpSendMode('auto');
    const prompt = 'Please rebuild the login page with OAuth and passkeys and keep the old session flow working';
    const named = (await api.conversationSend({ projectId: 'p1', prompt, provider: 'claude', model: 'opus', effort: 'high', helpers: { team: false }, title: 'Login rework' }) as { sessionId: string }).sessionId;
    await waitFor(() => f.calls.length === 1 && !f.manager.snapshot().running);
    f.manager.titles().observe('p1', named, prompt, 'Done: the login page now uses OAuth and passkeys.');
    expect(f.manager.titles().list('p1', named)).toEqual([]);
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === named)).toMatchObject({ title: 'Login rework', titleOrigin: 'manual' });
    // The control: a conversation started without a title (the panel's path) is temporary and gets a job.
    const plain = f.manager.start(prompt, undefined, { provider: 'claude' }, 'p1');
    await waitFor(() => f.calls.length === 2 && !f.manager.snapshot().running);
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === plain)?.titleOrigin).toBe('temporary');
    f.manager.titles().observe('p1', plain, prompt, 'Done: the login page now uses OAuth and passkeys.');
    expect(f.manager.titles().list('p1', plain).map((j) => j.mode)).toEqual(['automatic']);
  });

  it('with project spaces on, provider claude in a Work whose default is Codex (with a Codex default account) makes a Claude conversation', async () => {
    const f = fixture({ spaces: true });
    const space = f.manager.createProjectSpace({ requestId: 'ncg-space-0001', name: 'Guarded' });
    const created = f.manager.createSpaceWorkspace(space.id, { requestId: 'ncg-work-0001', name: 'Codex work', folder: 'codex-work', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', account: 'cx' });
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === created.sessionId)?.provider).toBe('codex');
    f.manager.setMcpSendMode('auto');
    const out = await controller(f).conversationSend({ projectId: created.projectId, prompt: 'a Claude task', provider: 'claude', model: 'opus', effort: 'max', helpers: { team: true }, title: 'Spaces task' });
    const sid = (out as { sessionId: string }).sessionId;
    expect(sid).not.toBe(created.sessionId);
    await waitFor(() => f.calls.length === 1);
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'opus', effort: 'max', subagents: claudeTeamAgents() });
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === sid)).toMatchObject({ provider: 'claude', model: 'opus', effort: 'max', helpers: { team: true }, title: 'Spaces task', titleOrigin: 'manual' });
    f.manager.titles().observe(created.projectId, sid, 'Please rebuild the login page with OAuth and passkeys', 'Done.');
    expect(f.manager.titles().list(created.projectId, sid)).toEqual([]);
  });

  it('with project spaces on, approval mode replays the title and a title for an existing conversation is ignored', async () => {
    const f = fixture({ spaces: true });
    const space = f.manager.createProjectSpace({ requestId: 'ncg-space-0003', name: 'Guarded' });
    const created = f.manager.createSpaceWorkspace(space.id, { requestId: 'ncg-work-0003', name: 'Claude work', folder: 'claude-work', provider: 'claude', model: 'opus', effort: 'high', account: 'a' });
    const before = f.manager.listConversations(created.projectId).find((c) => c.sessionId === created.sessionId)!.title;
    await controller(f).conversationSend({ projectId: created.projectId, prompt: 'approve me', provider: 'claude', model: 'sonnet', effort: 'medium', helpers: { team: false }, title: 'Approved title' });
    const decided = f.manager.decideMcpApproval(f.manager.listMcpApprovals()[0].id, true)!;
    await waitFor(() => f.calls.length === 1 && !f.manager.snapshot().running);
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === decided.resultSessionId)).toMatchObject({ title: 'Approved title', titleOrigin: 'manual' });
    f.manager.setMcpSendMode('auto');
    await controller(f).conversationSend({ projectId: created.projectId, sessionId: created.sessionId, prompt: 'more', title: 'Not a rename' });
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === created.sessionId)!.title).toBe(before);
  });
});

describe('a Claude conversation in a Codex Work', () => {
  it('does not leave a Claude model behind as that Work\'s default for its next Codex conversation', async () => {
    const f = fixture({ spaces: true });
    const space = f.manager.createProjectSpace({ requestId: 'ncg-space-0002', name: 'Guarded' });
    // Provider and account only: no model of its own to shadow the inherited one.
    const created = f.manager.createSpaceWorkspace(space.id, { requestId: 'ncg-work-0002', name: 'Codex work', folder: 'codex-work-2', provider: 'codex', account: 'cx' });
    f.manager.setMcpSendMode('auto');
    await controller(f).conversationSend({ projectId: created.projectId, prompt: 'a Claude task', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: false }, title: 'Claude task' });
    await waitFor(() => f.calls.length === 1 && !f.manager.snapshot().running);
    const next = f.manager.prepareProjectWork(created.projectId, { requestId: 'ncg-next-0001' });
    expect(f.manager.listConversations(created.projectId).find((c) => c.sessionId === next.sessionId)?.provider).toBe('codex');
  });
});

describe('create_chat (/api/chats)', () => {
  it('an MCP call must choose; the panel call (no marker) is unchanged; the team is applied', () => {
    const f = fixture(), chats = new ChatsController(f.manager);
    expect(message(() => chats.create({ requestId: 'ncg-chat-0001', provider: 'claude', mcp: true }))).toContain('missing model, effort, team, name.');
    expect(message(() => chats.create({ requestId: 'ncg-chat-0001', provider: 'claude', model: 'opus', effort: 'high', team: false, mcp: true }))).toContain('missing name.');
    expect(message(() => chats.create({ requestId: 'ncg-chat-0001', provider: 'claude', model: 'opus', effort: 'high', team: false, name: ' ', mcp: true }))).toContain('invalid name (empty after trimming)');
    expect(message(() => chats.create({ requestId: 'ncg-chat-0001', provider: 'codex', model: 'opus', effort: 'high', team: false, name: 'C', mcp: true }))).toContain('invalid model "opus" for codex');
    expect(f.manager.listProjects().projects.filter((p) => p.kind === 'chat')).toHaveLength(0);
    // The panel's dialog sends no marker and keeps working with partial choices.
    const panel = chats.create({ requestId: 'ncg-chat-panel', provider: 'claude' });
    expect(panel.kind).toBe('chat');
    const chat = chats.create({ requestId: 'ncg-chat-0002', provider: 'claude', model: 'opus', effort: 'high', team: true, name: '  Research notes  ', mcp: true, from: 'x' });
    expect(chat.provider).toBe('claude');
    expect(chat.name).toBe('Research notes');
    expect(f.manager.listConversations(chat.id)[0]).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true }, title: 'Research notes', titleOrigin: 'manual' });
    expect(f.manager.titlePending(chat.id, chat.lastSessionId!)).toBe(false);
    // A retry with the same requestId is the same Chat.
    expect(chats.create({ requestId: 'ncg-chat-0002', provider: 'claude', model: 'opus', effort: 'high', team: true, name: 'Research notes', mcp: true }).id).toBe(chat.id);
  });

  it('with project spaces on, an MCP Chat keeps its name as a manual title', () => {
    const f = fixture({ spaces: true }), chats = new ChatsController(f.manager);
    expect(message(() => chats.create({ requestId: 'ncg-chat-0003', provider: 'claude', model: 'opus', effort: 'high', team: false, mcp: true }))).toContain('missing name.');
    const chat = chats.create({ requestId: 'ncg-chat-0004', provider: 'claude', model: 'opus', effort: 'high', team: false, name: 'Spaces chat', mcp: true });
    expect(chat.name).toBe('Spaces chat');
    expect(f.manager.listConversations(chat.id)[0]).toMatchObject({ title: 'Spaces chat', titleOrigin: 'manual' });
  });
});

describe('schedule_task into a new conversation (/api/cron)', () => {
  function cronFor(f: ReturnType<typeof fixture>) {
    return new CronScheduler({ stateDir: f.stateDir, defaultTz: 'UTC',
      deliver: (pid, sid, prompt, choice) => f.manager.deliverMcpMessage(pid, sid, prompt, { sender: { kind: 'automation' },
        ...(choice ? { provider: choice.provider, model: choice.model, effort: choice.effort, helpers: { team: choice.team }, ...(choice.title ? { title: choice.title } : {}) } : {}) }) });
  }

  it('requires the four fields, stores them and the first run creates the conversation with them; later runs land in it', async () => {
    const f = fixture(), cron = cronFor(f), api = controller(f, cron);
    const base = { schedule: '0 9 * * *', projectId: 'p1', prompt: 'daily check', tz: 'UTC' };
    expect(message(() => api.addCron(base))).toContain('missing provider, model, effort, team, title.');
    expect(message(() => api.addCron({ ...base, provider: 'claude', model: 'opus', effort: 'high', team: false }))).toContain('missing title.');
    expect(message(() => api.addCron({ ...base, provider: 'claude', model: 'gpt-6.1-sol', effort: 'high', team: false, title: 'Daily' }))).toContain('invalid model "gpt-6.1-sol" for claude');
    expect(cron.list()).toHaveLength(0);
    // Into an existing conversation: unchanged, nothing required.
    expect(api.addCron({ ...base, sessionId: 'x' }).choice).toBeUndefined();
    expect(api.addCron({ ...base, sessionId: 'x', title: 'ignored' }).choice).toBeUndefined();
    const job = api.addCron({ ...base, provider: 'claude', model: 'opus', effort: 'high', team: true, title: 'Daily check' });
    expect(job.choice).toEqual({ provider: 'claude', model: 'opus', effort: 'high', team: true, title: 'Daily check' });
    for (const j of cron.list().filter((j) => j.sessionId === 'x')) cron.remove(j.id);
    cron.tick(new Date('2030-01-01T09:00:00Z'));
    await waitFor(() => f.calls.length === 1);
    const bound = cron.list()[0].sessionId!;
    expect(bound).toBeTruthy();
    expect(f.calls[0].adapter?.id).toBe('claude');
    expect(f.calls[0]).toMatchObject({ model: 'opus', effort: 'high', subagents: claudeTeamAgents() });
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === bound)).toMatchObject({ provider: 'claude', helpers: { team: true }, title: 'Daily check', titleOrigin: 'manual' });
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === 'x')?.title).toBe('X');
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

  it('a job stored before the title rule (choice without title) still delivers, with a prompt-derived title', async () => {
    const f = fixture();
    writeFileSync(join(f.stateDir, 'cron.json'), JSON.stringify([{ id: 'legacy02', schedule: '0 9 * * *', tz: 'UTC', projectId: 'p1', prompt: 'nightly report', enabled: true, createdAt: 1, runCount: 0,
      choice: { provider: 'claude', model: 'opus', effort: 'high', team: false } }]));
    const cron = cronFor(f);
    cron.tick(new Date('2030-01-01T09:00:00Z'));
    await waitFor(() => f.calls.length === 1);
    expect(cron.list()[0]).toMatchObject({ lastResult: 'delivered', runCount: 1 });
    expect(f.calls[0].adapter?.id).toBe('claude');
    const bound = cron.list()[0].sessionId!;
    expect(f.manager.listConversations('p1').find((c) => c.sessionId === bound)).toMatchObject({ provider: 'claude', titleOrigin: 'temporary' });
  });
});

describe('the MCP tools', () => {
  const schema = (name: string) => TOOLS.find((t) => t.name === name)!.inputSchema as { properties: Record<string, { enum?: string[]; properties?: Record<string, unknown> }>; required: string[] };
  const description = (name: string) => TOOLS.find((t) => t.name === name)!.description;

  it('list the fields, and say a new conversation requires them', () => {
    expect(schema('send_message').properties.provider.enum).toEqual(['claude', 'codex']);
    expect(schema('send_message').properties.helpers.properties).toHaveProperty('team');
    expect(description('send_message')).toContain('A NEW conversation (no sessionId) REQUIRES all five of: title');
    expect(description('send_message')).toContain('a title sent with one is ignored (never a rename)');
    expect(schema('send_message').properties).toHaveProperty('title');
    expect(schema('create_chat').required).toEqual(expect.arrayContaining(['name', 'provider', 'model', 'effort', 'team']));
    expect(description('create_chat')).toContain('REQUIRES name');
    for (const k of ['title', 'provider', 'model', 'effort', 'team']) expect(schema('schedule_task').properties).toHaveProperty(k);
    expect(description('schedule_task')).toContain('REQUIRES title, provider, model, effort and team');
  });

  it('the bridge refuses before the HTTP call with the same message', async () => {
    const api = vi.fn(async (path: string) => path === '/api/projects' ? { projects: [{ id: 'p1', kind: 'project' }] } : path === '/api/models' ? { codex: [{ slug: 'gpt-6.1-sol', efforts: ['low', 'high'] }] } : { mode: 'auto', sessionId: 'n', queued: false, messageId: 'm' });
    await expect(callToolResult(api, 'send_message', { projectId: 'p1', message: 'hi', provider: 'codex' })).rejects.toThrow(
      'New conversation needs explicit choices: missing model, effort, helpers.team, title. provider: claude|codex. Codex models (efforts): gpt-6.1-sol (low|high). helpers.team: true|false (agent team). title: the conversation\'s title, 1-120 characters on one line (kept; never auto-retitled).');
    await expect(callToolResult(api, 'send_message', { projectId: 'p1', message: 'hi', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true } })).rejects.toThrow('missing title.');
    await expect(callToolResult(api, 'create_chat', { requestId: 'ncg-bridge-0001' })).rejects.toThrow('missing provider, model, effort, team, name');
    await expect(callToolResult(api, 'create_chat', { requestId: 'ncg-bridge-0001', provider: 'claude', model: 'opus', effort: 'high', team: false })).rejects.toThrow('name: the conversation\'s title');
    await expect(callToolResult(api, 'schedule_task', { projectId: 'p1', schedule: '0 9 * * *', prompt: 'x' })).rejects.toThrow('missing provider, model, effort, team, title');
    expect(api.mock.calls.some(([p]) => p === '/api/conversations/send' || p === '/api/chats' || p === '/api/cron')).toBe(false);
    // A full choice goes through, carrying the provider; an existing conversation needs nothing.
    await callToolResult(api, 'send_message', { projectId: 'p1', message: 'hi', provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true }, title: 'Hello' });
    const sends = () => (api.mock.calls as unknown as [string, RequestInit][]).filter(([p]) => p === '/api/conversations/send').map(([, init]) => JSON.parse(init.body as string));
    expect(sends()[0]).toMatchObject({ provider: 'claude', model: 'opus', effort: 'high', helpers: { team: true }, title: 'Hello' });
    // An existing conversation: no title is forwarded, even when given.
    await callToolResult(api, 'send_message', { projectId: 'p1', sessionId: 's', message: 'more', title: 'Ignored' });
    expect(sends()[1]).not.toHaveProperty('title');
    await callToolResult(api, 'schedule_task', { projectId: 'p1', schedule: '0 9 * * *', prompt: 'x', provider: 'claude', model: 'opus', effort: 'high', team: false, title: 'Morning job' });
    const cronCall = (api.mock.calls as unknown as [string, RequestInit][]).find(([p]) => p === '/api/cron')!;
    expect(JSON.parse(cronCall[1].body as string)).toMatchObject({ provider: 'claude', title: 'Morning job' });
    const chatApi = vi.fn(async () => ({ id: 'c1' }));
    await callToolResult(chatApi, 'create_chat', { requestId: 'ncg-bridge-0002', provider: 'claude', model: 'opus', effort: 'high', team: false, name: 'Bridge chat' });
    expect(JSON.parse((chatApi.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ mcp: true, team: false, provider: 'claude', name: 'Bridge chat' });
  });

  it('a send into a Chat project without sessionId continues its conversation, so the bridge does not demand choices', async () => {
    const api = vi.fn(async (path: string) => path === '/api/projects' ? { projects: [{ id: 'c1', kind: 'chat' }] } : { mode: 'auto', sessionId: 'c1s', queued: false, messageId: 'm' });
    await callToolResult(api, 'send_message', { projectId: 'c1', message: 'hi' });
    expect(api.mock.calls.some(([p]) => p === '/api/conversations/send')).toBe(true);
  });
});
