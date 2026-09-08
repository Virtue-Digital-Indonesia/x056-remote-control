import 'reflect-metadata';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import { ProjectRegistry } from '../server/projects.js';
import { claudeAdapter } from '../src/adapters/claude.js';
const token = 'titles-api-token-0123456789';
let root: string, app: INestApplication, base: string, manager: SessionManager, pid: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'titles-api-'));
  AccountRegistry.init(join(root, 'accounts.json'), [{ name: 'a', configDir: join(root, 'a') }]);
  app = await createApp({
    token,
    stateDir: root,
    workspaceRoot: root,
    titleGenerator: async () => 'Conversation title improvements',
  });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  manager = app.get(SessionManager);
  pid = manager.createProject('Panel', root).id;
  const reg = ProjectRegistry.load(join(root, 'projects.json'));
  reg.addConversation(pid, 's', 'My original title', 'claude', 'manual');
  vi.spyOn(
    claudeAdapter as { readHistoryPage: NonNullable<typeof claudeAdapter.readHistoryPage> },
    'readHistoryPage',
  ).mockReturnValue({
    rows: [
      { role: 'user', text: 'Improve automatic conversation naming' },
      { role: 'assistant', text: 'The naming system is ready.' },
    ],
    cursor: 0,
    done: true,
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  await app.close();
  rmSync(root, { recursive: true, force: true });
});
async function api(path: string, body?: unknown) {
  const r = await fetch(base + '/api/' + path, {
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
it('requires authentication for title history, settings and writes', async () => {
  for (const path of ['conversation-titles', 'conversation-titles/settings'])
    expect((await fetch(base + '/api/' + path)).status).toBe(401);
  expect(
    (
      await fetch(base + '/api/conversation-titles/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [] }),
      })
    ).status,
  ).toBe(401);
});
it('previews an existing manual title, applies explicitly and undoes without losing its ownership', async () => {
  const result = await api('conversation-titles/suggest', {
    items: [{ projectId: pid, sessionId: 's' }],
  });
  expect(result.status).toBe(200);
  expect(result.data[0].context).toBeUndefined();
  const id = result.data[0].id;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
  await manager.titles().tick();
  clock.mockRestore();
  expect(manager.listConversations(pid)[0].title).toBe('My original title');
  expect((await api('conversation-titles/apply', { ids: [id] })).data.applied).toEqual([id]);
  expect(manager.listConversations(pid)[0].titleOrigin).toBe('generated');
  expect((await api('conversation-titles/undo', { ids: [id] })).data.undone).toEqual([id]);
  expect(manager.listConversations(pid)[0]).toMatchObject({
    title: 'My original title',
    titleOrigin: 'manual',
  });
});
it('validates settings and selections and marks ordinary renames as manual', async () => {
  expect((await api('conversation-titles/settings', { enabled: 'yes' })).status).toBe(400);
  expect(
    (await api('conversation-titles/suggest', { items: [{ projectId: pid, sessionId: 'missing' }] }))
      .status,
  ).toBe(400);
  expect((await api('conversation-titles/apply', { ids: ['missing'] })).status).toBe(400);
  expect(
    (await api('conversations/rename', { projectId: pid, sessionId: 's', title: 'Locked by operator' }))
      .status,
  ).toBe(200);
  expect(manager.listConversations(pid)[0].titleOrigin).toBe('manual');
  expect((await api('conversations/rename', { projectId: pid, sessionId: 's', title: 42 })).status).toBe(
    400,
  );
});
