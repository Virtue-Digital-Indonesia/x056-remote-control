import { afterEach, expect, it, vi } from 'vitest';
import { Ajv } from 'ajv';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('binds memory approval and recoverable deletion to the calling conversation', async () => {
  vi.stubEnv('X056_SELF_PROJECT_ID', 'own-project');
  vi.stubEnv('X056_SELF_SESSION_ID', 'own-session');
  vi.resetModules();
  const { TOOLS, callToolResult } = await import('../scripts/x056-mcp-tools.mjs');
  const entry = { id: 'note', revision: 2, title: 'Decision', content: 'Use the fixture', summary: '', kind: 'decision', status: 'confirmed', scope: 'conversation', projectId: 'own-project', sessionId: 'own-session', sharedProjectIds: [], providers: ['claude', 'codex'], tags: [], pinned: false, createdAt: 1, updatedAt: 2, actor: 'agent', sources: [] };
  const api = vi.fn(async (_path: string, _options: any) => entry);
  for (const name of ['memory_approve', 'memory_delete']) {
    const args = { id: 'note', revision: 1, ...(name === 'memory_delete' ? { reason: 'Replaced by current decision' } : {}) };
    const output = await callToolResult(api, name, args);
    const [path, options] = api.mock.calls.at(-1)!;
    expect(path).toBe('/api/memory/' + (name === 'memory_approve' ? 'approve' : 'delete'));
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ ...args, callerProjectId: 'own-project', callerSessionId: 'own-session' });
    expect(output.structuredContent).toEqual({ entry });
    const spec = TOOLS.find((t: any) => t.name === name)!;
    expect(spec.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const validate = new Ajv({ strict: true }).compile(spec.outputSchema);
    expect(validate(output.structuredContent), JSON.stringify(validate.errors)).toBe(true);
  }
  api.mockClear();
  for (const args of [{ id: 'note', revision: 1 }, { id: 'note', revision: 1, reason: '' }, { id: 'note', revision: 1, reason: 'x'.repeat(161) }, { id: 'note', revision: 0, reason: 'Obsolete' }, { id: 'note', revision: 1, reason: 'Obsolete', callerProjectId: 'foreign' }]) {
    await expect(callToolResult(api, 'memory_delete', args)).rejects.toThrow('Invalid tool arguments');
  }
  expect(api).not.toHaveBeenCalled();
});
