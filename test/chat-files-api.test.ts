import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { ProjectRegistry } from '../server/projects.js';
import { SessionManager } from '../server/manager.js';

const TOKEN = 'chat-test-token-01234567890123456789';
let app: INestApplication, base: string, stateDir: string;
const headers = { Authorization: `Bearer ${TOKEN}` };
const json = (path: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-chat-api-'));
  mkdirSync(join(dir, 'workspace'));
  stateDir=join(dir,'state');
  app = await createApp({ token: TOKEN, stateDir, workspaceRoot: join(dir, 'workspace'), chatEnabled: true });
  await app.listen(0); base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });
describe('Chat files HTTP', () => {
  it('streams upload/download with authentication, range requests, Unicode names, and idempotency', async () => {
    const chat = await (await json('/api/chats', { requestId: 'api-chat-0001' })).json();
    const form = () => { const f = new FormData(); f.append('files', new Blob(['Proposal bytes']), '提案.txt'); return f; };
    const upload = () => fetch(base + '/api/chats/' + chat.id + '/files', { method: 'POST', headers: { ...headers, 'x-upload-id': 'api-upload-0001' }, body: form() });
    const first = await upload(); expect(first.status).toBe(201);
    const { files } = await first.json(); expect(files[0].name).toBe('提案.txt');
    expect((await (await upload()).json()).files[0].id).toBe(files[0].id);
    const url = `/api/chats/${chat.id}/files/${files[0].id}/versions/${files[0].latestVersionId}/download`;
    expect((await fetch(base + url)).status).toBe(401);
    const full = await json(url); expect(await full.text()).toBe('Proposal bytes');
    expect(full.headers.get('content-disposition')).toContain(encodeURIComponent('提案.txt'));
    const range = await fetch(base + url, { headers: { ...headers, Range: 'bytes=0-3' } });
    expect(range.status).toBe(206); expect(await range.text()).toBe('Prop');
    const other = await (await json('/api/chats', { requestId: 'api-chat-0002' })).json();
    expect((await json(url.replace(chat.id, other.id))).status).toBe(404);
    const queued = { projectId: chat.id, sessionId: chat.lastSessionId, requestId: 'api-queue-message-0001', paused: true, fileRefs: [{ fileId: files[0].id, versionId: files[0].latestVersionId }] };
    const sent = await json('/api/queue', queued); expect(sent.status, await sent.clone().text()).toBe(200);
    const repeat = await json('/api/queue', queued); expect(repeat.status).toBe(200);
    const items = app.get(SessionManager).queues()[chat.id]; expect(items).toHaveLength(1); expect(items[0].fileRefs).toEqual(queued.fileRefs);
    expect(items[0].text).toBe('Use the attached files.');
    const steer=vi.spyOn(app.get(SessionManager),'steerSession').mockReturnValue(true);
    try {
      const attachedSteer={...queued,requestId:'api-steer-files-0001',prompt:'Read this with the attachment'};
      const response=await json('/api/steer',attachedSteer);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({queued:true,steered:false});
      expect(steer).not.toHaveBeenCalled();
      expect(app.get(SessionManager).queues()[chat.id].at(-1)).toMatchObject({text:attachedSteer.prompt,fileRefs:queued.fileRefs});
    } finally {steer.mockRestore();}
    const dispatch=vi.spyOn(app.get(SessionManager),'continueSession').mockReturnValue(chat.lastSessionId);
    try {
      const message={...queued,requestId:'api-direct-message-0001',paused:false,prompt:'Read this version'};
      expect((await json('/api/sessions/current/messages',message)).status).toBe(201);
      expect((await json('/api/sessions/current/messages',message)).status).toBe(201);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][3]).toMatchObject({requestId:message.requestId,fileRefs:queued.fileRefs});
    } finally { dispatch.mockRestore(); }
  });
});

it('queues Work attachments with no message and keeps them across text edits', async () => {
  const manager=app.get(SessionManager), project=manager.createProject('Queued Work files');
  const sid='work-queue-session';ProjectRegistry.load(join(stateDir,'projects.json')).addConversation(project.id,sid,'Queue attachments','claude');
  const body={projectId:project.id,sessionId:sid,requestId:'work-queued-file-0001',paused:true,attachments:[{name:'notes.txt',data:'data:text/plain;base64,'+Buffer.from('Queued document').toString('base64')}]};
  const response=await json('/api/queue',body);expect(response.status,await response.clone().text()).toBe(200);
  const queued=manager.queues()[project.id][0];expect(queued.attachmentPrompt).toContain('notes.txt');
  expect(queued.text).toBe('Use the attached files.');
  expect((await json('/api/queue/edit',{projectId:project.id,id:queued.id,prompt:'Updated instructions'})).status).toBe(200);
  expect(manager.queues()[project.id][0]).toMatchObject({text:'Updated instructions',attachmentPrompt:queued.attachmentPrompt});
  const steer=vi.spyOn(manager,'steerSession');
  try {
    const result=await json('/api/steer',{...body,requestId:'work-steer-file-0002',prompt:'Read together'});
    expect(result.status).toBe(200);expect(steer).not.toHaveBeenCalled();
    expect(manager.queues()[project.id][1].text).toContain('Read together');
    expect(manager.queues()[project.id][1].attachmentPrompt).toContain('notes.txt');
  } finally {steer.mockRestore();}
  const dispatch=vi.spyOn(manager,'continueSession').mockReturnValue(sid);
  try {
    manager.editQueueItem(project.id,queued.id,{paused:false});
    (manager as any).maybeDrainQueue(project.id,sid);
    await vi.waitFor(()=>expect(dispatch).toHaveBeenCalledTimes(1));
    const prompt=dispatch.mock.calls[0][2];
    expect(prompt).toContain('Updated instructions');
    expect(prompt).toContain('notes.txt');
    const path=prompt.match(/Read tool at: ([^\]]+)/)![1];
    expect(readFileSync(path,'utf8')).toBe('Queued document');
  } finally {dispatch.mockRestore();}
});
