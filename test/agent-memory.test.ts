import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import { MemoryStore } from '../server/memory-store.js';
import { validateResult } from './helpers/mcp-contract.js';

const token = 'disposable-agent-memory-fixture-token';
let dir: string, app: INestApplication, base: string, manager: SessionManager, spaceId: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-memory-'));
  AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'claude', configDir: join(dir, 'claude') },
    { name: 'codex', configDir: join(dir, 'codex'), provider: 'codex' },
  ]);
  app = await createApp({ token, stateDir: dir, workspaceRoot: dir, chatEnabled: true, projectSpacesEnabled: true });
  await app.listen(0, '127.0.0.1'); base = await app.getUrl(); manager = app.get(SessionManager);
  spaceId = manager.spaces().create({ requestId: randomUUID(), name: 'Proposal bank' }).id;
});
afterAll(async () => { await app?.close(); manager?.memory().close(); rmSync(dir, { recursive: true, force: true }); });

function bridge(projectId: string, sessionId: string) {
  const child = spawn(process.execPath, ['scripts/x056-mcp.mjs'], { env: {
    ...process.env, X056_URL: base, X056_TOKEN: token, X056_SELF_PROJECT_ID: projectId, X056_SELF_SESSION_ID: sessionId,
  }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, (value: any) => void>(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const data = JSON.parse(line); pending.get(data.id)?.(data); pending.delete(data.id); });
  return {
    call: (name: string, args = {}) => new Promise<any>((resolve, reject) => {
      const next = ++id;
      const timeout = setTimeout(() => { pending.delete(next); reject(new Error('MCP timeout: ' + name)); }, 5000);
      pending.set(next, data => {
        clearTimeout(timeout);
        try { expect(data.result.isError, name + ': ' + JSON.stringify(data.result)).not.toBe(true); resolve(validateResult(name, data.result)); }
        catch (error) { reject(error); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    }),
    close: async () => { lines.close(); child.stdin.end(); if (child.exitCode === null) await new Promise<void>(resolve => child.once('exit', () => resolve())); },
  };
}

it.each(['claude', 'codex'] as const)('lets %s agents save scoped Chat and Work memory without an approval dialog', async provider => {
  const chat = manager.createChat({ requestId: randomUUID(), name: provider + ' Chat', provider, spaceId });
  const work = manager.createProject(provider + ' Work', dir, provider);
  const conversation = manager.prepareProjectWork(work.id, { requestId: randomUUID(), name: 'Planning', provider, spaceId });
  for (const target of [{ projectId: chat.id, sessionId: chat.lastSessionId! }, { projectId: work.id, sessionId: conversation.sessionId }]) {
    const mcp = bridge(target.projectId, target.sessionId);
    try {
      const context = await mcp.call('memory_context', { query: '', ...target });
      expect(context.scope.spaceId).toBe(spaceId);
      const local = (await mcp.call('memory_propose', { title: provider + ' local decision', content: 'Keep the original document.' })).entry;
      expect(local).toMatchObject({ projectId: target.projectId, sessionId: target.sessionId, status: 'proposed' });
      expect(local.spaceId).toBeUndefined();
      expect(local.sources).toContainEqual(expect.objectContaining(target));
      const shared = (await mcp.call('memory_propose', { title: provider + ' Project decision', content: 'Use the approved proposal outline.', scope: 'space', spaceId })).entry;
      expect(shared).toMatchObject({ spaceId, scope: 'space', status: 'proposed' });
      expect(shared.projectId).toBeUndefined();
      expect(shared.sources).toContainEqual(expect.objectContaining(target));
      expect((await mcp.call('memory_context', { query: '', ...target })).items.map((e: any) => e.id)).not.toContain(shared.id);
      const reopened = new MemoryStore(dir, manager.projectContext());
      try { expect(reopened.get(shared.id)).toMatchObject({ status: 'proposed', spaceId }); }
      finally { reopened.close(); }
      // Operator review makes the same saved note eligible; correction returns it to review.
      manager.memory().update(shared.id, shared.revision, { status: 'confirmed' }, 'operator');
      expect((await mcp.call('memory_context', { query: '', ...target })).items.map((e: any) => e.id)).toContain(shared.id);
      const correction = (await mcp.call('memory_update', { id: shared.id, revision: 2, content: 'Use the revised approved outline.' })).entry;
      expect(correction).toMatchObject({ id: shared.id, status: 'proposed', revision: 3, spaceId });
      const approvals = await fetch(base + '/api/mcp/approvals', { headers: { Authorization: 'Bearer ' + token } });
      expect(await approvals.json()).toEqual([]);
    } finally { await mcp.close(); }
  }
}, 20000);
