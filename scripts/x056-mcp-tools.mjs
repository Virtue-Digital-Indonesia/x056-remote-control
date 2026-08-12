// Tool definitions + implementations for the x056 MCP bridge, shared by BOTH
// transports: the stdio server the gateway spawns per turn (scripts/x056-mcp.mjs)
// and the Streamable HTTP endpoint the gateway serves at /mcp for external
// clients (Claude Desktop, another Claude Code, any MCP client). Keeping them
// here means a tool can never exist on one transport and not the other.
//
// `api` is injected so each transport supplies its own authenticated fetch.

export const SERVER_INFO = { name: 'x056', version: '2.0.0' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TOOLS = [
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
      'The operator chooses the delivery mode in the panel: in APPROVAL mode (the default) this call pauses until they approve or deny it — it is not sent until approved, and may be denied; in AUTOMATIC mode it is delivered immediately. You cannot choose the mode. '
      + 'If that conversation is mid-turn the message is QUEUED and delivered when its current turn ends, ahead of any autopilot continuation. ' +
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

/** Poll a conversation's history until an assistant row appears past `before`. */
async function waitForReply(api, projectId, sid, before, waitSeconds) {
  const waitMs = Math.min(Math.max((waitSeconds || 0) * 1000, 0), 10 * 60 * 1000);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    const rows = await api(`/api/conversations/history?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sid)}&limit=500`).catch(() => null);
    if (!rows) continue;
    const reply = rows.slice(before).filter((r) => r.role === 'assistant');
    if (reply.length) return `reply from ${sid}:\n\n${reply.map((r) => r.text).join('\n\n')}`;
  }
  return `sent (sessionId: ${sid}), but no reply within ${Math.round(waitMs / 1000)}s — the turn may still be running. Poll read_conversation for the result.`;
}

export async function callTool(api, name, args) {
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
    // Two modes, chosen by the OPERATOR in the panel (not by us): 'auto' delivers
    // straight away, 'approval' waits for them to approve it. Either way, if that
    // conversation is mid-turn the message goes on its queue rather than failing.
    if (requested.mode === 'auto') {
      const sid = requested.sessionId;
      const where = requested.queued
        ? `queued — that conversation is mid-turn, so it will be delivered the moment its current turn ends.`
        : `delivered — its turn is running now.`;
      if (!args.waitSeconds || requested.queued) {
        return `sent (automatic mode). ${where}\nsessionId: ${sid}\nUse read_conversation to fetch the reply later.`;
      }
      return await waitForReply(api, args.projectId, sid, before, args.waitSeconds);
    }
    // Approval mode: the send does NOT happen yet — wait for the human operator's
    // decision in the panel (or the request to expire) before anything is sent.
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
    if (approval.queued) {
      return `approved and queued — that conversation is mid-turn, so it will be delivered when its current turn ends.\nsessionId: ${sid}\nUse read_conversation to fetch the reply later.`;
    }
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
