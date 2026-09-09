import 'reflect-metadata';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { CRON, CronScheduler } from '../server/cron.js';
import { CODEGRAPH, CodegraphClient } from '../server/codegraph.js';
import { AccountRegistry } from '../src/accounts.js';
import { TOOLS, callToolResult } from '../scripts/x056-mcp-tools.mjs';
import { ajv, validators, validateResult } from './helpers/mcp-contract.js';

const token = 'disposable-mcp-output-contract-fixture';
let dir: string, app: INestApplication, base: string, manager: SessionManager, cron: CronScheduler;
const covered = new Set<string>();
async function api(path: string, opts: RequestInit = {}) {
  const r = await fetch(base + path, { ...opts, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message);
  return data;
}
async function tool(name: string, args = {}) {
  const r = await api('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  covered.add(name);
  const data = validateResult(name, r.result);
  return { ...r.result, data };
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-output-'));
  mkdirSync(join(dir, 'work'));
  AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'fixture', configDir: join(dir, 'account') }]);
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ current: 'p', projects: [
    { id: 'p', name: 'Fixture', cwd: join(dir, 'work'), conversations: [
      { sessionId: 's', title: 'Legacy' },
      { sessionId: 'c', title: 'Codex', provider: 'codex', createdAt: 1, model: '', effort: '' },
    ] },
  ] }));
  app = await createApp({ token, stateDir: dir, workspaceRoot: dir });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  manager = app.get(SessionManager);
  cron = app.get(CRON);
  cron.stop(); // Fixture jobs can only run when this test explicitly ticks them.
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs(); });
afterAll(async () => { await app?.close(); manager?.memory().close(); rmSync(dir, { recursive: true, force: true }); });

describe('all advertised output contracts', () => {
  it('compiles 28 useful object schemas strictly and rejects empty or wrong results', () => {
    expect(TOOLS).toHaveLength(28);
    expect(validators.size).toBe(28);
    for (const tool of TOOLS) {
      expect(tool.outputSchema.type).toBe('object');
      expect(ajv.validateSchema(tool.outputSchema)).toBe(true);
      const check = validators.get(tool.name)!;
      expect(check({}), tool.name).toBe(false);
      expect(check([]), tool.name).toBe(false);
      expect(check({ error: 42 }), tool.name).toBe(false);
    }
  });

  it('returns actual project/conversation/history results with optional values and empty lists', async () => {
    const projects = await tool('list_projects');
    expect(projects.data.projects[0].provider).toBe('claude');
    const conversations = await tool('list_conversations', { projectId: 'p' });
    expect(conversations.data.conversations[0]).not.toHaveProperty('createdAt');
    expect(conversations.data.conversations[1]).toMatchObject({ provider: 'codex', model: '', effort: '', createdAt: '1970-01-01T00:00:00.001Z' });
    expect((await tool('read_conversation', { projectId: 'p', sessionId: 'unavailable' })).data.messages).toEqual([]);
    const empty = await callToolResult(async () => ({ projects: [] }), 'list_projects', {});
    expect(validateResult('list_projects', empty).projects).toEqual([]);
    const history = await callToolResult(async () => [
      { role: 'user', text: 'hello', sender: { kind: 'conversation', projectName: 'Source', conversationTitle: 'Reviewer' } }, { role: 'action', text: 'internal action' },
      { role: 'assistant', text: 'reply', ts: '2026-09-08T00:00:00Z' },
    ], 'read_conversation', { projectId: 'p', sessionId: 's' });
    expect(validateResult('read_conversation', history).messages).toHaveLength(2);
    expect(validateResult('read_conversation', history).messages[0].sender.projectName).toBe('Source');
  });

  it('exercises queue edits, cancellation, self limits and stop only in the fixture', async () => {
    expect((await tool('list_queued')).data.messages).toEqual([]);
    const first = manager.enqueue('p', { text: 'first', sender: { kind: 'autopilot' }, sessionId: 's', paused: true, model: '', effort: '', notBefore: Date.now() + 86400000 });
    const second = manager.enqueue('p', { text: 'second', sessionId: 'unavailable', paused: true });
    const rows = (await tool('list_queued')).data.messages;
    expect(rows.find((r: any) => r.id === second.id).provider).toBeNull();
    expect((await tool('list_queued', { projectId: 'p', sessionId: 's' })).data.messages).toHaveLength(1);
    expect((await tool('edit_queued', { projectId: 'p', id: first.id, message: 'changed' })).data.ok).toBe(true);
    expect(manager.queues().p[0].text).toBe('changed');
    expect((await tool('cancel_queued', { projectId: 'p', id: first.id })).data.ok).toBe(true);
    expect((await tool('stop_conversation', { projectId: 'p', sessionId: 'unavailable' })).isError).toBe(true);
    manager.removeQueueItem('p', second.id);
    manager.enqueue('p', { text: 'stop fixture', sessionId: 's', paused: true });
    expect((await tool('stop_conversation', { projectId: 'p', sessionId: 's', dropQueued: false })).data).toMatchObject({ stopped: false, dropped: 0 });
    expect((await tool('stop_conversation', { projectId: 'p', sessionId: 's' })).data).toMatchObject({ stopped: false, dropped: 1 });
    // Force only the fixture's abort branch; no live provider process is used.
    vi.spyOn(manager, 'haltConversation').mockReturnValueOnce({ stopped: true, dropped: 2 });
    expect((await tool('stop_conversation', { projectId: 'p', sessionId: 's' })).data).toMatchObject({ stopped: true, dropped: 2 });

    vi.stubEnv('X056_SELF_PROJECT_ID', 'p'); vi.stubEnv('X056_SELF_SESSION_ID', 's');
    vi.resetModules();
    const self = await import('../scripts/x056-mcp-tools.mjs');
    vi.useFakeTimers(); // Keep the fixture queue's drain timer from dispatching.
    for (let i = 0; i < SessionManager.SELF_QUEUE_LIMIT; i++) {
      const r = await self.callToolResult(async () => manager.queueSelfMessage('p', 's', 'fixture'), 'message_self', { message: 'fixture' });
      expect(validateResult('message_self', r).remaining).toBe(SessionManager.SELF_QUEUE_LIMIT - i - 1);
    }
    await expect(self.callToolResult(async () => manager.queueSelfMessage('p', 's', 'fixture'), 'message_self', { message: 'fixture' })).rejects.toThrow(/self-message limit/);
    manager.haltConversation('p', 's');
    covered.add('message_self');
  });

  it('exercises schedule creation, pause, resume, missing targets, run results and cancellation in the fixture', async () => {
    expect((await tool('list_scheduled')).data.jobs).toEqual([]);
    const scheduled = await tool('schedule_task', { projectId: 'p', sessionId: 'c', schedule: '0 9 * * *', tz: 'Asia/Jakarta', prompt: 'fixture', label: 'one off', once: true });
    const id = scheduled.data.job.id;
    expect(scheduled.data.job).toMatchObject({ once: true, tz: 'Asia/Jakarta', runCount: 0 });
    expect((await tool('pause_scheduled', { id, paused: true })).data.job.enabled).toBe(false);
    expect((await tool('pause_scheduled', { id, paused: false })).data.job.enabled).toBe(true);
    await tool('schedule_task', { projectId: 'missing', sessionId: 'missing', schedule: '0 9 * * *', tz: 'UTC', prompt: 'fixture' });
    const list = (await tool('list_scheduled')).data.jobs;
    expect(list.find((j: any) => j.id === id).provider).toBe('codex');
    expect(list.find((j: any) => j.projectId === 'missing').provider).toBeNull();
    expect((await tool('cancel_scheduled', { id })).data.ok).toBe(true);
    expect((await tool('cancel_scheduled', { id })).data.ok).toBe(false);
    for (const j of cron.list()) cron.remove(j.id);
    const recurring = await tool('schedule_task', { projectId: 'p', schedule: '0 9 * * *', tz: 'UTC', prompt: 'fixture' });
    vi.spyOn(manager, 'deliverMcpMessage').mockReturnValue({ sessionId: 's', queued: true, hopsLeft: 3 });
    cron.tick(new Date('2030-01-01T09:00:00Z'));
    expect((await tool('list_scheduled')).data.jobs[0]).toMatchObject({ runCount: 1, lastResult: 'queued', sessionId: 's' });
    await tool('cancel_scheduled', { id: recurring.data.job.id });
    expect((await tool('pause_scheduled', { id: 'missing', paused: true })).isError).toBe(true);
    expect((await tool('schedule_task', { projectId: 'p', schedule: 'invalid', prompt: 'fixture' })).isError).toBe(true);
  });

  it('validates actual memory entries, sources, revisions, links, search and context without bypassing review', async () => {
    expect((await tool('memory_search', { query: '', crossProject: true })).data.items).toEqual([]);
    const proposed = (await tool('memory_propose', { projectId: 'p', sessionId: 's', title: 'Contract fact', content: 'Fixture knowledge', tags: ['fixture'] })).data.entry;
    expect(proposed.status).toBe('proposed');
    expect((await tool('memory_search', { query: 'Contract', crossProject: true })).data.items).toEqual([]);
    const changed = (await tool('memory_update', { id: proposed.id, revision: proposed.revision, content: 'Updated fixture knowledge' })).data.entry;
    expect(changed).toMatchObject({ revision: 2, status: 'proposed' });
    expect((await tool('memory_update', { id: proposed.id, revision: 1, content: 'stale' })).isError).toBe(true);
    // Only the disposable store is reviewed, so populated search/context can be checked.
    manager.memory().update(changed.id, changed.revision, { status: 'confirmed', expiresAt: Date.now() + 86400000, pinned: true });
    const saved = await tool('save_memory', { projectId: 'p', name: 'contract-source', description: 'fixture description', content: 'Fixture source' });
    expect(saved.data).toMatchObject({ shared: true, status: 'proposed', existed: false });
    const linked = await tool('memory_link', { from: proposed.id, to: saved.data.id, kind: 'supports' });
    expect(linked.data.relationships).toHaveLength(1);
    const read = await tool('memory_read', { id: saved.data.id });
    expect(read.data.sources[0].current.content).toBe('Fixture source');
    expect(read.data.sources[0].original.content).toBe('Fixture source');
    expect((await tool('memory_read', { id: proposed.id })).data.revisions.length).toBeGreaterThan(1);
    expect((await tool('memory_search', { query: 'Contract', crossProject: true })).data.items).toHaveLength(1);
    const context = await tool('memory_context', { projectId: 'p', sessionId: 's', query: 'Contract' });
    expect(context.data.items).toHaveLength(1);
    manager.memory().recordContext('p', 's', 'claude', manager.memory().context('p', 's', 'claude', 'Contract'));
    expect((await tool('memory_context', { projectId: 'p', sessionId: 's', query: 'Contract' })).data.history).toHaveLength(1);
    manager.memory().setPreferences('p', 's', { enabled: false, excludedIds: [proposed.id], pinnedIds: [] });
    expect((await tool('memory_context', { projectId: 'p', sessionId: 's', query: 'Contract' })).data.enabled).toBe(false);
    expect((await tool('memory_read', { id: 'missing' })).isError).toBe(true);
  });

  it('validates code/wiki service return shapes through the actual gateway route', async () => {
    const service = app.get<CodegraphClient>(CODEGRAPH);
    vi.spyOn(service, 'enabled', 'get').mockReturnValue(true);
    const call = vi.spyOn(service, 'call');
    // These are the service's actual response shapes, not invented symbol JSON.
    for (const name of ['code_search', 'code_callers', 'code_callees', 'code_impact', 'code_node', 'code_explore']) {
      call.mockResolvedValueOnce({ text: 'Fixture code result', isError: false });
      expect((await tool(name, { query: 'fixture', symbol: 'fixture' })).data.text).toBe('Fixture code result');
    }
    call.mockResolvedValueOnce({ text: '', isError: false });
    expect((await tool('code_search', { query: 'empty' })).content[0].text).toBe('(no result)');
    call.mockResolvedValueOnce({ results: [], links: [], count: 0 });
    expect((await tool('wiki_search', { query: 'empty' })).data.results).toEqual([]);
    call.mockResolvedValueOnce({ results: [{ path: 'wiki/fixture.md', title: 'Fixture', snippet: 'Fixture snippet', score: 1.2, type: 'concept', hop: 0, related: [] }], links: [], count: 1 });
    await tool('wiki_search', { query: 'fixture' });
    call.mockResolvedValueOnce({ items: [{ ref: 'wiki/fixture.md', content: 'Fixture text' }, { ref: 'wiki/missing.md', not_found: true }] });
    expect((await tool('wiki_read', { ref: 'wiki/fixture.md' })).data.items).toHaveLength(2);
    call.mockRejectedValueOnce(new Error('code graph unavailable'));
    expect((await tool('code_search', { query: 'fixture' })).isError).toBe(true);
  });

  it('keeps HTTP approval denial and auto queue states distinct, with the same delivery selection', async () => {
    const delivered = vi.spyOn(manager, 'deliverMcpMessage').mockReturnValue({ sessionId: 's', queued: true, hopsLeft: 0 });
    manager.setMcpSendMode('auto');
    const automatic = await tool('send_message', { projectId: 'p', sessionId: 's', message: 'fixture', model: '', effort: '' });
    expect(automatic.data.delivery).toMatchObject({ mode: 'auto', status: 'queued', hopsLeft: 0 });
    expect(delivered.mock.calls[0][3]).toMatchObject({ model: '', effort: '' });
    manager.setMcpSendMode('approval');
    const request = tool('send_message', { projectId: 'p', sessionId: 's', message: 'deny fixture' });
    while (!manager.listMcpApprovals().length) await new Promise(r => setTimeout(r, 5));
    manager.decideMcpApproval(manager.listMcpApprovals()[0].id, false);
    expect((await request).data.delivery.status).toBe('denied');
    expect(delivered).toHaveBeenCalledOnce();
  });

  it('runs the release verifier against a disposable gateway using only read tools', async () => {
    const service = app.get<CodegraphClient>(CODEGRAPH);
    vi.spyOn(service, 'enabled', 'get').mockReturnValue(true);
    vi.spyOn(service, 'call').mockImplementation(async name => name === 'wiki_search'
      ? { results: [], links: [], count: 0 } : { text: 'Fixture code', isError: false });
    const send = vi.spyOn(manager, 'deliverMcpMessage');
    const snapshot = () => {
      const { exportedAt, ...memory } = manager.memory().export();
      return { queue: manager.queues(), jobs: cron.list(), memory };
    };
    const before = snapshot();
    const { stdout } = await promisify(execFile)('node', ['scripts/verify-mcp-output.mjs', base], {
      env: { ...process.env, X056_TOKEN: token },
    });
    expect(JSON.parse(stdout)).toMatchObject({ actions: 28, schemasCompiled: 28 });
    expect(send).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it('covers every advertised action', () => { expect([...covered].sort()).toEqual(TOOLS.map(t => t.name).sort()); });
});

describe('send polling variants with disposable responses and controlled time', () => {
  it.each(['pending', 'expired', 'denied', 'failed', 'queued', 'sent', 'reply', 'reply_timeout'])('approval %s preserves text and structured outcome', async status => {
    vi.useFakeTimers();
    const api = vi.fn(async (path: string) => {
      if (path === '/api/conversations/send') return { mode: 'approval', approvalId: 'fixture-approval' };
      if (path.includes('send-status')) return { status: ['pending', 'expired', 'denied'].includes(status) ? status : 'approved',
        ...(status === 'failed' ? { error: 'fixture send failure' } : {}), resultSessionId: 's', queued: status === 'queued' };
      return status === 'reply' ? [{ role: 'assistant', text: 'fixture reply' }] : [];
    });
    const pending = callToolResult(api, 'send_message', { projectId: 'p', message: 'fixture', waitSeconds: ['reply', 'reply_timeout'].includes(status) ? 3 : 0 });
    await vi.runAllTimersAsync();
    const r = await pending;
    expect(validateResult('send_message', r).delivery.status).toBe(status);
    expect(r.content[0].text.length).toBeGreaterThan(10);
    expect(api.mock.calls.filter(([path]) => path === '/api/conversations/send')).toHaveLength(1);
    expect(r).not.toHaveProperty('isError'); // Denial/expiry remain business outcomes.
  });
  it.each(['sent', 'queued', 'reply', 'reply_timeout'])('automatic %s retains hop counts and polling', async status => {
    vi.useFakeTimers();
    let reads = 0;
    const api = vi.fn(async (path: string) => {
      if (path === '/api/conversations/send') return { mode: 'auto', sessionId: 's', queued: status === 'queued', hopsLeft: 1 };
      if (++reads === 1) throw new Error('transient fixture read failure');
      return status === 'reply' ? [{ role: 'assistant', text: 'fixture reply' }] : [];
    });
    const p = callToolResult(api, 'send_message', { projectId: 'p', message: 'fixture', waitSeconds: ['reply', 'reply_timeout'].includes(status) ? 6 : 0 });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(validateResult('send_message', r).delivery).toMatchObject({ status, hopsLeft: 1 });
    expect(r.content[0].text).toContain('1 hop(s) left');
  });
});
