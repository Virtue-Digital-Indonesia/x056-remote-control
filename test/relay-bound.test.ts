import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { RelayLimitError, SessionManager } from '../server/manager.js';
import { callTool } from '../scripts/x056-mcp-tools.mjs';

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
const hop = (m: SessionManager, from: string, to: string) =>
  m.deliverMcpMessage('p1', to, 'have a look at this', { from, interactive: false });

describe('the relay bound', () => {
  const LIMIT = SessionManager.RELAY_HOP_LIMIT;

  it('lets two conversations trade a bounded number of messages, then refuses', () => {
    const m = manager();
    // a↔b ping-pong, each side answering the other. This is the exact shape of
    // the failure: both sides are being helpful and neither can see the loop.
    let from = 'a';
    let to = 'b';
    for (let i = 1; i <= LIMIT; i++) {
      expect(hop(m, from, to).hopsLeft).toBe(LIMIT - i);
      [from, to] = [to, from];
    }
    expect(() => hop(m, from, to)).toThrow(RelayLimitError);
  });

  it('names the cap and tells the caller to report to the human instead', () => {
    const m = manager();
    let [from, to] = ['a', 'b'];
    for (let i = 0; i < LIMIT; i++) { hop(m, from, to); [from, to] = [to, from]; }
    expect(() => hop(m, from, to)).toThrow(/relay limit reached/i);
    expect(() => hop(m, from, to)).toThrow(/for the human/i);
  });

  it('counts a chain that fans out, not just a ping-pong', () => {
    // a → b → a → b is the same chain as a → b → c → d would be: depth follows
    // the chain, not the pair, so routing through a third conversation to dodge
    // the cap does not work.
    const m = manager();
    expect(hop(m, 'a', 'b').hopsLeft).toBe(LIMIT - 1);
    expect(hop(m, 'b', 'a').hopsLeft).toBe(LIMIT - 2);
    expect(hop(m, 'a', 'b').hopsLeft).toBe(LIMIT - 3);
  });

  it('starts fresh for a message with no sender — a human, a cron job, an external client', () => {
    const m = manager();
    let [from, to] = ['a', 'b'];
    for (let i = 0; i < LIMIT; i++) { hop(m, from, to); [from, to] = [to, from]; }
    // No `from`: this is not part of the exchange, so it neither counts nor is
    // blocked by it.
    expect(m.deliverMcpMessage('p1', 'b', 'scheduled check', { interactive: false }).hopsLeft).toBe(LIMIT - 1);
  });

  it('resets when a human speaks — that is the only thing that clears it', () => {
    const m = manager();
    let [from, to] = ['a', 'b'];
    for (let i = 0; i < LIMIT; i++) { hop(m, from, to); [from, to] = [to, from]; }
    expect(() => hop(m, from, to)).toThrow(RelayLimitError);

    m.clearRelayChain(from); // what the panel's send does
    expect(hop(m, from, to).hopsLeft).toBe(LIMIT - 1);
  });

  it('does not hand back hops when the other side is stopped', () => {
    // Otherwise an exhausted pair could halt each other to buy another round.
    const m = manager();
    let [from, to] = ['a', 'b'];
    for (let i = 0; i < LIMIT; i++) { hop(m, from, to); [from, to] = [to, from]; }
    m.haltConversation('p1', from);
    m.haltConversation('p1', to);
    expect(() => hop(m, from, to)).toThrow(RelayLimitError);
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
  it('sends `from` so the gateway can count the hop, and reports what is left', async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = async (path: string, opts: RequestInit = {}) => {
      if (path.startsWith('/api/conversations/history')) return [];
      bodies.push(opts.body ? JSON.parse(String(opts.body)) : {});
      return { mode: 'auto', sessionId: 'b', queued: false, hopsLeft: 1 };
    };
    // SELF is read at import time, so re-evaluate the module with the env set.
    vi.stubEnv('X056_SELF_SESSION_ID', 'a');
    vi.stubEnv('X056_SELF_PROJECT_ID', 'p1');
    vi.resetModules();
    const fresh = await import('../scripts/x056-mcp-tools.mjs');
    const out = await fresh.callTool(api, 'send_message', { projectId: 'p1', sessionId: 'b', message: 'hi' });
    expect(bodies[0].from).toBe('a');
    expect(out).toContain('1 hop(s) left');
    expect(out).toContain('Plan to finish here.');
    vi.unstubAllEnvs();
  });
});
