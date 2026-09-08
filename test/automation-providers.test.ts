import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions } from '../src/failover.js';
import { SessionManager } from '../server/manager.js';
import { CronScheduler } from '../server/cron.js';
import { createApp } from '../server/main.js';
import { callTool } from '../scripts/x056-mcp-tools.mjs';

const TOKEN = 'automation-test-token-0123456789';
const dirs: string[] = [];
function seed() {
  const dir = mkdtempSync(join(tmpdir(), 'automation-providers-')); dirs.push(dir);
  const reg = AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'claude', configDir: join(dir, 'claude') },
    { name: 'chatgpt', configDir: join(dir, 'chatgpt'), provider: 'codex' },
  ]);
  reg.markOk('claude'); reg.markOk('chatgpt');
  mkdirSync(join(dir, 'claude')); mkdirSync(join(dir, 'chatgpt'));
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [
    { id: 'p1', name: 'Mixed project', cwd: dir, provider: 'claude', conversations: [
      { sessionId: 'cx', title: 'Codex follow-up', provider: 'codex', providerSessionId: 'native-codex-thread', createdAt: 1 },
      { sessionId: 'cl', title: 'Legacy Claude follow-up', createdAt: 2 },
    ] },
    { id: 'p2', name: 'Changed default', cwd: dir, provider: 'codex', conversations: [
      { sessionId: 'legacy', title: 'Original Claude chat', createdAt: 3 },
    ] },
  ] }));
  return dir;
}
let app: INestApplication, base: string;
const api = async (path: string, opts: RequestInit = {}) => {
  const response = await fetch(base + path, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response.json();
};
beforeAll(async () => {
  const dir = seed();
  app = await createApp({ token: TOKEN, stateDir: dir, workspaceRoot: dir });
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
  dirs.forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

describe('Automations across providers', () => {
  it('lists Codex and Claude MCP schedules with their actual conversation providers', async () => {
    for (const [projectId, sessionId] of [['p1', 'cx'], ['p1', 'cl'], ['p2', 'legacy']]) {
      const result = await callTool(api, 'schedule_task', { projectId, sessionId, schedule: '0 12 1 1 *', tz: 'Asia/Jakarta', prompt: 'Check the scheduled result', once: true });
      expect(result).toContain('ONCE'); expect(result).toContain(sessionId);
    }
    await api('/api/cron', { method: 'POST', body: JSON.stringify({ projectId: 'p2', schedule: '0 12 1 1 *', prompt: 'New chat each run' }) });
    const { jobs } = await api('/api/cron');
    expect(jobs.find((j: any) => j.sessionId === 'cx')).toMatchObject({ provider: 'codex', projectName: 'Mixed project', conversationTitle: 'Codex follow-up', source: 'gateway', once: true });
    expect(jobs.find((j: any) => j.sessionId === 'cl').provider).toBe('claude');
    expect(jobs.find((j: any) => j.sessionId === 'legacy').provider).toBe('claude');
    expect(jobs.find((j: any) => !j.sessionId).provider).toBe('codex');
    expect(await callTool(api, 'list_scheduled', {})).toContain('conversation=cx provider=codex');
    const job = jobs.find((j: any) => j.sessionId === 'cx');
    await callTool(api, 'pause_scheduled', { id: job.id, paused: true });
    expect((await api('/api/cron')).jobs.find((j: any) => j.id === job.id).enabled).toBe(false);
    await callTool(api, 'pause_scheduled', { id: job.id, paused: false });
    expect((await api('/api/cron')).jobs.find((j: any) => j.id === job.id).enabled).toBe(true);
    await callTool(api, 'cancel_scheduled', { id: job.id });
    expect((await api('/api/cron')).jobs.some((j: any) => j.id === job.id)).toBe(false);
  });
  it('keeps Codex and Claude planned queue entries visible and editable', async () => {
    for (const sessionId of ['cx', 'cl']) await api('/api/queue', { method: 'POST', body: JSON.stringify({ projectId: 'p1', sessionId, prompt: sessionId + ' queued', paused: true, notBefore: Date.now() + 86400000 }) });
    const queues = await api('/api/queue');
    expect(queues.p1.find((q: any) => q.sessionId === 'cx')).toMatchObject({ provider: 'codex', source: 'gateway', paused: true });
    expect(queues.p1.find((q: any) => q.sessionId === 'cl').provider).toBe('claude');
    const codex = queues.p1.find((q: any) => q.sessionId === 'cx');
    await callTool(api, 'edit_queued', { projectId: 'p1', id: codex.id, message: 'Updated Codex task' });
    expect(await callTool(api, 'list_queued', { projectId: 'p1', sessionId: 'cx' })).toContain('Updated Codex task');
    await callTool(api, 'cancel_queued', { projectId: 'p1', id: codex.id });
    expect((await api('/api/queue')).p1.some((q: any) => q.id === codex.id)).toBe(false);
  });
  it.each([['cx', 'codex', 'native-codex-thread'], ['cl', 'claude', 'cl']])('persists a %s schedule and delivers through the correct adapter and MCP identity', async (sessionId, provider, providerSessionId) => {
    const dir = seed(), calls: RunSessionOptions[] = [];
    const manager = new SessionManager({ stateDir: dir, workspaceRoot: dir,
      mcp: { configPath: join(dir, 'mcp.json'), command: 'node', args: ['x056-mcp.mjs'], env: {} },
      runSessionFn: async options => { calls.push(options); return { status: 'completed', failovers: 0 }; },
    });
    const deliver = (pid: string, sid: string | undefined, prompt: string) => manager.deliverMcpMessage(pid, sid, prompt);
    new CronScheduler({ stateDir: dir, deliver }).add({ projectId: 'p1', sessionId, schedule: '0 12 1 1 *', tz: 'UTC', once: true, prompt: 'Resume scheduled follow-up' });
    const reloaded = new CronScheduler({ stateDir: dir, deliver });
    expect(reloaded.list()[0].sessionId).toBe(sessionId);
    reloaded.tick(new Date('2027-01-01T12:00:00Z'));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ sessionId, providerSessionId: provider === 'codex' ? providerSessionId : undefined, resume: true });
    expect(calls[0].adapter?.id).toBe(provider);
    expect(calls[0].mcp?.env).toMatchObject({ X056_SELF_PROJECT_ID: 'p1', X056_SELF_SESSION_ID: sessionId });
    expect(calls[0].appendSystemPrompt).toContain('use x056 schedule_task');
    expect(reloaded.list()).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
});
