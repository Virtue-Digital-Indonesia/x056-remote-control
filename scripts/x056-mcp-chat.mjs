const string = { type: 'string' };
const tool = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const ref = { chatId: string, fileId: string, versionId: string };
export const CHAT_TOOLS = [
  tool('list_chat_files', 'List immutable files, version history, and current run epoch in a Chat. Use before continuing file work after account failover.', { chatId: string }, ['chatId']),
  tool('checkout_chat_file', 'Create a mutable working copy of a saved Chat file. Returns a checkout token and path. Saved originals must never be edited directly.', ref, ['chatId','fileId','versionId']),
  tool('commit_chat_file', 'Validate and save a new immutable version from a checkout. Reuse operationId on retry. Rejects stale base versions and checkouts from previous runs.', { chatId: string, fileId: string, checkoutToken: string, expectedBaseVersionId: string, operationId: string }, ['chatId','fileId','checkoutToken','expectedBaseVersionId','operationId']),
  tool('register_chat_file', 'Save a newly generated file inside the Chat working directory. Pass the epoch from list_chat_files and reuse operationId on retry. Returns saved version IDs and download URLs.', { chatId: string, path: string, name: string, operationId: string, epoch: { type: 'integer', minimum: 0 } }, ['chatId','path','name','operationId','epoch']),
  tool('preview_chat_file', 'Request or inspect a persisted DOCX/PDF preview job. The original remains downloadable if conversion fails. Poll this same tool for status.', { ...ref, retry: { type: 'boolean' } }, ['chatId','fileId','versionId']),
];
export const CHAT_OUTPUT = { type: 'object', properties: { data: { type: 'object', additionalProperties: true } }, required: ['data'], additionalProperties: false };
export async function callChatTool(api, name, args, self) {
  if (self.projectId && self.projectId !== args.chatId && name !== 'list_chat_files' && name !== 'preview_chat_file') throw new Error('File writes must target the calling Chat');
  const root = '/api/chats/' + encodeURIComponent(args.chatId) + '/files';
  const file = root + '/' + encodeURIComponent(args.fileId || '');
  let data;
  if (name === 'list_chat_files') data = await api(root);
  else if (name === 'checkout_chat_file') data = await api(file + '/checkout', { method: 'POST', body: JSON.stringify({ versionId: args.versionId }) });
  else if (name === 'commit_chat_file') data = await api(file + '/versions', { method: 'POST', body: JSON.stringify(args) });
  else if (name === 'register_chat_file') data = await api(root + '/register', { method: 'POST', body: JSON.stringify(args) });
  else if (name === 'preview_chat_file') data = await api(file + '/versions/' + encodeURIComponent(args.versionId) + '/preview', args.retry ? { method: 'POST', body: '{}' } : undefined);
  else throw new Error('Unknown Chat file tool');
  const enrich = f => ({ ...f, versions: f.versions?.map(v => ({ ...v, downloadPath: root + '/' + encodeURIComponent(f.id) + '/versions/' + encodeURIComponent(v.id) + '/download' })) });
  if (data.files) data.files = data.files.map(enrich);
  else if (data.versions) data = enrich(data);
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data } };
}
