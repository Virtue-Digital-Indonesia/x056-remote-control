// Output contracts for the shared HTTP/stdio handlers. Sources: api.controller,
// manager, cron, memory-store/controller, provider.HistoryEntry, and the deployed
// MemoryKnowledge code query and wiki search/page-read handlers. No live data or
// credentials belong in discovery metadata.
const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const integer = { type: 'integer' };
const literal = (value) => ({ const: value, type: typeof value });
const choices = (...values) => ({ type: 'string', enum: values });
const array = (items) => ({ type: 'array', items });
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const provider = choices('claude', 'codex');
const nullableProvider = { anyOf: [provider, { type: 'null' }] };
const ref = (name) => ({ $ref: `#/$defs/${name}` });

const sourceRef = object({ id: str, hash: str, label: str, projectId: str,
  sessionId: str, provider: str, ref: str, at: num }, ['label']);
const entry = object({
  id: str, revision: integer, title: str, content: str, summary: str,
  kind: choices('fact', 'decision', 'preference', 'procedure', 'knowledge', 'context'),
  status: choices('proposed', 'confirmed', 'archived', 'deleted', 'superseded'),
  scope: choices('conversation', 'project', 'shared', 'global'),
  projectId: str, sessionId: str, sharedProjectIds: array(str), providers: array(provider),
  tags: array(str), pinned: bool, expiresAt: num, createdAt: num, updatedAt: num,
  actor: str, sources: array(ref('sourceRef')), supersededBy: str,
}, ['id', 'revision', 'title', 'content', 'summary', 'kind', 'status', 'scope',
  'sharedProjectIds', 'providers', 'tags', 'pinned', 'createdAt', 'updatedAt', 'actor', 'sources']);
const source = object({ id: str, key: str, kind: choices('conversation', 'artifact', 'legacy', 'document'),
  title: str, content: str, projectId: str, sessionId: str, provider: str, ref: str,
  at: num, hash: str, excluded: bool,
}, ['id', 'key', 'kind', 'title', 'content', 'projectId', 'at', 'hash', 'excluded']);
const relationship = object({ id: str, from_id: str, to_id: str,
  kind: choices('related', 'supports', 'contradicts', 'depends_on'), at: num, entry: ref('entry'),
}, ['id', 'from_id', 'to_id', 'kind', 'at']);
const contextFields = {
  estimatedTokens: integer, budget: num,
  items: array(object({ id: str, revision: integer, title: str, reason: str, estimatedTokens: integer })),
  skipped: array(object({ id: str, reason: str })), enabled: bool,
};
const messageSender = object({ kind: choices('conversation', 'automation', 'autopilot', 'mcp'), messageId: str, projectId: str, sessionId: str, projectName: str, conversationTitle: str }, ['kind']);
const message = object({ sender: messageSender, role: choices('user', 'assistant'), text: str, ts: str }, ['role', 'text']);
const jobFields = {
  id: str, schedule: str, tz: str, projectId: str, sessionId: str, prompt: str,
  label: str, once: bool, enabled: bool, createdAt: num, createdBy: str,
  lastRunAt: num, lastResult: str, runCount: num,
};
const jobRequired = ['id', 'schedule', 'tz', 'projectId', 'prompt', 'enabled', 'createdAt', 'runCount'];
const targetFields = { provider: nullableProvider, projectName: str, conversationTitle: str, source: literal('gateway') };
const queueItem = object({
  sender: messageSender, projectId: str, id: str, text: str, at: num, sessionId: str, model: str, effort: str,
  account: str, useReserve: bool, dispatching: bool, error: str, notBefore: num,
  afterSessionId: str, paused: bool, requestId: str, ...targetFields,
}, ['projectId', 'id', 'text', 'at', ...Object.keys(targetFields)]);
const deliveryFields = { mode: choices('auto', 'approval'), projectId: str, sessionId: str, approvalId: str, hopsLeft: num };
const delivery = (status, extra = {}, required = []) => object({ ...deliveryFields, status: literal(status), ...extra },
  ['mode', 'projectId', 'status', ...required]);
const sendResult = { oneOf: [
  delivery('pending', {}, ['approvalId']), delivery('expired', {}, ['approvalId']),
  delivery('denied', {}, ['approvalId']), delivery('failed', { error: str }, ['approvalId', 'error']),
  delivery('queued', {}, ['sessionId']), delivery('sent', {}, ['sessionId']),
  delivery('reply', { messages: array(message) }, ['sessionId', 'messages']),
  delivery('reply_timeout', { waitSeconds: num }, ['sessionId', 'waitSeconds']),
] };

const schemas = {
  list_projects: object({ projects: array(object({ id: str, name: str, cwd: str, provider, current: bool })) }),
  list_conversations: object({ conversations: array(object({ sessionId: str, title: str, provider, model: str,
    effort: str, createdAt: str, current: bool }, ['sessionId', 'title', 'provider', 'current'])) }),
  read_conversation: object({ messages: array(message) }),
  send_message: object({ delivery: sendResult }),
  list_queued: object({ messages: array(queueItem) }),
  cancel_queued: object({ projectId: str, id: str, ok: bool }),
  edit_queued: object({ projectId: str, id: str, ok: bool }),
  stop_conversation: object({ projectId: str, sessionId: str, stopped: bool, dropped: num }),
  message_self: object({ id: str, remaining: num }),
  schedule_task: object({ job: object(jobFields, jobRequired) }),
  pause_scheduled: object({ job: object(jobFields, jobRequired) }),
  cancel_scheduled: object({ id: str, ok: bool }),
  list_scheduled: object({ jobs: array(object({ ...jobFields, ...targetFields }, [...jobRequired, ...Object.keys(targetFields)])), defaultTz: str }),
  save_memory: object({ id: str, file: str, accounts: array(str), existed: bool, status: entry.properties.status, shared: literal(true) }),
  memory_search: object({ items: array(object({ ...entry.properties, staleReason: str, expired: bool, score: num, reason: str },
    [...entry.required, 'expired', 'score', 'reason'])), total: integer, limit: num, offset: num, truncated: bool }),
  memory_read: object({ entry: ref('entry'), revisions: array(ref('entry')), related: array(ref('relationship')),
    sources: array(object({ ...sourceRef.properties, current: ref('source'), original: ref('source') }, sourceRef.required)) }),
  memory_propose: object({ entry: ref('entry') }),
  memory_update: object({ entry: ref('entry') }),
  memory_link: object({ relationships: array(ref('relationship')) }),
  memory_context: object({ text: str, ...contextFields, provider,
    preferences: object({ enabled: bool, excludedIds: array(str), pinnedIds: array(str) }, []),
    history: array(object({ id: str, projectId: str, sessionId: str, at: num, ...contextFields, provider })),
  }),
  wiki_search: object({ results: array(object({ path: str, title: str, snippet: str, score: num, type: str,
    hop: integer, via: str, related: array(object({ title: str, path: str, type: str, direction: choices('out', 'in', 'both') })),
  }, ['path', 'title', 'snippet', 'score', 'type'])),
  links: array(object({ source: str, target: str, weight: num })), count: integer }),
  wiki_read: object({ items: array({ oneOf: [object({ ref: str, content: str }), object({ ref: str, not_found: literal(true) })] }) }),
};
for (const name of ['code_search', 'code_callers', 'code_callees', 'code_impact', 'code_explore', 'code_node'])
  schemas[name] = object({ text: str, isError: bool });

const definitions = { entry, sourceRef, source, relationship };
// Include only definitions reachable from this action, not all memory metadata
// in every action. References keep revision/source arrays small in discovery.
function referencedDefinitions(schema, found = {}) {
  if (!schema || typeof schema !== 'object') return found;
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1);
    if (!found[name]) { found[name] = definitions[name]; referencedDefinitions(found[name], found); }
  }
  for (const value of Object.values(schema)) referencedDefinitions(value, found);
  return found;
}
export const OUTPUT_SCHEMAS = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => {
  const defs = referencedDefinitions(schema);
  return [name, { type: 'object', oneOf: [schema, object({ error: str })],
    ...(Object.keys(defs).length ? { $defs: defs } : {}) }];
}));
