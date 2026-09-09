import { describe, expect, it, vi } from 'vitest';
import { callToolResult } from '../scripts/x056-mcp-tools.mjs';
import { validateResult } from './helpers/mcp-contract.js';

describe('MCP activity observations', () => {
  const projects = { projects: [{ id: 'p', name: 'Project', runningSessionIds: ['s'], backgroundSessionIds: ['b'], runningAccounts: { s: 'account-a' }, conversations: [
    { sessionId: 's', title: 'Running', provider: 'codex', lastMessageAt: 300 },
    { sessionId: 'b', title: 'Background', lastMessageAt: 200 },
    { sessionId: 'q', title: 'Question', lastMessageAt: 100 },
    { sessionId: 'f', title: 'Failed', lastOutcome: { status: 'failed' } },
  ] }], activityPending: 2 };
  const questions = [{ projectId: 'p', sessionId: 'q', question: 'Which option?', options: ['A', 'B'], at: '2026-01-01T00:00:00Z' }];
  const api = async (path: string): Promise<any> => {
    if (path === '/api/projects') return projects;
    if (path === '/api/questions') return questions;
    if (path === '/api/sessions') return { running: false, runningProjects: [], backgroundProjects: [] };
    if (path === '/api/workflows/live') return { runs: [] };
    throw new Error('Unexpected path');
  };
  it('keeps busy true when observations differ and preserves independent status flags', async () => {
    const data = validateResult('get_activity', await callToolResult(api, 'get_activity', {}));
    expect(data.busy).toBe(true);
    expect(data.conversations.map((c: any) => c.sessionId)).toEqual(['s', 'b', 'q']);
    expect(data.conversations[0]).toMatchObject({ account: 'account-a', running: true, provider: 'codex' });
    expect(data.questions[0].question).toBe('Which option?');
  });
  it('does not mistake a workflow without a running conversation for idle', async () => {
    const wrapped = async (path: string) => path === '/api/projects' ? { projects: [] } : path === '/api/workflows/live' ? { runs: [{ sessionId: 'orphan', runId: 'w', started: 3, finished: 1 }] } : api(path);
    expect(validateResult('get_activity', await callToolResult(wrapped, 'get_activity', {})).busy).toBe(true);
  });
  it('propagates workflow read errors and rejects malformed activity data', async () => {
    await expect(callToolResult(async path => {
      if (path === '/api/workflows/live') throw new Error('workflow unavailable');
      return api(path);
    }, 'get_activity', {})).rejects.toThrow('workflow unavailable');
    await expect(callToolResult(async path => path === '/api/sessions' ? {} : api(path), 'get_activity', {})).rejects.toThrow('Activity data unavailable');
  });
  it('filters and paginates by project, provider, title and status', async () => {
    const search = async (args: Record<string, unknown>) => validateResult('search_conversations', await callToolResult(api, 'search_conversations', args));
    expect((await search({ status: 'needs_input' })).items[0].sessionId).toBe('q');
    expect((await search({ status: 'background' })).items[0].sessionId).toBe('b');
    expect((await search({ status: 'failed' })).items[0].sessionId).toBe('f');
    expect((await search({ projectId: 'missing' })).total).toBe(0);
    expect((await search({ query: 'PROJECT', provider: 'codex' })).total).toBe(1);
    const page = await search({ limit: 1, offset: 1 });
    expect(page).toMatchObject({ total: 4, truncated: true, activityPending: 2 });
    expect(page.items[0].sessionId).toBe('b');
  });
  it('does not publish an artifact after invalid arguments', async () => {
    const api = vi.fn();
    for (const args of [{ path: 'relative.png' }, { path: '/tmp/file.png', summary: 'test' }, { url: 'https://example.test', status: 'passed' }])
      await expect(callToolResult(api, 'register_artifact', { projectId: 'p', sessionId: 's', ...args })).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });
});
