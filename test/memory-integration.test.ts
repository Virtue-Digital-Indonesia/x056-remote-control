import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import { type RunSessionOptions } from '../src/failover.js';
import { MemorySources } from '../server/memory-sources.js';
import { withMemoryContext } from '../src/memory-context.js';
const token = 'memory-test-token-0123456789abcdefgh';
let dir: string, app: INestApplication, base: string, manager: SessionManager, pid: string, sid: string;
async function api(path: string, body?: unknown) {
  const r = await fetch(base + '/api/memory/' + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memory-api-'));
  AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'a', configDir: join(dir, 'a') },
    { name: 'b', configDir: join(dir, 'b'), provider: 'codex' },
  ]);
  app = await createApp({ token, stateDir: dir, workspaceRoot: dir });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  manager = app.get(SessionManager);
  const p = manager.createProject('Memory test', dir);
  pid = p.id;
  sid = 'memory-conversation';
  writeFileSync(
    join(dir, 'projects.json'),
    JSON.stringify({
      current: pid,
      projects: [
        {
          ...p,
          conversations: [
            {
              sessionId: sid,
              title: 'Test conversation',
              provider: 'claude',
              createdAt: new Date().toISOString(),
            },
          ],
        },
      ],
    }),
  );
});
afterAll(async () => {
  await app.close();
  manager.memory().close();
  rmSync(dir, { recursive: true, force: true });
});
describe('memory HTTP and MCP', () => {
  it('requires authentication for all knowledge, while release metadata is public', async () => {
    expect((await fetch(base + '/api/memory/search')).status).toBe(401);
    expect((await fetch(base + '/api/memory/export')).status).toBe(401);
    expect((await fetch(base + '/api/version')).status).toBe(200);
  });
  it('forces agent proposals into review and detects concurrent edits', async () => {
    const created = await api('propose', {
      entry: {
        title: 'Routing policy',
        content: 'Use least busy routing.',
        projectId: pid,
        status: 'confirmed',
      },
    });
    expect(created.status).toBe(200);
    expect(created.data.status).toBe('proposed');
    const update = await api('entry', { id: created.data.id, revision: 1, entry: { status: 'confirmed' } });
    expect(update.data.revision).toBe(2);
    expect(
      (await api('entry', { id: created.data.id, revision: 1, entry: { content: 'stale' } })).status,
    ).toBe(409);
    expect(
      (await api('propose', { id: created.data.id, revision: 2, entry: { projectId: 'does-not-exist' } }))
        .status,
    ).toBe(400);
  });
  it('exposes the same memory tools over MCP and saves proposals', async () => {
    const rpc = async (method: string, params?: unknown) => {
      const r = await fetch(base + '/mcp', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return r.json();
    };
    const list = await rpc('tools/list');
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([
        'memory_search',
        'memory_read',
        'memory_propose',
        'memory_update',
        'memory_link',
        'memory_context',
      ]),
    );
    const result = await rpc('tools/call', {
      name: 'memory_propose',
      arguments: { projectId: pid, title: 'MCP knowledge', content: 'A durable fact' },
    });
    expect(result.result.isError).not.toBe(true);
    expect(JSON.parse(result.result.content[0].text).status).toBe('proposed');
  });
  it('keeps excluded provider notes out of caller search and read', async () => {
    const e = manager.memory().create({
      projectId: pid,
      title: 'Provider limited fact',
      content: 'A Codex-only reference',
      providers: ['codex'],
      status: 'confirmed',
    });
    const q = new URLSearchParams({ callerProjectId: pid, callerSessionId: sid, query: 'Codex-only' });
    expect((await api('search?' + q)).data.items).toHaveLength(0);
    expect((await api('entry?id=' + e.id + '&' + q)).status).toBe(400);
  });
  it('imports only source messages, deduplicates repeats, and keeps them unconfirmed', () => {
    const read = vi.spyOn(manager, 'historyContext').mockReturnValue({
      adapter: {
        id: 'claude',
        readHistoryPage: () => ({
          rows: [
            {
              role: 'user',
              text: withMemoryContext('Build the memory workspace', 'Hidden memory'),
              ts: '2026-09-08T01:00:00Z',
            },
            { role: 'assistant', text: 'We decided to use SQLite', ts: '2026-09-08T01:01:00Z' },
            { role: 'thought', text: 'Private reasoning', ts: '2026-09-08T01:00:20Z' },
            { role: 'action', text: 'Shell output', ts: '2026-09-08T01:00:30Z' },
          ],
          done: true,
        }),
      } as never,
      providerSessionId: sid,
      configDirs: [],
    });
    try {
      const service = new MemorySources(manager, manager.memory(), dir);
      expect(service.ingestProject(pid, { legacy: false, artifacts: false }).created).toBe(2);
      expect(service.ingestProject(pid, { legacy: false, artifacts: false }).unchanged).toBe(2);
      const source = manager.memory().sources({ projectId: pid });
      expect(source.items.map((s) => s.content)).toEqual(
        expect.arrayContaining(['Build the memory workspace', 'We decided to use SQLite']),
      );
      expect(
        source.items.some(
          (s) => s.content.includes('Hidden memory') || s.content.includes('Private reasoning'),
        ),
      ).toBe(false);
    } finally {
      read.mockRestore();
    }
  });
});
describe('provider launch memory', () => {
  it('injects into Claude and Codex and captures clean excerpts without altering slash commands', async () => {
    const work = join(dir, 'launch');
    mkdirSync(work);
    AccountRegistry.init(join(work, 'accounts.json'), [
      { name: 'a', configDir: join(work, 'a') },
      { name: 'b', configDir: join(work, 'b'), provider: 'codex' },
    ]);
    const calls: RunSessionOptions[] = [];
    const mgr = new SessionManager({
      stateDir: work,
      workspaceRoot: work,
      runSessionFn: async (o) => {
        calls.push(o);
        return { status: 'completed', failovers: 0, resultText: 'Deployment verified.' };
      },
    });
    const cl = mgr.createProject('Claude', work, 'claude'),
      cx = mgr.createProject('Codex', work, 'codex');
    const memory = mgr.memory().create({
      title: 'Deployment process',
      content: 'Run release checks before deploying.',
      scope: 'global',
      status: 'confirmed',
    });
    const sid1 = mgr.start('Check deployment', undefined, undefined, cl.id);
    mgr.start('Check deployment', undefined, undefined, cx.id);
    mgr.start('/compact', undefined, undefined, cx.id);
    expect(calls.map((c) => c.adapter?.id)).toEqual(['claude', 'codex', 'codex']);
    expect(calls[0].prompt).toContain(memory.content);
    expect(calls[1].prompt).toContain(memory.content);
    expect(calls[2].prompt).toBe('/compact');
    await new Promise((r) => setTimeout(r, 40));
    expect(mgr.memory().contextHistory(cl.id, sid1)[0].items).toEqual([
      expect.objectContaining({ id: memory.id, revision: 1 }),
    ]);
    expect(
      mgr
        .memory()
        .sources()
        .items.some((s) => s.content.includes('[Shared memory reference]')),
    ).toBe(false);
    expect(
      mgr
        .memory()
        .sources()
        .items.some((s) => s.content === 'Deployment verified.'),
    ).toBe(true);
    mgr.memory().close();
  });
});
