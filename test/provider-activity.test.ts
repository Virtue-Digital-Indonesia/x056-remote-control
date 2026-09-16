import { describe, expect, it } from 'vitest';
import { ProviderActivity } from '../src/provider-activity.js';

function tracker() {
  const activity = new ProviderActivity();
  const emit = (method: string, params: Record<string, unknown> = {}) => activity.observe('codex', JSON.stringify({ method, params: { threadId: 'parent', ...params } }), 'parent');
  const agent = (id: string, kind = 'started') => emit('item/completed', { item: { type: 'subAgentActivity', agentThreadId: id, kind } });
  return { activity, emit, agent };
}

describe('provider activity evidence', () => {
  it('clears completed turns immediately; housekeeping and deltas do not restart work', () => {
    const { activity, emit } = tracker();
    emit('turn/started'); expect(activity.snapshot().active).toBe(true);
    emit('turn/completed'); expect(activity.snapshot().active).toBe(false);
    emit('thread/tokenUsage/updated'); emit('account/rateLimits/updated');
    emit('item/agentMessage/delta'); emit('thread/status/changed', { status: { type: 'idle' } });
    expect(activity.snapshot().active).toBe(false);
  });
  it('tracks quiet real work until explicit completion, including automatic parent turns', () => {
    const { activity, emit } = tracker();
    emit('thread/status/changed', { status: { type: 'active', activeFlags: [] } });
    expect(activity.snapshot().parentActive).toBe(true);
    emit('turn/completed'); expect(activity.snapshot().active).toBe(false);
    emit('turn/started'); expect(activity.snapshot().active).toBe(true);
  });
  it('does not finish the parent when one of several children completes', () => {
    const { activity, emit, agent } = tracker();
    emit('turn/started'); agent('a'); agent('b');
    emit('turn/completed', { threadId: 'a' });
    expect(activity.snapshot()).toMatchObject({ parentActive: true, agents: 1, active: true });
    emit('turn/completed');
    expect(activity.snapshot()).toMatchObject({ parentActive: false, agents: 1, active: true });
    emit('turn/completed', { threadId: 'b' });
    expect(activity.snapshot().active).toBe(false);
  });
  it('ignores unrelated threads and remembers child completion arriving before registration', () => {
    const { activity, emit, agent } = tracker();
    emit('turn/started', { threadId: 'unrelated' });
    expect(activity.snapshot().active).toBe(false);
    emit('turn/completed', { threadId: 'fast-child' });
    agent('fast-child');
    expect(activity.snapshot().active).toBe(false);
  });
  it('uses collaboration agent states, not the completion of a spawn/wait tool call', () => {
    const { activity, emit } = tracker();
    emit('item/completed', { item: { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', agentsStates: { a: { status: 'running' }, b: { status: 'pendingInit' } } } });
    expect(activity.snapshot().agents).toBe(2);
    emit('item/completed', { item: { type: 'collabAgentToolCall', tool: 'wait', status: 'completed', agentsStates: { a: { status: 'completed' }, b: { status: 'running' } } } });
    expect(activity.snapshot().agents).toBe(1);
  });
  it('tracks grandchildren registered by known children, and closes interrupted agents', () => {
    const { activity, emit, agent } = tracker();
    agent('child');
    emit('item/completed', { threadId: 'child', item: { type: 'subAgentActivity', kind: 'started', agentThreadId: 'grandchild' } });
    agent('child', 'completed');
    expect(activity.snapshot().agents).toBe(1);
    emit('turn/completed', { threadId: 'grandchild' });
    expect(activity.snapshot().active).toBe(false);
  });
  it('clears tools when a turn is interrupted, and all work when the process exits', () => {
    const { activity, emit, agent } = tracker();
    emit('item/started', { item: { type: 'commandExecution', id: 'cmd' } });
    expect(activity.snapshot().tasks).toBe(1);
    emit('turn/completed', { turn: { status: 'interrupted' } });
    expect(activity.snapshot().tasks).toBe(0);
    agent('a'); activity.stop();
    expect(activity.snapshot().active).toBe(false);
  });
  it('Claude result ends only the parent; explicit task lifecycle outlives it', () => {
    const a = new ProviderActivity();
    const emit = (m: object) => a.observe('claude', JSON.stringify(m));
    a.start();
    emit({ type: 'system', subtype: 'task_started', task_id: 'task' });
    emit({ type: 'result', parent_tool_use_id: 'child' });
    expect(a.snapshot().parentActive).toBe(true);
    emit({ type: 'result' });
    expect(a.snapshot()).toMatchObject({ parentActive: false, active: true });
    emit({ type: 'system', subtype: 'task_notification', task_id: 'task', status: 'completed' });
    expect(a.snapshot().active).toBe(false);
  });
});
