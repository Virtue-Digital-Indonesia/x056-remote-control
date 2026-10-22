import 'reflect-metadata';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import { ApiController } from '../server/api.controller.js';
import { ReadState } from '../server/read-state.js';
import { noticeFor, replyExcerpt } from '../server/notices.js';
import { cleanMemorySource } from '../server/memory-sources.js';
import { OwnerViewStore, ownerInitialTurn, ownerRowView, ownerSenderLabel, isAgentTrigger } from '../server/owner-view.js';
import { OWNER_HIDDEN_LINE, readMessageSender, stripTeamLine, withMessageSender } from '../src/message-sender.js';
import { FOR_OWNER, hasForOwner, stripAsk } from '../src/question.js';
import type { HistoryEntry } from '../src/provider.js';
import type { RunSessionOptions } from '../src/failover.js';

type Result = { status: 'completed' | 'failed'; reason?: string; resultText?: string; texts?: string[] };

function fixture(script: Result[] = []) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-ownerview-'));
  const stateDir = join(dir, 'state'), work = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(work, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [{
    id: 'p1', name: 'Work', cwd: work, provider: 'claude', conversations: [{ sessionId: 'x', title: 'X' }, { sessionId: 'y', title: 'Y' }], lastSessionId: 'x',
  }] }));
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    const r = script.shift() ?? { status: 'completed', resultText: 'ok' };
    for (const text of r.texts ?? []) (o as unknown as { tap?: (e: unknown) => void }).tap?.({ type: 'assistant', message: { content: [{ type: 'text', text }] } } as never);
    return { status: r.status, reason: r.reason, resultText: r.resultText, sessionId: o.sessionId, finalAccount: 'a', failovers: 0 };
  }) as unknown as typeof import('../src/failover.js').runSession;
  const mcp = { configPath: join(stateDir, 'mcp-x056.json'), command: 'node', args: ['bridge.mjs'], env: { X056_URL: 'http://x', X056_TOKEN: 't' } };
  const manager = new SessionManager({ stateDir, workspaceRoot: dir, chatEnabled: true, runSessionFn, mcp });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  manager.subscribe((e) => events.push({ kind: e.kind, data: e.data }));
  const readState = new ReadState(stateDir, (k, d) => manager.broadcast(k, d), () => false, Date.now, (pid) => manager.bot().isBotProject(pid));
  manager.attachReadState(readState);
  manager.subscribe((e) => { if (e.kind !== 'read_state') readState.observe(e.kind, e.data); });
  return { dir, stateDir, manager, calls, events, readState };
}
type Fixture = ReturnType<typeof fixture>;
const until = async (cond: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); if (!cond()) throw new Error('timed out'); };
const done = (f: Fixture, sid = 'x') => f.events.filter((e) => e.kind === 'session_done' && e.data.sessionId === sid);
const agentSend = async (f: Fixture, id: string) => {
  const n = done(f).length;
  f.manager.deliverMcpMessage('p1', 'x', 'FYI: the build finished', { from: 'y', interactive: false });
  await until(() => done(f).length === n + 1);
  void id;
  return done(f)[n].data;
};
function controller(f: Fixture): ApiController {
  const Ctor = ApiController as unknown as new (...args: unknown[]) => ApiController;
  return new Ctor(f.manager, f.stateDir, {}, {}, {}, {}, {}, {}, {}, {}, { list: () => [] }, {}, {}, {}, {});
}

describe('owner-view table', () => {
  const { cases } = JSON.parse(readFileSync(new URL('./fixtures/owner-view-table.json', import.meta.url), 'utf8')) as {
    cases: { name: string; rows: HistoryEntry[]; expected: ('show' | 'hide')[]; initialTurn?: { kind: 'agent' | ''; forOwner?: boolean } }[];
  };
  it('has the table', () => expect(cases.length).toBeGreaterThanOrEqual(14));
  for (const c of cases) it(c.name, () => {
    const rows = JSON.parse(JSON.stringify(c.rows).replace(/\$SELF/g, 'sid-1')) as HistoryEntry[];
    const out = ownerRowView(rows, { sessionId: 'sid-1', initialTurn: c.initialTurn });
    expect(out.map((r) => r.ownerView)).toEqual(c.expected);
  });

  it('labels agent turns and marks forOwner from the store', () => {
    const rows: HistoryEntry[] = [
      { role: 'user', text: 'a', sender: { kind: 'conversation', messageId: 'm1', conversationTitle: 'Deploy', projectName: 'P' } },
      { role: 'assistant', text: 'r' },
      { role: 'user', text: 'b', sender: { kind: 'automation', messageId: 'm2' } },
      { role: 'assistant', text: 'r' },
    ];
    const out = ownerRowView(rows, { sessionId: 's', shown: new Set(['m1']) });
    expect(out.map((r) => r.ownerView)).toEqual(['show', 'show', 'hide', 'hide']);
    expect(out[0]).toMatchObject({ forOwner: true, ownerTurn: 'agent', ownerSender: 'Deploy' });
    expect(out[2]).toMatchObject({ ownerSender: 'Scheduled task' });
    expect(out[2].forOwner).toBeUndefined();
    expect(rows[0].ownerView).toBeUndefined();
  });

  it('labels and self-sends', () => {
    expect(ownerSenderLabel({ kind: 'delegate' })).toBe('Delegates');
    expect(ownerSenderLabel({ kind: 'mcp', projectName: 'Obscura' })).toBe('Obscura');
    expect(isAgentTrigger({ role: 'user', sender: { kind: 'conversation', sessionId: 's' } }, 's')).toBe(false);
    expect(isAgentTrigger({ role: 'user', sender: { kind: 'conversation', sessionId: 't' } }, 's')).toBe(true);
  });

  it('ownerInitialTurn looks back to the trigger', () => {
    const older = { rows: [{ role: 'user', text: 'u', sender: { kind: 'conversation', messageId: 'm9', conversationTitle: 'T' } }, { role: 'assistant', text: 'r' }] as HistoryEntry[], cursor: 0, done: true };
    const page: HistoryEntry[] = [{ role: 'assistant', text: 'r' }];
    expect(ownerInitialTurn(page, 10, false, 's', () => older)).toEqual({ kind: 'agent', messageId: 'm9', sender: 'T' });
    expect(ownerInitialTurn([{ role: 'user', text: 'u' }], 10, false, 's', () => older)).toEqual({ kind: '' });
    expect(ownerInitialTurn(page, 0, true, 's', () => older)).toEqual({ kind: '' });
  });
});

describe('OwnerViewStore', () => {
  it('round-trips, tolerates a missing or corrupt file, and keeps the newest 500', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-ovs-'));
    const store = new OwnerViewStore(dir);
    expect(store.shown('s').size).toBe(0);
    store.markShown('s', 'm1', 'marker');
    expect(store.shown('s').has('m1')).toBe(true);
    mkdirSync(join(dir, 'owner-view'), { recursive: true });
    writeFileSync(join(dir, 'owner-view', 'bad.json'), '{nope');
    expect(store.shown('bad').size).toBe(0);
    store.markShown('bad', 'm', 'ask');
    expect([...store.shown('bad')]).toEqual(['m']);
    for (let i = 0; i < 510; i++) store.markShown('big', 'm' + i, 'ask');
    const shown = store.shown('big');
    expect(shown.size).toBe(500);
    expect(shown.has('m509')).toBe(true);
  });
});

describe('the marker', () => {
  it('is detected and stripped everywhere the RESOLVED marker is', () => {
    expect(hasForOwner(`done\n${FOR_OWNER}\n`)).toBe(true);
    expect(hasForOwner('nothing')).toBe(false);
    expect(stripAsk(`Report.\n${FOR_OWNER}\nMore.`)).not.toContain('FOR_OWNER');
    expect(replyExcerpt(`Report ready.\n${FOR_OWNER}`)).toBe('Report ready.');
    expect(cleanMemorySource(`Report ready.\n${FOR_OWNER}`)).not.toContain('FOR_OWNER');
  });
  it('the per-turn line is stripped by stripTeamLine', () => {
    const text = 'hello\n\n' + OWNER_HIDDEN_LINE;
    expect(stripTeamLine(text)).toBe('hello');
    const withSender = withMessageSender('hello\n\n' + OWNER_HIDDEN_LINE, { kind: 'conversation' });
    expect(stripTeamLine(readMessageSender(withSender).text)).toBe('hello');
  });
});

describe('notices and read state', () => {
  const settled = { projectId: 'p1', sessionId: 'x', status: 'completed', origin: 'relay', durationMs: 5000, resultText: 'Done.' };
  it('a hidden agent turn has tier none; a shown one is as before', () => {
    expect(noticeFor('conversation_settled', { ...settled, ownerHidden: true })?.tier).toBe('none');
    expect(noticeFor('conversation_settled', { ...settled, forOwner: true })?.tier).toBe('quiet');
    expect(noticeFor('conversation_settled', { ...settled, status: 'failed', ownerHidden: true })?.tier).not.toBe('none');
  });
  it('read-state: no unread for ownerHidden, unread otherwise', () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-rs-'));
    const rs = new ReadState(dir);
    rs.observe('conversation_settled', { ...settled, ownerHidden: true });
    expect(rs.view('p1', 'x').unread).toBe(false);
    rs.observe('conversation_settled', { ...settled });
    expect(rs.view('p1', 'x').unread).toBe(true);
  });
});

describe('the manager', () => {
  it('tells an agent turn, and only an agent turn, that it is hidden', async () => {
    const f = fixture();
    await agentSend(f, 'a');
    expect(f.calls[0].prompt).toContain(OWNER_HIDDEN_LINE);
    expect(readMessageSender(f.calls[0].prompt).sender?.kind).toBe('conversation');
    f.manager.continueSession('p1', 'x', 'owner here');
    await until(() => done(f).length === 2);
    expect(f.calls[1].prompt).not.toContain('Hidden from the owner');
    // a conversation's own message_self is a continuation
    f.manager.deliverMcpMessage('p1', 'x', 'next step', { from: 'x', interactive: false });
    await until(() => done(f).length === 3);
    expect(f.calls[2].prompt).not.toContain('Hidden from the owner');
  });

  it('an unmarked agent turn is ownerHidden with its trigger id; the settled event keeps it; no unread', async () => {
    const f = fixture();
    const d = await agentSend(f, 'a');
    expect(d.ownerHidden).toBe(true);
    expect(typeof d.triggerMessageId).toBe('string');
    expect(d.forOwner).toBeUndefined();
    await until(() => f.events.some((e) => e.kind === 'conversation_settled'));
    const s = f.events.find((e) => e.kind === 'conversation_settled')!;
    expect(s.data.ownerHidden).toBe(true);
    expect(f.readState.view('p1', 'x').unread).toBe(false);
  });

  it('a marker in a NON-final assistant message marks the turn', async () => {
    const f = fixture([{ status: 'completed', resultText: 'ok', texts: [`Here.\n${FOR_OWNER}`, 'tail'] }]);
    const d = await agentSend(f, 'a');
    expect(d).toMatchObject({ forOwner: true });
    expect(d.ownerHidden).toBeUndefined();
    expect(new OwnerViewStore(f.stateDir).shown('x').has(String(d.triggerMessageId))).toBe(true);
    const shownText = f.events.filter((e) => e.kind === 'assistant_text').map((e) => e.data.text);
    expect(shownText.join('\n')).not.toContain('FOR_OWNER');
  });

  it('an ASK-only message counts although it is dropped from display', async () => {
    const f = fixture([{ status: 'completed', resultText: 'ok', texts: ['<<<ASK\nquestion: Ship?\noptions: Yes | No\n>>>', 'ok'] }]);
    const d = await agentSend(f, 'a');
    expect(d.forOwner).toBe(true);
    expect(new OwnerViewStore(f.stateDir).shown('x').size).toBe(1);
  });

  it('the marker in the result text alone also marks', async () => {
    const f = fixture([{ status: 'completed', resultText: `Report.\n${FOR_OWNER}` }]);
    expect((await agentSend(f, 'a')).forOwner).toBe(true);
  });

  it('a woken reply with the marker shows a hidden turn and emits owner_view', async () => {
    const f = fixture();
    const d = await agentSend(f, 'a');
    await until(() => f.events.some((e) => e.kind === 'conversation_settled'));
    const before = f.events.length;
    const m = f.manager as unknown as { afterTurns: Map<string, unknown>; onSettled(d: Record<string, unknown>): void };
    m.afterTurns.set('x', { sawWork: true, seq: 0, reply: { text: `Agents done.\n${FOR_OWNER}`, seq: 1, at: new Date().toISOString() } });
    m.onSettled({ projectId: 'p1', sessionId: 'x', status: 'completed', origin: 'relay', ownerHidden: true, triggerMessageId: d.triggerMessageId });
    const added = f.events.slice(before);
    expect(added.find((e) => e.kind === 'owner_view')?.data).toMatchObject({ projectId: 'p1', sessionId: 'x', messageId: d.triggerMessageId, shown: true, reason: 'marker' });
    const settled = added.find((e) => e.kind === 'conversation_settled')!;
    expect(settled.data.forOwner).toBe(true);
    expect(settled.data.ownerHidden).toBeUndefined();
    expect(new OwnerViewStore(f.stateDir).shown('x').has(String(d.triggerMessageId))).toBe(true);
  });

  it('a woken reply without a marker leaves the turn hidden', async () => {
    const f = fixture();
    const d = await agentSend(f, 'a');
    const m = f.manager as unknown as { afterTurns: Map<string, unknown>; onSettled(d: Record<string, unknown>): void };
    const before = f.events.length;
    m.afterTurns.set('x', { sawWork: true, seq: 0, reply: { text: 'All quiet.', seq: 1, at: new Date().toISOString() } });
    m.onSettled({ projectId: 'p1', sessionId: 'x', status: 'completed', origin: 'relay', ownerHidden: true, triggerMessageId: d.triggerMessageId });
    const added = f.events.slice(before);
    expect(added.some((e) => e.kind === 'owner_view')).toBe(false);
    expect(added.find((e) => e.kind === 'conversation_settled')!.data.ownerHidden).toBe(true);
  });
});

describe('the history routes', () => {
  it('annotate a normal conversation and leave the Bot untouched', () => {
    const f = fixture(), api = controller(f);
    const dir = join(f.dir, 'cfg', 'projects', '-w');
    mkdirSync(dir, { recursive: true });
    const agent = withMessageSender('Build finished.', { kind: 'conversation', sessionId: 'y', projectId: 'p1', messageId: 'm-agent', conversationTitle: 'Y' });
    const lines = [
      { type: 'user', timestamp: '2026-10-21T01:00:00Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: '2026-10-21T01:00:05Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'user', timestamp: '2026-10-21T01:10:00Z', message: { role: 'user', content: agent } },
      { type: 'assistant', timestamp: '2026-10-21T01:10:05Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'noted' }] } },
    ];
    writeFileSync(join(dir, 'x.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const rows = (api.conversationHistory('p1', 'x', '50') as HistoryEntry[]).filter((r) => r.role !== 'model');
    expect(rows.map((r) => r.ownerView)).toEqual(['show', 'show', 'hide', 'hide']);
    expect(rows[2]).toMatchObject({ ownerTurn: 'agent', ownerSender: 'Y' });
    new OwnerViewStore(f.stateDir).markShown('x', 'm-agent', 'marker');
    const page = api.conversationHistoryPage('p1', 'x', '50') as { rows: HistoryEntry[] };
    const prows = page.rows.filter((r) => r.role !== 'model');
    expect(prows.map((r) => r.ownerView)).toEqual(['show', 'show', 'show', 'show']);
    expect(prows[2].forOwner).toBe(true);
    // the Bot's rows carry the Bot's fields and none of these
    const s = f.manager.bot().update({ enabled: true });
    const botDir = join(f.dir, 'cfg', 'projects', '-bot');
    mkdirSync(botDir, { recursive: true });
    writeFileSync(join(botDir, `${s.sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const bot = api.conversationHistory(s.projectId!, s.sessionId!, '50') as HistoryEntry[];
    expect(bot.some((r) => 'ownerView' in r || 'ownerTurn' in r)).toBe(false);
    expect(bot.every((r) => 'botView' in r || r.role === 'model')).toBe(true);
  });
});
