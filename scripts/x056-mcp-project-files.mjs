const string = { type: 'string' };
const tool = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } });
const owner = { parentProjectId: string }, execution = { projectId: string, sessionId: string }, ref = { fileId: string, versionId: string };
export const PROJECT_FILE_TOOLS = [
  tool('list_project_files', 'List shared Project files and saved versions. parentProjectId is the shared owner; projectId and sessionId still identify the execution conversation.', { ...owner, ...execution }, ['parentProjectId']),
  tool('checkout_project_file', 'Check out an exact Project file version into the calling Chat or Work directory. Returns a write lease scoped to this execution attempt. Re-check out after failover.', { ...owner, ...execution, ...ref }, ['parentProjectId', 'fileId', 'versionId']),
  tool('commit_project_file', 'Save a shared file checkout using its expected base version and operationId. Stale executions, changed membership and concurrent edits are rejected.', { ...owner, ...execution, fileId: string, checkoutToken: string, expectedBaseVersionId: string, operationId: string }, ['parentProjectId', 'fileId', 'checkoutToken', 'expectedBaseVersionId', 'operationId']),
  tool('preview_project_file', 'Request or inspect a persisted DOCX or PDF preview. Saved originals stay downloadable if preview fails.', { ...owner, ...ref, retry: { type: 'boolean' } }, ['parentProjectId', 'fileId', 'versionId']),
  tool('add_file_to_project', 'Create an independent shared Project file from an exact saved Chat version. Later private edits do not change the shared copy.', { ...owner, chatId: string, ...ref, operationId: string }, ['parentProjectId', 'chatId', 'fileId', 'versionId', 'operationId']),
  tool('import_work_file', 'Retain a selected Work output in Project Files. Requires an artifact ID registered for the calling Work conversation; never accepts arbitrary repository paths.', { ...owner, ...execution, artifactId: string, operationId: string }, ['parentProjectId', 'artifactId', 'operationId']),
];
export async function callProjectFileTool(api, name, args, self) {
  const pid = self.projectId || args.projectId, sid = self.sessionId || args.sessionId;
  if (self.projectId && args.projectId && args.projectId !== self.projectId) throw new Error('File execution must be the calling conversation');
  if (self.sessionId && args.sessionId && args.sessionId !== self.sessionId) throw new Error('File execution must be the calling conversation');
  const root = '/api/project-spaces/' + encodeURIComponent(args.parentProjectId) + '/files';
  const file = root + '/' + encodeURIComponent(args.fileId || '');
  const post = body => ({ method: 'POST', body: JSON.stringify(body) });
  let data;
  if (name === 'list_project_files') data = await api(root + (pid && sid ? '?' + new URLSearchParams({ projectId: pid, sessionId: sid }) : ''));
  else if (name === 'preview_project_file') data = await api(file + '/versions/' + encodeURIComponent(args.versionId) + '/preview', args.retry ? post({}) : undefined);
  else if (name === 'add_file_to_project') {
    if (self.projectId && self.projectId !== args.chatId) throw new Error('Share files from the calling Chat');
    data = await api(root + '/copy', post({ ...args, sourceOwnerId: args.chatId }));
  } else {
    if (!pid || !sid) throw new Error('Choose a Chat or Work execution conversation');
    const body = { ...args, executionId: pid, sessionId: sid };
    if (name === 'checkout_project_file') data = await api(file + '/checkout', post(body));
    else if (name === 'commit_project_file') data = await api(file + '/versions', post(body));
    else if (name === 'import_work_file') data = await api(root + '/import-artifact', post(body));
    else throw new Error('Unknown Project file tool');
  }
  const enrich = f => ({ ...f, versions: f.versions?.map(v => ({ ...v, downloadPath: root + '/' + encodeURIComponent(f.id) + '/versions/' + encodeURIComponent(v.id) + '/download' })) });
  if (data.files) data.files = data.files.map(enrich); else if (data.versions) data = enrich(data);
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: { data } };
}
