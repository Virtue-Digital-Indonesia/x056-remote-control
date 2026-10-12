import { describe, expect, it } from 'vitest';
import { ProviderActivity } from '../src/provider-activity.js';

function claude() {
  const activity = new ProviderActivity();
  const emit = (m: object) => activity.observe('claude', JSON.stringify(m));
  return { activity, emit };
}

describe('Claude task counts', () => {
  it('does not count a task started inside a subagent, and never marks it running', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'nested', task_type: 'local_agent', parent_tool_use_id: 'toolu_1' });
    emit({ type: 'system', subtype: 'task_progress', task_id: 'nested', parent_tool_use_id: 'toolu_1' });
    expect(activity.counts()).toEqual({ agents: 0, shells: 0, total: 0 });
    expect(activity.snapshot()).toMatchObject({ agents: 0, active: false });
    expect(activity.agentRunning('nested')).toBeUndefined();
  });

  it('splits top-level agent tasks from background shells', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent' });
    emit({ type: 'system', subtype: 'task_started', task_id: 'r1', task_type: 'remote_agent' });
    emit({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash' });
    expect(activity.counts()).toEqual({ agents: 2, shells: 1, total: 3 });
    expect(activity.snapshot()).toMatchObject({ agents: 2, active: true });
    expect(activity.agentRunning('a1')).toBe(true);
  });

  it('a notification clears its task and the count falls', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent' });
    emit({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash' });
    emit({ type: 'system', subtype: 'task_progress', task_id: 'b1' });
    emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed' });
    expect(activity.counts()).toEqual({ agents: 0, shells: 1, total: 1 });
    expect(activity.agentRunning('a1')).toBe(false);
    emit({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    expect(activity.counts()).toEqual({ agents: 0, shells: 0, total: 0 });
    expect(activity.snapshot().active).toBe(false);
  });

  it('a task with an unknown or missing type counts as a shell, never an agent', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'x1', task_type: 'some_future_kind' });
    emit({ type: 'system', subtype: 'task_started', task_id: 'x2' });
    expect(activity.counts()).toEqual({ agents: 0, shells: 2, total: 2 });
    emit({ type: 'system', subtype: 'task_progress', task_id: 'x2' });
    expect(activity.counts()).toEqual({ agents: 0, shells: 2, total: 2 });
  });

  it('falls back to subagent_type when task_type is absent', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'g1', subagent_type: 'general-purpose' });
    expect(activity.counts()).toEqual({ agents: 1, shells: 0, total: 1 });
  });

  it('a progress event does not change the kind task_started gave', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'a1', task_type: 'local_agent' });
    emit({ type: 'system', subtype: 'task_progress', task_id: 'a1', task_type: 'local_bash' });
    expect(activity.counts()).toEqual({ agents: 1, shells: 0, total: 1 });
  });

  it('stop clears Claude tasks as well', () => {
    const { activity, emit } = claude();
    emit({ type: 'system', subtype: 'task_started', task_id: 'b1', task_type: 'local_bash' });
    activity.stop();
    expect(activity.counts().total).toBe(0);
  });
});
