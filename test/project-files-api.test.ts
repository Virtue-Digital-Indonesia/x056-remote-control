import 'reflect-metadata';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';

const token = 'project-file-api-fixture-token-0123456789';
let app: INestApplication, base: string;
const auth = { Authorization: 'Bearer ' + token };
async function api(path: string, body?: unknown) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'project-files-api-')), workspaceRoot = join(root, 'workspace'); mkdirSync(workspaceRoot);
  app = await createApp({ token, stateDir: join(root, 'state'), workspaceRoot, chatEnabled: true, projectSpacesEnabled: true });
  await app.listen(0, '127.0.0.1'); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
it('serves Project uploads without a Work workspace, preserving authentication, ranges, Unicode names and retries', async () => {
  const parent = await (await api('/api/project-spaces', { requestId: 'api-project-001', name: 'Proposal' })).json();
  expect(parent.cwd).toBeUndefined();
  const root = '/api/project-spaces/' + parent.id + '/files';
  const upload = () => {
    const form = new FormData(); form.append('files', new Blob(['Shared proposal bytes']), '提案.txt');
    return fetch(base + root, { method: 'POST', headers: { ...auth, 'x-upload-id': 'project-upload-001' }, body: form });
  };
  const first = await upload(); expect(first.status).toBe(201);
  const file = (await first.json()).files[0];
  expect((await (await upload()).json()).files[0].id).toBe(file.id);
  expect(file.ownerKind).toBe('project');
  const download = root + '/' + file.id + '/versions/' + file.latestVersionId + '/download';
  expect((await fetch(base + download)).status).toBe(401);
  const range = await fetch(base + download, { headers: { ...auth, Range: 'bytes=0-5' } });
  expect(range.status).toBe(206); expect(await range.text()).toBe('Shared');
  expect(range.headers.get('content-disposition')).toContain(encodeURIComponent('提案.txt'));
  expect((await api(root + '/' + file.id + '/checkout', { versionId: file.latestVersionId })).status).toBe(400);
  const other = await (await api('/api/project-spaces', { requestId: 'api-project-002', name: 'Other' })).json();
  expect((await api(download.replace(parent.id, other.id))).status).toBe(404);
  const failedWork = await api('/api/sessions', { projectId: parent.id, prompt: 'Do work', interactive: false });
  expect(failedWork.status).toBe(400); expect((await failedWork.json()).message).toContain('workspace');
  expect((await api('/api/project-spaces/' + parent.id)).status).toBe(200);
});
