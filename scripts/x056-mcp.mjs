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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TOOLS = [
  {
    name: 'list_projects',
    description:
      'List the projects on this x056 gateway (id, name, working directory, provider — which AI runs it — and which is currently selected in the panel). Use the ids with the other tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_conversations',
    description:
      'List a project\'s conversations (sessionId, title, provider, created time). A conversation is one resumable chat thread with the AI running that project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'id from list_projects' } },
      required: ['projectId'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_conversation',
    description:
      'Read a conversation\'s message history (user + assistant turns, oldest first). Works across projects and providers.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        sessionId: { type: 'string', description: 'conversation id from list_conversations' },
        limit: { type: 'number', description: 'max messages, from the end (default 30)' },
      },
      required: ['projectId', 'sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Send a message to a conversation (it resumes with full context and runs a turn), or omit sessionId to start a NEW conversation in the project. ' +
      'REQUIRES THE HUMAN OPERATOR\'S APPROVAL: this call pauses (polling) until they approve or deny it in the panel, or it times out (~10 minutes) — it is not sent until approved, and may be denied. ' +
      'Set waitSeconds > 0 to additionally wait for and return the reply once sent; otherwise returns as soon as it is sent, and the reply can be fetched later with read_conversation. The receiving AI may take minutes on hard tasks — prefer a short wait plus polling over a long block.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        sessionId: { type: 'string', description: 'omit to start a new conversation' },
        message: { type: 'string' },
        model: { type: 'string', description: 'optional model id valid for that conversation\'s provider' },
        effort: { type: 'string', description: 'optional reasoning effort valid for that provider' },
        waitSeconds: { type: 'number', description: 'wait up to this long for the reply (default 0 = don\'t wait)' },
      },
      required: ['projectId', 'message'],
      additionalProperties: false,
    },
  },
];

function fmtHistory(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '(no messages)';
  return rows
    .filter((r) => r.role === 'user' || r.role === 'assistant')
    .map((r) => `[${r.role}${r.ts ? ' ' + r.ts : ''}]\n${r.text}`)
    .join('\n\n');
}

async function callTool(name, args) {
  if (name === 'list_projects') {
    const reg = await api('/api/projects');
    const list = (reg.projects || reg || []).map((p) => ({ id: p.id, name: p.name, cwd: p.cwd, provider: p.provider || 'claude', current: p.id === reg.current }));
    return JSON.stringify(list, null, 2);
  }
  if (name === 'list_conversations') {
    const reg = await api('/api/projects');
    const p = (reg.projects || reg || []).find((x) => x.id === args.projectId);
    if (!p) throw new Error('unknown projectId — use list_projects');
    const convs = (p.conversations || []).map((c) => ({ sessionId: c.sessionId, title: c.title, provider: c.provider || 'claude', createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : undefined, current: c.sessionId === p.lastSessionId }));
    return JSON.stringify(convs, null, 2);
  }
  if (name === 'read_conversation') {
    const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 30;
    const rows = await api(`/api/conversations/history?projectId=${encodeURIComponent(args.projectId)}&sessionId=${encodeURIComponent(args.sessionId)}&limit=${limit}`);
    return fmtHistory(rows);
  }
  if (name === 'send_message') {
    const before = args.sessionId
      ? (await api(`/api/conversations/history?projectId=${encodeURIComponent(args.projectId)}&sessionId=${encodeURIComponent(args.sessionId)}&limit=500`)).length
      : 0;
    const requested = await api('/api/conversations/send', {
      method: 'POST',
      body: JSON.stringify({ projectId: args.projectId, sessionId: args.sessionId, prompt: args.message, model: args.model, effort: args.effort }),
    });
    // The send does NOT happen yet — wait for the human operator's decision in
    // the panel (or the request to expire) before anything is actually sent.
    const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000 + 15000; // give the server's own 10min timeout time to land first
    const approvalDeadline = Date.now() + APPROVAL_TIMEOUT_MS;
    const statusUrl = `/api/conversations/send-status?id=${encodeURIComponent(requested.approvalId)}`;
    let approval = await api(statusUrl);
    while (approval.status === 'pending' && Date.now() < approvalDeadline) {
      await sleep(2000);
      approval = await api(statusUrl).catch(() => approval);
    }
    if (approval.status === 'pending') return 'still awaiting the operator\'s approval — not sent. It will expire soon; try again later if this is still needed.';
    if (approval.status === 'expired') return 'the approval request expired before the operator responded — not sent.';
    if (approval.status === 'denied') return 'the operator DENIED this message — it was not sent.';
    if (approval.error) return `approved, but the send itself failed: ${approval.error}`;
    const sid = approval.resultSessionId;
    const waitMs = Math.min(Math.max((args.waitSeconds || 0) * 1000, 0), 10 * 60 * 1000);
    if (waitMs <= 0) {
      return `sent — the turn is running.\nsessionId: ${sid}\nUse read_conversation (projectId=${args.projectId}, sessionId=${sid}) to fetch the reply once it finishes.`;
    }
    // Wait for the reply: history grows past what was there before the send
    // (the sent user message itself counts, so require an ASSISTANT entry after it).
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(3000);
      const rows = await api(`/api/conversations/history?projectId=${encodeURIComponent(args.projectId)}&sessionId=${encodeURIComponent(sid)}&limit=500`).catch(() => null);
      if (!rows) continue;
      const fresh = rows.slice(before);
      const reply = fresh.filter((r) => r.role === 'assistant');
      if (reply.length) return `reply from ${sid}:\n\n${reply.map((r) => r.text).join('\n\n')}`;
    }
    return `sent (sessionId: ${sid}), but no reply within ${Math.round(waitMs / 1000)}s — the turn may still be running. Poll read_conversation for the result.`;
  }
  throw new Error(`unknown tool: ${name}`);
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
      serverInfo: { name: 'x056', version: '1.0.0' },
    } });
    return;
  }
  if (method === 'notifications/initialized' || String(method || '').startsWith('notifications/')) return; // notifications need no reply
  if (method === 'ping') { out({ jsonrpc: '2.0', id, result: {} }); return; }
  if (method === 'tools/list') { out({ jsonrpc: '2.0', id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    try {
      const text = await callTool(params?.name, params?.arguments || {});
      out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (err) {
      out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } });
    }
    return;
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
});
