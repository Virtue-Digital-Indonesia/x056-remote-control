import { describe, expect, it } from 'vitest';
import { claudeAdapter } from '../src/adapters/claude.js';

// A subagent's messages arrive on the parent's stream tagged with
// parent_tool_use_id. Shown as main-session text they vanished on reload,
// because they live in the subagent's own transcript.
describe('claude assistantText', () => {
  const ev = (parent?: string) => ({ type: 'assistant', ...(parent ? { parent_tool_use_id: parent } : {}), message: { content: [{ type: 'text', text: 'hello' }] } });
  it('keeps the main session text', () => {
    expect(claudeAdapter.assistantText!(ev() as never)).toEqual(['hello']);
  });
  it('drops a subagent message', () => {
    expect(claudeAdapter.assistantText!(ev('toolu_9') as never)).toEqual([]);
  });
});
