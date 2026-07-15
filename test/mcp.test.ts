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

describe('x056 MCP bridge (real script against a live gateway)', () => {
  it('handshakes: initialize + tools/list expose the four tools', async () => {
    const init = await rpc('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'vitest', version: '1' } });
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('x056');
    mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await rpc('tools/list');
    const names = (tools.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(['list_projects', 'list_conversations', 'read_conversation', 'send_message']);
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

  it('send_message starts a NEW conversation in the project and reports its sessionId', async () => {
    const text = toolText(await rpc('tools/call', { name: 'send_message', arguments: { projectId: 'p1', message: 'kick off a fresh thread' } }));
    expect(text).toContain('sent');
    const sid = /sessionId: ([0-9a-f-]{36})/.exec(text)?.[1];
    expect(sid).toBeTruthy();
    // The gateway really registered it as a conversation of that project.
    const convs = toolText(await rpc('tools/call', { name: 'list_conversations', arguments: { projectId: 'p1' } }));
    expect(convs).toContain(sid as string);
  });

  it('send_message to an unknown conversation id is a per-call error, not a crash', async () => {
    const res = await rpc('tools/call', { name: 'send_message', arguments: { projectId: 'p1', sessionId: 'not-a-real-conv', message: 'hi' } });
    const r = res.result as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(toolText(res)).toContain('unknown conversation');
  });
});
