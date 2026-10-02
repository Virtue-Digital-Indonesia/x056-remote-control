import 'reflect-metadata';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';

const token = 'autopilot-api-fixture-token-0123456789';
let app: INestApplication, base: string, projectId: string;
const sessionId = 'api-conversation';
async function api(path: string, body?: unknown, auth = true) {
  return fetch(base + '/api/autopilot' + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(auth ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'x056-autopilot-api-')), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  app = await createApp({ token, stateDir: join(root, 'state'), workspaceRoot, projectSpacesEnabled: false });
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
  projectId = app.get(SessionManager).createProject('API fixture', workspaceRoot).id;
});
afterAll(async () => { await app?.close(); });
it('exposes the same-deploy last route, armed edits, status fields, conflicts and remembered defaults', async () => {
  const last = '/last?projectId=' + projectId + '&sessionId=' + sessionId;
  expect((await api(last, undefined, false)).status).toBe(401);
  let response = await api(last); expect(response.status).toBe(200); expect(await response.json()).toEqual({});
  expect((await api('/instruction', { projectId, sessionId, instruction: 'No run yet' })).status).toBe(409);
  response = await api('', { projectId, sessionId, count: 8, instruction: '  Follow docs/plan.md\nTick off each item  ' });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  expect((await (await api('')).json())[sessionId]).toEqual({ projectId, count: 8, remaining: 8, instruction: 'Follow docs/plan.md\nTick off each item' });
  response = await api('/instruction', { projectId, sessionId, instruction: 'Updated instruction' });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ ok: true });
  expect((await (await api('')).json())[sessionId]).toEqual({ projectId, count: 8, remaining: 8, instruction: 'Updated instruction' });
  expect((await api('/instruction', { projectId: 'wrong', sessionId, instruction: 'No' })).status).toBe(409);
  expect((await api('/instruction', { projectId, sessionId, instruction: null })).status).toBe(400);
  expect((await api('', { projectId, sessionId, count: 8, instruction: 123 })).status).toBe(400);
  await api('/stop', { sessionId });
  expect(await (await api(last)).json()).toEqual({ count: 8, instruction: 'Updated instruction' });
  expect((await api('/instruction', { projectId, sessionId, instruction: 'Stopped' })).status).toBe(409);
  await api('', { projectId, sessionId, count: 5, instruction: '\n ' });
  expect((await (await api('')).json())[sessionId]).toEqual({ projectId, count: 5, remaining: 5 });
  await api('/stop', { sessionId });
  expect(await (await api(last)).json()).toEqual({ count: 5 });
});
