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

/**
 * Code-graph + memory tools, served through the gateway (POST /api/codegraph/call)
 * rather than by talking to the knowledge service directly: the service lives on
 * the dind sidecar and is unreachable from outside the container, and the gateway
 * holds its token. That is what lets an external client — Claude Desktop, claude.ai —
 * use these over the same OAuth-gated endpoint as everything else.
 *
 * ids are optional everywhere: the gateway fills in this repo's graph and the
 * memory wiki, because there is no tool to discover those ids.
 */
const CODEGRAPH_TOOLS = [
  ['code_search', 'Find a symbol by name in the indexed codebase. Returns locations and signatures, not source — follow with code_node or code_explore for the code itself.',
    { query: { type: 'string', description: 'symbol name or partial name' }, limit: { type: 'number' } }, ['query']],
  ['code_callers', 'List the functions that CALL a symbol, by name and location. Use this for "what breaks if I change this" — it resolves each call site to its enclosing function, which a text search cannot.',
    { symbol: { type: 'string' }, limit: { type: 'number' } }, ['symbol']],
  ['code_callees', 'List the functions a symbol calls.', { symbol: { type: 'string' }, limit: { type: 'number' } }, ['symbol']],
  ['code_impact', 'Walk the dependency chain out from a symbol to the given depth — the transitive blast radius of changing it.',
    { symbol: { type: 'string' }, depth: { type: 'number', description: '1-10, default 2' } }, ['symbol']],
  ['code_explore', 'Find files matching a query and return their source.', { query: { type: 'string' }, maxFiles: { type: 'number' } }, ['query']],
  ['code_node', 'Details of one symbol; set includeCode for its source.',
    { symbol: { type: 'string' }, includeCode: { type: 'boolean' }, file: { type: 'string' }, line: { type: 'number' } }, ['symbol']],
  ['wiki_search', 'Search saved memories across ALL projects on this gateway (deployment gotchas, auth decisions, e2e recipes, user preferences). Lexical search, so prefer two or three concrete words over a sentence. Returns page paths — read one with wiki_read.',
    { query: { type: 'string' }, limit: { type: 'number' } }, ['query']],
  ['wiki_read', 'Read one memory page in full, by the path wiki_search returned.', { ref: { type: 'string', description: 'page path from wiki_search' } }, ['ref']],
];

for (const [name, description, props, required] of CODEGRAPH_TOOLS) {
  TOOLS.push({
    name,
    description,
    inputSchema: { type: 'object', properties: props, required, additionalProperties: false },
  });
}

const CODEGRAPH_TOOL_NAMES = new Set(CODEGRAPH_TOOLS.map(([n]) => n));

const CRON_TOOLS = [
  {
    name: 'schedule_task',
    description:
      'Schedule a prompt to be sent to a conversation on a repeating cron schedule — a daily standup, an hourly health check, a Monday-morning review. '
      + 'The prompt runs as a real turn in that conversation, so write it as an instruction to whoever picks it up, with the context they will need; they will not remember why it was scheduled. '
      + 'Omit sessionId to target your own conversation. Schedule is 5-field cron (minute hour day-of-month month day-of-week). '
      + 'Times are interpreted in the operator\'s timezone unless you pass tz, NOT in UTC — "0 9 * * *" means 9am where they are.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule: { type: 'string', description: '5-field cron, e.g. "0 9 * * 1-5" for 9am on weekdays' },
        prompt: { type: 'string', description: 'the message to send each time' },
        projectId: { type: 'string', description: 'omit to use your own project' },
        sessionId: { type: 'string', description: 'target conversation; omit for your own' },
        tz: { type: 'string', description: 'IANA timezone, e.g. Asia/Jakarta. Defaults to the operator\'s.' },
        label: { type: 'string', description: 'short note on what this job is for' },
      },
      required: ['schedule', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_scheduled',
    description: 'List the scheduled jobs on this gateway: id, schedule, timezone, target conversation, when each last ran and what happened.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'cancel_scheduled',
    description: 'Delete a scheduled job by the id from list_scheduled. To pause without losing it, use pause_scheduled instead.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'pause_scheduled',
    description: 'Pause or resume a scheduled job without deleting it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, paused: { type: 'boolean', description: 'true to pause, false to resume' } },
      required: ['id', 'paused'],
      additionalProperties: false,
    },
  },
];
for (const t of CRON_TOOLS) TOOLS.push(t);
const CRON_TOOL_NAMES = new Set(CRON_TOOLS.map((t) => t.name));

function fmtJobs(data) {
  const jobs = data?.jobs ?? [];
  if (!jobs.length) return '(nothing scheduled)';
  return jobs.map((j) => {
    const when = j.lastRunAt ? new Date(j.lastRunAt).toISOString() : 'never';
    return `${j.enabled ? '●' : '○'} id=${j.id}  ${j.schedule}  (${j.tz})`
      + `${j.label ? '  — ' + j.label : ''}\n   project=${j.projectId} conversation=${j.sessionId ?? '(new each run)'}`
      + `\n   last run: ${when}${j.lastResult ? ' · ' + j.lastResult : ''} · ${j.runCount} run(s)`
      + `\n   prompt: ${String(j.prompt ?? '').replace(/\s+/g, ' ').slice(0, 160)}`;
  }).join('\n\n');
}


/** The conversation this bridge is running inside, injected per turn by the
 *  manager. Absent for an external client (Claude Desktop has no "self"). */
const SELF = {
  projectId: process.env.X056_SELF_PROJECT_ID || '',
  sessionId: process.env.X056_SELF_SESSION_ID || '',
};

const QUEUE_TOOLS = [
  {
    name: 'list_queued',
    description:
      'List messages waiting to be delivered to a conversation. A message sent to a conversation that is mid-turn is queued rather than dropped, so this is how you see what will arrive next, and in what order. Omit projectId to list every project\'s queue.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'omit for all projects' },
        sessionId: { type: 'string', description: 'omit to include every conversation of that project' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cancel_queued',
    description:
      'Cancel a queued message before it is delivered, by the id from list_queued. Use when a queued follow-up has been overtaken by events — the answer arrived another way, or the request is no longer wanted. Cannot recall a message already delivered.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, id: { type: 'string', description: 'id from list_queued' } },
      required: ['projectId', 'id'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_queued',
    description:
      'Rewrite a queued message before it is delivered. Use to add what you have since learned rather than cancelling and re-sending, which would lose its place in the queue.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        id: { type: 'string', description: 'id from list_queued' },
        message: { type: 'string', description: 'replacement text' },
      },
      required: ['projectId', 'id', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'message_self',
    description:
      'Queue a message to YOUR OWN conversation, delivered as a new turn the moment this one ends. '
      + 'Use it to hand yourself work you cannot finish now — a long build to check, a follow-up after a deploy lands — so it survives the end of this turn, which otherwise kills any background work. '
      + 'It is a note to your future self, so write the context that self will need; it will not remember this turn\'s reasoning beyond the transcript. '
      + 'Only available to a session running on this gateway. Bounded: a few consecutive self-messages with no human message in between are refused, so this cannot become a silent infinite loop.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

for (const t of QUEUE_TOOLS) TOOLS.push(t);
const QUEUE_TOOL_NAMES = new Set(QUEUE_TOOLS.map((t) => t.name));

function fmtQueue(map, filter) {
  const rows = [];
  for (const [pid, items] of Object.entries(map ?? {})) {
    if (filter.projectId && pid !== filter.projectId) continue;
    for (const it of items ?? []) {
      if (filter.sessionId && it.sessionId !== filter.sessionId) continue;
      rows.push({ pid, ...it });
    }
  }
  if (!rows.length) return '(nothing queued)';
  rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  return rows
    .map((r, i) => {
      const when = r.at ? new Date(r.at).toISOString() : '?';
      const head = `${i + 1}. id=${r.id}  project=${r.pid}  conversation=${r.sessionId ?? '?'}  queued=${when}`;
      const text = String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
      return `${head}\n   ${text}`;
    })
    .join('\n');
}

// MCP gives a server no way to READ a client's conversation — roots, sampling
// and elicitation are the only client primitives and none expose the transcript.
// So the only possible direction is the client pushing to us: this is how an
// external client (Claude Desktop, claude.ai) hands over what it worked out.
TOOLS.push({
  name: 'save_memory',
  description:
    'Save a durable note into one of this gateway\'s projects, so its future sessions know it. '
    + 'Use for a conclusion worth keeping — a decision, a gotcha, a convention — not for chat transcripts or anything already in the repo. '
    + 'The note is written into that project\'s memory directory (so it is loaded into that project\'s future sessions) and becomes searchable from every project via wiki_search. '
    + 'It is stamped as externally authored and its name is prefixed "desktop-", so it can never overwrite a memory this gateway wrote itself. Re-saving the same name replaces it.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'id from list_projects' },
      name: { type: 'string', description: 'short kebab-case slug, e.g. "postgres-pool-limit"' },
      description: { type: 'string', description: 'one line explaining what this is, used when deciding relevance later' },
      content: { type: 'string', description: 'the note itself, markdown; state the fact and why it matters' },
    },
    required: ['projectId', 'name', 'description', 'content'],
    additionalProperties: false,
  },
});

/** Render whatever shape a code-graph/wiki route returns as readable text. */
function fmtCodegraph(tool, data) {
  if (data == null) return '(no result)';
  if (typeof data === 'string') return data;
  // Code query routes answer {text, isError}; wiki search answers {results:[…]}.
  if (typeof data.text === 'string') return data.text || '(no result)';
  if (Array.isArray(data.results)) {
    if (!data.results.length) return '(no matches)';
    return data.results.map((r) => `${r.path ?? r.ref ?? r.title ?? '?'}${r.score != null ? `  (score ${Number(r.score).toFixed(2)})` : ''}`).join('\n');
  }
  if (Array.isArray(data.items)) {
    if (!data.items.length) return '(none)';
    // page/read answers [{ref, content}] — the CONTENT is the point of the call,
    // so render it under its ref rather than listing bare paths.
    if (data.items.some((i) => i && typeof i.content === 'string')) {
      return data.items.map((i) => `# ${i.ref ?? '?'}\n\n${i.content ?? '(empty)'}`).join('\n\n---\n\n');
    }
    return data.items.map((i) => (typeof i === 'string' ? i : i.path ?? i.ref ?? i.title ?? JSON.stringify(i))).join('\n');
  }
  return JSON.stringify(data, null, 2);
}

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
  if (CRON_TOOL_NAMES.has(name)) {
    if (name === 'list_scheduled') return fmtJobs(await api('/api/cron'));
    if (name === 'cancel_scheduled') {
      const res = await api('/api/cron/remove', { method: 'POST', body: JSON.stringify({ id: args.id }) });
      return res?.ok ? `cancelled scheduled job ${args.id}.` : `no scheduled job with id ${args.id}.`;
    }
    if (name === 'pause_scheduled') {
      const job = await api('/api/cron/enabled', { method: 'POST', body: JSON.stringify({ id: args.id, enabled: !args.paused }) });
      return `job ${job.id} is now ${job.enabled ? 'active' : 'paused'} (${job.schedule}, ${job.tz}).`;
    }
    if (name === 'schedule_task') {
      const projectId = args.projectId ?? SELF.projectId;
      if (!projectId) throw new Error('projectId is required (this client has no project of its own)');
      const sessionId = args.sessionId ?? (args.projectId ? undefined : SELF.sessionId || undefined);
      const job = await api('/api/cron', {
        method: 'POST',
        body: JSON.stringify({ schedule: args.schedule, prompt: args.prompt, projectId, sessionId, tz: args.tz, label: args.label, createdBy: SELF.sessionId || 'mcp' }),
      });
      return `scheduled job ${job.id}: "${job.schedule}" in ${job.tz}`
        + `${job.sessionId ? ` → conversation ${job.sessionId}` : ' → a new conversation each run'}.`
        + `\nUse list_scheduled to see it, cancel_scheduled to remove it.`;
    }
  }
  if (QUEUE_TOOL_NAMES.has(name)) {
    if (name === 'list_queued') {
      const map = await api('/api/queue');
      return fmtQueue(map, { projectId: args.projectId, sessionId: args.sessionId });
    }
    if (name === 'cancel_queued') {
      await api('/api/queue/remove', { method: 'POST', body: JSON.stringify({ projectId: args.projectId, id: args.id }) });
      return `cancelled queued message ${args.id} — it will not be delivered.`;
    }
    if (name === 'edit_queued') {
      await api('/api/queue/edit', { method: 'POST', body: JSON.stringify({ projectId: args.projectId, id: args.id, prompt: args.message }) });
      return `rewrote queued message ${args.id}; it keeps its place in the queue.`;
    }
    if (name === 'message_self') {
      if (!SELF.projectId || !SELF.sessionId) {
        throw new Error('message_self is only available to a conversation running on this gateway (no self identity in this client)');
      }
      const res = await api('/api/queue/self', {
        method: 'POST',
        body: JSON.stringify({ projectId: SELF.projectId, sessionId: SELF.sessionId, prompt: args.message }),
      });
      return `queued for yourself (id ${res?.id ?? '?'}). It starts a new turn as soon as this one ends.\n`
        + `${res?.remaining != null ? `${res.remaining} consecutive self-message(s) left before a human message is required.` : ''}`;
    }
  }
  if (CODEGRAPH_TOOL_NAMES.has(name)) {
    const res = await api('/api/codegraph/call', {
      method: 'POST',
      body: JSON.stringify({ tool: name, args }),
    });
    return fmtCodegraph(name, res?.data ?? res);
  }
  if (name === 'save_memory') {
    const res = await api('/api/memories/save', {
      method: 'POST',
      body: JSON.stringify({
        projectId: args.projectId,
        name: args.name,
        description: args.description,
        content: args.content,
        source: 'claude-desktop',
      }),
    });
    const where = res?.accounts?.length ? ` on ${res.accounts.length} account(s)` : '';
    return `${res?.existed ? 'Replaced' : 'Saved'} memory ${res?.file}${where}.\n`
      + 'It loads into that project\'s future sessions, and is searchable from any project with wiki_search '
      + '(within the hour, once the memory mirror next runs).';
  }
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
