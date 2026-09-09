#!/usr/bin/env node
// Safe, authenticated release verification. Reads discovery and tool results;
// never invokes send, stop, queue edits, schedules, or memory writes.
// Supply the existing X056_TOKEN through the environment; it is never logged.
import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { SERVER_INFO, TOOLS } from './x056-mcp-tools.mjs';

const origin = process.argv[2] || 'https://x056.rc.val.id';
if (!process.env.X056_TOKEN) throw new Error('No existing X056_TOKEN available');
const headers = { Authorization: 'Bearer ' + process.env.X056_TOKEN, 'Content-Type': 'application/json' };
const ajv = new Ajv({ strict: true, allErrors: true });
const expected = new Map(TOOLS.map(t => [t.name, t]));
const hash = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
async function rpc(method, params) {
  const response = await fetch(origin + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error('MCP protocol error ' + body.error.code);
  return body.result;
}
const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
if (init.serverInfo.version !== SERVER_INFO.version) throw new Error('Unexpected MCP server version');
const discovery = await rpc('tools/list');
if (discovery.tools.length !== expected.size) throw new Error('Advertised action count differs');
const validators = new Map();
for (const tool of discovery.tools) {
  if (hash(tool) !== hash(expected.get(tool.name))) throw new Error('Metadata differs for ' + tool.name);
  validators.set(tool.name, ajv.compile(tool.outputSchema));
}
const checks = [];
async function check(name, args = {}, errorExpected = false) {
  const result = await rpc('tools/call', { name, arguments: args });
  const validate = validators.get(name);
  if (!validate(result.structuredContent)) throw new Error(name + ': ' + ajv.errorsText(validate.errors));
  if (!!result.isError !== errorExpected) throw new Error('Unexpected error state: ' + name);
  if (result.content?.[0]?.type !== 'text') throw new Error('Legacy text is missing: ' + name);
  if (errorExpected && result.content[0].text !== 'error: ' + result.structuredContent.error)
    throw new Error('Error text differs: ' + name);
  checks.push({ name, errorExpected, valid: true });
  return result.structuredContent;
}
const projects = await check('list_projects');
const project = projects.projects.find(p => p.cwd === '/home/efran/remote-development/x056-remote-control');
if (project) {
  await check('list_conversations', { projectId: project.id });
  await check('read_conversation', { projectId: project.id, sessionId: '__mcp_output_missing_readonly__', limit: 1 }, true);
  await check('memory_context', { projectId: project.id, query: 'deployment' });
}
await check('get_activity');
await check('search_conversations', { limit: 1 });
await check('list_artifacts', { limit: 1 });
await check('read_artifact', { id: '__mcp_output_missing_readonly__' }, true);
await check('read_reply', { projectId: '__missing__', sessionId: '__missing__', messageId: '__missing__' }, true);
await check('list_queued');
await check('list_scheduled');
const memory = await check('memory_search', { query: '', crossProject: true, limit: 1 });
if (memory.items[0]) await check('memory_read', { id: memory.items[0].id });
await check('memory_read', { id: '__mcp_output_missing_readonly__' }, true);
await check('list_conversations', { projectId: '__mcp_output_missing_readonly__' }, true);
for (const name of ['code_search', 'code_callers', 'code_callees', 'code_impact', 'code_node'])
  await check(name, name === 'code_search' ? { query: 'callTool', limit: 1 } : { symbol: 'callTool' });
await check('code_explore', { query: 'x056-mcp-tools.mjs', maxFiles: 1 });
const wiki = await check('wiki_search', { query: 'deployment', limit: 1 });
if (wiki.results[0]) await check('wiki_read', { ref: wiki.results[0].path });
console.log(JSON.stringify({ origin, at: new Date().toISOString(), serverInfo: init.serverInfo,
  actions: discovery.tools.length, schemasCompiled: validators.size, discoverySha256: hash(discovery.tools), checks,
  credential: 'existing gateway bearer token', oauthClientFlow: 'not exercised; no OAuth credentials changed',
}, null, 2));
