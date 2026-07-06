import { describe, expect, it } from 'vitest';
import { toActivity } from '../server/activity.js';

describe('toActivity', () => {
  it('maps a Bash tool_use to a running-start activity', () => {
    const e = { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } };
    expect(toActivity(e)).toEqual([
      { toolUseId: 't1', parentToolUseId: null, tool: 'Bash', label: 'Running: npm test', status: 'start', isSubagent: false },
    ]);
  });

  it('flags Task as a subagent and carries parent_tool_use_id', () => {
    const e = { type: 'assistant', parent_tool_use_id: 'p9', message: { content: [{ type: 'tool_use', id: 't2', name: 'Task', input: { description: 'review the diff' } }] } };
    const [a] = toActivity(e);
    expect(a.isSubagent).toBe(true);
    expect(a.label).toBe('Subagent: review the diff');
    expect(a.parentToolUseId).toBe('p9');
  });

  it('maps a successful tool_result to done and an error to error', () => {
    const ok = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } };
    const bad = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true }] } };
    expect(toActivity(ok)[0].status).toBe('done');
    expect(toActivity(bad)[0].status).toBe('error');
  });

  it('labels file tools by basename and ignores plain text/thinking', () => {
    expect(toActivity({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e', name: 'Edit', input: { file_path: '/a/b/foo.ts' } }] } })[0].label).toBe('Editing foo.ts');
    expect(toActivity({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([]);
    expect(toActivity({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
  });
});
