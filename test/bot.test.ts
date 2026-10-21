import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import { ApiController } from '../server/api.controller.js';
import { BOT_DENIED_TOOLS, BOT_SYSTEM_NOTE, BotService, briefDue, digestLine, localParts, type BotHost, type BotState } from '../server/bot.js';
import { noticeFor, originOf, NOTICE_KINDS, type Notice } from '../server/notices.js';
import { readMessageSender, withMessageSender, type MessageSender } from '../src/message-sender.js';
import type { RunSessionOptions } from '../src/failover.js';

// 2026-10-15 07:31 in Asia/Jakarta (UTC+7) = 00:31 UTC.
const JKT = (hhmm: string, day = '2026-10-15') => Date.parse(`${day}T${hhmm}:00+07:00`);

type Result = { status: 'completed' | 'failed'; reason?: string; resultText?: string };

/** A manager with Chat on, a Work project `p1` with conversation `x`, and
 *  turns stubbed: `outcome(sid)` decides each turn's result. */
function fixture(outcome: (o: RunSessionOptions) => Result = () => ({ status: 'completed', resultText: 'ok' })) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-bot-'));
  const stateDir = join(dir, 'state'), work = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(work, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [{
    id: 'p1', name: 'Work', cwd: work, provider: 'claude', conversations: [{ sessionId: 'x', title: 'X' }, { sessionId: 'y', title: 'Y' }], lastSessionId: 'x',
  }] }));
  const clock = { now: JKT('07:00') };
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    const r = outcome(o);
    return { ...r, sessionId: o.sessionId, finalAccount: 'a', failovers: 0 };
  }) as unknown as typeof import('../src/failover.js').runSession;
  const mcp = { configPath: join(stateDir, 'mcp-x056.json'), command: 'node', args: ['bridge.mjs'], env: { X056_URL: 'http://x', X056_TOKEN: 't' } };
  const manager = new SessionManager({ stateDir, workspaceRoot: dir, chatEnabled: true, runSessionFn, mcp, bot: { now: () => clock.now } });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  manager.subscribe((e) => events.push({ kind: e.kind, data: e.data }));
  return { dir, stateDir, manager, clock, calls, events };
}

const cronStub = { list: () => [] };
/** The controller by hand: only the manager, the state dir and cron matter here. */
function controller(f: ReturnType<typeof fixture>): ApiController {
  const Ctor = ApiController as unknown as new (...args: unknown[]) => ApiController;
  return new Ctor(f.manager, f.stateDir, {}, {}, {}, {}, {}, {}, {}, {}, cronStub, {}, {}, {}, {});
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('enabling the Bot', () => {
  it('creates one Chat, idempotently, and marks it on the project and chat rows', () => {
    const f = fixture();
    const bot = f.manager.bot();
    expect(bot.status()).toEqual({ enabled: false, name: 'Bot', projectId: null, sessionId: null, briefAt: '07:30', tz: 'Asia/Jakarta', lastBriefDate: null, url: null });
    const a = bot.update({ enabled: true });
    expect(a.enabled).toBe(true);
    expect(a.projectId).toBeTruthy();
    // createChat gives a sessionId at once: no first-turn trick needed.
    expect(a.sessionId).toBeTruthy();
    expect(a.url).toBe('/chat/' + a.projectId);
    const b = f.manager.bot().update({ enabled: true });
    expect(b.projectId).toBe(a.projectId);
    expect(b.sessionId).toBe(a.sessionId);
    // A restarted gateway (fresh manager, same state) finds the same Chat.
    const again = new SessionManager({ stateDir: f.stateDir, workspaceRoot: f.dir, chatEnabled: true }).bot().update({ enabled: true });
    expect(again.projectId).toBe(a.projectId);
    const chats = f.manager.listProjects().projects.filter((p) => p.kind === 'chat');
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ id: a.projectId, bot: true, provider: 'claude' });
    expect(f.manager.listProjects().projects.find((p) => p.id === 'p1')).not.toHaveProperty('bot');
    expect(JSON.parse(readFileSync(join(f.stateDir, 'bot.json'), 'utf8'))).toMatchObject({ enabled: true, projectId: a.projectId, sessionId: a.sessionId, briefAt: '07:30', tz: 'Asia/Jakarta' });
  });

  it('validates briefAt and tz before changing anything, and keeps the Chat when turned off', () => {
    const f = fixture(), bot = f.manager.bot();
    expect(() => bot.update({ enabled: true, briefAt: '7:30' })).toThrow('HH:MM');
    expect(() => bot.update({ enabled: true, briefAt: '13:00' })).toThrow('before 12:00');
    expect(() => bot.update({ enabled: true, tz: 'Mars/Olympus' })).toThrow('IANA');
    expect(bot.status().projectId).toBeNull(); // nothing was created
    const on = bot.update({ enabled: true, briefAt: '06:45', tz: 'Europe/Amsterdam' });
    expect(on).toMatchObject({ briefAt: '06:45', tz: 'Europe/Amsterdam' });
    const off = bot.update({ enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.projectId).toBe(on.projectId);
  });

  it('refuses the agent team, archiving and another provider for the Bot only', () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true });
    expect(() => f.manager.setHelpers(s.projectId!, s.sessionId!, { team: true })).toThrow('agent team');
    expect(() => f.manager.patchHelpers(s.projectId!, s.sessionId!, { team: true })).toThrow('agent team');
    expect(f.manager.patchHelpers(s.projectId!, s.sessionId!, { advisor: true })).toMatchObject({ advisor: true });
    expect(() => f.manager.updateChat(s.projectId!, { archived: true })).toThrow('cannot be archived');
    expect(() => f.manager.setProjectProvider(s.projectId!, 'codex')).toThrow('Claude only');
    expect(f.manager.patchHelpers('p1', 'x', { team: true })).toMatchObject({ team: true });
  });
});

describe('the Bot\'s turns', () => {
  it('get BOT_SYSTEM_NOTE, the deny list and X056_BOT; other conversations are unchanged', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true });
    f.manager.patchHelpers('p1', 'x', { team: true });
    // The team is refused for the Bot; force one into its record to show launch ignores it.
    const reg = JSON.parse(readFileSync(join(f.stateDir, 'projects.json'), 'utf8'));
    reg.projects.find((p: { id: string }) => p.id === s.projectId).conversations[0].helpers = { team: true };
    writeFileSync(join(f.stateDir, 'projects.json'), JSON.stringify(reg));
    f.manager.continueSession(s.projectId!, s.sessionId!, 'hello');
    await settle();
    f.manager.continueSession('p1', 'x', 'hello');
    await settle();
    const [botTurn, other] = f.calls;
    expect(botTurn.appendSystemPrompt).toBe(BOT_SYSTEM_NOTE);
    expect(botTurn.disallowedTools).toEqual(BOT_DENIED_TOOLS);
    expect(botTurn.subagents).toBeUndefined();
    expect(botTurn.mcp?.env?.X056_BOT).toBe('1');
    expect(other.appendSystemPrompt).not.toBe(BOT_SYSTEM_NOTE);
    expect(other.appendSystemPrompt).toContain('EXECUTION ENVIRONMENT');
    expect(other.disallowedTools).toBeUndefined();
    expect(other.subagents).toBeDefined(); // its own team still applies
    expect(other.mcp?.env?.X056_BOT).toBeUndefined();
  });

  it('the deny list reaches the CLI as ONE comma-joined --disallowedTools value', async () => {
    const { disallowedToolsArgs } = await import('../src/turn.js');
    expect(disallowedToolsArgs(BOT_DENIED_TOOLS)).toEqual(['--disallowedTools', BOT_DENIED_TOOLS.join(',')]);
  });

  it('BOT_SYSTEM_NOTE keeps the useful guidance and drops the container-only parts', () => {
    for (const s of ['notify_user', 'status_overview', 'delegate', 'send_message', 'confirm_relay', 'schedule_task', 'once: true', 'timezone', 'memory_search', 'x056.think.val.id', 'bot_event', 'bot_brief'])
      expect(BOT_SYSTEM_NOTE).toContain(s);
    for (const s of ['ssh', 'nginx', 'dind', 'docker', 'Toolchains', 'pauses until the human operator', 'SUBAGENTS ARE FULLY SUPPORTED'])
      expect(BOT_SYSTEM_NOTE).not.toContain(s);
  });
});

describe('the approval exemption', () => {
  it('delivers a Bot send directly in approval mode; a non-Bot caller still gets a pending card', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    expect(f.manager.mcpSendMode()).toBe('approval');
    const fromBot = await api.conversationSend({ projectId: 'p1', sessionId: 'x', prompt: 'please check the build', from: s.sessionId!, interactive: false });
    expect(fromBot).toMatchObject({ mode: 'auto', sessionId: 'x', hopsUntilCheck: 6 });
    const fromOther = await api.conversationSend({ projectId: 'p1', sessionId: 'y', prompt: 'hi', from: 'x', interactive: false });
    expect(fromOther.mode).toBe('approval');
    expect(f.manager.listMcpApprovals()).toHaveLength(1);
    // A turned-off Bot is an ordinary caller again.
    f.manager.bot().update({ enabled: false });
    await settle();
    const offBot = await api.conversationSend({ projectId: 'p1', sessionId: 'y', prompt: 'hi again', from: s.sessionId!, interactive: false });
    expect(offBot.mode).toBe('approval');
  });
});

describe('notify_user and the overview routes', () => {
  it('refuses a caller that is not the Bot; for the Bot notify_user is message_owner (urgent = needs you, else an FYI)', () => {
    // Pinned the old bot_notice event (a push in its own words); notify_user is now an alias of message_owner (docs/bot-owner-view-contract.md).
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    expect(() => api.botNotify({ from: 'x', title: 'Hi', body: 'b' })).toThrow(ForbiddenException);
    expect(() => api.botNotify({ title: 'Hi', body: 'b' })).toThrow(ForbiddenException);
    expect(() => api.botOverview('x')).toThrow(ForbiddenException);
    const r = api.botNotify({ from: s.sessionId!, title: 'Deploy needs you', body: 'Approve the migration?', tier: 'urgent', link: 'https://evil.example/' });
    expect(r).toMatchObject({ ok: true, tier: 'urgent' });
    expect(r).not.toHaveProperty('link'); // not a panel path: dropped
    const q = f.events.find((x) => x.kind === 'question')!;
    expect(q.data).toMatchObject({ projectId: s.projectId, sessionId: s.sessionId, question: 'Deploy needs you\n\nApprove the migration?' });
    expect(q.data.notice).toMatchObject({ tier: 'urgent', category: 'needs_you', link: '/chat/' + s.projectId });
    api.botNotify({ from: s.sessionId!, title: 'Done', body: 'Shipped.', link: '/chat/abc' });
    const m = f.events.filter((x) => x.kind === 'bot_message')[1];
    expect(m.data).toMatchObject({ needsYou: false, text: 'Done\n\nShipped.\n\n/chat/abc' });
    expect(m.data).not.toHaveProperty('notice'); // an FYI is never pushed
  });

  it('answers the overview with cheap reads', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true }), api = controller(f);
    f.manager.reportCronFailure({ id: 'job1', projectId: 'p1', sessionId: 'x', label: 'Nightly', prompt: 'p' }, 'boom');
    const o = api.botOverview(s.sessionId!) as Record<string, unknown>;
    expect(Object.keys(o).sort()).toEqual(['accounts', 'briefAt', 'delegates', 'lastBriefDate', 'needsYou', 'now', 'recent', 'running', 'scheduled', 'tz']);
    expect(o.accounts).toEqual([{ name: 'a', label: null, provider: 'claude', state: 'unknown', until: null, estimated: false, paused: false, usable: true }]);
    expect((o.recent as { kind: string }[])[0]).toMatchObject({ kind: 'cron_failed', tier: 'urgent', projectId: 'p1' });
  });
});

describe('the digest', () => {
  type Q = { id: string; sessionId?: string; sender?: MessageSender; text: string; dispatching?: boolean };
  function host(state: { queue: Q[] }) {
    const project = { id: 'bot', kind: 'chat', lastSessionId: 'b1', conversations: [{ sessionId: 'b1' }] };
    const h: BotHost = {
      project: (pid) => (pid === 'bot' ? project : undefined),
      createChat: () => project,
      unarchiveChat: () => {},
      queue: () => state.queue,
      enqueue: (_pid, item) => { const q = { id: 'q' + (state.queue.length + 1), ...item }; state.queue.push(q); return q; },
      appendToQueued: (_pid, id, text) => { const it = state.queue.find((x) => x.id === id)!; it.text += '\n\n---\n\n' + text; },
    };
    return h;
  }
  const urgent = (id: string, over: Partial<Notice> = {}): Notice => ({ tier: 'urgent', category: 'needs_you', kind: 'session_done', title: 'X', body: 'Turn failed: ' + id, link: '/', tag: 't', id, projectId: 'p1', sessionId: 'x', ...over });
  function service(clock: { now: number }, state = { queue: [] as Q[] }) {
    const dir = mkdtempSync(join(tmpdir(), 'x056-bot-digest-'));
    const svc = new BotService(dir, host(state), { now: () => clock.now, debounceMs: 60_000, flushCap: 6 });
    svc.update({ enabled: true });
    return { svc, state, dir };
  }

  it('debounces 60 s from the first line, then wakes the Bot once with every line', () => {
    const clock = { now: 1_000_000 }, { svc, state } = service(clock);
    svc.observe('session_done', {}, urgent('a'));
    clock.now += 30_000;
    svc.observe('session_done', {}, urgent('b'));
    expect(svc.flush()).toBe('waiting');
    clock.now += 30_000;
    expect(svc.flush()).toBe('queued');
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({ sessionId: 'b1', sender: { kind: 'bot_event' } });
    expect(state.queue[0].text).toContain('2 items');
    expect(state.queue[0].text).toContain('Turn failed: a');
    expect(state.queue[0].text).toContain('Turn failed: b');
    svc.stop();
  });

  it('merges into a bot_event item still waiting, dedupes by notice id, and skips the Bot itself and non-urgent', () => {
    const clock = { now: 1_000_000 }, { svc, state } = service(clock);
    svc.observe('session_done', {}, urgent('a'));
    clock.now += 61_000; svc.flush();
    svc.observe('question', {}, urgent('a')); // same id: not again
    svc.observe('question', { projectId: 'bot' }, urgent('q', { projectId: 'bot', sessionId: 'b1' }));
    svc.observe('mcp_approval', { projectId: 'p1', sender: { kind: 'conversation', projectId: 'bot', sessionId: 'b1' } }, urgent('ap', { kind: 'mcp_approval' }));
    svc.observe('conversation_settled', {}, urgent('n', { tier: 'normal' }));
    svc.observe('bot_notice', {}, urgent('bn', { projectId: undefined, sessionId: undefined }));
    expect(svc.pendingDigest().lines).toEqual([]);
    svc.observe('session_done', {}, urgent('c'));
    clock.now += 61_000;
    expect(svc.flush()).toBe('merged');
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0].text).toContain('Turn failed: c');
    // A dispatching item is not merged into: a new one is queued.
    state.queue[0].dispatching = true;
    svc.observe('session_done', {}, urgent('d'));
    clock.now += 61_000;
    expect(svc.flush()).toBe('queued');
    expect(state.queue).toHaveLength(2);
    svc.stop();
  });

  it('wakes at most 6 times per rolling hour, keeping the rest for the next allowed flush, and caps the buffer at 50', () => {
    const clock = { now: 1_000_000 }, { svc, state } = service(clock);
    for (let i = 0; i < 6; i++) {
      svc.observe('session_done', {}, urgent('w' + i));
      clock.now += 61_000;
      expect(svc.flush()).toBe('queued');
      state.queue.length = 0; // the Bot took it
    }
    for (let i = 0; i < 55; i++) svc.observe('session_done', {}, urgent('late' + i));
    clock.now += 61_000;
    expect(svc.flush()).toBe('capped');
    expect(svc.pendingDigest().lines).toHaveLength(50);
    expect(svc.pendingDigest().dropped).toBe(5);
    clock.now = 1_000_000 + 61_000 + 3600_000; // the first wake leaves the hour
    expect(svc.flush()).toBe('queued');
    expect(state.queue[0].text).toContain('55 items');
    expect(state.queue[0].text).toContain('and 5 more not shown');
    expect(state.queue[0].text).not.toContain('late0:'); // the oldest were dropped
    svc.stop();
  });

  it('a throwing observer never breaks event delivery', () => {
    const f = fixture();
    f.manager.bot().update({ enabled: true });
    const spy = vi.spyOn(f.manager.bot(), 'observe').mockImplementation(() => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    f.manager.reportCronFailure({ id: 'j', projectId: 'p1', prompt: 'p' }, 'down');
    expect(f.events.some((e) => e.kind === 'cron_failed')).toBe(true);
    expect(spy).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('digestLine names the item and where it is', () => {
    expect(digestLine(urgent('a'))).toBe('- session_done · X: Turn failed: a (project p1, conversation x)');
  });
});

describe('the morning brief', () => {
  const state = (over: Partial<BotState> = {}): BotState => ({ enabled: true, projectId: 'bot', briefAt: '07:30', tz: 'Asia/Jakarta', ...over });

  it('is due once per local day, from briefAt until noon', () => {
    expect(localParts(JKT('07:31'), 'Asia/Jakarta')).toEqual({ date: '2026-10-15', minutes: 451 });
    expect(briefDue(state(), JKT('07:29'))).toBeNull();
    expect(briefDue(state(), JKT('07:30'))).toBe('2026-10-15');
    expect(briefDue(state(), JKT('11:59'))).toBe('2026-10-15'); // catch-up after a swap
    expect(briefDue(state(), JKT('12:00'))).toBeNull(); // not after noon
    expect(briefDue(state({ lastBriefDate: '2026-10-15' }), JKT('08:00'))).toBeNull();
    expect(briefDue(state({ lastBriefDate: '2026-10-15' }), JKT('07:31', '2026-10-16'))).toBe('2026-10-16');
    expect(briefDue(state({ enabled: false }), JKT('08:00'))).toBeNull();
  });

  it('the timer queues it to the Bot as bot_brief, saving lastBriefDate first, and never twice', async () => {
    const f = fixture(), s = f.manager.bot().update({ enabled: true });
    const bot = f.manager.bot();
    bot.tick();
    await settle(600);
    expect(f.calls).toHaveLength(0); // 07:00: not yet
    f.clock.now = JKT('07:31');
    bot.tick();
    expect(JSON.parse(readFileSync(join(f.stateDir, 'bot.json'), 'utf8')).lastBriefDate).toBe('2026-10-15');
    bot.tick();
    await settle(600); // the queue drains after 400 ms
    const briefs = f.calls.filter((c) => readMessageSender(c.prompt).sender?.kind === 'bot_brief');
    expect(briefs).toHaveLength(1);
    expect(briefs[0].sessionId).toBe(s.sessionId);
    expect(briefs[0].prompt).toContain('Morning brief for 2026-10-15');
    f.clock.now = JKT('09:00');
    bot.tick();
    await settle(600);
    expect(f.calls.filter((c) => readMessageSender(c.prompt).sender?.kind === 'bot_brief')).toHaveLength(1);
    // A completed brief turn pushes (normal), even when short.
    const settled = () => f.events.filter((e) => e.kind === 'conversation_settled' && e.data.sessionId === s.sessionId);
    for (let i = 0; i < 40 && !settled().length; i++) await settle(100); // the completion gate waits 2 s of quiet
    expect(settled()[0].data).toMatchObject({ origin: 'brief' });
    expect((settled()[0].data.notice as Notice)).toMatchObject({ tier: 'normal', category: 'finished', body: 'ok' });
    bot.stop();
  });

  it('a brief reply ending in an ASK block still pushes as the brief, not as a question card', async () => {
    const f = fixture(() => ({ status: 'completed', resultText: 'Deploy finished. Nothing needs you.\n<<<ASK\nWhat should I delegate today?\n- Tests\n- Docs\n>>>' }));
    const s = f.manager.bot().update({ enabled: true });
    f.clock.now = JKT('07:31');
    f.manager.bot().tick();
    const settled = () => f.events.filter((e) => e.kind === 'conversation_settled' && e.data.sessionId === s.sessionId);
    for (let i = 0; i < 40 && !settled().length; i++) await settle(100);
    expect(f.events.some((e) => e.kind === 'question' && e.data.sessionId === s.sessionId)).toBe(false);
    expect((settled()[0].data.notice as Notice)).toMatchObject({ tier: 'normal', body: 'Deploy finished. Nothing needs you.' });
    f.manager.bot().stop();
  });

  it('a brief that was due before a restart at 13:00 is skipped', () => {
    const f = fixture();
    f.manager.bot().update({ enabled: true });
    f.clock.now = JKT('13:00');
    f.manager.bot().tick();
    expect(JSON.parse(readFileSync(join(f.stateDir, 'bot.json'), 'utf8')).lastBriefDate).toBeUndefined();
    expect(f.manager.queues()[f.manager.bot().status().projectId!] ?? []).toHaveLength(0);
  });
});

describe('notices and senders for the Bot', () => {
  it('bot_notice: urgent is needs_you, else normal finished; its own title, body, link, id and tag', () => {
    expect(NOTICE_KINDS.has('bot_notice')).toBe(true);
    const u = noticeFor('bot_notice', { projectId: 'bot', sessionId: 'b1', title: 'A decision for you', body: 'Ship today?', tier: 'urgent', at: 'T1' }, { link: '/chat/bot', conversationTitle: 'Bot' })!;
    expect(u).toMatchObject({ tier: 'urgent', category: 'needs_you', title: 'A decision for you', body: 'Ship today?', link: '/chat/bot', id: 'bot:T1', tag: 'x056-bot-T1' });
    const n = noticeFor('bot_notice', { title: 'x'.repeat(80), body: 'b', link: '/work/p/s', at: 'T2' }, { link: '/chat/bot' })!;
    expect(n).toMatchObject({ tier: 'normal', category: 'finished', link: '/work/p/s', id: 'bot:T2', tag: 'x056-bot-T2' });
    expect(n.title.length).toBeLessThanOrEqual(60);
    expect(noticeFor('bot_notice', { title: 't', body: 'b', link: '//evil', at: 'T3' }, { link: '/chat/bot' })!.link).toBe('/chat/bot');
  });

  it('bot_brief is origin brief (a completed turn pushes, normal); bot_event is a quiet relay', () => {
    expect(originOf({ kind: 'bot_brief' })).toBe('brief');
    expect(originOf({ kind: 'bot_event' })).toBe('relay');
    const brief = noticeFor('conversation_settled', { status: 'completed', origin: 'brief', durationMs: 5000, resultText: 'Two things need you. Deploy finished. What should I delegate today?', sessionId: 'b1' }, { projectKind: 'chat', conversationTitle: 'Bot' })!;
    expect(brief).toMatchObject({ tier: 'normal', category: 'finished' });
    expect(brief.body.startsWith('Two things need you.')).toBe(true); // its own order, the question last
    const digest = noticeFor('conversation_settled', { status: 'completed', origin: 'relay', durationMs: 90_000, resultText: 'noted', sessionId: 'b1' }, { projectKind: 'chat' })!;
    expect(digest.tier).toBe('quiet');
  });

  it('the sender marker round-trips for the new kinds (no raw JSON in history)', () => {
    for (const kind of ['bot_event', 'bot_brief'] as const) {
      expect(readMessageSender(withMessageSender('hello', { kind }))).toEqual({ text: 'hello', sender: { kind } });
    }
  });
});

describe('the Bot\'s MCP tools', () => {
  it('are not listed or callable outside a Bot turn (stdio without X056_BOT, and the http bridge)', async () => {
    vi.stubEnv('X056_SELF_PROJECT_ID', 'p'); vi.stubEnv('X056_SELF_SESSION_ID', 's');
    vi.resetModules();
    const m = await import('../scripts/x056-mcp-tools.mjs');
    expect(m.listTools().map((t: { name: string }) => t.name)).not.toContain('notify_user');
    expect(m.TOOLS.map((t: { name: string }) => t.name)).not.toContain('status_overview');
    await expect(m.callToolResult(async () => ({}), 'notify_user', { title: 't', body: 'b' })).rejects.toThrow('only available to the Bot');
  });

  it('are listed in a Bot turn and call the Bot routes with the caller as `from`', async () => {
    vi.stubEnv('X056_SELF_PROJECT_ID', 'bot'); vi.stubEnv('X056_SELF_SESSION_ID', 'b1'); vi.stubEnv('X056_BOT', '1');
    vi.resetModules();
    const m = await import('../scripts/x056-mcp-tools.mjs');
    const names = m.listTools().map((t: { name: string }) => t.name);
    expect(names).toContain('notify_user');
    expect(names).toContain('status_overview');
    const seen: { path: string; body?: unknown }[] = [];
    const api = async (path: string, opts?: RequestInit): Promise<unknown> => {
      seen.push({ path, body: typeof opts?.body === 'string' ? JSON.parse(opts.body) : undefined });
      return path.startsWith('/api/bot/notify') ? { ok: true, id: 'bot:1', tier: 'urgent' } : { now: 'n' };
    };
    const r = await m.callToolResult(api, 'notify_user', { title: 'T', body: 'B', urgent: true });
    expect(r.structuredContent).toEqual({ ok: true, id: 'bot:1', tier: 'urgent' });
    expect(seen[0]).toEqual({ path: '/api/bot/notify', body: { from: 'b1', title: 'T', body: 'B', tier: 'urgent' } });
    const o = await m.callToolResult(api, 'status_overview', {});
    expect(seen[1].path).toBe('/api/bot/overview?from=b1');
    expect(o.structuredContent).toEqual({ overview: { now: 'n' } });
    await expect(m.callToolResult(api, 'notify_user', { body: 'no title' })).rejects.toThrow('Invalid tool arguments');
  });
});

describe('loop check: Bot -> X fails -> digest wakes the Bot -> Bot -> X again', () => {
  it('shows what the relay depth does across the loop (finding: it does NOT advance)', async () => {
    const f = fixture((o) => (o.sessionId === 'x' ? { status: 'failed', reason: 'Turn failed: build broke' } : { status: 'completed', resultText: 'ok' }));
    const s = f.manager.bot().update({ enabled: true }), bot = f.manager.bot(), botSid = s.sessionId!;
    const depths: number[] = [];
    for (let round = 0; round < 3; round++) {
      // The Bot's turn sends to X (from = the Bot's conversation: no approval).
      const sent = f.manager.deliverMcpMessage('p1', 'x', 'fix the build', { from: botSid, interactive: false });
      depths.push(f.manager.relayDepth('x'));
      expect(sent.hopsUntilCheck).toBe(6);
      await settle(50);
      // X's turn failed: an urgent notice, buffered for the Bot.
      expect(bot.pendingDigest().lines.length).toBe(1);
      f.clock.now += 61_000;
      bot.tick(); // the digest flush: a queue item, sender bot_event
      await settle(600); // the queue drains into a Bot turn
      const woke = f.calls.filter((c) => c.sessionId === botSid && readMessageSender(c.prompt).sender?.kind === 'bot_event');
      expect(woke).toHaveLength(round + 1);
      // The digest is not a hop and bot_event does not clear the chain...
      expect(f.manager.relayDepth(botSid)).toBe(0);
    }
    // ...but nothing ever sets the Bot's OWN chain either, so every Bot -> X
    // send starts a fresh chain at depth 1: the relay checkpoint never fires
    // on this loop. The digest's wake cap (6 per rolling hour) is the only brake.
    expect(depths).toEqual([1, 1, 1]);
    bot.stop();
  });
});

describe('the event log', () => {
  it('records urgent and normal notices not about the Bot, newest first, and trims', () => {
    const clock = { now: Date.parse('2026-10-15T00:00:00Z') };
    const dir = mkdtempSync(join(tmpdir(), 'x056-bot-log-'));
    const project = { id: 'bot', kind: 'chat', lastSessionId: 'b1' };
    const svc = new BotService(dir, { project: () => project, createChat: () => project, unarchiveChat: () => {}, queue: () => [], enqueue: () => ({ id: 'q' }), appendToQueued: () => {} }, { now: () => clock.now });
    svc.update({ enabled: true });
    const n = (i: number, tier: Notice['tier'] = 'normal'): Notice => ({ tier, category: 'finished', kind: 'conversation_settled', title: 'T' + i, body: 'x'.repeat(400), link: '/', tag: 't', id: 'id' + i, projectId: 'p1', sessionId: 'x' });
    svc.observe('conversation_settled', {}, n(1));
    svc.observe('conversation_settled', {}, n(2, 'quiet'));
    clock.now += 1000;
    svc.observe('conversation_settled', {}, n(3));
    const recent = svc.recentEvents();
    expect(recent.map((e) => e.title)).toEqual(['T3', 'T1']);
    expect(recent[0].body.length).toBe(300);
    for (let i = 0; i < 4000; i++) svc.observe('conversation_settled', {}, n(10 + i));
    const lines = readFileSync(join(dir, 'bot-events.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    expect(lines).toBeLessThanOrEqual(4000);
    expect(lines).toBeGreaterThanOrEqual(2000);
    expect(existsSync(join(dir, 'bot-events.jsonl'))).toBe(true);
    svc.stop();
  });
});
