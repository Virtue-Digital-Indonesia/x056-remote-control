const string = { type: 'string' };
const tool = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const ref = { chatId: string, fileId: string, versionId: string };
export const CHAT_TOOLS = [
  tool('list_chats', 'List Chats, including id, lastSessionId, provider and Project membership. Pass id as chatId to Chat tools, or as projectId with lastSessionId to queue and scheduling tools.', {}, []),
  tool('create_chat', 'Create an empty Chat without starting a turn. Reuse requestId on retry; use send_chat_message to send through the operator approval flow.', { requestId: string, name: string, provider: { type: 'string', enum: ['claude','codex'] }, model: string, effort: string, account: string, spaceId: string }, ['requestId']),
  tool('read_chat', 'Read a Chat history across providers. chatId is the id from list_chats; no separate sessionId is needed.', { chatId: string, limit: { type: 'integer', minimum: 1, maximum: 500 } }, ['chatId']),
  tool('send_chat_message', 'Send to a Chat through the SAME approval, queue and hop-limit rules as send_message. Omitted model/effort reuse the Chat selection. Does not bypass operator approval.', { chatId: string, message: string, model: string, effort: string, waitSeconds: { type: 'number' } }, ['chatId','message']),
  tool('update_chat', 'Rename or archive/unarchive a Chat. Archiving refuses active or queued work.', { chatId: string, name: string, archived: { type: 'boolean' } }, ['chatId']),
  tool('chat_status', 'Read a Chat identity, model preferences and current running/background activity.', { chatId: string }, ['chatId']),
  tool('stop_chat', 'Stop a Chat using the same rules as stop_conversation. Only use when authorized by the operator.', { chatId: string }, ['chatId']),
  tool('list_chat_files', 'List immutable files, version history, and current run epoch in a Chat. Use before continuing file work after account failover.', { chatId: string }, ['chatId']),
  tool('checkout_chat_file', 'Create a mutable working copy of a saved Chat file. Returns a checkout token and path. Saved originals must never be edited directly.', ref, ['chatId','fileId','versionId']),
  tool('commit_chat_file', 'Validate and save a new immutable version from a checkout. Reuse operationId on retry. Rejects stale base versions and checkouts from previous runs.', { chatId: string, fileId: string, checkoutToken: string, expectedBaseVersionId: string, operationId: string }, ['chatId','fileId','checkoutToken','expectedBaseVersionId','operationId']),
  tool('register_chat_file', 'Save a newly generated file inside the Chat working directory. Pass the epoch from list_chat_files and reuse operationId on retry. Returns saved version IDs and download URLs.', { chatId: string, path: string, name: string, operationId: string, epoch: { type: 'integer', minimum: 0 } }, ['chatId','path','name','operationId','epoch']),
  tool('preview_chat_file', 'Request or inspect a persisted DOCX/PDF preview job. The original remains downloadable if conversion fails. Poll this same tool for status.', { ...ref, retry: { type: 'boolean' } }, ['chatId','fileId','versionId']),
];
export const CHAT_OUTPUT = { type: 'object', properties: { data: { type: 'object', additionalProperties: true } }, required: ['data'], additionalProperties: false };
export async function callChatTool(api, name, args, self, conversationTool) {
  const response = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data } });
  if (name === 'list_chats') return response(await api('/api/chats'));
  if (name === 'create_chat') return response(await api('/api/chats', { method: 'POST', body: JSON.stringify(args) }));
  if (['read_chat','send_chat_message','update_chat','chat_status','stop_chat'].includes(name)) {
    const chat = await api('/api/chats/' + encodeURIComponent(args.chatId));
    if (name === 'update_chat') {
      const { chatId, ...patch } = args;
      return response(await api('/api/chats/' + encodeURIComponent(chatId), { method: 'POST', body: JSON.stringify(patch) }));
    }
    if (!chat.lastSessionId) throw new Error('Chat has no conversation');
    if (name === 'chat_status') {
      const activity = await conversationTool(api, 'get_activity', {});
      return response({ ...chat, activity: activity.structuredContent.conversations.filter(c => c.projectId === args.chatId) });
    }
    const { chatId, ...options } = args;
    const delegated = await conversationTool(api, { read_chat: 'read_conversation', send_chat_message: 'send_message', stop_chat: 'stop_conversation' }[name], { ...options, projectId: chatId, sessionId: chat.lastSessionId });
    return { ...delegated, structuredContent: { data: delegated.structuredContent } };
  }
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
