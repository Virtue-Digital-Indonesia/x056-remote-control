#!/usr/bin/env node
// x056 MCP bridge: exposes the gateway's projects/conversations to AI models as
// MCP tools, so a session (Claude or Codex) can READ other conversations — in
// its own project or any other — and SEND messages to them (cross-conversation,
// cross-project, even cross-provider: a Claude session can message a ChatGPT
// conversation and vice versa, because everything goes through the gateway's
// HTTP API rather than either CLI's own transcript format).
//
// Protocol: MCP over stdio (newline-delimited JSON-RPC 2.0) — implemented by
// hand so the gateway image needs no extra dependency. Auth + endpoint come
// from the environment the gateway wires into each spawned turn:
//   X056_URL   gateway base URL (default http://localhost:4056)
//   X056_TOKEN bearer token (required)
import { createInterface } from 'node:readline';
import { SERVER_INFO, TOOLS, callTool } from './x056-mcp-tools.mjs';

const BASE = process.env.X056_URL || 'http://localhost:4056';
const TOKEN = process.env.X056_TOKEN || '';

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.message) || `gateway returned ${res.status}`);
  return body;
}

// ---- MCP stdio plumbing (newline-delimited JSON-RPC 2.0) ----
const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === 'initialize') {
    out({ jsonrpc: '2.0', id, result: {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    } });
    return;
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return; // notifications need no reply
  if (method === 'ping') { out({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { out({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    try {
      const text = await callTool(api, params?.name, params?.arguments || {});
      out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (err) {
      out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
