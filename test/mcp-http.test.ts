import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import { createApp } from '../server/main.js';

const TOKEN = 'test-token-0123456789abcdefghij';
let app: INestApplication;
let base = '';

/** One JSON-RPC round trip against the Streamable HTTP endpoint. */
async function rpc(body: unknown, opts: { token?: string | null; query?: string } = {}): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const tok = opts.token === undefined ? TOKEN : opts.token;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${base}/mcp${opts.query ?? ''}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 202 has no body */ }
  return { status: res.status, json, text };
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x056-mcphttp-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg-a') }]);
  const proj = join(dir, 'workdir'); mkdirSync(proj, { recursive: true });
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{ id: 'p1', name: 'SeededProj', cwd: proj, provider: 'claude', conversations: [] }],
  }));
  app = await createApp({ token: TOKEN, stateDir, workspaceRoot: dir });
  await app.listen(0);
  base = await app.getUrl();
});

afterAll(async () => { await app?.close(); });

describe('MCP over Streamable HTTP (generic client compatibility)', () => {
  it('completes the initialize handshake, echoing a protocol revision it supports', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });
    expect(r.status).toBe(200);
    expect(r.json.result.protocolVersion).toBe('2025-03-26'); // the one the client asked for
    expect(r.json.result.serverInfo.name).toBe('x056');
    expect(r.json.result.capabilities.tools).toBeTruthy();
  });

  it('answers an unknown protocol revision with its own latest rather than failing', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect(r.json.result.protocolVersion).toBe('2025-06-18');
  });

  it('acknowledges a notification with 202 and NO body (it has no id to answer)', async () => {
    const r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(r.status).toBe(202);
    expect(r.text).toBe('');
  });

  it('lists the same tools the stdio bridge exposes', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(r.json.result.tools.map((t: { name: string }) => t.name)).toEqual(
      ['list_projects', 'list_conversations', 'read_conversation', 'send_message'],
    );
    for (const t of r.json.result.tools) expect(t.inputSchema).toBeTruthy(); // clients need a schema to call it
  });

  it('runs a tool and returns its output as MCP content', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_projects', arguments: {} } });
    expect(r.json.result.isError).toBeUndefined();
    expect(r.json.result.content[0].type).toBe('text');
    expect(r.json.result.content[0].text).toContain('SeededProj');
  });

  it('reports a failing tool as isError content, not a JSON-RPC error', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_message', arguments: { projectId: 'p1', sessionId: 'nope', message: 'hi' } } });
    expect(r.json.error).toBeUndefined();       // the CALL succeeded…
    expect(r.json.result.isError).toBe(true);   // …the tool reported failure, which the model can read
    expect(r.json.result.content[0].text).toMatch(/unknown conversation/);
  });

  it('returns -32601 for a method it does not implement', async () => {
    const r = await rpc({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    expect(r.json.error.code).toBe(-32601);
  });

  it('answers a batch with an array (older clients still send them)', async () => {
    const r = await rpc([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
    ]);
    expect(Array.isArray(r.json)).toBe(true);
    expect(r.json.map((m: { id: string }) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('requires auth, and accepts it as a bearer header OR ?token= (clients that cannot set headers)', async () => {
    expect((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { token: null })).status).toBe(401);
    expect((await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { token: null, query: '?token=wrong' })).status).toBe(401);
    const okQ = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/list' }, { token: null, query: `?token=${TOKEN}` });
    expect(okQ.status).toBe(200);
    expect(okQ.json.result.tools.length).toBe(4);
  });

  it('refuses GET (no server-initiated stream) with an Allow header', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});
