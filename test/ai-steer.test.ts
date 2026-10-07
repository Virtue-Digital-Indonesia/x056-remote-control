import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { readMessageSender } from '../src/message-sender.js';
import { RelayLimitError, SessionManager } from '../server/manager.js';
import { ConversationJournal } from '../server/conversation-journal.js';
import { buildTurns } from '../server/agent-tree.js';
import { createApp } from '../server/main.js';

/**
 * AI steers: send_message {steer}, the steer tool, message_self {steer}.
 * Turns are stubbed (`hold` keeps one running until released) and the
 * persistent pools are replaced by a recorder, so "steered" here means "the
 * gateway handed the text to the live process of a RUNNING gateway turn".
 */
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Inject = { sid: string; text: string; requireTurn?: boolean };
function stubPools(mgr: SessionManager, accept: () => boolean = () => true): Inject[] {
  const injected: Inject[] = [];
  vi.spyOn(mgr as unknown as { pools: () => unknown[] }, 'pools').mockReturnValue([{
    injectMessage: async (sid: string, text: string, o: { requireTurn?: boolean } = {}) => {
      if (!accept()) return false;
      injected.push({ sid, text, requireTurn: o.requireTurn });
      return true;
    },
    activeSessions: () => [], workingSessions: () => [], workingAccounts: () => [], agentRunning: () => undefined,
    interruptSession: () => false, retireIdleSession: () => true, shutdown: () => {},
  }]);
  return injected;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'x056-steer-')); dirs.push(dir);
  const stateDir = join(dir, 'state');
  const cwd = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{ id: 'p1', name: 'P', cwd, provider: 'claude',
      conversations: [{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }], lastSessionId: 'a' }],
  }));
  const open = new Map<string, () => void>();
  const runSessionFn = ((o: { sessionId: string; control?: (c: { abort: () => void }) => void }) => new Promise((resolve) => {
    const done = () => resolve({ status: 'completed', finalAccount: 'a', failovers: 0, resultText: 'ok' });
    open.set(o.sessionId, done);
    o.control?.({ abort: done });
  })) as unknown as typeof import('../src/failover.js').runSession;
  const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  mgr.subscribe((e) => events.push({ kind: e.kind, data: e.data as Record<string, unknown> }));
  const end = async (sid: string) => { const f = open.get(sid); open.delete(sid); f?.(); await new Promise((r) => setTimeout(r, 30)); };
  return { mgr, stateDir, events, end, busy: (sid: string) => mgr.isSessionRunning(sid) };
}
/** Start a turn on `sid` and leave it running. */
const run = (f: ReturnType<typeof fixture>, sid: string) => f.mgr.deliverMcpMessage('p1', sid, 'work on it', { interactive: false });

describe('steerFromAi: only into a running gateway turn', () => {
  it('never injects into an idle conversation: send_message {steer} falls back to an ordinary send', async () => {
    const f = fixture(); const injected = stubPools(f.mgr);
    expect(await f.mgr.steerFromAi('p1', 'b', 'look at X', { kind: 'mcp' })).toBe(false);
    const out = await f.mgr.deliverMcpSteer('p1', 'b', 'look at X', { from: 'a', interactive: false });
    expect(out).toMatchObject({ steered: false, queued: false, sessionId: 'b', hopsLeft: SessionManager.RELAY_HOP_LIMIT - 1 });
    expect(injected).toEqual([]);
    expect(f.busy('b')).toBe(true); // the send started a turn instead
    await f.end('b');
  });

  it('a busy turn takes it: sender marker, live event, journal row that is not a turn', async () => {
    const f = fixture(); const injected = stubPools(f.mgr);
    run(f, 'b');
    const out = await f.mgr.deliverMcpSteer('p1', 'b', 'the bug is in parse()', { from: 'a', interactive: false });
    expect(out).toMatchObject({ steered: true, queued: false, hopsLeft: SessionManager.RELAY_HOP_LIMIT - 1 });
    expect(injected).toHaveLength(1);
    expect(injected[0].requireTurn).toBe(true); // never an idle process
    const parsed = readMessageSender(injected[0].text);
    expect(parsed.text).toBe('the bug is in parse()');
    expect(parsed.sender).toMatchObject({ kind: 'conversation', sessionId: 'a', conversationTitle: 'A', messageId: out.messageId });
    expect(f.events.find((e) => e.kind === 'steered')?.data).toMatchObject({ projectId: 'p1', sessionId: 'b', text: 'the bug is in parse()', messageId: out.messageId });
    expect(f.mgr.relayDepth('b')).toBe(1);
    const journal = new ConversationJournal(f.stateDir).turnSource('p1', 'b');
    const row = journal.rows.find((r) => r.messageId === out.messageId);
    expect(row).toMatchObject({ role: 'user', steered: true, sender: { kind: 'conversation', sessionId: 'a' } });
    // The steer is not a turn of its own in the agent tree.
    expect(buildTurns(journal.rows, journal.ends, true)).toHaveLength(1);
    expect(new ConversationJournal(f.stateDir).lastPromptAt('p1', 'b')).toBe(journal.rows.find((r) => r.role === 'user' && !r.steered)!.ts);
    await f.end('b');
  });

  it('a steer the process refuses (Codex: no active turn) is queued, not lost', async () => {
    const f = fixture(); stubPools(f.mgr, () => false);
    run(f, 'b');
    const out = await f.mgr.deliverMcpSteer('p1', 'b', 'late news', { from: 'a', interactive: false });
    expect(out).toMatchObject({ steered: false, queued: true });
    expect(f.mgr.queues()['p1'].map((q) => q.text)).toEqual(['late news']);
    await f.end('b');
  });

  it('two conversations steering each other stop at the relay bound', async () => {
    const f = fixture(); stubPools(f.mgr);
    run(f, 'a'); run(f, 'b');
    f.mgr.clearRelayChain('a'); f.mgr.clearRelayChain('b'); // as if a person started both
    let [from, to] = ['a', 'b'];
    for (let i = 1; i <= SessionManager.RELAY_HOP_LIMIT; i++) {
      expect((await f.mgr.deliverMcpSteer('p1', to, `round ${i}`, { from, interactive: false })).hopsLeft).toBe(SessionManager.RELAY_HOP_LIMIT - i);
      [from, to] = [to, from];
    }
    await expect(f.mgr.deliverMcpSteer('p1', to, 'one more', { from, interactive: false })).rejects.toBeInstanceOf(RelayLimitError);
    await f.end('a'); await f.end('b');
  });
});

describe('self steers', () => {
  it('count on the self streak and stop at the limit; idle = queued', async () => {
    const f = fixture(); const injected = stubPools(f.mgr);
    run(f, 'a');
    const limit = SessionManager.SELF_QUEUE_LIMIT;
    for (let i = 0; i < limit; i++) expect(await f.mgr.steerSelf('p1', 'a', `note ${i}`)).toMatchObject({ delivered: 'steered', remaining: limit - i - 1 });
    await expect(f.mgr.steerSelf('p1', 'a', 'again')).rejects.toThrow(/self-message limit/);
    expect(injected).toHaveLength(limit);
    expect(f.mgr.relayDepth('a')).toBe(1); // unchanged: the self streak counts, not the relay chain
    await f.end('a');
    f.mgr.clearSelfQueueStreak('a');
    vi.useFakeTimers(); // keep the queued item from draining
    expect(await f.mgr.steerSelf('p1', 'a', 'for later')).toMatchObject({ delivered: 'queued', remaining: limit - 1 });
    vi.useRealTimers();
  });
});

describe('approval mode', () => {
  it('approved while the turn runs: steered; approved after it ended: delivered as a new message, and says so', async () => {
    const f = fixture(); const injected = stubPools(f.mgr);
    run(f, 'b');
    const a = f.mgr.requestMcpSend('p1', 'b', 'check the schema', { from: 'a', interactive: false, steer: true });
    expect(a).toMatchObject({ status: 'pending', steer: true });
    f.mgr.decideMcpApproval(a.id, true);
    await f.mgr.approvalSettled(a.id);
    expect(f.mgr.mcpApprovalStatus(a.id)).toMatchObject({ status: 'approved', delivered: 'steered', resultSessionId: 'b', queued: false });
    expect(f.mgr.mcpApprovalStatus(a.id)?.delivering).toBeUndefined();
    expect(injected).toHaveLength(1);
    expect(f.mgr.relayDepth('b')).toBe(1); // approved = human: the count starts over

    const late = f.mgr.requestMcpSend('p1', 'b', 'and the index', { from: 'a', interactive: false, steer: true });
    await f.end('b');
    f.mgr.decideMcpApproval(late.id, true);
    await f.mgr.approvalSettled(late.id);
    expect(f.mgr.mcpApprovalStatus(late.id)).toMatchObject({ status: 'approved', delivered: 'started', note: 'Delivered as a new message: the turn had ended.' });
    expect(injected).toHaveLength(1);
    expect(f.busy('b')).toBe(true);
    await f.end('b');
  });
});

describe('the steer tool over HTTP (what a Claude subagent reaches: it shares the parent\'s x056 server and env)', () => {
  let app: INestApplication | undefined;
  afterEach(async () => { await app?.close(); app = undefined; });

  it('no target + SELF ids -> /api/conversations/steer -> into the parent\'s running turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-steer-http-')); dirs.push(dir);
    mkdirSync(join(dir, 'work'));
    AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'fixture', configDir: join(dir, 'account') }]);
    writeFileSync(join(dir, 'projects.json'), JSON.stringify({ current: 'p', projects: [
      { id: 'p', name: 'Fixture', cwd: join(dir, 'work'), conversations: [{ sessionId: 's', title: 'Parent' }, { sessionId: 't', title: 'Other' }] }] }));
    const token = 'steer-fixture-token-0123456789';
    app = await createApp({ token, stateDir: dir, workspaceRoot: dir });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const mgr = app.get(SessionManager);
    const injected = stubPools(mgr);
    // The parent's turn is running (the subagent runs inside it).
    vi.spyOn(mgr as unknown as { sessionBusy: (sid: string) => boolean }, 'sessionBusy').mockImplementation((sid) => sid === 's');
    const api = async (path: string, opts: RequestInit = {}) => {
      const r = await fetch(base + path, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      return data;
    };
    vi.stubEnv('X056_SELF_PROJECT_ID', 'p'); vi.stubEnv('X056_SELF_SESSION_ID', 's');
    vi.resetModules();
    const tools = await import('../scripts/x056-mcp-tools.mjs');
    const r = await tools.callToolResult(api, 'steer', { text: 'subagent: the failing test is flaky, not broken' });
    expect(r.content[0].text).toMatch(/^steered into the running turn/);
    expect(injected).toHaveLength(1);
    expect(injected[0].sid).toBe('s');
    expect(readMessageSender(injected[0].text).sender).toMatchObject({ kind: 'conversation', sessionId: 's' });
    // A self-steer claimed for another conversation is refused.
    await expect(api('/api/conversations/steer', { method: 'POST', body: JSON.stringify({ prompt: 'x', self: { projectId: 'p', sessionId: 's' }, from: 't' }) })).rejects.toThrow(/must come from that conversation/);
    // A made-up delegate cannot skip the approval gate.
    await expect(api('/api/conversations/steer', { method: 'POST', body: JSON.stringify({ prompt: 'x', delegate: { of: 'p/s', id: 'd-nope' } }) })).rejects.toThrow(/unknown delegate/);
  });
});
