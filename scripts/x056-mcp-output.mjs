import { WORKSPACE_SCHEMAS } from './x056-mcp-workspace.mjs';
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
// router is what the user SAVED ('none' = "Your choice", absent = not
// overridden); effectiveRouter is the picker that actually runs (null = none).
const helpers = object({ advisor: bool, team: bool, router: choices('jev', 'decisions', 'none'), lean: choices('low', 'high') }, []);
const effectiveRouter = { anyOf: [choices('jev', 'decisions'), { type: 'null' }] };
const ref = (name) => ({ $ref: `#/$defs/${name}` });

const memoryOwner=object({kind:choices('space','execution'),id:str});
const savedFile=object({ownerId:str,fileId:str,versionId:str});
const locator=object({kind:choices('lines','paragraph','table-cell','page'),heading:str,startLine:integer,endLine:integer,paragraph:integer,table:integer,row:integer,cell:integer,page:integer,charStart:integer,charEnd:integer},['kind']);
const citation=object({sourceId:str,versionId:str,passageId:str,locator,file:savedFile,sourceProjectId:str,sourceSessionId:str},['sourceId','versionId','passageId','locator']);
const passage=object({id:str,sourceId:str,versionId:str,file:savedFile,title:str,owner:memoryOwner,estimatedTokens:integer,ordinal:integer,locator,text:str,hash:str,citation},['id','sourceId','versionId','title','owner','estimatedTokens','ordinal','locator','text','hash','citation']);
const sourceRef = object({ spaceId:str,versionId:str,grantId:str,grantRevision:integer,id: str, hash: str, label: str, projectId: str,
  sessionId: str, provider: str, ref: str, at: num }, ['label']);
const entry = object({
  id: str, revision: integer, title: str, content: str, summary: str,
  kind: choices('fact', 'decision', 'preference', 'procedure', 'knowledge', 'context'),
  status: choices('proposed', 'confirmed', 'archived', 'deleted', 'superseded'),
  scope: choices('conversation', 'project','space', 'shared', 'global'),
  spaceId:str,projectId: str, sessionId: str, sharedProjectIds: array(str), providers: array(provider),
  tags: array(str), pinned: bool, expiresAt: num, createdAt: num, updatedAt: num,
  actor: str, sources: array(ref('sourceRef')), supersededBy: str,
}, ['id', 'revision', 'title', 'content', 'summary', 'kind', 'status', 'scope',
  'sharedProjectIds', 'providers', 'tags', 'pinned', 'createdAt', 'updatedAt', 'actor', 'sources']);
const source = object({ document:object({contentHash:str,file:savedFile,extractor:str,cacheKey:str,format:str,coverage:str,warnings:array(str),sourceProjectId:str,sourceSessionId:str},['file','extractor','cacheKey','format','coverage','warnings']),spaceId:str,versionId:str,id: str, key: str, kind: choices('conversation', 'artifact', 'legacy', 'document'),
  title: str, content: str, projectId: str, sessionId: str, provider: str, ref: str,
  at: num, hash: str, excluded: bool,
}, ['id', 'key', 'kind', 'title', 'content', 'projectId', 'at', 'hash', 'excluded']);
const compactEntry = object({ ...entry.properties, contentTruncated: bool, metadataTruncated: bool }, [...entry.required, 'contentTruncated', 'metadataTruncated']);
const revisionMetadata = object({id:str,revision:integer,title:str,updatedAt:num,status:entry.properties.status});
const sourceMetadata = object({id:str,versionId:str,title:str,kind:source.properties.kind,projectId:str,sessionId:str,spaceId:str,hash:str,ref:str},['id','title','kind','projectId','hash']);
const relationship = object({ id: str, from_id: str, to_id: str,
  kind: choices('related', 'supports', 'contradicts', 'depends_on'), at: num, entry: ref('entry'),
}, ['id', 'from_id', 'to_id', 'kind', 'at']);
const contextFields = {
  passages:array(object({id:str,sourceId:str,versionId:str,title:str,estimatedTokens:integer,citation})),
  requestId:str,referencesRevision:integer,grants:array(object({id:str,revision:integer,subject:object({kind:choices('entry','source'),id:str})})),
  scope: object({ spaceId:str,workProjectId:str,spaceArchived:bool,executionProjectId: str, sessionId: str, parentProjectId: str, membershipRevision: integer, inherited: bool }, ['executionProjectId', 'membershipRevision', 'inherited']),
  estimatedTokens: integer, budget: num,
  items: array(object({ id: str, revision: integer, title: str, reason: str, estimatedTokens: integer, sources: array(sourceRef) }, ['id', 'revision', 'title', 'reason', 'estimatedTokens'])),
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
  contextReview: object({ operationId: str, membershipRevision: integer, reason: str }),
  sender: messageSender, projectId: str, id: str, text: str, at: num, sessionId: str, model: str, effort: str,
  account: str, useReserve: bool, dispatching: bool, error: str, notBefore: num,
  afterSessionId: str, paused: bool, requestId: str, ...targetFields,
}, ['projectId', 'id', 'text', 'at', ...Object.keys(targetFields)]);
const deliveryFields = { messageId: str, mode: choices('auto', 'approval'), projectId: str, sessionId: str, approvalId: str, hopsLeft: num, note: str };
const delivery = (status, extra = {}, required = []) => object({ ...deliveryFields, status: literal(status), ...extra },
  ['mode', 'projectId', 'status', ...required]);
const sendResult = { oneOf: [
  delivery('pending', {}, ['approvalId']), delivery('expired', {}, ['approvalId']),
  delivery('denied', {}, ['approvalId']), delivery('failed', { error: str }, ['approvalId', 'error']),
  delivery('queued', {}, ['sessionId']), delivery('sent', {}, ['sessionId']), delivery('steered', {}, ['sessionId']),
  delivery('reply', { messages: array(message), truncated: bool }, ['sessionId', 'messages']),
  delivery('reply_timeout', { waitSeconds: num }, ['sessionId', 'waitSeconds']),
] };

const schemas = {
  ...WORKSPACE_SCHEMAS,
  read_reply: object({ messageId: str, found: bool, messages: array(message), truncated: bool }),
  list_projects: object({ projects: array(object({ id: str, name: str, cwd: { anyOf: [str, { type: 'null' }] }, provider, current: bool, kind: choices('project','chat'), parentProjectId: str, membershipRevision: integer }, ['id','name','cwd','provider','current'])) }),
  list_conversations: object({ conversations: array(object({ sessionId: str, title: str, provider, model: str,
    effort: str, createdAt: str, current: bool, helpers, effectiveRouter }, ['sessionId', 'title', 'provider', 'current'])) }),
  read_conversation: object({ messages: array(message), helpers, effectiveRouter, delegates: array(object({ id: str, role: str, provider, status: choices('working', 'idle', 'failed', 'stopped', 'interrupted') })) }, ['messages']),
  set_helpers: object({ projectId: str, sessionId: str, helpers, effectiveRouter }, ['projectId', 'sessionId', 'helpers']),
  send_message: object({ delivery: sendResult }),
  list_queued: object({ messages: array(queueItem) }),
  cancel_queued: object({ projectId: str, id: str, ok: bool }),
  edit_queued: object({ projectId: str, id: str, ok: bool }),
  stop_conversation: object({ projectId: str, sessionId: str, stopped: bool, dropped: num }),
  message_self: object({ id: str, remaining: num, delivered: choices('steered', 'queued'), projectId: str, sessionId: str, messageId: str }, ['remaining']),
  steer: object({ delivered: choices('steered', 'queued', 'started', 'pending_approval', 'denied', 'expired', 'failed'), projectId: str, sessionId: str, messageId: str,
    hopsLeft: num, remaining: num, id: str, approvalId: str, note: str, error: str }, ['delivered']),
  delegate: object({ id: str, role: str, provider, status: literal('working') }),
  delegate_followup: object({ id: str, status: choices('working', 'queued') }),
  list_delegates: object({ delegates: array(object({ id: str, role: str, provider, model: str, effort: str, status: choices('working', 'idle', 'failed', 'stopped', 'interrupted'), turns: integer, queued: integer, dismissed: bool,
    lastReport: object({ at: str, gate: choices('done', 'needs_orchestrator', 'needs_human', 'blocked'), status: choices('completed', 'failed', 'stopped', 'interrupted'), text: str }) }, ['id', 'role', 'provider', 'status', 'turns', 'queued'])) }),
  stop_delegate: object({ stopped: integer, dismissed: integer }, ['stopped']),
  quick_decision: object({ verdict: choices('sharp', 'split'), choice: str, confidence: num, backend: choices('jev', 'openai'), latencyMs: num, error: str }, ['verdict', 'backend', 'latencyMs']),
  schedule_task: object({ job: object(jobFields, jobRequired) }),
  pause_scheduled: object({ job: object(jobFields, jobRequired) }),
  cancel_scheduled: object({ id: str, ok: bool }),
  list_scheduled: object({ jobs: array(object({ ...jobFields, ...targetFields }, [...jobRequired, ...Object.keys(targetFields)])), defaultTz: str }),
  save_memory: object({ id: str, file: str, accounts: array(str), existed: bool, status: entry.properties.status, shared: literal(true) }),
  memory_search: object({ items: array(object({ ...compactEntry.properties, staleReason: str, expired: bool, score: num, reason: str },
    [...compactEntry.required, 'expired', 'score', 'reason'])), total: integer, limit: num, offset: num, truncated: bool, nextOffset:integer }, ['items','total','limit','offset','truncated']),
  memory_source_search:object({items:array(passage),total:integer,offset:integer,limit:integer,truncated:bool,nextOffset:integer},['items','total','offset','limit','truncated']),
  memory_source_read:object({sourceId:str,versionId:str,title:str,items:array(passage),total:integer,offset:integer,limit:integer,downloadPath:str,truncated:bool,nextOffset:integer},['sourceId','versionId','title','items','total','offset','limit']),
  memory_read: object({ entry: compactEntry, revisions: array(revisionMetadata), related: array(object({...relationship.properties,entry:revisionMetadata},relationship.required)),
    sources: array(object({ ...sourceRef.properties,unavailable:str, current: sourceMetadata, original: sourceMetadata }, sourceRef.required)),offset:integer,limit:integer,totalCharacters:integer,revisionsTotal:integer,relatedTotal:integer,sourcesTotal:integer,truncated:bool,metadataTruncated:bool,nextOffset:integer },['entry','revisions','related','sources','offset','limit','totalCharacters','revisionsTotal','relatedTotal','sourcesTotal','truncated','metadataTruncated']),
  memory_propose: object({ entry: ref('entry') }),
  memory_update: object({ entry: ref('entry') }),
  memory_approve: object({ entry: ref('entry') }),
  memory_delete: object({ entry: ref('entry') }),
  memory_link: object({ relationships: array(ref('relationship')) }),
  memory_context: object({ text: str, ...contextFields, provider, preview: bool,
    preferences: object({ enabled: bool, excludedIds: array(str), pinnedIds: array(str) }, []),
    history: array(object({ id: str, projectId: str, sessionId: str, at: num, ...contextFields, provider }, ['id', 'projectId', 'sessionId', 'at', 'estimatedTokens', 'budget', 'items', 'skipped', 'enabled', 'provider'])),
  }, ['text', 'estimatedTokens', 'budget', 'items', 'skipped', 'enabled', 'provider', 'preferences', 'history']),
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
