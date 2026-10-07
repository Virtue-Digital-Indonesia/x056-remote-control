import { Ajv } from 'ajv';
import { WORKSPACE_TOOLS, callWorkspaceTool } from './x056-mcp-workspace.mjs';
import { CHAT_TOOLS, CHAT_OUTPUT, callChatTool } from './x056-mcp-chat.mjs';
import { PROJECT_FILE_TOOLS, callProjectFileTool } from './x056-mcp-project-files.mjs';
// Tool definitions + implementations for the x056 MCP bridge, shared by BOTH
// transports: the stdio server the gateway spawns per turn (scripts/x056-mcp.mjs)
// and the Streamable HTTP endpoint the gateway serves at /mcp for external
// clients (Claude Desktop, another Claude Code, any MCP client). Keeping them
// here means a tool can never exist on one transport and not the other.
//
// `api` is injected so each transport supplies its own authenticated fetch.

import { OUTPUT_SCHEMAS } from './x056-mcp-output.mjs';

export const SERVER_INFO = { name: 'x056', version: '2.3.0' };

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
      'Read a conversation\'s message history (user + assistant turns, oldest first). Works across projects and providers. Also returns its helpers (advisor, agent team, model/effort picker) and its delegates with their status.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        sessionId: { type: 'string', description: 'conversation id from list_conversations' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'max messages, from the end (default 30, max 500)' },
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
      'Set waitSeconds > 0 to additionally wait for and return the reply once sent; otherwise returns as soon as it is sent. Use read_reply with the returned messageId for the exact reply later, including queued messages. Reply text may still be streaming; it does not prove task completion. The receiving AI may take minutes on hard tasks — prefer a short wait plus polling over a long block. '
      + 'BOUNDED: an AI-to-AI exchange may run a limited number of hops before the gateway refuses further sends and requires a human message. Two conversations passing a task back and forth cannot tell that they are stuck, so treat a refusal as the answer: write up what you have, unresolved parts included, for the person. Use stop_conversation to end a runaway exchange early.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        sessionId: { type: 'string', description: 'omit to start a new conversation' },
        message: { type: 'string' },
        model: { type: 'string', description: 'Model id for the target conversation\'s provider. Omit to reuse that conversation\'s last selected model; new conversations use the project default. Empty string selects the provider default. The choice is retained through approval and queueing.' },
        effort: { type: 'string', description: 'Reasoning effort for the target provider. Omit to reuse the target conversation\'s last selection; empty string selects the provider default.' },
        waitSeconds: { type: 'number', description: 'wait up to this long for the reply (default 0 = don\'t wait)' },
        steer: { type: 'boolean', description: 'STEER: if that conversation is mid-turn, put this message INTO its running turn (it reads it now, not after the turn) instead of queueing it. If it is not running a turn this is an ordinary send. Same approval mode and hop bound. Default false. See the steer tool for when to use it.' },
        helpers: { type: 'object', properties: { advisor: { type: 'boolean' }, team: { type: 'boolean' }, router: { type: 'string', enum: ['jev', 'decisions', 'none'], description: 'per-turn model/effort picker; none = the conversation\'s own model/effort (saved, so the Jev default no longer applies)' }, lean: { type: 'string', enum: ['low', 'medium', 'high'], description: 'which way the picker errs: low = cheaper models and less effort, high = stronger ones' } }, additionalProperties: false, description: 'Turn helpers on or off for the target before this message runs (only those named change): advisor, the agent team, the Jev/OpenAI Decisions picker. Applied only if the send is delivered.' },
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
      'Schedule a prompt to be sent to a conversation — a daily standup, an hourly health check, or a ONE-OFF (set once: true) like "check the deploy at 3am". '
      + 'Works for ChatGPT/Codex and Claude. Gateway jobs persist after the CLI exits and appear in Automations; use this tool for work in this panel rather than a provider-local or desktop scheduler. Verify creation with list_scheduled. '
      + 'The prompt runs as a real turn in that conversation, so write it as an instruction to whoever picks it up, with the context they will need; they will not remember why it was scheduled. '
      + 'Omit sessionId to target your own conversation. Schedule is 5-field cron (minute hour day-of-month month day-of-week). '
      + 'Times are interpreted in the operator\'s timezone unless you pass tz, NOT in UTC — "0 9 * * *" means 9am where they are. '
      + 'For anything meant to happen only once, PASS once: true — a bare "0 3 * * *" is a job that fires every night forever, and the surprise lands a day after everyone stopped thinking about it.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule: { type: 'string', description: '5-field cron, e.g. "0 9 * * 1-5" for 9am on weekdays' },
        prompt: { type: 'string', description: 'the message to send each time' },
        projectId: { type: 'string', description: 'omit to use your own project' },
        sessionId: { type: 'string', description: 'target conversation; omit for your own' },
        tz: { type: 'string', description: 'IANA timezone, e.g. Asia/Jakarta. Defaults to the operator\'s.' },
        label: { type: 'string', description: 'short note on what this job is for' },
        once: { type: 'boolean', description: 'run at the next matching time, then delete the job' },
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
    return `${j.enabled ? '●' : '○'} id=${j.id}  ${j.schedule}  (${j.tz})${j.once ? '  [once]' : ''}`
      + `${j.label ? '  — ' + j.label : ''}\n   project=${j.projectId} conversation=${j.sessionId ?? '(new each run)'}`
      + `${j.provider ? ' provider=' + j.provider : ''}`
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
      + 'Use it to hand yourself work you cannot finish now — a long build to check, a follow-up after a deploy lands — so it survives the end of this turn, without depending on a background shell surviving a process restart. '
      + 'It is a note to your future self, so write the context that self will need; it will not remember this turn\'s reasoning beyond the transcript. '
      + 'Only available to a session running on this gateway. Bounded: a few consecutive self-messages with no human message in between are refused, so this cannot become a silent infinite loop.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' }, steer: { type: 'boolean', description: 'deliver INTO this turn now (same as the steer tool with no target) instead of after it; default false' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

// The agent team's fork layer: Jev (or OpenAI Decisions) answers small forks.
QUEUE_TOOLS.push({
  name: 'quick_decision',
  description:
    'Fork layer for AGENT TEAM conversations: hand a small routine choice (which file to open first, which tool or subagent to use, retry a failed step or stop) to a fast decision model and get an answer in well under a second. '
    + 'Give the question, 2 to 6 short distinct options, and one line of context. The answer is SHARP (confident: follow it) or SPLIT (a close call: decide yourself). '
    + 'Not for design decisions or anything the user must decide. Only works in a conversation whose agent team is on.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The fork, as one question.' },
      options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6, description: 'The choices, each short and distinct.' },
      context: { type: 'string', description: 'One or two lines the decision depends on.' },
    },
    required: ['question', 'options'],
    additionalProperties: false,
  },
});

// Helpers of any conversation: read with read_conversation, change here.
QUEUE_TOOLS.push({
  name: 'set_helpers',
  description: 'Turn a conversation\'s helpers on or off -- the advisor, the agent team (explorer/worker/researcher subagents plus the Jev fork layer), and the per-turn model/effort picker (Jev or OpenAI Decisions) with its lean (low = cost, high = performance). With no router saved, Jev picks by default while it has credits; router none keeps the conversation\'s own model/effort. Only the helpers you name change. Defaults to this conversation; give projectId and sessionId for another one. Takes effect from its next turn.',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, sessionId: { type: 'string' }, advisor: { type: 'boolean' }, team: { type: 'boolean' }, router: { type: 'string', enum: ['jev', 'decisions', 'none'] }, lean: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Low = the picker errs toward cheaper models and less effort (cost), High = toward stronger ones (performance), Medium = balanced.' } }, additionalProperties: false },
});

// Delegates: an orchestrator's hidden workers. They never appear in the panel
// as conversations; their reports come back to the orchestrator on their own.
const DELEGATE_NOTE = ' Delegates are hidden workers owned by THIS conversation: no sidebar rows, no approvals, no polling -- when one finishes a turn its report is handed to you automatically (reports that need nothing from you are held until the rest of the team is quiet, then handed over together). Limits: 8 active delegates, and 40 dispatches between two messages from the user.';
QUEUE_TOOLS.push({
  name: 'delegate',
  description: 'Start a worker (a delegate) for a piece of work you are orchestrating: a full agent session that keeps its own context across rounds, on any provider and model, in this project or another.' + DELEGATE_NOTE
    + ' Write a self-contained brief: it does not see this conversation. Do NOT wait, sleep or poll for the result.',
  inputSchema: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Short name, unique among your delegates: "backend", "reviewer", "dwh".' },
      brief: { type: 'string', description: 'Goal, context, files or paths, constraints, and what to report.' },
      provider: { type: 'string', enum: ['claude', 'codex'], description: 'Defaults to this conversation\'s provider.' },
      model: { type: 'string', description: 'e.g. opus, sonnet, fable, gpt-6.1-sol, gpt-6-astra. Defaults to the provider default.' },
      effort: { type: 'string', description: 'low, medium, high, xhigh, max (ultra on some GPT models).' },
      projectId: { type: 'string', description: 'Run in another project\'s working directory (id from list_projects). Defaults to this one.' },
      advisor: { type: 'boolean', description: 'Give it an advisor too.' },
    },
    required: ['role', 'brief'],
    additionalProperties: false,
  },
});
QUEUE_TOOLS.push({
  name: 'delegate_followup',
  description: 'Send a delegate its next instruction. It continues with its full context; if it is still working, the instruction waits for its current turn to end. Its report comes back to you automatically.',
  inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'delegate id from delegate or list_delegates' }, message: { type: 'string' } }, required: ['id', 'message'], additionalProperties: false },
});
QUEUE_TOOLS.push({
  name: 'list_delegates',
  description: 'Delegates of this conversation (or of another one: give projectId and sessionId): role, provider and model, status, and the start of each last report. Pass id for one delegate with its full last report. Dismissed delegates (put away once their DONE report reached you, or by hand) are left out unless include_dismissed is true.',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, sessionId: { type: 'string' }, id: { type: 'string' }, include_dismissed: { type: 'boolean', description: 'Also list dismissed delegates (default false). delegate_followup revives one.' } }, additionalProperties: false },
});
QUEUE_TOOLS.push({
  name: 'stop_delegate',
  description: 'Stop a delegate (or all of them, without id) of this conversation or of another one (projectId + sessionId): its turn ends and its waiting instructions are dropped. With dismiss: true it is also put away (out of the Delegates bar and the 8-active limit; its reports stay). A later delegate_followup from its orchestrator revives it with its context.',
  inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, sessionId: { type: 'string' }, id: { type: 'string' }, dismiss: { type: 'boolean', description: 'Also dismiss it (default false).' } }, additionalProperties: false },
});

QUEUE_TOOLS.push({
  name: 'stop_conversation',
  description:
    'STOP another conversation: abort the turn it is running and drop every message queued for it. '
    + 'This is the brake on an exchange that is going nowhere — two conversations trading "can you check this?" and "here is the report" with no end, '
    + 'or one you asked for something that is now moot and is burning a usage window on it. '
    + 'Stopping the turn alone would not be enough, since the queue would simply drain into a new one, so both go together (set dropQueued false to keep the queue). '
    + 'The stopped turn ends where it is: work already written to disk survives, work still in its head does not, and it will not be resumed automatically. '
    + 'It does NOT give either side more hops — the relay bound is unaffected. Prefer it over sending "please stop", which costs a hop and may not be obeyed.',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string' },
      sessionId: { type: 'string', description: 'the conversation to stop' },
      dropQueued: { type: 'boolean', description: 'also discard its queued messages (default true)' },
    },
    required: ['projectId', 'sessionId'],
    additionalProperties: false,
  },
});

QUEUE_TOOLS.push({
  name: 'steer',
  description:
    'STEER a running turn: your text reaches that conversation\'s model INSIDE the turn it is running now (a mid-turn correction, a finding it needs before it goes further, "stop, the bug is in X"), instead of waiting for the turn to end. '
    + 'Pick the right tool: steer = the target is working right now and should change course on THIS turn; send_message = a new request or hand-off (it queues behind a running turn, or starts one); message_self = a note for your own NEXT turn. '
    + 'No target = your own conversation (also what a subagent reaches: it shares your conversation) -- bounded like message_self, a few in a row without a human message are refused. '
    + 'From a delegate, no target = your orchestrator (no approval; counts on its hop bound). '
    + 'A target that is another conversation follows send_message\'s rules: the operator\'s approval mode applies and the AI-to-AI hop bound counts. '
    + 'If nothing is running there it is NOT lost: your own conversation gets it as a queued message, another conversation as an ordinary send. The result says which: steered, queued, started or pending_approval.',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'what the running turn should read now; say why it matters, it interrupts work in progress' },
      project_id: { type: 'string', description: 'target project; omit to steer your own conversation (or, from a delegate, your orchestrator)' },
      session_id: { type: 'string', description: 'target conversation; omit as project_id' },
    },
    required: ['text'],
    additionalProperties: false,
  },
});

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
    + 'The note is saved in canonical shared memory as a review proposal. Confirm it in the Memory workspace before automatic inclusion in future turns. Search confirmed knowledge with memory_search.',
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
    .map((r) => `[${r.role}${r.ts ? ' ' + r.ts : ''}]${r.sender ? '\nFrom: ' + (r.sender.conversationTitle || r.sender.kind) + (r.sender.projectName ? ' · ' + r.sender.projectName : '') : ''}\n${r.text}`)
    .join('\n\n');
}

/** Poll only the exact request; counts and timestamps cannot correlate replies. */
async function waitForReply(api, projectId, sid, messageId, waitSeconds) {
  const waitMs = Math.min(Math.max((waitSeconds || 0) * 1000, 0), 10 * 60 * 1000);
  const deadline = Date.now() + waitMs;
  if (!messageId) throw new Error('Gateway did not return a messageId; do not resend. Read conversation history or upgrade the gateway.');
  while (Date.now() < deadline) {
    await sleep(Math.min(3000, Math.max(0, deadline - Date.now())));
    const data = await api('/api/conversations/reply?' + new URLSearchParams({ projectId, sessionId: sid, messageId })).catch(() => null);
    if (data?.found && data.messages?.length) return { text: `reply from ${sid} (may still be streaming):\n\n${data.messages.map(r => r.text).join('\n\n')}`, status: 'reply', messages: messages(data.messages), truncated: !!data.truncated };
  }
  return { text: `No correlated reply observed within ${Math.round(waitMs / 1000)}s. The message may still be queued or running. Use read_reply with messageId ${messageId}; do not resend merely because this wait ended.`, status: 'reply_timeout', waitSeconds: Math.round(waitMs / 1000) };
}

const MEMORY_TOOLS = [
  [
    'memory_search',
    'Search reviewed gateway memory across conversations, projects and providers. Omit projectId for the current project; crossProject=true searches all shared knowledge. Results include source links and revisions.',
    {
      query: { type: 'string' },
      projectId: { type: 'string' },
      sessionId: { type: 'string' },
      crossProject: { type: 'boolean' },
      kind: { type: 'string' },
      limit: { type: 'number' },
    },
    ['query'],
  ],
  ['memory_source_search','Search eligible document passages with exact file versions and locators. Results respect memory settings, ownership, sharing grants, and this turn’s selected references.',{query:{type:'string'},limit:{type:'number'},offset:{type:'number'}},['query']],
  ['memory_source_read','Read up to five cited passages from an eligible source version. A source grant allows reading, never file editing.',{id:{type:'string'},versionId:{type:'string'},passageId:{type:'string'},offset:{type:'number'},limit:{type:'number'}},['id']],
  [
    'memory_read',
    'Read a shared memory, its source evidence, revision history and relationships.',
    { id: { type: 'string' } },
    ['id'],
  ],
  [
    'memory_propose',
    'Save durable facts, decisions or procedures automatically as memory proposals, with source references. No approval is needed to save. Keep conversation and Work knowledge local; use scope space and spaceId for knowledge intended for the owning Project bank. memory_context returns the current scope. Search existing memory first. Identical notes are reused; same-title corrections must use memory_update. New conversation facts/decisions can be auto-approved only when the operator enables that setting; shared notes and corrections require review.',
    {
      title: { type: 'string' },
      content: { type: 'string' },
      kind: { type: 'string', enum: ['fact', 'decision', 'preference'], description: 'fact (default): something true about the project; decision: a choice and why; preference: how the user wants things done' },
      scope: { type: 'string', enum: ['conversation', 'project', 'space', 'shared', 'global'] },
      projectId: { type: 'string' },
      sessionId: { type: 'string' },
      spaceId:{type:'string'},
      sources:{type:'array',maxItems:20,items:{type:'object',properties:{id:{type:'string'},label:{type:'string'},versionId:{type:'string'}},required:['id','label'],additionalProperties:false}},
      sharedProjectIds: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
    },
    ['title', 'content'],
  ],
  [
    'memory_update',
    'Propose a correction to an existing memory using its current revision. The correction needs review before automatic context inclusion.',
    {
      id: { type: 'string' },
      revision: { type: 'number' },
      title: { type: 'string' },
      content: { type: 'string' },
    },
    ['id', 'revision', 'content'],
  ],
  [
    'memory_context',
    'Preview the reviewed memories that this conversation would receive for a prompt.',
    { query: { type: 'string' }, projectId: { type: 'string' }, sessionId: { type: 'string' } },
    ['query'],
  ],
  [
    'memory_link',
    'Link two memories as related, supporting, contradicting or dependent knowledge.',
    {
      from: { type: 'string' },
      to: { type: 'string' },
      kind: { type: 'string', enum: ['related', 'supports', 'contradicts', 'depends_on'] },
    },
    ['from', 'to', 'kind'],
  ],
];
for (const [name, description, properties, required] of MEMORY_TOOLS)
  TOOLS.push({
    name,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
  });
TOOLS.push(...WORKSPACE_TOOLS);
TOOLS.push(...CHAT_TOOLS);
TOOLS.push(...PROJECT_FILE_TOOLS);
for (const tool of PROJECT_FILE_TOOLS) OUTPUT_SCHEMAS[tool.name] = CHAT_OUTPUT;
for (const tool of CHAT_TOOLS) OUTPUT_SCHEMAS[tool.name] = CHAT_OUTPUT;
for (const tool of TOOLS) {
  if (!OUTPUT_SCHEMAS[tool.name]) throw new Error(`missing output schema: ${tool.name}`);
  tool.outputSchema = OUTPUT_SCHEMAS[tool.name];
  const readOnly = /^(list_|read_|search_|get_|code_|wiki_)/.test(tool.name) || ['chat_status', 'memory_search', 'memory_read', 'memory_context','memory_source_search','memory_source_read'].includes(tool.name);
  tool.annotations = { readOnlyHint: readOnly, destructiveHint: ['stop_chat', 'update_chat', 'stop_conversation', 'cancel_queued', 'cancel_scheduled', 'edit_queued', 'pause_scheduled', 'memory_update'].includes(tool.name), idempotentHint: readOnly, openWorldHint: ['send_chat_message', 'send_message', 'message_self', 'schedule_task'].includes(tool.name) };

}

const inputValidator = new Ajv({ strict: true, allErrors: true });
const inputs = new Map(TOOLS.map(tool => [tool.name, inputValidator.compile(tool.inputSchema)]));

// A conversation's helpers as stored (older rows keep one `decisionMaker`).
const helpersOfRow = (c) => c.helpers || (c.decisionMaker === 'advisor' ? { advisor: true } : c.decisionMaker ? { router: c.decisionMaker } : {});
// `eff` is the picker that actually runs (the gateway's effectiveRouter):
// the saved one, else Jev by default while it has credits. undefined = an
// older gateway that does not report it, so the saved value is all we know.
const helperText = (h = {}, eff) => {
  const saved = h.router === 'none' ? undefined : h.router;
  const r = eff === undefined ? saved : eff || undefined;
  const picker = r && `${r === 'jev' ? 'Jev' : 'OpenAI Decisions'} picks model/effort${!h.router ? ' (default)' : ''}${h.lean ? ` (leaning ${h.lean})` : ''}`;
  return [h.advisor && 'advisor', h.team && 'agent team', picker || (h.router === 'none' ? 'own model/effort (chosen)' : '')].filter(Boolean).join(', ') || 'none';
};
const result = (text, structuredContent) => ({ content: [{ type: 'text', text: text + (structuredContent.delivery?.messageId ? `\nmessageId: ${structuredContent.delivery.messageId}` : '') }], structuredContent });
const messages = (rows) => (Array.isArray(rows) ? rows : [])
  .filter((r) => r.role === 'user' || r.role === 'assistant')
  .map(({ role, text, ts, sender }) => ({ role, text, ...(ts !== undefined ? { ts } : {}), ...(sender ? { sender } : {}) }));

/** Compatibility entry point for callers that only need the legacy text. */
export async function callTool(api, name, args) {
  return (await callToolResult(api, name, args)).content[0].text;
}

/** One execution produces both representations; neither transport replays calls. */
export async function callToolResult(api, name, args) {
  const validate = inputs.get(name);
  if (!validate) throw new Error(`unknown tool: ${name}`);
  if (!validate(args)) throw new Error('Invalid tool arguments: ' + inputValidator.errorsText(validate.errors));
  if (WORKSPACE_TOOLS.some(tool => tool.name === name)) return callWorkspaceTool(api, name, args);
  if (CHAT_TOOLS.some(tool => tool.name === name)) return callChatTool(api, name, args, SELF, callToolResult);
  if (PROJECT_FILE_TOOLS.some(tool => tool.name === name)) return callProjectFileTool(api, name, args, SELF);
  if(MEMORY_TOOLS.some(t=>t[0]===name)){
    const pid=args.projectId||SELF.projectId,sid=args.sessionId||(pid===SELF.projectId?SELF.sessionId:'');
    let path,body;
    if(name==='memory_search'){const query=new URLSearchParams({query:args.query||'',status:'confirmed',...(SELF.projectId&&SELF.sessionId?{callerProjectId:SELF.projectId,callerSessionId:SELF.sessionId}:{}),limit:String(Math.min(100,args.limit||20)),...(args.kind?{kind:args.kind}:{}),...(!args.crossProject&&pid?{projectId:pid,sessionId:sid||'',access:'context'}:{})});path='/api/memory/search?'+query;}
    else if(name==='memory_source_search'||name==='memory_source_read')path='/api/memory/source/'+(name==='memory_source_search'?'search':'read')+'?'+new URLSearchParams({...args,...(SELF.projectId&&SELF.sessionId?{callerProjectId:SELF.projectId,callerSessionId:SELF.sessionId}:{projectId:pid||'',sessionId:sid||'',access:'context'})});
    else if(name==='memory_read')path='/api/memory/entry?'+new URLSearchParams({id:args.id,...(SELF.projectId&&SELF.sessionId?{callerProjectId:SELF.projectId,callerSessionId:SELF.sessionId}:{})});
    else if(name==='memory_context')path='/api/memory/context?'+new URLSearchParams({projectId:pid,sessionId:sid||'',query:args.query||'',...(SELF.projectId&&SELF.sessionId?{callerProjectId:SELF.projectId,callerSessionId:SELF.sessionId}:{})});
    else if(name==='memory_link'){path='/api/memory/link';body={from:args.from,to:args.to,kind:args.kind,...(SELF.projectId&&SELF.sessionId?{callerProjectId:SELF.projectId,callerSessionId:SELF.sessionId}:{})};}
    else {path='/api/memory/propose';const {id,revision,...entry}=args;body={id,revision,entry:name==='memory_update'?entry:{...entry,projectId:entry.spaceId?undefined:pid,sessionId:entry.spaceId?undefined:sid,sources:entry.sources||[{label:'Agent proposal',projectId:pid,sessionId:sid}]}};}
    if(body&&['memory_propose','memory_update'].includes(name)&&SELF.projectId&&SELF.sessionId)Object.assign(body,{callerProjectId:SELF.projectId,callerSessionId:SELF.sessionId});
    if (name === 'memory_propose') {
      const query = new URLSearchParams({ query: args.title, limit: '20', ...(SELF.projectId && SELF.sessionId ? { callerProjectId: SELF.projectId, callerSessionId: SELF.sessionId } : { projectId: pid || '', sessionId: sid || '' }) });
      const known = await api('/api/memory/search?' + query);
      const normalize = text => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const conflict = (known.entries || known.items || []).find(e => normalize(e.title) === normalize(args.title) && e.scope === (args.scope || 'project') && (args.spaceId ? e.spaceId === args.spaceId : e.projectId === pid) && normalize(e.content) !== normalize(args.content));
      if (conflict) throw new Error('Related memory already exists: ' + conflict.id + ' (revision ' + conflict.revision + '). Read it with memory_read and use memory_update for a correction. Use a distinct title if this is a separate fact.');
    }
    const data = await api(path,body?{method:'POST',body:JSON.stringify(body)}:undefined);
    const structured = name === 'memory_link' ? { relationships: data }
      : name === 'memory_propose' || name === 'memory_update' ? { entry: data } : data;
    return result(JSON.stringify(data,null,2), structured);
  }

  if (CRON_TOOL_NAMES.has(name)) {
    if (name === 'list_scheduled') {
      const data = await api('/api/cron');
      return result(fmtJobs(data), data);
    }
    if (name === 'cancel_scheduled') {
      const res = await api('/api/cron/remove', { method: 'POST', body: JSON.stringify({ id: args.id }) });
      return result(res?.ok ? `cancelled scheduled job ${args.id}.` : `no scheduled job with id ${args.id}.`, { id: args.id, ok: res.ok });
    }
    if (name === 'pause_scheduled') {
      const job = await api('/api/cron/enabled', { method: 'POST', body: JSON.stringify({ id: args.id, enabled: !args.paused }) });
      return result(`job ${job.id} is now ${job.enabled ? 'active' : 'paused'} (${job.schedule}, ${job.tz}).`, { job });
    }
    if (name === 'schedule_task') {
      const projectId = args.projectId ?? SELF.projectId;
      if (!projectId) throw new Error('projectId is required (this client has no project of its own)');
      const sessionId = args.sessionId ?? (args.projectId ? undefined : SELF.sessionId || undefined);
      const job = await api('/api/cron', {
        method: 'POST',
        body: JSON.stringify({ schedule: args.schedule, prompt: args.prompt, projectId, sessionId, tz: args.tz, label: args.label, once: args.once, createdBy: SELF.sessionId || 'mcp' }),
      });
      return result(`scheduled job ${job.id}: "${job.schedule}" in ${job.tz}${job.once ? ' — ONCE, then deleted' : ' (repeats)'}`
        + `${job.sessionId ? ` → conversation ${job.sessionId}` : ' → a new conversation each run'}.`
        + `\nUse list_scheduled to see it, cancel_scheduled to remove it.`, { job });
    }
  }
  if (QUEUE_TOOL_NAMES.has(name)) {
    if (name === 'list_queued') {
      const map = await api('/api/queue');
      const rows = Object.entries(map ?? {}).flatMap(([projectId, items]) =>
        (!args.projectId || projectId === args.projectId) ? (items ?? [])
          .filter((item) => !args.sessionId || item.sessionId === args.sessionId)
          .map((item) => ({ projectId, ...item })) : []);
      rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      return result(fmtQueue(map, { projectId: args.projectId, sessionId: args.sessionId }), { messages: rows });
    }
    if (name === 'cancel_queued') {
      const res = await api('/api/queue/remove', { method: 'POST', body: JSON.stringify({ projectId: args.projectId, id: args.id }) });
      return result(`cancelled queued message ${args.id} — it will not be delivered.`, { projectId: args.projectId, id: args.id, ok: res.ok });
    }
    if (name === 'edit_queued') {
      const res = await api('/api/queue/edit', { method: 'POST', body: JSON.stringify({ projectId: args.projectId, id: args.id, prompt: args.message }) });
      return result(`rewrote queued message ${args.id}; it keeps its place in the queue.`, { projectId: args.projectId, id: args.id, ok: res.ok });
    }
    if (name === 'stop_conversation') {
      const res = await api('/api/conversations/halt', {
        method: 'POST',
        body: JSON.stringify({ projectId: args.projectId, sessionId: args.sessionId, dropQueued: args.dropQueued }),
      });
      const parts = [];
      parts.push(res?.stopped ? 'stopped its running turn' : 'it had no turn running');
      parts.push(res?.dropped ? `dropped ${res.dropped} queued message(s)` : 'nothing was queued for it');
      return result(`${args.sessionId}: ${parts.join('; ')}.`, { projectId: args.projectId, sessionId: args.sessionId, stopped: res.stopped, dropped: res.dropped });
    }
    if (['delegate', 'delegate_followup', 'list_delegates', 'stop_delegate'].includes(name)) {
      // Reading and stopping reach any conversation; starting and instructing
      // delegates only your own.
      const other = args.projectId && args.sessionId && ['list_delegates', 'stop_delegate'].includes(name);
      if (!other && (!SELF.projectId || !SELF.sessionId)) throw new Error(name + ' is only available to a conversation running on this gateway (a delegate cannot delegate)');
      const self = other ? { projectId: args.projectId, sessionId: args.sessionId } : { projectId: SELF.projectId, sessionId: SELF.sessionId };
      const clip = (d) => ({ id: d.id, role: d.role, provider: d.provider, ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}), status: d.working ? 'working' : d.status, turns: d.turns, queued: (d.pending || []).length, ...(d.dismissedAt ? { dismissed: true } : {}),
        ...(d.lastReport ? { lastReport: { at: d.lastReport.at, gate: d.lastReport.gate, status: d.lastReport.status, text: d.lastReport.text } } : {}) });
      if (name === 'delegate') {
        const d = await api('/api/delegates', { method: 'POST', body: JSON.stringify({ ...self, role: args.role, brief: args.brief, provider: args.provider, model: args.model, effort: args.effort, targetProjectId: args.projectId, advisor: args.advisor }) });
        return result(`Delegate ${d.role} (${d.id}) started on ${d.provider}${d.model ? ' · ' + d.model : ''}. Its report will come back to you when it finishes: do not wait or poll.`, { id: d.id, role: d.role, provider: d.provider, status: 'working' });
      }
      if (name === 'delegate_followup') {
        const r = await api('/api/delegates/followup', { method: 'POST', body: JSON.stringify({ ...self, id: args.id, message: args.message }) });
        return result(r.status === 'queued' ? `${args.id} is still working; the instruction runs when its current turn ends.` : `${args.id} is working on it. Its report will come back to you.`, { id: r.id, status: r.status });
      }
      if (name === 'list_delegates') {
        const q = new URLSearchParams({ ...self, ...(args.id ? { id: args.id } : {}) });
        const r = await api('/api/delegates?' + q);
        const list = (r.delegates || []).filter((d) => args.id || args.include_dismissed === true || !d.dismissedAt).map(clip);
        const hidden = (r.delegates || []).length - list.length;
        const text = (list.length ? list.map((d) => `${d.id} ${d.role} · ${d.provider}${d.model ? ' ' + d.model : ''} · ${d.status}${d.dismissed ? ' · dismissed' : ''}${d.queued ? ` (+${d.queued} queued)` : ''}${d.lastReport ? `\n  last report (${d.lastReport.gate}): ${args.id ? d.lastReport.text : d.lastReport.text.split('\n')[0]}` : ''}`).join('\n') : hidden ? 'No active delegates.' : 'No delegates yet.') + (hidden ? `\n(${hidden} dismissed: include_dismissed to list them)` : '');
        return result(text, { delegates: list });
      }
      const r = await api('/api/delegates/stop', { method: 'POST', body: JSON.stringify({ ...self, ...(args.id ? { id: args.id } : {}) }) });
      if (args.dismiss !== true) return result(`Stopped ${r.stopped} delegate(s).`, { stopped: r.stopped });
      const x = await api('/api/delegates/dismiss', { method: 'POST', body: JSON.stringify({ ...self, ...(args.id ? { id: args.id } : { all: 'all' }) }) });
      return result(`Stopped ${r.stopped} and dismissed ${x.dismissed} delegate(s).`, { stopped: r.stopped, dismissed: x.dismissed });
    }
    if (name === 'set_helpers') {
      const target = args.projectId && args.sessionId ? { projectId: args.projectId, sessionId: args.sessionId } : { projectId: SELF.projectId, sessionId: SELF.sessionId };
      if (!target.projectId || !target.sessionId) throw new Error('give projectId and sessionId (this client has no conversation of its own)');
      const patch = Object.fromEntries(['advisor', 'team', 'router', 'lean'].filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
      if (!Object.keys(patch).length) throw new Error('name at least one helper: advisor, team, router or lean');
      const r = await api('/api/conversations/helpers/patch', { method: 'POST', body: JSON.stringify({ ...target, ...patch }) });
      return result('Helpers now: ' + helperText(r.helpers, r.effectiveRouter) + '. Takes effect from its next turn.', { projectId: target.projectId, sessionId: target.sessionId, helpers: r.helpers, ...(r.effectiveRouter !== undefined ? { effectiveRouter: r.effectiveRouter } : {}) });
    }
    if (name === 'quick_decision') {
      if (!SELF.projectId || !SELF.sessionId) throw new Error('quick_decision is only available to a conversation running on this gateway');
      const d = await api('/api/jev/fork', { method: 'POST', body: JSON.stringify({ projectId: SELF.projectId, sessionId: SELF.sessionId, question: args.question, options: args.options, context: args.context }) });
      const sure = d.confidence != null ? ` (${Math.round(d.confidence * 100)}% sure)` : '';
      const text = d.verdict === 'sharp'
        ? `SHARP: ${d.choice}${sure}. Follow it.`
        : `SPLIT${d.choice ? `: leaning ${d.choice}${sure}, too close to call` : ''}${d.error ? ` (${d.error})` : ''}. Decide this one yourself.`;
      return result(text, { verdict: d.verdict, backend: d.backend, latencyMs: d.latencyMs, ...(d.choice ? { choice: d.choice } : {}), ...(d.confidence != null ? { confidence: d.confidence } : {}), ...(d.error ? { error: d.error } : {}) });
    }
    if (name === 'steer' || (name === 'message_self' && args.steer)) {
      const text = name === 'steer' ? args.text : args.message;
      const target = name === 'steer' && (args.project_id || args.session_id) ? { projectId: args.project_id, sessionId: args.session_id } : {};
      const delegateOf = process.env.X056_DELEGATE_OF || '', delegateId = process.env.X056_DELEGATE_ID || '';
      if (!target.sessionId && !(SELF.projectId && SELF.sessionId) && !(delegateOf && delegateId)) {
        throw new Error(`${name} with no target is only available to a conversation (or delegate) running on this gateway; give project_id and session_id`);
      }
      if (target.sessionId && !target.projectId) throw new Error('give project_id with session_id');
      const r = await api('/api/conversations/steer', {
        method: 'POST',
        body: JSON.stringify({ ...target, prompt: text, from: SELF.sessionId || process.env.X056_RELAY_FROM || undefined,
          ...(SELF.projectId && SELF.sessionId ? { self: SELF } : {}), ...(delegateOf && delegateId ? { delegate: { of: delegateOf, id: delegateId } } : {}) }),
      });
      let out = { delivered: r.delivered, ...(r.projectId ? { projectId: r.projectId } : {}), ...(r.sessionId ? { sessionId: r.sessionId } : {}), ...(r.messageId ? { messageId: r.messageId } : {}),
        ...(typeof r.hopsLeft === 'number' ? { hopsLeft: r.hopsLeft } : {}), ...(typeof r.remaining === 'number' ? { remaining: r.remaining } : {}), ...(r.id ? { id: r.id } : {}), ...(r.approvalId ? { approvalId: r.approvalId } : {}) };
      if (r.delivered === 'pending_approval') {
        const a = await waitForApproval(api, r.approvalId);
        const status = a.status === 'approved' ? (a.error ? 'failed' : a.delivered || (a.queued ? 'queued' : 'started')) : a.status === 'pending' ? 'pending_approval' : a.status;
        out = { ...out, delivered: status, ...(a.resultSessionId ? { sessionId: a.resultSessionId } : {}), ...(a.note ? { note: a.note } : {}), ...(a.error ? { error: a.error } : {}) };
      }
      const said = {
        steered: 'steered into the running turn: it reads this now, inside that turn.',
        queued: 'not steered (no turn was running there to take it): queued, delivered when its current turn ends or right away if idle.',
        started: 'not steered (that conversation was not running a turn): delivered as a new message, which started a turn.',
        pending_approval: 'still awaiting the operator\'s approval: not delivered.',
        denied: 'the operator DENIED it: not delivered.',
        expired: 'the approval request expired: not delivered.',
        failed: 'approved, but delivery failed: ' + (out.error || 'unknown error'),
      }[out.delivered] || String(out.delivered);
      const tail = [out.note, typeof out.hopsLeft === 'number' ? `${out.hopsLeft} hop(s) left in this exchange.` : '', typeof out.remaining === 'number' ? `${out.remaining} self-message(s) left before a human message is required.` : ''].filter(Boolean).join('\n');
      return result(said + (tail ? '\n' + tail : ''), out);
    }
    if (name === 'message_self') {
      if (!SELF.projectId || !SELF.sessionId) {
        throw new Error('message_self is only available to a conversation running on this gateway (no self identity in this client)');
      }
      const res = await api('/api/queue/self', {
        method: 'POST',
        body: JSON.stringify({ projectId: SELF.projectId, sessionId: SELF.sessionId, prompt: args.message }),
      });
      return result(`queued for yourself (id ${res?.id ?? '?'}). It starts a new turn as soon as this one ends.\n`
        + `${res?.remaining != null ? `${res.remaining} consecutive self-message(s) left before a human message is required.` : ''}`, { id: res.id, remaining: res.remaining });
    }
  }
  if (CODEGRAPH_TOOL_NAMES.has(name)) {
    const res = await api('/api/codegraph/call', {
      method: 'POST',
      body: JSON.stringify({ tool: name, args }),
    });
    const data = res?.data ?? res;
    // Query routes return text/isError; wiki routes return typed results/items.
    return result(fmtCodegraph(name, data), data);
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
    if(res?.shared)return result(`Saved shared memory ${res.id} (${res.status}). Review it in Memory before automatic context inclusion. Search confirmed notes with memory_search.`, res);
    const where = res?.accounts?.length ? ` on ${res.accounts.length} account(s)` : '';
    return result(`Saved memory ${res?.file}${where}.`, res);
  }
  if (name === 'list_projects') {
    const reg = await api('/api/projects');
    const list = (reg.projects || reg || []).map((p) => ({ id: p.id, name: p.name, cwd: p.cwd ?? null, kind: p.kind || 'project', provider: p.provider || 'claude', current: p.id === reg.current,
      ...(p.parentProjectId ? { parentProjectId: p.parentProjectId, membershipRevision: p.membershipRevision ?? 0 } : {}) }));
    return result(JSON.stringify(list, null, 2), { projects: list });
  }
  if (name === 'list_conversations') {
    const reg = await api('/api/projects');
    const p = (reg.projects || reg || []).find((x) => x.id === args.projectId);
    if (!p) throw new Error('unknown projectId — use list_projects');
    const convs = (p.conversations || []).map((c) => ({ sessionId: c.sessionId, title: c.title, provider: c.provider || 'claude', model: c.model, effort: c.effort, createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : undefined, current: c.sessionId === p.lastSessionId, helpers: helpersOfRow(c), ...(c.effectiveRouter !== undefined ? { effectiveRouter: c.effectiveRouter } : {}) }));
    return result(JSON.stringify(convs, null, 2), { conversations: convs });
  }
  if (name === 'read_conversation') {
    const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 30;
    const rows = await api(`/api/conversations/history?projectId=${encodeURIComponent(args.projectId)}&sessionId=${encodeURIComponent(args.sessionId)}&limit=${limit}&strict=true`);
    // Its helpers and delegates, so a reader can see and then steer them.
    const state = await api(`/api/conversations/helpers?projectId=${encodeURIComponent(args.projectId)}&sessionId=${encodeURIComponent(args.sessionId)}`).catch(() => null);
    const team = (state?.delegates || []).filter((d) => !d.dismissedAt).map((d) => ({ id: d.id, role: d.role, provider: d.provider, status: d.working ? 'working' : d.status }));
    const head = state ? `[helpers: ${helperText(state.helpers, state.effectiveRouter)}${team.length ? ` · delegates: ${team.map((d) => d.role + ' ' + d.status).join(', ')}` : ''}]\n\n` : '';
    return result(head + fmtHistory(rows), { messages: messages(rows), ...(state ? { helpers: state.helpers, ...(state.effectiveRouter !== undefined ? { effectiveRouter: state.effectiveRouter } : {}), delegates: team } : {}) });
  }
  if (name === 'send_message') {
    const requested = await api('/api/conversations/send', {
      method: 'POST',
      // `from` is OUR identity from the per-turn config, not something the
      // model chose: it is what lets the gateway count this exchange's hops.
      // A delegate has no identity of its own; its sends count against its
      // orchestrator's chain (X056_RELAY_FROM) rather than starting a new one.
      body: JSON.stringify({ projectId: args.projectId, sessionId: args.sessionId, prompt: args.message, model: args.model, effort: args.effort, from: SELF.sessionId || process.env.X056_RELAY_FROM || undefined, ...(args.helpers ? { helpers: args.helpers } : {}), ...(args.steer ? { steer: true } : {}) }),
    });
    // Two modes, chosen by the OPERATOR in the panel (not by us): 'auto' delivers
    // straight away, 'approval' waits for them to approve it. Either way, if that
    // conversation is mid-turn the message goes on its queue rather than failing.
    if (requested.mode === 'auto') {
      const sid = requested.sessionId;
      const delivery = { mode: 'auto', projectId: args.projectId, sessionId: sid, messageId: requested.messageId,
        ...(typeof requested.hopsLeft === 'number' ? { hopsLeft: requested.hopsLeft } : {}) };
      const where = requested.steered
        ? `steered into its running turn — it reads this now, inside that turn.`
        : requested.queued
        ? `queued — that conversation is mid-turn, so it will be delivered the moment its current turn ends.`
        : `delivered — its turn is running now.`;
      // Say how much of the exchange is left. Knowing there is one hop to go is
      // what lets a caller close the loop deliberately instead of being cut off.
      const left = typeof requested.hopsLeft === 'number'
        ? `\n${requested.hopsLeft} hop(s) left in this exchange before a human message is required.`
          + (requested.hopsLeft <= 1 ? ' Plan to finish here.' : '')
        : '';
      if (!args.waitSeconds || requested.queued || requested.steered) {
        return result(`sent (automatic mode). ${where}\nsessionId: ${sid}\nUse read_reply with this messageId to fetch the exact reply later.${left}`, { delivery: { ...delivery, status: requested.steered ? 'steered' : requested.queued ? 'queued' : 'sent' } });
      }
      const { text, ...reply } = await waitForReply(api, args.projectId, sid, requested.messageId, args.waitSeconds);
      return result(text + left, { delivery: { ...delivery, ...reply } });
    }
    // Approval mode: the send does NOT happen yet — wait for the human operator's
    // decision in the panel (or the request to expire) before anything is sent.
    const delivery = { mode: 'approval', projectId: args.projectId, approvalId: requested.approvalId, messageId: requested.messageId };
    const approval = await waitForApproval(api, requested.approvalId);
    if (approval.status === 'pending') return result('still awaiting the operator\'s approval — not sent. It will expire soon; try again later if this is still needed.', { delivery: { ...delivery, status: 'pending' } });
    if (approval.status === 'expired') return result('the approval request expired before the operator responded — not sent.', { delivery: { ...delivery, status: 'expired' } });
    if (approval.status === 'denied') return result('the operator DENIED this message — it was not sent.', { delivery: { ...delivery, status: 'denied' } });
    if (approval.error) return result(`approved, but the send itself failed: ${approval.error}`, { delivery: { ...delivery, status: 'failed', error: approval.error } });
    const sid = approval.resultSessionId;
    delivery.sessionId = sid;
    delivery.messageId = requested.messageId || approval.sender?.messageId;
    if (approval.note) delivery.note = approval.note;
    if (approval.delivered === 'steered') {
      return result(`approved and steered into its running turn — it reads this now.\nsessionId: ${sid}`, { delivery: { ...delivery, status: 'steered' } });
    }
    if (approval.queued) {
      return result(`approved and queued — that conversation is mid-turn, so it will be delivered when its current turn ends.\nsessionId: ${sid}\nUse read_reply with this messageId to fetch the exact reply later.`, { delivery: { ...delivery, status: 'queued' } });
    }
    const waitMs = Math.min(Math.max((args.waitSeconds || 0) * 1000, 0), 10 * 60 * 1000);
    if (waitMs <= 0) {
      return result(`sent — the turn is running.\nsessionId: ${sid}\nUse read_reply (projectId=${args.projectId}, sessionId=${sid}, messageId=${delivery.messageId}) to fetch its reply.`, { delivery: { ...delivery, status: 'sent' } });
    }
    const { text, ...reply } = await waitForReply(api, args.projectId, sid, delivery.messageId, args.waitSeconds);
    return result(text, { delivery: { ...delivery, ...reply } });
  }
  throw new Error(`unknown tool: ${name}`);
}

/** Wait for the operator's decision on an approval -- and, for an approved
 *  steer, for its delivery (`delivering`) -- or the request's expiry. */
async function waitForApproval(api, approvalId) {
  const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000 + 15000; // give the server's own 10min timeout time to land first
  const approvalDeadline = Date.now() + APPROVAL_TIMEOUT_MS;
  const statusUrl = `/api/conversations/send-status?id=${encodeURIComponent(approvalId)}`;
  let approval = await api(statusUrl);
  while ((approval.status === 'pending' || approval.delivering) && Date.now() < approvalDeadline) {
    await sleep(approval.delivering ? 250 : 2000);
    approval = await api(statusUrl).catch(() => approval);
  }
  return approval;
}
