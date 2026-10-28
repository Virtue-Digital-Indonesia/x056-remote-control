import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import { ApiController } from '../server/api.controller.js';
import { ReadState } from '../server/read-state.js';
import { BOT_SYSTEM_NOTE, botAttention, botSystemNote, checkBotName, digestText } from '../server/bot.js';
import { DEFAULT_DEVICE_SETTINGS, deviceWants } from '../server/push.js';
import { PersistentTurns } from '../src/persistent.js';
import { botHistory, botInitialTurn, botRowKind, botRowView, ownerMessageRows, type BotTurnKind } from '../server/bot-view.js';
import { noticeFor } from '../server/notices.js';
import { findMessageReply } from '../server/message-reply.js';
import { openQuestionLine, stripTeamLine, withMessageSender, withTeamLine, readMessageSender } from '../src/message-sender.js';
import { stripAsk, parseQuestion } from '../src/question.js';
import type { HistoryEntry } from '../src/provider.js';
import type { RunSessionOptions } from '../src/failover.js';

type Result = { status: 'completed' | 'failed'; reason?: string; resultText?: string };

/** The same shape as test/bot.test.ts: Chat on, a Work project `p1` with conversations x and y, turns stubbed
 *  by `script` (each turn takes the next result, else `ok`). A ReadState is wired as in app.module. */
function fixture(script: Result[] = [], gate?: () => Promise<void>) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-botowner-'));
  const stateDir = join(dir, 'state'), work = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(work, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [{
    id: 'p1', name: 'Work', cwd: work, provider: 'claude', conversations: [{ sessionId: 'x', title: 'X' }, { sessionId: 'y', title: 'Y' }], lastSessionId: 'x',
  }] }));
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    if (gate) await gate();
    const r = script.shift() ?? { status: 'completed', resultText: 'ok' };
    return { ...r, sessionId: o.sessionId, finalAccount: 'a', failovers: 0 };
  }) as unknown as typeof import('../src/failover.js').runSession;
  const mcp = { configPath: join(stateDir, 'mcp-x056.json'), command: 'node', args: ['bridge.mjs'], env: { X056_URL: 'http://x', X056_TOKEN: 't' } };
  const manager = new SessionManager({ stateDir, workspaceRoot: dir, chatEnabled: true, runSessionFn, mcp });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  manager.subscribe((e) => events.push({ kind: e.kind, data: e.data }));
  const readState = new ReadState(stateDir, (k, d) => manager.broadcast(k, d), () => false, Date.now, (pid) => manager.bot().isBotProject(pid));
  manager.attachReadState(readState);
  manager.subscribe((e) => { if (e.kind !== 'read_state') readState.observe(e.kind, e.data); });
  return { dir, stateDir, manager, calls, events, readState, script };
}
type Fixture = ReturnType<typeof fixture>;

const cronStub = { list: () => [] };
function controller(f: Fixture): ApiController {
  const Ctor = ApiController as unknown as new (...args: unknown[]) => ApiController;
  return new Ctor(f.manager, f.stateDir, {}, {}, {}, {}, {}, {}, {}, {}, cronStub, {}, {}, {}, {});
}
const until = async (cond: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); if (!cond()) throw new Error('timed out'); };
const turnsDone = (f: Fixture, sid: string) => f.events.filter((e) => e.kind === 'session_done' && e.data.sessionId === sid).length;
const kinds = (f: Fixture, k: string) => f.events.filter((e) => e.kind === k);

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

// ---------------------------------------------------------------- the rule

const row = (over: Partial<HistoryEntry> & { role: HistoryEntry['role'] }): HistoryEntry => ({ text: '', ...over });
const user = (kind?: string, over: Partial<HistoryEntry> = {}) => row({ role: 'user', text: 'u:' + (kind ?? 'owner'), ...(kind ? { sender: { kind: kind as never } } : {}), ...over });
const reply = (text = 'r') => row({ role: 'assistant', text });
const tool = (text = 'Bash ls') => row({ role: 'action', text });
const owner = (needsYou = false, id = 't1') => row({ role: 'assistant', text: 'for you', ownerMessage: true, needsYou, messageId: 'bot-owner:' + id });
const view = (rows: HistoryEntry[], initial: BotTurnKind = '') => botRowView(rows, initial).map((r) => r.botView);

describe('bot-view: the visibility rule over history rows', () => {
  // The table is JSON so the panel's browser test can load the same rows (test/fixtures/bot-view-table.json).
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/bot-view-table.json', import.meta.url), 'utf8')) as { cases: { name: string; rows: HistoryEntry[]; expected: ('show' | 'hide')[] }[] };
  it('has the table', () => expect(cases.length).toBeGreaterThanOrEqual(20));
  for (const c of cases) it(c.name, () => expect(view(c.rows)).toEqual(c.expected));

  it('a page that starts mid-turn takes the turn kind it was handed', () => {
    expect(view([reply(), tool()], 'agent')).toEqual(['hide', 'hide']);
    expect(view([reply('a'), tool(), reply('b')], 'bot_brief')).toEqual(['hide', 'hide', 'show']);
  });

  it('labels the brief\'s reply and names the turn kind of every non-owner row; nothing is dropped', () => {
    const out = botRowView([user('bot_brief'), reply('Checking'), reply('Brief'), user('conversation'), reply('x'), user(), reply('y')]);
    expect(out).toHaveLength(7);
    expect(out.map((r) => r.botLabel)).toEqual([undefined, undefined, 'brief', undefined, undefined, undefined, undefined]);
    expect(out.map((r) => r.botTurn)).toEqual(['bot_brief', 'bot_brief', 'bot_brief', 'agent', 'agent', undefined, undefined]);
  });

  it('botRowKind keeps the panel\'s vocabulary', () => {
    expect(botRowKind(user())).toBe('trigger');
    expect(botRowKind(user('conversation', { steered: true }))).toBe('steer');
    expect(botRowKind(owner())).toBe('keep');
    expect(botRowKind(row({ role: 'advisor', text: 'x' }))).toBe('other');
    expect(botRowKind(row({ role: 'assistant', text: 'Relay checkpoint: stop.' }))).toBe('system');
  });

  it('botInitialTurn looks back for the trigger of a page that starts mid-turn', () => {
    const older = { rows: [user('conversation'), reply()], cursor: 5, done: false };
    expect(botInitialTurn([reply(), tool()], 10, false, () => older)).toBe('agent');
    expect(botInitialTurn([user(), reply()], 10, false, () => { throw new Error('not needed'); })).toBe('');
    expect(botInitialTurn([reply()], 0, true, () => { throw new Error('done'); })).toBe('');
    let reads = 0;
    expect(botInitialTurn([reply()], 10, false, () => { reads++; return { rows: [reply()], cursor: reads, done: false }; })).toBe('');
    expect(reads).toBe(3);
  });
});

describe('bot-view: owner messages come from message_owner calls in the transcript', () => {
  const call = (name: string, input: Record<string, unknown>, id = 'toolu_1') => row({ role: 'action', text: name, toolName: name, toolUseId: id, detail: JSON.stringify(input), ts: '2026-10-21T01:00:00Z' });

  it('turns a message_owner call into {assistant, ownerMessage, needsYou, bot-owner:<toolUseId>}', () => {
    const [fyi, ask, other] = ownerMessageRows([
      call('mcp__x056__message_owner', { text: 'Deploy done' }, 'toolu_a'),
      call('mcp__x056__message_owner', { text: 'Ship it?', needs_you: true, options: ['Yes', 'No'] }, 'toolu_b'),
      tool('Bash ls'),
    ]);
    expect(fyi).toMatchObject({ role: 'assistant', text: 'Deploy done', ownerMessage: true, needsYou: false, messageId: 'bot-owner:toolu_a', ts: '2026-10-21T01:00:00Z' });
    expect(ask).toMatchObject({ role: 'assistant', text: 'Ship it?', ownerMessage: true, needsYou: true, options: ['Yes', 'No'], messageId: 'bot-owner:toolu_b' });
    for (const r of [fyi, ask]) for (const k of ['detail', 'toolName', 'toolUseId']) expect(r).not.toHaveProperty(k);
    expect(other).toMatchObject({ role: 'action' });
  });

  it('notify_user is the alias, and is not shown twice next to the notice it used to leave', () => {
    const [urgent] = ownerMessageRows([call('mcp__x056__notify_user', { title: 'Down', body: 'The build broke', urgent: true })]);
    expect(urgent).toMatchObject({ ownerMessage: true, needsYou: true, text: 'Down\n\nThe build broke' });
    const old = row({ role: 'notice', text: 'Bot needs you: Down\nThe build broke', messageId: 'bot-notice:1', needsYou: true });
    const rows = ownerMessageRows([old, call('mcp__x056__notify_user', { title: 'Down', body: 'The build broke', urgent: true })]);
    expect(rows[1].role).toBe('action');
  });

  it('leaves an unreadable or empty call as the tool row it was', () => {
    expect(ownerMessageRows([row({ role: 'action', text: 'x', toolName: 'mcp__x056__message_owner', toolUseId: 't', detail: '{nope' })])[0].role).toBe('action');
    expect(ownerMessageRows([call('mcp__x056__message_owner', { text: '  ' })])[0].role).toBe('action');
  });

  it('an agent that sent a message to the Bot never reads an owner message as the reply', () => {
    // The route turns the call into an owner message; findMessageReply reads the ADAPTER's rows, which only ever hold the tool row.
    const adapterRows: HistoryEntry[] = [
      user('conversation', { sender: { kind: 'conversation', messageId: 'm1' } }),
      call('mcp__x056__message_owner', { text: 'secret for the owner' }),
      reply('This goes back to the agent.'),
    ];
    const found = findMessageReply(() => ({ rows: adapterRows, cursor: 0, done: true }), 'm1');
    expect(found.messages.map((m) => m.text)).toEqual(['This goes back to the agent.']);
    // ...while the owner's route does show it.
    expect(botHistory(adapterRows).some((r) => r.ownerMessage && r.botView === 'show')).toBe(true);
  });

  it('botHistory annotates after the transform', () => {
    const out = botHistory([user('conversation'), call('mcp__x056__message_owner', { text: 'hi' }), reply('to agent')]);
    expect(out.map((r) => [r.role, r.botView])).toEqual([['user', 'hide'], ['assistant', 'show'], ['assistant', 'hide']]);
  });
});

// ------------------------------------------------------- message_owner + questions

describe('message_owner', () => {
  it('an FYI emits bot_message, marks the Bot chat unread (done), pushes nothing and opens no question', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    const r = api.botMessage({ from: s.sessionId!, text: 'Tests are green.' });
    expect(r).toMatchObject({ ok: true, needsYou: false });
    const e = kinds(f, 'bot_message')[0];
    expect(e.data).toMatchObject({ projectId: s.projectId, sessionId: s.sessionId, text: 'Tests are green.', needsYou: false, id: r.id });
    expect(typeof e.data.at).toBe('string');
    expect(e.data).not.toHaveProperty('notice'); // not a notice kind: no push, no bell
    expect(f.readState.view(s.projectId!, s.sessionId!)).toMatchObject({ unread: true, kind: 'done' });
    expect(f.manager.listPendingQuestions()).toEqual([]);
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 0, fyi: true });
  });

  it('needs_you creates a question card with its options, urgent, and merges the next ask into a batch of two', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    api.botMessage({ from: s.sessionId!, text: 'Deploy the migration?', needsYou: true, options: ['Yes', 'Not yet'] });
    expect(f.manager.listPendingQuestions()).toHaveLength(1);
    const first = kinds(f, 'question')[0];
    expect(first.data).toMatchObject({ projectId: s.projectId, sessionId: s.sessionId, question: 'Deploy the migration?', options: ['Yes', 'Not yet'] });
    expect(first.data.notice).toMatchObject({ tier: 'urgent', category: 'needs_you', body: 'Deploy the migration?' });
    api.botMessage({ from: s.sessionId!, text: 'Also rotate the key?', needsYou: true });
    api.botMessage({ from: s.sessionId!, text: 'Also rotate the key?', needsYou: true }); // identical: once
    const pending = f.manager.listPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0].questions?.map((q) => q.question)).toEqual(['Deploy the migration?', 'Also rotate the key?']);
    expect(pending[0]).toMatchObject({ question: 'Deploy the migration?', options: ['Yes', 'Not yet'] });
    const second = kinds(f, 'question')[1];
    expect(second.data.questions).toHaveLength(2);
    expect((second.data.notice as { body: string }).body).toBe('Also rotate the key?'); // the push names the NEW ask
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 2, fyi: false }); // needs-me does not mark the chat unread
    expect(kinds(f, 'bot_message').map((e) => e.data.needsYou)).toEqual([true, true, true]);
  });

  it('refuses a caller that is not the Bot, empty text and a bad shape', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    expect(() => api.botMessage({ from: 'x', text: 'hi' })).toThrow(ForbiddenException);
    expect(() => api.botMessage({ text: 'hi' })).toThrow(ForbiddenException);
    expect(() => api.botMessage({ from: s.sessionId!, text: '  ' })).toThrow(BadRequestException);
    expect(() => api.botMessage({ from: s.sessionId!, text: 'a', needsYou: 'yes' as never })).toThrow(BadRequestException);
    expect(() => api.botMessage({ from: s.sessionId!, text: 'a', options: [1 as never] })).toThrow(BadRequestException);
    expect(kinds(f, 'bot_message')).toHaveLength(0);
  });

  it('answering the card (a human turn from the card) closes it and leaves an unrelated FYI alone', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    api.botMessage({ from: s.sessionId!, text: 'Heads up' });
    api.botMessage({ from: s.sessionId!, text: 'Ship it?', needsYou: true });
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 1, fyi: true });
    // An option-less card answered with free text: only the card's own marker says it is the answer.
    f.manager.continueSession(s.projectId!, s.sessionId!, 'yes', { answersQuestionAt: f.manager.listPendingQuestions()[0].at });
    await until(() => turnsDone(f, s.sessionId!) === 1);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ by: 'turn' });
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 0, fyi: true });
  });

  it('notify_user is an alias: urgent -> a needs-you question, else an FYI', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    expect(() => api.botNotify({ from: 'x', title: 'Hi', body: 'b' })).toThrow(ForbiddenException);
    expect(api.botNotify({ from: s.sessionId!, title: 'Deploy needs you', body: 'Approve the migration?', tier: 'urgent', link: 'https://evil.example/' })).toMatchObject({ ok: true, tier: 'urgent' });
    expect(f.manager.listPendingQuestions()[0].question).toBe('Deploy needs you\n\nApprove the migration?');
    expect(kinds(f, 'bot_notice')).toHaveLength(0);
    api.botNotify({ from: s.sessionId!, title: 'Done', body: 'Shipped.', link: '/chat/abc' });
    expect(f.manager.listPendingQuestions()).toHaveLength(1); // the FYI opened nothing
    expect(kinds(f, 'bot_message')[1].data).toMatchObject({ needsYou: false, text: 'Done\n\nShipped.\n\n/chat/abc' });
  });
});

describe('message_owner source: no second push for an item the gateway already pushed', () => {
  const pushedQuestion = { projectId: 'p1', sessionId: 'x', question: 'Run the migration?', at: '2026-10-21T00:00:00Z' };
  /** The gateway pushed an urgent notice for p1/x and the Bot's digest saw it. */
  const seeItem = (f: Fixture, pid = 'p1', sid = 'x') => {
    const n = noticeFor('question', { ...pushedQuestion, projectId: pid, sessionId: sid }, {})!;
    f.manager.bot().observe('question', { ...pushedQuestion, projectId: pid, sessionId: sid }, n);
  };
  const deviceWantsIt = (n: unknown) => deviceWants(n as never, DEFAULT_DEVICE_SETTINGS, Date.now());

  it('a needs_you with the source the digest saw: the card and needs-me exist, the notice is not pushed', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    seeItem(f);
    const r = api.botMessage({ from: s.sessionId!, text: 'x needs a migration go-ahead', needsYou: true, source: { projectId: 'p1', sessionId: 'x' } });
    expect(r).toMatchObject({ ok: true, needsYou: true, pushDeduped: true });
    expect(f.manager.listPendingQuestions().map((q) => q.question)).toEqual(['x needs a migration go-ahead']);
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 1 });
    const q = kinds(f, 'question')[0];
    expect(q.data).toMatchObject({ pushDeduped: true, question: 'x needs a migration go-ahead' });
    const notice = q.data.notice as { tier: string; category: string; screenSuppressed?: boolean };
    expect(notice).toMatchObject({ tier: 'urgent', category: 'needs_you', screenSuppressed: true });
    expect(deviceWantsIt(notice)).toBe(false);
    expect(f.readState.view(s.projectId!, s.sessionId!)).toBeDefined();
  });

  it('silent (HTTP route only, for an operator test ask) opens and counts the question without pushing; the MCP tool cannot send it', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    const r = api.botMessage({ from: s.sessionId!, text: 'Deploy check: ignore', needsYou: true, silent: true });
    expect(r).toMatchObject({ ok: true, needsYou: true, pushDeduped: true });
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 1 });
    const notice = kinds(f, 'question')[0].data.notice as { screenSuppressed?: boolean };
    expect(deviceWantsIt(notice)).toBe(false);
    const tool = (await import(String('../scripts/x056-mcp-bot.mjs')) as { BOT_TOOLS: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).BOT_TOOLS.find((t) => t.name === 'message_owner')!;
    expect(Object.keys(tool.inputSchema.properties)).not.toContain('silent');
  });

  it('without a source it pushes as before', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    seeItem(f);
    expect(api.botMessage({ from: s.sessionId!, text: 'Ship it?', needsYou: true })).toMatchObject({ pushDeduped: false });
    const q = kinds(f, 'question')[0];
    expect(q.data).not.toHaveProperty('pushDeduped');
    expect((q.data.notice as { screenSuppressed?: boolean }).screenSuppressed).toBeUndefined();
    expect(deviceWantsIt(q.data.notice)).toBe(true);
  });

  it('an unrelated, unknown or malformed source pushes (and never fails the call)', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    seeItem(f);
    for (const [i, source] of ([{ projectId: 'p1', sessionId: 'y' }, { projectId: 'nope', sessionId: 'x' }, { projectId: 7, sessionId: 'x' }, 'x', null] as unknown[]).entries()) {
      expect(api.botMessage({ from: s.sessionId!, text: 'ask ' + i, needsYou: true, source: source as never })).toMatchObject({ ok: true, pushDeduped: false });
    }
    for (const q of kinds(f, 'question')) expect(deviceWantsIt(q.data.notice)).toBe(true);
    expect(f.manager.listPendingQuestions()[0].questions).toHaveLength(5);
  });

  it('a source pushed more than 24 h ago pushes again; a fresh one inside the window does not', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-21T00:00:00Z'));
      const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
      seeItem(f);
      vi.setSystemTime(new Date('2026-10-21T23:00:00Z'));
      expect(api.botMessage({ from: s.sessionId!, text: 'inside', needsYou: true, source: { projectId: 'p1', sessionId: 'x' } }).pushDeduped).toBe(true);
      vi.setSystemTime(new Date('2026-10-22T01:00:00Z'));
      expect(api.botMessage({ from: s.sessionId!, text: 'outside', needsYou: true, source: { projectId: 'p1', sessionId: 'x' } }).pushDeduped).toBe(false);
      expect(deviceWantsIt(kinds(f, 'question')[1].data.notice)).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('an item that was never pushed (a silent suppressed notice) does not count; FYI never pushes either way', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    const n = noticeFor('question', pushedQuestion, {})!;
    f.manager.bot().observe('question', pushedQuestion, { ...n, screenSuppressed: true });
    expect(api.botMessage({ from: s.sessionId!, text: 'ask', needsYou: true, source: { projectId: 'p1', sessionId: 'x' } }).pushDeduped).toBe(false);
    seeItem(f);
    expect(api.botMessage({ from: s.sessionId!, text: 'just so you know', source: { projectId: 'p1', sessionId: 'x' } })).toMatchObject({ needsYou: false, pushDeduped: false });
    expect(kinds(f, 'bot_message').at(-1)!.data).not.toHaveProperty('notice');
  });

  it('the digest lines name each item\'s projectId and sessionId, and the persona tells the Bot to pass source', () => {
    const f = fixture(); f.manager.bot().update({ enabled: true });
    seeItem(f);
    expect(f.manager.bot().pendingDigest().lines[0]).toContain('[projectId=p1 sessionId=x]');
    expect(botSystemNote()).toContain('pass its projectId and sessionId as source so the owner is not pushed twice');
    expect(digestText(['- a'], 0)).toContain('source');
  });

  it('the tool schema carries source and the bridge sends it', async () => {
    vi.stubEnv('X056_SELF_PROJECT_ID', 'p'); vi.stubEnv('X056_SELF_SESSION_ID', 's'); vi.stubEnv('X056_BOT', '1');
    vi.resetModules();
    const m = await import('../scripts/x056-mcp-tools.mjs');
    const tool = m.listTools().find((t: { name: string }) => t.name === 'message_owner') as unknown as { inputSchema: { properties: Record<string, unknown> }; description: string };
    expect(tool.inputSchema.properties.source).toMatchObject({ type: 'object', required: ['projectId', 'sessionId'] });
    expect(tool.description).toContain('source');
    let body: Record<string, unknown> | undefined;
    await m.callToolResult(async (_p: string, o?: RequestInit) => { body = JSON.parse(String(o?.body)); return { ok: true, id: 'i', needsYou: true, pushDeduped: true }; }, 'message_owner', { text: 'q', needs_you: true, source: { projectId: 'p1', sessionId: 'x' } });
    expect(body).toEqual({ from: 's', text: 'q', needsYou: true, source: { projectId: 'p1', sessionId: 'x' } });
  });
});

describe('the Bot\'s MCP tools: message_owner', () => {
  it('is listed only in a Bot turn and posts to /api/bot/message; notify_user keeps its route', async () => {
    vi.stubEnv('X056_SELF_PROJECT_ID', 'p'); vi.stubEnv('X056_SELF_SESSION_ID', 's');
    vi.resetModules();
    const plain = await import('../scripts/x056-mcp-tools.mjs');
    expect(plain.listTools().map((t: { name: string }) => t.name)).not.toContain('message_owner');
    await expect(plain.callToolResult(async () => ({}), 'message_owner', { text: 'x' })).rejects.toThrow('only available to the Bot');
    vi.stubEnv('X056_BOT', '1');
    vi.resetModules();
    const m = await import('../scripts/x056-mcp-tools.mjs');
    expect(m.listTools().map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['message_owner', 'notify_user', 'status_overview']));
    const seen: { path: string; body?: Record<string, unknown> }[] = [];
    const api = async (path: string, opts?: RequestInit): Promise<unknown> => {
      seen.push({ path, body: typeof opts?.body === 'string' ? JSON.parse(opts.body) : undefined });
      return path === '/api/bot/message' ? { ok: true, id: 'bot-owner:1', needsYou: !!seen.at(-1)!.body!.needsYou } : { ok: true, id: 'bot-owner:2', tier: 'normal' };
    };
    const a = await m.callToolResult(api, 'message_owner', { text: 'Ship it?', needs_you: true, options: ['Yes'] });
    expect(seen[0]).toEqual({ path: '/api/bot/message', body: { from: 's', text: 'Ship it?', needsYou: true, options: ['Yes'] } });
    expect(a.structuredContent).toEqual({ ok: true, id: 'bot-owner:1', needs_you: true });
    const b = await m.callToolResult(api, 'message_owner', { text: 'FYI' });
    expect(seen[1].body).toEqual({ from: 's', text: 'FYI' });
    expect(b.structuredContent).toMatchObject({ needs_you: false });
    await m.callToolResult(api, 'notify_user', { title: 'T', body: 'B', urgent: true });
    expect(seen[2].path).toBe('/api/bot/notify');
    await expect(m.callToolResult(api, 'message_owner', {})).rejects.toThrow('Invalid tool arguments');
  });
});

// --------------------------------------------------- agent turns in the Bot chat

describe('agent messages to the Bot', () => {
  const ASK = 'Looks fine.\n<<<ASK\nquestion: Anything else?\noptions: No\n>>>';

  it('a send to the Bot is not interactive; a send to any other conversation still is', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true });
    f.manager.deliverMcpMessage(s.projectId!, s.sessionId!, 'status of the build?', { from: 'x' });
    await until(() => f.calls.length === 1);
    expect(f.calls[0].prompt).not.toContain('x056 question protocol');
    f.manager.deliverMcpMessage('p1', 'y', 'hello', { from: 'x' });
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('x056 question protocol');
  });

  it('an ASK in an agent-origin Bot turn never becomes a question card', async () => {
    const f = fixture([{ status: 'completed', resultText: ASK }]), s = f.manager.bot().update({ enabled: true });
    f.manager.deliverMcpMessage(s.projectId!, s.sessionId!, 'status?', { from: 'x', interactive: false });
    await until(() => turnsDone(f, s.sessionId!) === 1);
    expect(kinds(f, 'question')).toHaveLength(0);
    expect(f.manager.listPendingQuestions()).toEqual([]);
  });

  it('an ASK in the owner\'s own Bot turn still does', async () => {
    const f = fixture([{ status: 'completed', resultText: ASK }]), s = f.manager.bot().update({ enabled: true });
    f.manager.continueSession(s.projectId!, s.sessionId!, 'how is it going');
    await until(() => turnsDone(f, s.sessionId!) === 1);
    expect(f.manager.listPendingQuestions()).toHaveLength(1);
  });

  it('an agent turn may resolve the owner\'s open question but not open one', async () => {
    const f = fixture([{ status: 'completed', resultText: 'Resolved.\n' + ASK + '\n<<<RESOLVED>>>' }]), s = f.manager.bot().update({ enabled: true });
    controller(f).botMessage({ from: s.sessionId!, text: 'Ship it?', needsYou: true });
    f.manager.deliverMcpMessage(s.projectId!, s.sessionId!, 'the owner said yes in chat', { from: 'x', interactive: false });
    await until(() => turnsDone(f, s.sessionId!) === 1);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ by: 'resolved' });
    expect(f.manager.listPendingQuestions()).toEqual([]);
  });
});

// ---------------------------------------------- read-state gating and attention

describe('read-state for the Bot chat', () => {
  const T = (over: Record<string, unknown>) => ({ projectId: 'bot', sessionId: 'b1', ...over });
  const mk = () => {
    const published: Record<string, unknown>[] = [];
    return { rs: new ReadState(mkdtempSync(join(tmpdir(), 'x056-rs-')), (_k, d) => published.push(d), () => false, () => 1000, (pid) => pid === 'bot'), published };
  };

  it('counts only a turn the owner is meant to see: human, brief, recap', () => {
    for (const origin of ['human', 'brief', 'recap']) {
      const { rs } = mk();
      rs.observe('conversation_settled', T({ origin, status: 'completed' }));
      expect(rs.view('bot', 'b1').unread, origin).toBe(true);
    }
    for (const origin of ['relay', 'cron', 'delegate', 'advisor', 'autopilot', undefined]) {
      const { rs } = mk();
      rs.observe('conversation_settled', T({ origin, status: 'completed' }));
      rs.observe('session_done', T({ origin, status: 'failed' }));
      rs.observe('session_error', T({ origin }));
      rs.observe('delegate_report', T({ notice: { tier: 'urgent' } }));
      rs.observe('cron_failed', T({}));
      expect(rs.view('bot', 'b1').unread, String(origin)).toBe(false);
    }
  });

  it('a failed owner turn is unread; a failed agent turn is not', () => {
    const a = mk(); a.rs.observe('session_done', T({ origin: 'human', status: 'failed' }));
    expect(a.rs.view('bot', 'b1')).toMatchObject({ unread: true, kind: 'failed' });
    const b = mk(); b.rs.observe('session_done', T({ origin: 'relay', status: 'failed' }));
    expect(b.rs.view('bot', 'b1').unread).toBe(false);
  });

  it('keeps needs-me and FYI apart: a question never marks it unread, answering one never wipes an FYI', () => {
    const { rs } = mk();
    rs.observe('question', T({}));
    expect(rs.view('bot', 'b1').unread).toBe(false);
    rs.observe('bot_message', T({ needsYou: false }));
    expect(rs.view('bot', 'b1')).toMatchObject({ unread: true, kind: 'done' });
    rs.observe('question_answered', T({}));
    rs.observe('question_dismissed', T({}));
    rs.observe('session_done', T({ origin: 'human', status: 'stopped' }));
    expect(rs.view('bot', 'b1').unread).toBe(true);
    rs.observe('bot_message', T({ needsYou: true })); // the question carries a needs-you message
    expect(rs.view('bot', 'b1').noticeAt).toBeLessThanOrEqual(1000);
  });

  it('every other project keeps its old behaviour', () => {
    const { rs } = mk();
    rs.observe('question', { projectId: 'p1', sessionId: 'x' });
    expect(rs.view('p1', 'x')).toMatchObject({ unread: true, kind: 'question' });
    rs.observe('question_answered', { projectId: 'p1', sessionId: 'x' });
    expect(rs.view('p1', 'x').unread).toBe(false);
    rs.observe('conversation_settled', { projectId: 'p1', sessionId: 'x', origin: 'relay', status: 'completed' });
    expect(rs.view('p1', 'x').unread).toBe(true);
  });
});

describe('attention', () => {
  const q = (at: string, over: Record<string, unknown> = {}) => ({ at, ...over });
  it('is a pure function of the open questions and the unread state', () => {
    expect(botAttention({ questions: [], unread: false })).toEqual({ needsMe: 0, fyi: false });
    expect(botAttention({ questions: [], unread: true, unreadAt: 500 })).toEqual({ needsMe: 0, fyi: true, since: 500 });
    expect(botAttention({ questions: [q('2026-10-21T00:00:00Z')], unread: false })).toEqual({ needsMe: 1, fyi: false, since: Date.parse('2026-10-21T00:00:00Z') });
    // a batch counts each question; both kinds at once; the older moment is `since`
    expect(botAttention({ questions: [q('2026-10-21T00:00:00Z', { questions: [{}, {}, {}] })], unread: true, unreadAt: 5 })).toEqual({ needsMe: 3, fyi: true, since: 5 });
    // a stale question (3 days) is not counted
    expect(botAttention({ questions: [q('2026-10-01T00:00:00Z', { stale: true })], unread: false })).toEqual({ needsMe: 0, fyi: false });
  });

  it('is on GET /api/bot, the Bot\'s project row and the chat read, and bot_attention fires only when it changes', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    expect(api.botStatus()).toMatchObject({ enabled: true, name: 'Bot', attention: { needsMe: 0, fyi: false } });
    expect(kinds(f, 'bot_attention')).toHaveLength(0);
    api.botMessage({ from: s.sessionId!, text: 'FYI one' });
    expect(kinds(f, 'bot_attention').map((e) => [e.data.needsMe, e.data.fyi])).toEqual([[0, true]]);
    api.botMessage({ from: s.sessionId!, text: 'FYI two' }); // unchanged: no second event
    expect(kinds(f, 'bot_attention')).toHaveLength(1);
    api.botMessage({ from: s.sessionId!, text: 'Decide?', needsYou: true });
    const last = kinds(f, 'bot_attention').at(-1)!.data;
    expect(last).toMatchObject({ projectId: s.projectId, sessionId: s.sessionId, needsMe: 1, fyi: true, name: 'Bot' });
    const row = f.manager.listProjects().projects.find((p) => p.id === s.projectId)! as Record<string, unknown>;
    expect(row).toMatchObject({ bot: true, botName: 'Bot', botAttention: { needsMe: 1, fyi: true } });
    expect(f.manager.listProjects().projects.find((p) => p.id === 'p1')).not.toHaveProperty('botAttention');
    // opening the chat reads it; the card stays
    f.readState.read(s.projectId!, s.sessionId!);
    expect(kinds(f, 'bot_attention').at(-1)!.data).toMatchObject({ needsMe: 1, fyi: false });
    // dismissing it clears needs-me
    const pending = f.manager.listPendingQuestions()[0];
    f.manager.dismissPendingQuestion(s.projectId!, s.sessionId!, pending.at);
    expect(kinds(f, 'bot_attention').at(-1)!.data).toMatchObject({ needsMe: 0, fyi: false });
    expect(api.botStatus().attention).toEqual({ needsMe: 0, fyi: false });
  });

  it('an agent turn in the Bot chat leaves attention alone', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true });
    f.manager.deliverMcpMessage(s.projectId!, s.sessionId!, 'status?', { from: 'x', interactive: false });
    await until(() => turnsDone(f, s.sessionId!) === 1);
    expect(f.manager.botAttention()).toEqual({ needsMe: 0, fyi: false });
    expect(kinds(f, 'bot_attention')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------- rename

describe('renaming the Bot', () => {
  it('validates: trimmed, 1-40 characters, no control characters, no < or >', () => {
    expect(checkBotName('  Jarvis ')).toBe('Jarvis');
    expect(checkBotName('a'.repeat(40))).toHaveLength(40);
    for (const bad of ['', '   ', 'a'.repeat(41), 'Bo\nt', 'Bo\u0000t', '<b>Bot</b>', 'x>y', 7, null]) expect(() => checkBotName(bad as never), String(bad)).toThrow();
  });

  it('renames the Chat, its conversation title, the notice title, the route answers and the persona; nothing changes on a bad name', () => {
    const f = fixture(), api = controller(f);
    const on = api.botUpdate({ enabled: true });
    expect(on).toMatchObject({ name: 'Bot' });
    const pid = on.projectId!, sid = on.sessionId!;
    expect(() => api.botUpdate({ name: '<script>' })).toThrow(BadRequestException);
    expect(api.botStatus().name).toBe('Bot');
    const after = api.botUpdate({ name: '  Jarvis ' });
    expect(after).toMatchObject({ name: 'Jarvis', enabled: true, projectId: pid, attention: { needsMe: 0, fyi: false } });
    const chat = f.manager.chat(pid);
    expect(chat.name).toBe('Jarvis');
    expect(chat.conversations?.find((c) => c.sessionId === sid)?.title).toBe('Jarvis');
    expect(JSON.parse(readFileSync(join(f.stateDir, 'bot.json'), 'utf8')).name).toBe('Jarvis');
    expect(f.manager.listProjects().projects.find((p) => p.id === pid)).toMatchObject({ bot: true, botName: 'Jarvis', name: 'Jarvis' });
    // a notice about the Bot's conversation is titled with the name
    api.botMessage({ from: sid, text: 'Ship it?', needsYou: true });
    expect((kinds(f, 'question')[0].data.notice as { title: string }).title).toBe('Jarvis');
    // a restarted gateway keeps it
    expect(new SessionManager({ stateDir: f.stateDir, workspaceRoot: f.dir, chatEnabled: true }).bot().displayName()).toBe('Jarvis');
    // back to the default clears the field
    api.botUpdate({ name: 'Bot' });
    expect(JSON.parse(readFileSync(join(f.stateDir, 'bot.json'), 'utf8'))).not.toHaveProperty('name');
  });

  it('a rename given together with enabled names the new Chat', () => {
    const f = fixture(), api = controller(f);
    const s = api.botUpdate({ enabled: true, name: 'Nova' });
    expect(f.manager.chat(s.projectId!).name).toBe('Nova');
  });

  it('the persona uses the name, and a turn runs with it (a rename restarts the process once)', async () => {
    expect(botSystemNote('Jarvis')).toContain('Your name is Jarvis.');
    expect(BOT_SYSTEM_NOTE).toBe(botSystemNote('Bot'));
    expect(botSystemNote('Jarvis')).not.toBe(BOT_SYSTEM_NOTE);
    const f = fixture(), api = controller(f);
    const s = api.botUpdate({ enabled: true, name: 'Jarvis' });
    f.manager.continueSession(s.projectId!, s.sessionId!, 'hello');
    await until(() => f.calls.length === 1);
    expect(f.calls[0].appendSystemPrompt).toBe(botSystemNote('Jarvis'));
  });

  it('a rename while a Bot turn runs leaves the turn and the pools alone; the NEXT turn carries the new persona', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => { release = r; });
    let first = true;
    const f = fixture([], async () => { if (first) { first = false; await held; } });
    const api = controller(f);
    const pools = (f.manager as unknown as { pools(): { retireIdleSession(s: string): boolean; shutdown(): void; stop?: unknown }[] }).pools();
    const touched = pools.flatMap((p) => [vi.spyOn(p, 'retireIdleSession'), vi.spyOn(p, 'shutdown')]);
    const s = api.botUpdate({ enabled: true });
    f.manager.continueSession(s.projectId!, s.sessionId!, 'hello');
    await until(() => f.calls.length === 1);
    expect(f.calls[0].appendSystemPrompt).toBe(botSystemNote('Bot'));
    api.botUpdate({ name: 'Jarvis' }); // mid-turn
    expect(turnsDone(f, s.sessionId!)).toBe(0);
    release();
    await until(() => turnsDone(f, s.sessionId!) === 1);
    expect(kinds(f, 'session_error').filter((e) => e.data.sessionId === s.sessionId)).toEqual([]);
    expect(touched.every((t) => t.mock.calls.length === 0)).toBe(true); // nothing was retired or shut down
    expect(f.calls).toHaveLength(1);
    f.manager.continueSession(s.projectId!, s.sessionId!, 'again');
    await until(() => f.calls.length === 2);
    expect(f.calls[1].appendSystemPrompt).toBe(botSystemNote('Jarvis'));
  });

  describe('the pool: the persona is process identity, but only once nothing is running', () => {
    const fakeCli = () => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: { write: (s: string) => void; destroyed: boolean; writableEnded: boolean }; kill: () => void };
      child.stdout = new EventEmitter();
      child.stdin = { write: () => {}, destroyed: false, writableEnded: false };
      const st = { killed: false };
      child.kill = () => { st.killed = true; child.emit('close', null, 'SIGKILL'); };
      return {
        child, st,
        result: () => child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', result: 'ok' }) + '\n')),
        emit: (e: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(e) + '\n')),
      };
    };
    const mk = () => {
      const spawned: ReturnType<typeof fakeCli>[] = [];
      const p = new PersistentTurns({ spawnFn: () => { const c = fakeCli(); spawned.push(c); return c.child as never; } });
      return { p, spawned };
    };
    const turn = (note: string, over: Record<string, unknown> = {}) => ({ configDir: '/cfg/a', cwd: '/work', sessionId: 'bot', mode: 'new', prompt: 'hi', appendSystemPrompt: note, onEvent: () => {}, ...over }) as never;

    it('a running turn is never killed by a new persona being asked for; after it ends, the next turn respawns on the new note', async () => {
      const { p, spawned } = mk();
      const h1 = p.startTurn(turn(botSystemNote('Bot')));
      // a rename does not call the pool; even if a turn with the new note were asked for mid-turn it is refused, not run on a new process
      const mid = p.startTurn(turn(botSystemNote('Jarvis'), { mode: 'resume' }));
      expect(spawned).toHaveLength(1);
      expect(spawned[0].st.killed).toBe(false);
      void mid;
      spawned[0].result();
      expect(await h1.done).toMatchObject({ code: 0 });
      expect(spawned[0].st.killed).toBe(false); // the turn completed on its own process
      p.startTurn(turn(botSystemNote('Jarvis'), { mode: 'resume' }));
      expect(spawned).toHaveLength(2);          // new identity: a new process
      expect(spawned[0].st.killed).toBe(false); // the old one is inside its output grace: kept, stale, never reused (retired once quiet)
      p.shutdown();
    });

    it('with background work still running after the turn, the next turn stays on the held process (old note, no kill)', async () => {
      const { p, spawned } = mk();
      const h1 = p.startTurn(turn(botSystemNote('Bot')));
      spawned[0].emit({ type: 'system', subtype: 'task_started', task_id: 'bg1', task_type: 'local_agent', description: 'explorer' });
      spawned[0].result();
      await h1.done;
      p.startTurn(turn(botSystemNote('Jarvis'), { mode: 'resume' }));
      expect(spawned).toHaveLength(1);
      expect(spawned[0].st.killed).toBe(false);
      p.shutdown();
    });
  });

  it('the persona teaches the agent-reply and message_owner rules', () => {
    const note = botSystemNote();
    for (const s of ['message_owner', 'needs_you', 'hidden from the owner', 'Never end an agent-directed reply with an ASK', 'notify_user is the older name']) expect(note).toContain(s);
  });
});

// ---------------------------------------- open questions survive agent messages

describe('open questions survive agent messages (all conversations)', () => {
  const ask = (q: string) => `Plan ready.\n<<<ASK\nquestion: ${q}\noptions: Yes | No\n>>>`;
  const A = { status: 'completed' as const, resultText: ask('Proceed with the migration?') };
  const open = async (f: Fixture) => {
    f.manager.continueSession('p1', 'x', 'plan it');
    await until(() => turnsDone(f, 'x') === 1);
    expect(f.manager.listPendingQuestions()).toHaveLength(1);
  };
  const agentSend = async (f: Fixture, from = 'y') => {
    const before = turnsDone(f, 'x');
    f.manager.deliverMcpMessage('p1', 'x', 'FYI: the build finished', { from, interactive: false });
    await until(() => turnsDone(f, 'x') === before + 1);
  };

  it('an agent message arrives while an ASK is pending: the ASK stays, nothing is answered, and the agent turn is told', async () => {
    const f = fixture([A, { status: 'completed', resultText: 'Noted.' }]);
    await open(f);
    const at = f.manager.listPendingQuestions()[0].at;
    await agentSend(f);
    const still = f.manager.listPendingQuestions();
    expect(still).toHaveLength(1);
    expect(still[0]).toMatchObject({ question: 'Proceed with the migration?', at });
    expect(kinds(f, 'question_answered')).toHaveLength(0);
    expect(f.calls[1].prompt).toContain('[Open question to the owner, still unanswered: "Proceed with the migration?". Only if THIS message gives the owner\'s answer or makes the question moot, end your reply with <<<RESOLVED>>> on its own line. Never add it as a sign-off or while you still need the owner\'s answer.]');
    // the sender marker stays last, and a reading client sees none of it
    expect(readMessageSender(f.calls[1].prompt).sender?.kind).toBe('conversation');
    expect(stripTeamLine(readMessageSender(f.calls[1].prompt).text)).not.toContain('Open question');
  });

  it('a human turn that answers it (an option\'s text) gets no line and closes it (question_answered by turn)', async () => {
    const f = fixture([A, { status: 'completed', resultText: 'Done.' }]);
    await open(f);
    f.manager.continueSession('p1', 'x', 'yes');
    await until(() => turnsDone(f, 'x') === 2);
    expect(f.calls[1].prompt).not.toContain('Open question');
    expect(f.manager.listPendingQuestions()).toEqual([]);
    expect(kinds(f, 'question_answered')).toHaveLength(1);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ projectId: 'p1', sessionId: 'x', by: 'turn' });
  });

  it('<<<RESOLVED>>> at the end of an agent turn closes it (question_answered by resolved), and is not shown', async () => {
    const f = fixture([A, { status: 'completed', resultText: 'The owner already decided.\n<<<RESOLVED>>>' }]);
    await open(f);
    await agentSend(f);
    expect(f.manager.listPendingQuestions()).toEqual([]);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ by: 'resolved' });
    expect(stripAsk('The owner already decided.\n<<<RESOLVED>>>')).toBe('The owner already decided.');
  });

  it('a second ASK merges into a batch of two (identical text once)', async () => {
    const f = fixture([A, { status: 'completed', resultText: ask('Also rotate the key?') }, { status: 'completed', resultText: ask('Also rotate the key?') }]);
    await open(f);
    await agentSend(f);
    const pending = f.manager.listPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0].questions?.map((q) => q.question)).toEqual(['Proceed with the migration?', 'Also rotate the key?']);
    expect(kinds(f, 'question').at(-1)!.data).toMatchObject({ latest: 'Also rotate the key?' });
    await agentSend(f);
    expect(f.manager.listPendingQuestions()[0].questions).toHaveLength(2);
    // the line names both
    expect(f.calls[2].prompt).toContain('"Proceed with the migration?", "Also rotate the key?"');
  });

  it('RESOLVED plus a new ASK in the same reply: the old question is resolved, the new one stays', async () => {
    const f = fixture([A, { status: 'completed', resultText: ask('Use the new plan instead?') + '\n<<<RESOLVED>>>' }]);
    await open(f);
    await agentSend(f);
    const pending = f.manager.listPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ question: 'Use the new plan instead?' });
    expect(pending[0].questions).toBeUndefined();
  });

  it('a failed agent turn leaves it open', async () => {
    const f = fixture([A, { status: 'failed', reason: 'boom' }]);
    await open(f);
    f.manager.deliverMcpMessage('p1', 'x', 'FYI', { from: 'y', interactive: false });
    await until(() => turnsDone(f, 'x') === 2);
    expect(f.manager.listPendingQuestions()).toHaveLength(1);
  });

  it('the line is stripped wherever a prompt is read back', () => {
    const line = openQuestionLine(['Proceed?', 'Rotate "the" key?\nplease']);
    expect(line.includes('\n')).toBe(false);
    const sent = withMessageSender(withTeamLine('hello', line), { kind: 'conversation', sessionId: 'y' });
    const read = readMessageSender(sent);
    expect(read.text).toContain('Open question to the owner');
    expect(stripTeamLine(read.text)).toBe('hello');
    // stacked with the team and advisor lines
    expect(stripTeamLine(withTeamLine(withTeamLine('hello', '[Advisor on: consult it.]'), line))).toBe('hello');
    // the marker is hidden like <<<ASK, and the notification excerpt
    expect(parseQuestion('a\n<<<RESOLVED>>>')).toBeNull();
    expect(noticeFor('conversation_settled', { status: 'completed', origin: 'human', durationMs: 60000, resultText: 'Done.\n<<<RESOLVED>>>' })!.body).not.toContain('RESOLVED');
  });
});

// ------------------------------------------------- the history routes, end to end

describe('the Bot\'s history routes', () => {
  function transcript(f: Fixture, sid: string, lines: unknown[]) {
    const dir = join(f.dir, 'cfg', 'projects', '-bot');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const asst = (ts: string, content: unknown[]) => ({ type: 'assistant', timestamp: ts, message: { role: 'assistant', model: 'claude-sonnet-5-5', content } });
  const usr = (ts: string, text: string) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });

  it('turn the Bot\'s message_owner calls into owner messages and give every row a verdict; other chats are untouched; the agent\'s reply lookup never sees one', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    const agent = withMessageSender('Build finished, 3 tests failed.', { kind: 'conversation', sessionId: 'x', projectId: 'p1', messageId: 'm-agent' });
    transcript(f, s.sessionId!, [
      usr('2026-10-21T01:00:00Z', 'what is running?'),
      asst('2026-10-21T01:00:05Z', [{ type: 'text', text: 'Nothing right now.' }]),
      usr('2026-10-21T01:10:00Z', agent),
      asst('2026-10-21T01:10:05Z', [{ type: 'tool_use', id: 'toolu_01', name: 'mcp__x056__message_owner', input: { text: 'Build X has 3 failing tests', needs_you: true, options: ['Fix', 'Ignore'] } }]),
      asst('2026-10-21T01:10:06Z', [{ type: 'text', text: 'Thanks, noted.' }]),
    ]);
    const rows = (api.conversationHistory(s.projectId!, s.sessionId!, '50') as HistoryEntry[]).filter((r) => r.role !== 'model');
    expect(rows.map((r) => [r.role, r.text.split(' ')[0], r.botView])).toEqual([
      ['user', 'what', 'show'], ['assistant', 'Nothing', 'show'],
      ['user', 'Build', 'hide'], ['assistant', 'Build', 'show'], ['assistant', 'Thanks,', 'hide'],
    ]);
    expect(rows[3]).toMatchObject({ ownerMessage: true, needsYou: true, options: ['Fix', 'Ignore'], messageId: 'bot-owner:toolu_01', ts: '2026-10-21T01:10:05Z' });
    expect(rows[2]).toMatchObject({ botTurn: 'agent', sender: { kind: 'conversation', messageId: 'm-agent' } });
    const page = api.conversationHistoryPage(s.projectId!, s.sessionId!, '50') as { rows: HistoryEntry[] };
    expect(page.rows.filter((r) => r.role !== 'model').map((r) => r.botView)).toEqual(rows.map((r) => r.botView));
    // the agent that sent the message reads only the reply meant for it
    const reply = api.conversationReply(s.projectId!, s.sessionId!, 'm-agent') as { found: boolean; messages: { text: string }[] };
    expect(reply.found).toBe(true);
    expect(reply.messages.map((m) => m.text)).toEqual(['Thanks, noted.']);
    // an ordinary conversation's history carries none of it
    transcript(f, 'x', [usr('2026-10-21T01:00:00Z', 'hi'), asst('2026-10-21T01:00:05Z', [{ type: 'text', text: 'hello' }])]);
    const other = api.conversationHistory('p1', 'x', '50') as HistoryEntry[];
    expect(other.some((r) => 'botView' in r || 'ownerMessage' in r)).toBe(false);
  });
});

describe('the morning brief with the owner\'s question still open', () => {
  it('settles and pushes like any brief, and the chat shows FYI beside needs-me', async () => {
    const f = fixture([{ status: 'completed', resultText: 'Two things need you. What should I delegate today?' }]);
    const s = f.manager.bot().update({ enabled: true });
    controller(f).botMessage({ from: s.sessionId!, text: 'Ship it?', needsYou: true });
    f.readState.read(s.projectId!, s.sessionId!); // the owner has seen the chat; only the brief is new
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 1, fyi: false });
    f.manager.bot().sendBrief();
    const settled = () => kinds(f, 'conversation_settled').filter((e) => e.data.sessionId === s.sessionId);
    await until(() => settled().length === 1, 15000); // the completion gate waits 2 s of quiet
    expect(settled()[0].data).toMatchObject({ origin: 'brief' });
    expect(settled()[0].data.notice).toMatchObject({ tier: 'normal', category: 'finished' });
    expect(f.readState.view(s.projectId!, s.sessionId!)).toMatchObject({ unread: true, kind: 'done' });
    expect(f.manager.botAttention()).toMatchObject({ needsMe: 1, fyi: true });
    expect(f.manager.listPendingQuestions()).toHaveLength(1); // the brief did not touch the card
    expect(kinds(f, 'question_answered')).toHaveLength(0);
  });
});
