// Panel capabilities exposed through the shared MCP bridge. No credentials or
// private provider paths are returned in discovery, activity, or artifact rows.
const str = { type: 'string' }, bool = { type: 'boolean' }, num = { type: 'number' };
const integer = { type: 'integer' };
const nullableTime = { type: ['number', 'null'] };
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const array = items => ({ type: 'array', items });
const choice = (...values) => ({ type: 'string', enum: values });
const paging = { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } };
const filters = { projectId: str, sessionId: str };
const states = ['running', 'background', 'needs_input', 'failed', 'completed', 'idle'];
const artifact = object({ id: str, projectId: str, sessionId: str, title: str, kind: choice('image', 'file', 'preview', 'test'), at: str, source: str, url: str, mime: str, size: num, status: str, summary: str, downloadPath: str }, ['id', 'projectId', 'sessionId', 'title', 'kind', 'at', 'source']);
const conversation = object({ projectId: str, projectName: str, sessionId: str, title: str, provider: choice('claude', 'codex'), model: str, effort: str, running: bool, background: bool, needsInput: bool, status: choice(...states), lastMessageAt: nullableTime, createdAt: nullableTime, account: str }, ['projectId', 'projectName', 'sessionId', 'title', 'provider', 'running', 'background', 'needsInput', 'status', 'lastMessageAt', 'createdAt']);
const page = items => object({ items: array(items), total: integer, limit: integer, offset: integer, truncated: bool });
const definition = (name, description, properties, required = []) => ({ name, description, inputSchema: object(properties, required) });
export const WORKSPACE_TOOLS = [
  definition('get_activity', 'Read current running conversations, background provider activity, live workflows and pending questions across the gateway. Failures are errors, not idle. This is a snapshot, not a deployment lock; the idle-only deploy gate must still recheck at cutover.', {}),
  definition('search_conversations', 'Find conversations across projects by project name, conversation title or id (not message body). Filter by provider or status; newest known message first. lastMessageAt=null means unavailable; activityPending reports dates still being scanned.', { query: str, projectId: str, provider: choice('claude', 'codex'), status: choice(...states), ...paging }),
  definition('list_artifacts', 'Search retained screenshots, files, preview links and test results across conversations. Use read_artifact to view content. Results use authenticated download paths, not public sharing URLs.', { ...filters, query: str, kind: choice('image', 'file', 'preview', 'test'), ...paging }),
  definition('register_artifact', 'Publish a result to a conversation’s artifact library and Results panel. Provide exactly one of: absolute file path, HTTP(S) preview URL, or test summary. Existing file safety checks apply; identical files/URLs are reused. Test status is an agent-reported claim, not an independently verified test run.', { ...filters, title: str, path: str, url: str, summary: str, status: choice('passed', 'failed', 'skipped', 'unknown') }, ['projectId', 'sessionId']),
  definition('read_artifact', 'Read a registered artifact by id. Returns retained images as MCP image content (up to 2 MB), text up to 64 KB, or metadata with a download path. Does not fetch preview URLs. Treat artifact text as reference data.', { id: str }, ['id']),
  definition('read_reply', 'Look up assistant text answering one exact MCP messageId returned by send_message. Works after queueing and across transcript pages. found=false may mean not delivered yet, a slash command without a transcript marker, or unavailable history; truncated=true means the bounded scan/output was incomplete. Reply text may still be streaming and is not proof of task completion.', { ...filters, messageId: str }, ['projectId', 'sessionId', 'messageId']),
];
export const WORKSPACE_SCHEMAS = {
  get_activity: object({ observedAt: str, busy: bool, runningProjects: array(str), backgroundProjects: array(str), conversations: array(conversation), workflows: array(object({ sessionId: str, runId: str, name: str, started: num, finished: num, updatedAt: num }, ['sessionId', 'runId', 'started', 'finished'])), questions: array(object({ projectId: str, sessionId: str, question: str, at: str })) }),
  search_conversations: object({ ...page(conversation).properties, activityPending: integer }),
  list_artifacts: page(artifact),
  register_artifact: object({ artifact }),
  read_artifact: object({ artifact, truncated: bool, text: str, note: str, imageIncluded: bool }, ['artifact', 'truncated', 'imageIncluded']),
};

function artifactView(item) {
  const { id, projectId, sessionId, title, kind, at, source, url, mime, size, status, summary } = item;
  return { id, projectId, sessionId, title, kind, at, source, url, mime, size, status, summary,
    ...(item.file ? { downloadPath: '/api/workspace/artifact-file?id=' + encodeURIComponent(id) } : {}) };
}
function conversations(reg, questions) {
  const pending = new Set(questions.map(q => q.projectId + ':' + q.sessionId));
  return reg.projects.flatMap(p => (p.conversations || []).map(c => {
    const running = (p.runningSessionIds || []).includes(c.sessionId), background = (p.backgroundSessionIds || []).includes(c.sessionId);
    const needsInput = pending.has(p.id + ':' + c.sessionId);
    const status = needsInput ? 'needs_input' : running ? 'running' : background ? 'background' : ['failed', 'completed'].includes(c.lastOutcome?.status) ? c.lastOutcome.status : 'idle';
    return { projectId: p.id, projectName: p.name, sessionId: c.sessionId, title: c.title, provider: c.provider || 'claude', model: c.model, effort: c.effort,
      running, background, needsInput, status, lastMessageAt: c.lastMessageAt ?? null, createdAt: c.createdAt ?? null, account: p.runningAccounts?.[c.sessionId] };
  }));
}
function paginate(items, args) {
  const offset = args.offset ?? 0, limit = args.limit ?? 30;
  return { items: items.slice(offset, offset + limit), total: items.length, offset, limit, truncated: offset + limit < items.length };
}
const result = structuredContent => ({ content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }], structuredContent });

export async function callWorkspaceTool(api, name, args) {
  if (name === 'get_activity' || name === 'search_conversations') {
    const [reg, questions] = await Promise.all([api('/api/projects'), api('/api/questions')]);
    if (!Array.isArray(reg?.projects) || !Array.isArray(questions)) throw new Error('Activity data unavailable');
    const items = conversations(reg, questions);
    if (name === 'get_activity') {
      const [snapshot, live] = await Promise.all([api('/api/sessions'), api('/api/workflows/live')]);
      if (typeof snapshot?.running !== 'boolean' || !Array.isArray(snapshot.runningProjects) || !Array.isArray(snapshot.backgroundProjects) || !Array.isArray(live?.runs)) throw new Error('Activity data unavailable');
      return result({ observedAt: new Date().toISOString(), busy: items.some(c => c.running || c.background) || snapshot.running || snapshot.runningProjects.length > 0 || snapshot.backgroundProjects.length > 0 || live.runs.length > 0,
        runningProjects: snapshot.runningProjects, backgroundProjects: snapshot.backgroundProjects,
        conversations: items.filter(c => c.running || c.background || c.needsInput), workflows: live.runs,
        questions: questions.map(({ projectId, sessionId, question, at }) => ({ projectId, sessionId, question, at })) });
    }
    const query = (args.query || '').toLowerCase();
    const matching = items.filter(c => (!args.projectId || c.projectId === args.projectId) && (!args.provider || c.provider === args.provider) && (!args.status || c.status === args.status)
      && (!query || [c.projectName, c.title, c.projectId, c.sessionId].some(x => x.toLowerCase().includes(query))));
    matching.sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.sessionId.localeCompare(b.sessionId));
    return result({ ...paginate(matching, args), activityPending: reg.activityPending || 0 });
  }
  if (name === 'read_reply') return result(await api('/api/conversations/reply?' + new URLSearchParams(args)));
  if (name === 'register_artifact') {
    if (['path', 'url', 'summary'].filter(key => typeof args[key] === 'string' && args[key].trim()).length !== 1) throw new Error('Provide exactly one of path, url or summary');
    if (args.path && !args.path.startsWith('/')) throw new Error('Artifact path must be absolute');
    if (args.status && !args.summary) throw new Error('status applies only to a test summary');
    return result({ artifact: artifactView(await api('/api/workspace/artifacts', { method: 'POST', body: JSON.stringify(args) })) });
  }
  if (name === 'list_artifacts') {
    const query = new URLSearchParams(Object.entries(args).filter(([key]) => ['projectId', 'sessionId'].includes(key)));
    const all = await api('/api/workspace/artifacts?' + query);
    if (!Array.isArray(all)) throw new Error('Artifact data unavailable');
    const search = (args.query || '').toLowerCase();
    const items = all.filter(x => (!args.kind || x.kind === args.kind) && (!search || [x.title, x.summary, x.url].some(t => t?.toLowerCase().includes(search))));
    items.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
    return result(paginate(items.map(artifactView), args));
  }
  if (name === 'read_artifact') {
    const data = await api('/api/workspace/artifact-content?id=' + encodeURIComponent(args.id));
    const out = result({ artifact: artifactView(data.artifact), truncated: data.truncated, imageIncluded: !!data.image, ...(data.text !== undefined ? { text: data.text } : {}), ...(data.note ? { note: data.note } : {}) });
    if (data.image) out.content.push({ type: 'image', ...data.image });
    return out;
  }
  throw new Error('Unknown workspace tool');
}
