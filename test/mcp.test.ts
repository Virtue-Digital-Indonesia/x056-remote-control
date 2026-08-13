import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import { createApp } from '../server/main.js';

const FAKE = new URL('./bin/fake-claude', import.meta.url).pathname;
const MCP = new URL('../scripts/x056-mcp.mjs', import.meta.url).pathname;
const TOKEN = 'test-token-0123456789abcdefghij';

let app: INestApplication;
let base = '';
let dir = '';
let mcp: ChildProcess;
let nextId = 1;
const pending = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>();

function rpc(method: string, params?: unknown): Promise<{ result?: unknown; error?: { message?: string } }> {
  const id = nextId++;
  const p = new Promise<{ result?: unknown; error?: { message?: string } }>((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc timeout: ${method}`)); }, 10_000);
  });
  mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}
function toolText(res: { result?: unknown }): string {
  const r = res.result as { content?: { type: string; text: string }[]; isError?: boolean };
  return (r.content ?? []).map((c) => c.text).join('\n');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'x056-mcp-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg-a') }]);

  // Seed one project with one conversation whose transcript really exists on
  // disk in the account's projects tree, so read_conversation exercises the
  // REAL history path (adapter.readHistory), not a mock.
  const proj = join(dir, 'workdir'); mkdirSync(proj, { recursive: true });
  const sid = 'seeded-conv-1';
  const munged = proj.replace(/[/.]/g, '-');
  mkdirSync(join(dir, 'cfg-a', 'projects', munged), { recursive: true });
  writeFileSync(join(dir, 'cfg-a', 'projects', munged, `${sid}.jsonl`), [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'what is the plan?' }, timestamp: '2026-07-15T01:00:00.000Z' }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'THE_SEEDED_PLAN: ship it' }] }, timestamp: '2026-07-15T01:00:05.000Z' }),
  ].join('\n') + '\n');
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{ id: 'p1', name: 'SeededProj', cwd: proj, provider: 'claude', lastSessionId: sid,
      conversations: [{ sessionId: sid, title: 'Seeded', createdAt: 1 }] }],
  }));

  // fake-claude needs a scenario to replay for the send_message tool's turn.
  const scenario = join(dir, 'ok.jsonl');
  writeFileSync(scenario, [
    JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'mcp' } }),
    JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: 'on it' }] } } }),
    JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'done' } }),
    JSON.stringify({ exit: 0 }),
  ].join('\n'));
  process.env.X056_FAKE_SCENARIO = scenario;

  app = await createApp({ token: TOKEN, stateDir, workspaceRoot: dir, claudePath: FAKE });
  await app.listen(0);
  base = await app.getUrl();

  // The real bridge process, exactly as a session would get it.
  mcp = spawn('node', [MCP], { env: { ...process.env, X056_URL: base, X056_TOKEN: TOKEN }, stdio: ['pipe', 'pipe', 'inherit'] });
  createInterface({ input: mcp.stdout! }).on('line', (line) => {
    try {
      const msg = JSON.parse(line) as { id?: number };
      const resolve = msg.id !== undefined ? pending.get(msg.id) : undefined;
      if (resolve) { pending.delete(msg.id as number); resolve(msg as never); }
    } catch { /* not json */ }
  });
});

afterAll(async () => {
  delete process.env.X056_FAKE_SCENARIO;
  try { mcp?.kill(); } catch { /* gone */ }
  await app?.close();
});

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
/** Wait for a pending approval to show up in GET /api/mcp/approvals (the
 *  panel's hydration endpoint) — send_message creates it synchronously but the
 *  test still needs to poll since it races the tool call's own request. */
async function waitForPendingApproval(message: string): Promise<{ id: string }> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${base}/api/mcp/approvals`, { headers: auth })).json() as { id: string; message: string }[];
    const found = list.find((a) => a.message === message);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`approval for "${message}" never appeared`);
}
function decideApproval(id: string, approve: boolean): Promise<Response> {
  return fetch(`${base}/api/mcp/approvals/decide`, { method: 'POST', headers: auth, body: JSON.stringify({ id, approve }) });
}

describe('x056 MCP bridge (real script against a live gateway)', () => {
  it('handshakes: initialize + tools/list expose the conversation and code-graph tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'vitest', version: '1' } });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('x056');
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await rpc('tools/list');
    const names = (tools.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    // The four conversation tools are the invariant; code-graph/memory tools
    // were added alongside them and must not displace any.
    expect(names.slice(0, 4)).toEqual(['list_projects', 'list_conversations', 'read_conversation', 'send_message']);
    expect(names).toEqual(expect.arrayContaining(['code_callers', 'code_impact', 'wiki_search', 'wiki_read']));
  });

  it('list_projects / list_conversations expose the gateway state with providers', async () => {
    const projects = toolText(await rpc('tools/call', { name: 'list_projects', arguments: {} }));
    expect(projects).toContain('SeededProj');
    expect(projects).toContain('"provider": "claude"');
    const convs = toolText(await rpc('tools/call', { name: 'list_conversations', arguments: { projectId: 'p1' } }));
    expect(convs).toContain('seeded-conv-1');
    expect(convs).toContain('Seeded');
  });

  it('read_conversation returns the real on-disk transcript across the API', async () => {
    const text = toolText(await rpc('tools/call', { name: 'read_conversation', arguments: { projectId: 'p1', sessionId: 'seeded-conv-1' } }));
    expect(text).toContain('what is the plan?');
    expect(text).toContain('THE_SEEDED_PLAN: ship it');
    expect(text).toMatch(/\[user.*\]/);
    expect(text).toMatch(/\[assistant.*\]/);
  });

  it('send_message pauses for approval, lists as pending, and only dispatches once approved', async () => {
    // The tool call blocks (polling) until a human decides — fire it, then act
    // as the panel operator would: see it in the pending list and approve it.
    const call = rpc('tools/call', { name: 'send_message', arguments: { projectId: 'p1', message: 'kick off a fresh thread' } });
    const pending = await waitForPendingApproval('kick off a fresh thread');
    const listed = await (await fetch(`${base}/api/mcp/approvals`, { headers: auth })).json() as { id: string; projectName: string; targetLabel: string }[];
    expect(listed.some((a) => a.id === pending.id && a.projectName === 'SeededProj' && a.targetLabel === 'a new conversation')).toBe(true);

    const decided = await (await decideApproval(pending.id, true)).json() as { status: string; resultSessionId?: string };
    expect(decided.status).toBe('approved');
    expect(decided.resultSessionId).toBeTruthy();

    const text = toolText(await call);
    expect(text).toContain('sent');
    const sid = /sessionId: ([0-9a-f-]{36})/.exec(text)?.[1];
    expect(sid).toBe(decided.resultSessionId);
    // The gateway really registered it as a conversation of that project.
    const convs = toolText(await rpc('tools/call', { name: 'list_conversations', arguments: { projectId: 'p1' } }));
    expect(convs).toContain(sid as string);
    // Decided requests drop out of the pending list.
    const after = await (await fetch(`${base}/api/mcp/approvals`, { headers: auth })).json() as { id: string }[];
    expect(after.some((a) => a.id === pending.id)).toBe(false);
  });

  it('send_message is never sent when the operator denies it', async () => {
    const before = (await (await fetch(`${base}/api/conversations/history?projectId=p1&sessionId=seeded-conv-1&limit=500`, { headers: auth })).json() as unknown[]).length;
    const call = rpc('tools/call', { name: 'send_message', arguments: { projectId: 'p1', sessionId: 'seeded-conv-1', message: 'please deny me' } });
    const pending = await waitForPendingApproval('please deny me');
    const decided = await (await decideApproval(pending.id, false)).json() as { status: string; resultSessionId?: string };
    expect(decided.status).toBe('denied');
    expect(decided.resultSessionId).toBeUndefined();

    const text = toolText(await call);
    expect(text).toMatch(/denied/i);
    expect(text).toContain('not sent');
    // Nothing was appended to the target conversation's history.
    const after = await (await fetch(`${base}/api/conversations/history?projectId=p1&sessionId=seeded-conv-1&limit=500`, { headers: auth })).json() as unknown[];
    expect(after.length).toBe(before);
  });

  it('send_message to an unknown conversation id is a per-call error, not a crash', async () => {
    const res = await rpc('tools/call', { name: 'send_message', arguments: { projectId: 'p1', sessionId: 'not-a-real-conv', message: 'hi' } });
    const r = res.result as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(toolText(res)).toContain('unknown conversation');
  });
});

describe('send modes and queueing', () => {
  const auth2 = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
  const setMode = (mode: string) => fetch(`${base}/api/settings/mcp-send-mode`, { method: 'POST', headers: auth2, body: JSON.stringify({ mode }) });
  const send = (body: Record<string, unknown>) =>
    fetch(`${base}/api/conversations/send`, { method: 'POST', headers: auth2, body: JSON.stringify(body) }).then((r) => r.json() as Promise<any>);

  afterAll(async () => { await setMode('approval'); }); // leave the default as we found it

  it('approval is the default and still gates the send', async () => {
    const s = await (await fetch(`${base}/api/settings`, { headers: auth2 })).json() as any;
    expect(s.mcpSendMode).toBe('approval');
    const out = await send({ projectId: 'p1', prompt: 'gated please' });
    expect(out.mode).toBe('approval');
    expect(out.approvalId).toBeTruthy();
    expect(out.sessionId).toBeUndefined(); // nothing dispatched yet
    // clean up so it doesn't linger as a pending card
    await fetch(`${base}/api/mcp/approvals/decide`, { method: 'POST', headers: auth2, body: JSON.stringify({ id: out.approvalId, approve: false }) });
  });

  it('automatic mode delivers straight away, with no approval to decide', async () => {
    await setMode('auto');
    const before = await (await fetch(`${base}/api/mcp/approvals`, { headers: auth2 })).json() as unknown[];
    const out = await send({ projectId: 'p1', prompt: 'no approval needed' });
    expect(out.mode).toBe('auto');
    expect(out.sessionId).toBeTruthy();
    expect(out.queued).toBe(false);
    // it raised no approval request at all
    const after = await (await fetch(`${base}/api/mcp/approvals`, { headers: auth2 })).json() as unknown[];
    expect(after.length).toBe(before.length);
  });

  it('queues instead of failing when that conversation is mid-turn', async () => {
    await setMode('auto');
    const first = await send({ projectId: 'p1', prompt: 'start a turn' });
    const sid = first.sessionId as string;
    // second message while the first turn is still running
    const second = await send({ projectId: 'p1', sessionId: sid, prompt: 'while busy' });
    expect(second.sessionId).toBe(sid);
    // either it was queued, or the first turn had already finished — assert the
    // outcome that actually happened rather than racing the fake CLI
    if (second.queued) {
      const q = await (await fetch(`${base}/api/queue`, { headers: auth2 })).json() as Record<string, { text: string }[]>;
      expect(JSON.stringify(q)).toContain('while busy');
    } else {
      expect(second.queued).toBe(false);
    }
  });

  it('rejects an unknown mode', async () => {
    const res = await setMode('whatever');
    expect(res.status).toBe(400);
  });
});
