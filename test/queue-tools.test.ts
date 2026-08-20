import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../server/manager.js';
import { TOOLS, callTool } from '../scripts/x056-mcp-tools.mjs';

function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'x056-queue-'));
  const stateDir = join(dir, 'state');
  const cwd = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{ id: 'p1', name: 'P', cwd, provider: 'claude', conversations: [{ sessionId: 's1', title: 'Main' }], lastSessionId: 's1' }],
  }));
  return new SessionManager({ stateDir, workspaceRoot: dir });
}

describe('self-message brake', () => {
  it('allows a bounded run of self-messages, then refuses', () => {
    const m = manager();
    const limit = SessionManager.SELF_QUEUE_LIMIT;
    for (let i = 0; i < limit; i++) {
      const r = m.queueSelfMessage('p1', 's1', `step ${i}`);
      expect(r.remaining).toBe(limit - i - 1);
    }
    expect(() => m.queueSelfMessage('p1', 's1', 'one more')).toThrow(/self-message limit reached/);
  });

  it('resets once someone else sends to that conversation — the loop needs an outside nudge', () => {
    const m = manager();
    for (let i = 0; i < SessionManager.SELF_QUEUE_LIMIT; i++) m.queueSelfMessage('p1', 's1', 'x');
    expect(() => m.queueSelfMessage('p1', 's1', 'x')).toThrow();

    m.clearSelfQueueStreak('s1');
    expect(() => m.queueSelfMessage('p1', 's1', 'x')).not.toThrow();
  });

  it('counts per conversation, so one busy conversation cannot starve another', () => {
    const m = manager();
    for (let i = 0; i < SessionManager.SELF_QUEUE_LIMIT; i++) m.queueSelfMessage('p1', 's1', 'x');
    expect(() => m.queueSelfMessage('p1', 's1', 'x')).toThrow();
    expect(() => m.queueSelfMessage('p1', 's2', 'x')).not.toThrow();
  });

  it('returns an id and, when the conversation is IDLE, delivers at once rather than sitting in the queue', () => {
    const m = manager();
    const { id, remaining } = m.queueSelfMessage('p1', 's1', 'check the build');
    expect(id).toBeTruthy();
    expect(remaining).toBe(SessionManager.SELF_QUEUE_LIMIT - 1);
    // enqueue() kicks an immediate drain for an idle conversation, so nothing is
    // left waiting. From a RUNNING turn — the real caller — it queues instead
    // and drains when that turn ends.
    expect(m.queues()['p1']).toEqual([]);
  });
});

describe('queue MCP tools', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('exposes the four queue tools with schemas', () => {
    const names = TOOLS.map((t: { name: string }) => t.name);
    for (const n of ['list_queued', 'cancel_queued', 'edit_queued', 'message_self']) expect(names).toContain(n);
    for (const t of TOOLS) expect(t.inputSchema).toBeTruthy();
  });

  it('renders the queue oldest-first with the ids needed to act on it', async () => {
    const api = async () => ({
      p1: [
        { id: 'b', text: 'second', at: 2000, sessionId: 's1' },
        { id: 'a', text: 'first', at: 1000, sessionId: 's1' },
      ],
    });
    const out = await callTool(api, 'list_queued', {});
    expect(out.indexOf('id=a')).toBeLessThan(out.indexOf('id=b')); // oldest first
    expect(out).toContain('conversation=s1');
  });

  it('filters by conversation, so a busy project does not bury the one you asked about', async () => {
    const api = async () => ({
      p1: [{ id: 'a', text: 'mine', at: 1, sessionId: 's1' }, { id: 'b', text: 'theirs', at: 2, sessionId: 's2' }],
    });
    const out = await callTool(api, 'list_queued', { projectId: 'p1', sessionId: 's2' });
    expect(out).toContain('theirs');
    expect(out).not.toContain('mine');
  });

  it('says so plainly when nothing is queued', async () => {
    expect(await callTool(async () => ({}), 'list_queued', {})).toBe('(nothing queued)');
  });

  it('cancel and edit post to the queue endpoints', async () => {
    const calls: { path: string; body: any }[] = [];
    const api = async (path: string, opts: RequestInit = {}) => {
      calls.push({ path, body: opts.body ? JSON.parse(String(opts.body)) : null });
      return {};
    };
    await callTool(api, 'cancel_queued', { projectId: 'p1', id: 'q1' });
    await callTool(api, 'edit_queued', { projectId: 'p1', id: 'q1', message: 'revised' });
    expect(calls[0].path).toBe('/api/queue/remove');
    expect(calls[1].path).toBe('/api/queue/edit');
    expect(calls[1].body.prompt).toBe('revised'); // the endpoint's field name, not the tool's
  });

  it('refuses message_self when the client has no identity (an external client has no "self")', async () => {
    await expect(callTool(async () => ({}), 'message_self', { message: 'hi' }))
      .rejects.toThrow(/only available to a conversation running on this gateway/);
  });
});
