import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { RelayCheckpointError, SessionManager, relayNudge } from '../server/manager.js';
import { callTool, callToolResult } from '../scripts/x056-mcp-tools.mjs';
import { validateResult } from './helpers/mcp-contract.js';

/** A manager whose turns are stubbed: `holdMs` keeps a launched turn running,
 *  which is what makes a message QUEUE rather than start a fresh turn. */
function manager(holdMs = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-relay-'));
  const stateDir = join(dir, 'state');
  const cwd = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{
      id: 'p1', name: 'P', cwd, provider: 'claude',
      conversations: [{ sessionId: 'a', title: 'A' }, { sessionId: 'b', title: 'B' }],
      lastSessionId: 'a',
    }],
  }));
  const runSessionFn = (async (o: { control?: (c: { abort: () => void }) => void }) => {
    let aborted = false;
    o.control?.({ abort: () => { aborted = true; } });
    for (let waited = 0; waited < holdMs && !aborted; waited += 10) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { status: 'completed', finalAccount: 'a', failovers: 0, resultText: 'ok' };
  }) as unknown as typeof import('../src/failover.js').runSession;
  return new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
}

/** One AI-to-AI hop: `from`'s turn messages `to`. */
const hop = (m: SessionManager, from: string, to: string, confirmRelay?: boolean) =>
  m.deliverMcpMessage('p1', to, 'have a look at this', { from, interactive: false, ...(confirmRelay ? { confirmRelay } : {}) });

/** Run a↔b ping-pong for `n` hops (confirming any checkpoint on the way);
 *  returns whose turn it is to send next. */
function pingPong(m: SessionManager, n: number): [string, string] {
  let [from, to] = ['a', 'b'];
  for (let i = 0; i < n; i++) { hop(m, from, to, true); [from, to] = [to, from]; }
  return [from, to];
}

describe('the relay checkpoint', () => {
  const LIMIT = SessionManager.RELAY_HOP_LIMIT;

  it('delivers hops 1-6 freely, as under the old cap, reporting how far the checkpoint is', () => {
    const m = manager();
    // a↔b ping-pong, each side answering the other. This is the exact shape of
    // the failure: both sides are being helpful and neither can see the loop.
    let [from, to] = ['a', 'b'];
    for (let i = 1; i <= LIMIT; i++) {
      const r = hop(m, from, to);
      expect(r.hopsUntilCheck).toBe(LIMIT + 1 - i); // 6 at hop 1, 1 at hop 6
      expect(r.hopsLeft).toBe(r.hopsUntilCheck); // the old name, kept as an alias
      expect(r).not.toHaveProperty('confirmedCheckpoint');
      [from, to] = [to, from];
    }
  });

  it('holds hop 7 without confirm: nothing is sent, and the caller is asked, not refused', () => {
    const m = manager();
    const [from, to] = pingPong(m, LIMIT);
    const before = m.relayDepth(to);
    let err: unknown;
    try { hop(m, from, to); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RelayCheckpointError);
    const cp = err as RelayCheckpointError;
    expect(cp.body()).toEqual({ error: 'relay_confirm_required', hops: LIMIT + 1, checkpointEvery: LIMIT, message: relayNudge(LIMIT + 1) });
    expect(cp.message).toBe(`This is hop ${LIMIT + 1} of an AI-to-AI exchange with no human message since it started. Before sending more: is this converging? If the other side is repeating itself or you are going back and forth, stop and report to the user instead. To send anyway, call again with confirm_relay: true.`);
    expect(m.relayDepth(to)).toBe(before); // not delivered: the target's chain did not move
  });

  it('the same call with confirmRelay is delivered; hops 8-12 are free and 13 is the next checkpoint', () => {
    const m = manager();
    let [from, to] = pingPong(m, LIMIT);
    const r = hop(m, from, to, true);
    expect(r).toMatchObject({ confirmedCheckpoint: true, hopsUntilCheck: LIMIT, hopsLeft: LIMIT });
    expect(m.relayDepth(to)).toBe(LIMIT + 1);
    [from, to] = [to, from];
    // hops 8-12 go through without confirming
    for (let i = LIMIT + 2; i <= 2 * LIMIT; i++) {
      const out = hop(m, from, to);
      expect(out.hopsUntilCheck).toBe(2 * LIMIT + 1 - i); // 5 at hop 8, 1 at hop 12
      expect(out).not.toHaveProperty('confirmedCheckpoint');
      [from, to] = [to, from];
    }
    // hop 13 is the next checkpoint
    expect(() => hop(m, from, to)).toThrow(RelayCheckpointError);
    expect(hop(m, from, to, true)).toMatchObject({ confirmedCheckpoint: true, hopsUntilCheck: LIMIT });
    expect(m.relayDepth(to)).toBe(2 * LIMIT + 1);
  });

  it('has no hard cap: a confirmed exchange keeps going past where the old limit stopped it', () => {
    const m = manager();
    pingPong(m, 4 * LIMIT + 1);
    expect(Math.max(m.relayDepth('a'), m.relayDepth('b'))).toBe(4 * LIMIT + 1);
  });

  it('ignores confirmRelay when no checkpoint is due', () => {
    const m = manager();
    const r = hop(m, 'a', 'b', true);
    expect(r.hopsUntilCheck).toBe(LIMIT);
    expect(r).not.toHaveProperty('confirmedCheckpoint');
  });

  it('counts a chain that fans out, not just a ping-pong', () => {
    // a → b → a → b is the same chain as a → b → c → d would be: depth follows
    // the chain, not the pair, so routing through a third conversation does not
    // dodge the checkpoint.
    const m = manager();
    expect(hop(m, 'a', 'b').hopsUntilCheck).toBe(LIMIT);
    expect(hop(m, 'b', 'a').hopsUntilCheck).toBe(LIMIT - 1);
    expect(hop(m, 'a', 'b').hopsUntilCheck).toBe(LIMIT - 2);
  });

  it('starts fresh for a message with no sender — a human, a cron job, an external client', () => {
    const m = manager();
    pingPong(m, LIMIT);
    // No `from`: this is not part of the exchange, so it neither counts nor is
    // held by it.
    expect(m.deliverMcpMessage('p1', 'b', 'scheduled check', { interactive: false }).hopsUntilCheck).toBe(LIMIT);
  });

  it('resets when a human speaks, so the next 6 hops are free again and 7 is checked', () => {
    const m = manager();
    const [from, to] = pingPong(m, LIMIT);
    expect(() => hop(m, from, to)).toThrow(RelayCheckpointError);

    m.clearRelayChain(from); // what the panel's send does
    expect(hop(m, from, to).hopsUntilCheck).toBe(LIMIT);
    // A person talking to both sides: the whole exchange starts over.
    m.clearRelayChain(from); m.clearRelayChain(to);
    expect(hop(m, from, to).hopsUntilCheck).toBe(LIMIT); // hop 1
    let [f2, t2] = [to, from];
    for (let i = 2; i <= LIMIT; i++) { hop(m, f2, t2); [f2, t2] = [t2, f2]; } // hops 2-6 free
    expect(() => hop(m, f2, t2)).toThrow(RelayCheckpointError); // hop 7
  });

  it('does not hand back hops when the other side is stopped', () => {
    // Otherwise a pair could halt each other to skip the checkpoint.
    const m = manager();
    const [from, to] = pingPong(m, LIMIT);
    m.haltConversation('p1', from);
    m.haltConversation('p1', to);
    expect(() => hop(m, from, to)).toThrow(RelayCheckpointError);
  });

  it('never lowers a conversation\'s depth when a shallower chain arrives', () => {
    const m = manager();
    hop(m, 'a', 'b'); // b is 1 deep
    hop(m, 'b', 'a'); // a is 2 deep
    hop(m, 'a', 'b'); // b is 3 deep
    // A separate exchange opening on b at depth 1 must not reset it.
    m.deliverMcpMessage('p1', 'b', 'unrelated', { from: 'c', interactive: false });
    expect(m.relayDepth('b')).toBe(3);
  });
});

describe('haltConversation', () => {
  it('drops what is queued, not just the running turn — the queue would just restart it', () => {
    const m = manager(5000);
    m.deliverMcpMessage('p1', 'b', 'go', { interactive: false }); // b is now busy
    m.deliverMcpMessage('p1', 'a', 'go', { interactive: false });
    m.enqueue('p1', { text: 'one', sessionId: 'b' });
    m.enqueue('p1', { text: 'two', sessionId: 'b' });
    m.enqueue('p1', { text: 'elsewhere', sessionId: 'a' });
    const out = m.haltConversation('p1', 'b');
    expect(out.stopped).toBe(true);
    expect(out.dropped).toBe(2);
    // A sibling conversation's queue is untouched.
    expect((m.queues()['p1'] ?? []).map((q) => q.sessionId)).toEqual(['a']);
  });

  it('leaves the queue alone when asked to', () => {
    const m = manager(5000);
    m.deliverMcpMessage('p1', 'b', 'go', { interactive: false }); // b is now busy
    m.enqueue('p1', { text: 'keep me', sessionId: 'b' });
    expect(m.haltConversation('p1', 'b', false).dropped).toBe(0);
    expect((m.queues()['p1'] ?? []).length).toBe(1);
  });

  it('reports honestly when there was no turn to stop', () => {
    const m = manager();
    expect(m.haltConversation('p1', 'b').stopped).toBe(false);
  });
});

describe('the stop_conversation tool', () => {
  it('halts through the gateway and says what it did', async () => {
    const calls: { path: string; body: unknown }[] = [];
    const api = async (path: string, opts: RequestInit = {}) => {
      calls.push({ path, body: opts.body ? JSON.parse(String(opts.body)) : undefined });
      return { stopped: true, dropped: 2 };
    };
    const out = await callTool(api, 'stop_conversation', { projectId: 'p1', sessionId: 'b' });
    expect(calls[0].path).toBe('/api/conversations/halt');
    expect(calls[0].body).toEqual({ projectId: 'p1', sessionId: 'b', dropQueued: undefined });
    expect(out).toContain('stopped its running turn');
    expect(out).toContain('dropped 2 queued message(s)');
  });

  it('does not claim to have stopped something that was already idle', async () => {
    const api = async () => ({ stopped: false, dropped: 0 });
    const out = await callTool(api, 'stop_conversation', { projectId: 'p1', sessionId: 'b' });
    expect(out).toContain('no turn running');
    expect(out).toContain('nothing was queued');
  });
});

describe('send_message carries its own identity', () => {
  it('sends `from` so the gateway can count the hop, and reports how far the checkpoint is', async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = async (path: string, opts: RequestInit = {}) => {
      if (path.startsWith('/api/conversations/history')) return [];
      bodies.push(opts.body ? JSON.parse(String(opts.body)) : {});
      return { mode: 'auto', sessionId: 'b', queued: false, hopsUntilCheck: 1, hopsLeft: 1 };
    };
    // SELF is read at import time, so re-evaluate the module with the env set.
    vi.stubEnv('X056_SELF_SESSION_ID', 'a');
    vi.stubEnv('X056_SELF_PROJECT_ID', 'p1');
    vi.resetModules();
    const fresh = await import('../scripts/x056-mcp-tools.mjs');
    const out = await fresh.callTool(api, 'send_message', { projectId: 'p1', sessionId: 'b', message: 'hi' });
    expect(bodies[0].from).toBe('a');
    expect(bodies[0]).not.toHaveProperty('confirmRelay');
    expect(out).toContain('1 hop(s) until the next relay checkpoint');
    vi.unstubAllEnvs();
  });
});

describe('the MCP tools at a relay checkpoint', () => {
  const nudge = relayNudge(7);
  /** What both api helpers throw on a 409 relay_confirm_required. */
  const checkpointError = () => Object.assign(new Error(nudge), { status: 409, body: { error: 'relay_confirm_required', hops: 7, checkpointEvery: 6, message: nudge } });

  it('send_message turns the 409 into plain "Not sent yet" text, not a failure, and passes confirm_relay through', async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = async (_path: string, opts: RequestInit = {}) => {
      const body = JSON.parse(String(opts.body));
      bodies.push(body);
      if (!body.confirmRelay) throw checkpointError();
      return { mode: 'auto', sessionId: 'b', queued: false, hopsUntilCheck: 6, hopsLeft: 6, confirmedCheckpoint: true, messageId: 'm1' };
    };
    const held = await callToolResult(api, 'send_message', { projectId: 'p1', sessionId: 'b', message: 'again' });
    expect(held).not.toHaveProperty('isError');
    expect(held.content[0].text).toBe(`Not sent yet (relay checkpoint): ${nudge}`);
    expect(validateResult('send_message', held).delivery).toMatchObject({ status: 'relay_checkpoint', hops: 7, checkpointEvery: 6, note: nudge });

    const sent = await callToolResult(api, 'send_message', { projectId: 'p1', sessionId: 'b', message: 'again', confirm_relay: true });
    expect(bodies[1].confirmRelay).toBe(true);
    expect(sent.content[0].text).toContain('Relay checkpoint confirmed.');
    expect(validateResult('send_message', sent).delivery).toMatchObject({ status: 'sent', confirmedCheckpoint: true, hopsUntilCheck: 6, hopsLeft: 6 });
  });

  it('steer and send_chat_message do the same; any other error still throws', async () => {
    const steerApi = async (_path: string, opts: RequestInit = {}) => {
      if (!JSON.parse(String(opts.body)).confirmRelay) throw checkpointError();
      return { delivered: 'steered', mode: 'auto', projectId: 'p1', sessionId: 'b', hopsUntilCheck: 6, hopsLeft: 6, confirmedCheckpoint: true, messageId: 'm1' };
    };
    const held = await callToolResult(steerApi, 'steer', { text: 'x', project_id: 'p1', session_id: 'b' });
    expect(held.content[0].text).toMatch(/^Not sent yet \(relay checkpoint\): This is hop 7/);
    expect(validateResult('steer', held)).toMatchObject({ delivered: 'relay_checkpoint', hops: 7 });
    const ok = await callToolResult(steerApi, 'steer', { text: 'x', project_id: 'p1', session_id: 'b', confirm_relay: true });
    expect(validateResult('steer', ok)).toMatchObject({ delivered: 'steered', confirmedCheckpoint: true });

    const chatBodies: Record<string, unknown>[] = [];
    const chatApi = async (path: string, opts: RequestInit = {}) => {
      if (path.startsWith('/api/chats/')) return { id: 'c1', lastSessionId: 'cs' };
      const body = JSON.parse(String(opts.body)); chatBodies.push(body);
      if (!body.confirmRelay) throw checkpointError();
      return { mode: 'auto', sessionId: 'cs', queued: false, hopsUntilCheck: 6, hopsLeft: 6, confirmedCheckpoint: true, messageId: 'm2' };
    };
    const chatHeld = await callToolResult(chatApi, 'send_chat_message', { chatId: 'c1', message: 'x' });
    expect(chatHeld.content[0].text).toMatch(/^Not sent yet \(relay checkpoint\):/);
    await callToolResult(chatApi, 'send_chat_message', { chatId: 'c1', message: 'x', confirm_relay: true });
    expect(chatBodies[1]).toMatchObject({ projectId: 'c1', sessionId: 'cs', confirmRelay: true });

    const broken = async () => { throw Object.assign(new Error('unknown conversation for that project'), { status: 400, body: { message: 'unknown conversation for that project' } }); };
    await expect(callToolResult(broken, 'send_message', { projectId: 'p1', sessionId: 'b', message: 'x' })).rejects.toThrow(/unknown conversation/);
  });
});
