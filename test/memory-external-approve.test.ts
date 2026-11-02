import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import type { MemoryEntry } from '../server/memory-store.js';
import { OAUTH_STORE } from '../server/oauth.controller.js';
import type { OAuthStore } from '../server/oauth.js';
import { MCP_VIA_HEADER, MCP_VIA_SECRET_HEADER, mcpViaHeaders } from '../server/mcp-via.js';

let dir: string, app: INestApplication, base: string, manager: SessionManager;
let pid: string, sid: string;
const token = 'memory-external-approve-test-token';
const note = (patch: Partial<MemoryEntry> = {}) => manager.memory().create({ title: 'Fact ' + randomUUID(), content: 'Original content', scope: 'project', projectId: pid, status: 'proposed', ...patch });
const caller = () => ({ callerProjectId: pid, callerSessionId: sid });

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(base + '/api/memory/' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
}
/** One tools/call over the HTTP /mcp endpoint, which runs the tool in-process. */
async function mcp(name: string, args: Record<string, unknown>, bearer = token) {
  const r = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const json = await r.json();
  return json.result as { isError?: boolean; content: { text: string }[]; structuredContent: { entry?: MemoryEntry; error?: string } };
}
const events = () => existsSync(join(dir, 'events.jsonl'))
  ? readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'memory_external_approval')
  : [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'memory-external-approve-'));
  AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'claude', configDir: join(dir, 'claude') }]);
  app = await createApp({ token, stateDir: dir, workspaceRoot: dir, chatEnabled: true, projectSpacesEnabled: true });
  await app.listen(0, '127.0.0.1'); base = await app.getUrl(); manager = app.get(SessionManager);
  const chat = manager.createChat({ requestId: randomUUID(), name: 'Owner chat', provider: 'claude' });
  pid = chat.id; sid = chat.lastSessionId!;
});
beforeEach(() => manager.memory().setSettings({ allowExternalApprovals: false, autoManage: false }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
afterAll(async () => { await app?.close(); manager?.memory().close(); rmSync(dir, { recursive: true, force: true }); });

it('is off by default and the setting round-trips through the settings routes', async () => {
  const r = await fetch(base + '/api/memory/settings', { headers: { Authorization: 'Bearer ' + token } });
  expect((await r.json()).allowExternalApprovals).toBe(false);
  expect((await post('settings', { allowExternalApprovals: 'yes' })).status).toBe(400);
  expect((await post('settings', { allowExternalApprovals: true })).data.allowExternalApprovals).toBe(true);
  const entry = note();
  manager.memory().setSettings({ allowExternalApprovals: false });
  const refused = await mcp('memory_approve', { id: entry.id, revision: 1, reason: 'Checked' });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain('External memory approvals are off');
  const rest = await post('approve', { id: entry.id, revision: 1, reason: 'Checked' }, mcpViaHeaders({ kind: 'token' }));
  expect(rest.status).toBe(403);
  expect(rest.data.error).toBe('external_approvals_off');
  expect(manager.memory().get(entry.id)).toMatchObject({ status: 'proposed', revision: 1 });
});

it('approves a proposal over /mcp with the operator actor, a new revision and a quiet event', async () => {
  manager.memory().setSettings({ allowExternalApprovals: true });
  const entry = note();
  const before = events().length;
  const r = await mcp('memory_approve', { id: entry.id, revision: 1, reason: 'Verified against the runbook' });
  expect(r.isError).toBeUndefined();
  expect(r.structuredContent.entry).toMatchObject({ id: entry.id, status: 'confirmed', revision: 2 });
  const saved = manager.memory().get(entry.id)!;
  expect(saved.actor).toBe('mcp (operator) · approve · token · Verified against the runbook');
  expect(manager.memory().revisions(entry.id).map((e) => [e.revision, e.status])).toEqual([[2, 'confirmed'], [1, 'proposed']]);
  const ev = events().slice(before);
  expect(ev).toHaveLength(1);
  expect(ev[0]).toMatchObject({ id: entry.id, revision: 2, action: 'approve', actor: saved.actor });
  // restore-revision reverts it (back to the inbox, as for any restore).
  expect((await post('restore-revision', { id: entry.id, revision: 2, restoreRevision: 1 })).data).toMatchObject({ status: 'proposed', revision: 3 });
  // A reason is required on this path.
  expect((await mcp('memory_approve', { id: entry.id, revision: 3 })).content[0].text).toContain('reason');
});

it('names the OAuth connector in the actor (sanitized), never a forged via header', async () => {
  manager.memory().setSettings({ allowExternalApprovals: true });
  const store = app.get<OAuthStore>(OAUTH_STORE);
  const client = store.registerClient('Efran\u0007 Assistant · v2', ['http://localhost/cb']);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const code = store.issueCode(client.client_id, 'http://localhost/cb', challenge);
  const { access_token } = store.redeemCode(code, client.client_id, 'http://localhost/cb', verifier)!;
  const entry = note();
  const r = await mcp('memory_approve', { id: entry.id, revision: 1, reason: 'Looks right' }, access_token);
  expect(r.isError).toBeUndefined();
  expect(manager.memory().get(entry.id)!.actor).toBe('mcp (operator) · approve · Efran Assistant v2 · Looks right');

  // A forged via header without the per-boot secret is not trusted at all.
  const forged = note();
  for (const headers of <Record<string, string>[]>[{ [MCP_VIA_HEADER]: `oauth:${client.client_id}` }, { [MCP_VIA_HEADER]: `oauth:${client.client_id}`, [MCP_VIA_SECRET_HEADER]: 'guess' }]) {
    const res = await post('approve', { id: forged.id, revision: 1, reason: 'Forged' }, headers);
    expect(res.status).toBe(400);
    expect(res.data.message).toBe('A verified caller conversation is required');
  }
  // A plain token REST call with no via pair keeps the old answer.
  expect((await post('approve', { id: forged.id, revision: 1, reason: 'Plain' })).data.message).toBe('A verified caller conversation is required');
  expect(manager.memory().get(forged.id)).toMatchObject({ status: 'proposed', revision: 1 });
});

it('rejects: a never-confirmed proposal goes to trash, a proposed edit of a confirmed memory restores it', async () => {
  manager.memory().setSettings({ allowExternalApprovals: true });
  const fresh = note();
  const gone = await mcp('memory_approve', { id: fresh.id, revision: 1, action: 'reject', reason: 'Not a real decision' });
  expect(gone.structuredContent.entry).toMatchObject({ status: 'deleted', revision: 2, actor: 'mcp (operator) · reject · token · Not a real decision' });

  const confirmed = note({ status: 'confirmed', content: 'Deploy at 03:00', tags: ['ops'] });
  // An agent proposal (no caller ids over REST = 'agent proposal') edits the confirmed memory into review.
  const proposal = manager.memory().update(confirmed.id, 1, { content: 'Deploy at noon', tags: ['ops', 'wrong'], pinned: true, status: 'proposed' }, 'agent proposal');
  const reverted = await mcp('memory_approve', { id: confirmed.id, revision: proposal.revision, action: 'reject', reason: 'Wrong time' });
  expect(reverted.structuredContent.entry).toMatchObject({ status: 'confirmed', revision: 3, content: 'Deploy at 03:00', tags: ['ops'], pinned: false });
  expect(manager.memory().revisions(confirmed.id).map((e) => e.revision)).toEqual([3, 2, 1]);
  expect(events().at(-1)).toMatchObject({ id: confirmed.id, revision: 3, action: 'reject' });
});

it('refuses a stale revision (409) and a memory that is not proposed', async () => {
  manager.memory().setSettings({ allowExternalApprovals: true });
  const entry = note();
  manager.memory().update(entry.id, 1, { content: 'Changed meanwhile' }, 'operator');
  const via = mcpViaHeaders({ kind: 'token' });
  expect((await post('approve', { id: entry.id, revision: 1, reason: 'Stale' }, via)).status).toBe(409);
  expect((await mcp('memory_approve', { id: entry.id, revision: 1, reason: 'Stale' })).isError).toBe(true);
  const confirmed = note({ status: 'confirmed' });
  const r = await post('approve', { id: confirmed.id, revision: 1, reason: 'Already' }, via);
  expect(r.status).toBe(400);
  expect(r.data.message).toBe('Only a proposed memory can be approved or rejected');
  expect((await post('approve', { id: confirmed.id, revision: 1, action: 'reject', reason: 'Nope' }, via)).status).toBe(400);
  expect((await post('approve', { id: confirmed.id, revision: 1, action: 'maybe', reason: 'Nope' }, via)).status).toBe(400);
  expect(manager.memory().get(confirmed.id)).toMatchObject({ status: 'confirmed', revision: 1 });
});

it('refuses agent identities even with a trusted via pair', async () => {
  manager.memory().setSettings({ allowExternalApprovals: true });
  const entry = note();
  const via = mcpViaHeaders({ kind: 'token' });
  for (const [body, headers] of [
    [{ from: sid }, via], [{ self: { projectId: pid, sessionId: sid } }, via], [{ delegate: { of: pid + '/' + sid, id: 'd1' } }, via], [{}, { ...via, 'x-x056-caller': sid }],
  ] as [Record<string, unknown>, Record<string, string>][]) {
    const r = await post('approve', { id: entry.id, revision: 1, reason: 'Agent', ...body }, headers);
    expect(r.status).toBe(403);
    expect(r.data.error).toBe('agent_caller');
  }
  expect(manager.memory().get(entry.id)).toMatchObject({ status: 'proposed', revision: 1 });
});

it('keeps the caller-scoped rules for a conversation: ownership and autoManage still apply, reject is refused', async () => {
  manager.memory().setSettings({ allowExternalApprovals: true, autoManage: false });
  const entry = note();
  const via = mcpViaHeaders({ kind: 'token' });
  // autoManage off: refused exactly as before, even with the external setting on.
  const off = await post('approve', { id: entry.id, revision: 1, ...caller() }, via);
  expect(off.status).toBe(400);
  expect(off.data.message).toBe('Automatic memory management is disabled');
  manager.memory().setSettings({ autoManage: true });
  const rejected = await post('approve', { id: entry.id, revision: 1, action: 'reject', reason: 'x', ...caller() }, via);
  expect(rejected.status).toBe(400);
  expect(manager.memory().get(entry.id)!.status).toBe('proposed');
  const ok = await post('approve', { id: entry.id, revision: 1, ...caller() });
  expect(ok.data).toMatchObject({ status: 'confirmed', revision: 2 });
  expect(ok.data.actor).toContain('agent · approve · claude · ' + pid + '/' + sid);
  // memory_update approve:true with caller ids is refused at the route.
  const confirmed = note({ status: 'confirmed' });
  const r = await post('propose', { id: confirmed.id, revision: 1, entry: { content: 'x' }, approve: true, reason: 'x', ...caller() }, via);
  expect(r.status).toBe(400);
  expect(r.data.message).toContain('approve is for the operator over /mcp');
});

it('the stdio bridge: SELF refuses reject and approve flags; a delegate carries its marker', async () => {
  vi.stubEnv('X056_SELF_PROJECT_ID', 'own-project');
  vi.stubEnv('X056_SELF_SESSION_ID', 'own-session');
  vi.resetModules();
  let tools = await import('../scripts/x056-mcp-tools.mjs');
  const api = vi.fn(async () => ({}));
  await expect(tools.callToolResult(api, 'memory_approve', { id: 'n', revision: 1, action: 'reject', reason: 'x' })).rejects.toThrow('cannot reject');
  await expect(tools.callToolResult(api, 'memory_update', { id: 'n', revision: 1, content: 'x', approve: true, reason: 'x' })).rejects.toThrow('approve is only for an operator');
  expect(api).not.toHaveBeenCalled();
  vi.unstubAllEnvs();
  vi.stubEnv('X056_DELEGATE_OF', 'p/s');
  vi.stubEnv('X056_DELEGATE_ID', 'd1');
  vi.resetModules();
  tools = await import('../scripts/x056-mcp-tools.mjs');
  const entry = { id: 'n', revision: 2, title: 'T', content: 'C', summary: '', kind: 'decision', status: 'confirmed', scope: 'project', projectId: 'p', sharedProjectIds: [], providers: ['claude', 'codex'], tags: [], pinned: false, createdAt: 1, updatedAt: 2, actor: 'x', sources: [] };
  const api2 = vi.fn(async (_p: string, _o?: RequestInit) => entry);
  await tools.callToolResult(api2, 'memory_approve', { id: 'n', revision: 1, reason: 'x' });
  expect(JSON.parse(api2.mock.calls[0][1]!.body as string)).toMatchObject({ delegate: { of: 'p/s', id: 'd1' } });
  // memory_update keeps approve/reason out of the entry patch.
  await tools.callToolResult(api2, 'memory_update', { id: 'n', revision: 1, content: 'x', approve: true, reason: 'y' });
  expect(JSON.parse(api2.mock.calls[1][1]!.body as string)).toEqual({ id: 'n', revision: 1, entry: { content: 'x' }, approve: true, reason: 'y', delegate: { of: 'p/s', id: 'd1' } });
});

it('memory_update approve:true over /mcp: off writes nothing, on writes the edit then the approval', async () => {
  const entry = note({ content: 'Draft wording' });
  const off = await mcp('memory_update', { id: entry.id, revision: 1, content: 'Final wording', approve: true, reason: 'Owner asked' });
  expect(off.isError).toBe(true);
  expect(off.content[0].text).toContain('External memory approvals are off');
  expect(manager.memory().get(entry.id)).toMatchObject({ revision: 1, content: 'Draft wording', status: 'proposed' });

  manager.memory().setSettings({ allowExternalApprovals: true });
  const before = events().length;
  const on = await mcp('memory_update', { id: entry.id, revision: 1, content: 'Final wording', approve: true, reason: 'Owner asked' });
  expect(on.isError).toBeUndefined();
  expect(on.structuredContent.entry).toMatchObject({ revision: 3, status: 'confirmed', content: 'Final wording' });
  const revs = manager.memory().revisions(entry.id);
  expect(revs.map((e) => [e.revision, e.status, e.actor])).toEqual([
    [3, 'confirmed', 'mcp (operator) · approve · token · Owner asked'],
    [2, 'proposed', 'mcp (operator) · edit · token · Owner asked'],
    [1, 'proposed', 'operator'],
  ]);
  expect(revs[1].content).toBe('Final wording');
  expect(events().slice(before)).toEqual([expect.objectContaining({ id: entry.id, revision: 3, action: 'edit+approve' })]);
  // Without approve it stays the old proposal path.
  const plain = await mcp('memory_update', { id: entry.id, revision: 3, content: 'Another' });
  expect(plain.structuredContent.entry).toMatchObject({ revision: 4, status: 'proposed', actor: 'agent proposal' });
  // A reason is required; a stale revision writes nothing.
  expect((await mcp('memory_update', { id: entry.id, revision: 4, content: 'x', approve: true })).isError).toBe(true);
  expect((await mcp('memory_update', { id: entry.id, revision: 1, content: 'x', approve: true, reason: 'stale' })).isError).toBe(true);
  expect(manager.memory().get(entry.id)!.revision).toBe(4);
});
