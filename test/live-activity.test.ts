import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveActivities, type TurnContent } from '../server/live-activity.js';
import type { ApnsEnv } from '../server/apns.js';

const TOKEN = 'ab'.repeat(40);
const ref = { projectId: 'p1', sessionId: 's1' };

interface Sent { token: string; env: ApnsEnv; priority: 5 | 10; event: string; content: TurnContent; dismissal?: number }

function setup(opts: { gap?: number; reply?: { status: number; reason?: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-la-'));
  let clock = 1_000_000_000_000;
  const sent: Sent[] = [];
  const la = new LiveActivities(dir, async (token, env, payload, priority) => {
    const aps = payload.aps as Record<string, unknown>;
    sent.push({ token, env, priority, event: aps.event as string, content: structuredClone(aps['content-state']) as TurnContent, dismissal: aps['dismissal-date'] as number | undefined });
    return opts.reply ?? { status: 200 };
  }, () => clock, opts.gap ?? 0);
  return { dir, la, sent, tick: (ms: number) => { clock += ms; } };
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.useRealTimers(); });

describe('Live Activities', () => {
  it('follows a turn: started, its steps, then the end, and forgets it', async () => {
    const { dir, la, sent } = setup(); dirs.push(dir);
    la.register({ token: TOKEN, env: 'production', ...ref });
    la.observe('session_started', { ...ref });
    la.observe('activity', { ...ref, status: 'start', label: 'Running: npm test', toolUseId: 't1' });
    la.observe('activity', { ...ref, status: 'start', label: 'Agent: explorer', toolUseId: 'x', parentToolUseId: 't0' });
    la.observe('activity', { ...ref, status: 'done', toolUseId: 't1' });
    la.observe('session_done', { ...ref, status: 'completed' });
    await Promise.resolve();
    expect(sent.map((s) => [s.event, s.priority])).toEqual([['update', 10], ['update', 5], ['update', 5], ['end', 10]]);
    expect(sent[1].content).toMatchObject({ status: 'running', steps: 1, activity: 'Running: npm test' });
    // A subagent's own tools are not this turn's steps.
    expect(sent[2].content.steps).toBe(1);
    const end = sent[3];
    expect(end.content).toMatchObject({ status: 'done', steps: 1 });
    expect(end.content.endedAt).toBeGreaterThan(0);
    expect(end.content.activity).toBeUndefined();
    expect(end.dismissal).toBe(end.content.endedAt! + 20 * 60);
    expect(la.list()).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'push', 'live-activities.json'), 'utf8'))).toEqual([]);
  });

  it('ends a turn that asked something as waiting for an answer', () => {
    const { dir, la, sent } = setup(); dirs.push(dir);
    la.register({ token: TOKEN, env: 'production', ...ref });
    la.observe('session_started', { ...ref });
    la.observe('question', { ...ref, question: 'Ship it?' });
    la.observe('session_done', { ...ref, status: 'completed' });
    expect(sent.at(-1)).toMatchObject({ event: 'end', content: { status: 'waiting', detail: 'Ship it?' } });
  });

  it('ends a failed turn with its reason and shows a question as waiting', () => {
    const { dir, la, sent } = setup(); dirs.push(dir);
    la.register({ token: TOKEN, env: 'sandbox', ...ref });
    la.observe('question', { ...ref, question: 'Which page should we publish?' });
    expect(sent[0]).toMatchObject({ priority: 10, content: { status: 'waiting', detail: 'Which page should we publish?' } });
    la.observe('session_done', { ...ref, status: 'failed', reason: 'Every account is at its limit' });
    expect(sent[1]).toMatchObject({ event: 'end', env: 'sandbox', content: { status: 'failed', detail: 'Every account is at its limit' } });
  });

  it('stays up between autopilot steps and ends when the run does', () => {
    const { dir, la, sent } = setup(); dirs.push(dir);
    la.observe('autopilot', { ...ref, active: true, remaining: 4, count: 5 });
    la.register({ token: TOKEN, env: 'production', ...ref, content: { steps: 3, startedAt: 999 } });
    la.observe('session_started', { ...ref });
    expect(sent[0].content).toMatchObject({ status: 'running', steps: 3, startedAt: 999, autopilotLeft: 4, autopilotCount: 5 });
    la.observe('session_done', { ...ref, status: 'completed' });
    expect(sent.at(-1)).toMatchObject({ event: 'update', content: { status: 'running', activity: 'Next step in a moment' } });
    la.observe('autopilot', { ...ref, active: true, remaining: 3, count: 5 });
    la.observe('session_started', { ...ref });
    la.observe('session_done', { ...ref, status: 'completed' });
    // The reply said it was done: autopilot disarms with no turn running.
    la.observe('autopilot', { ...ref, active: false, remaining: 0, reason: 'done' });
    expect(sent.at(-1)).toMatchObject({ event: 'end', content: { status: 'done' } });
    expect(sent.filter((s) => s.event === 'end')).toHaveLength(1);
    expect(la.list()).toEqual([]);
  });

  it('holds step updates to one per gap, sending the latest when it passes', () => {
    vi.useFakeTimers();
    const { dir, la, sent, tick } = setup({ gap: 8000 }); dirs.push(dir);
    la.register({ token: TOKEN, env: 'production', ...ref });
    la.observe('session_started', { ...ref });
    for (const n of [1, 2, 3]) la.observe('activity', { ...ref, status: 'start', label: `Step ${n}`, toolUseId: `t${n}` });
    expect(sent).toHaveLength(1);
    tick(8000);
    vi.advanceTimersByTime(8000);
    expect(sent).toHaveLength(2);
    expect(sent[1].content).toMatchObject({ steps: 3, activity: 'Step 3' });
    // An end is never held back.
    la.observe('session_done', { ...ref, status: 'stopped' });
    expect(sent.at(-1)).toMatchObject({ event: 'end', content: { status: 'stopped' } });
  });

  it('forgets an activity APNs says is gone, and refuses a bad token', async () => {
    const { dir, la } = setup({ reply: { status: 410 } }); dirs.push(dir);
    expect(() => la.register({ token: 'nope', env: 'production', ...ref })).toThrow('invalid activity token');
    la.register({ token: TOKEN, env: 'production', ...ref });
    la.observe('session_started', { ...ref });
    await new Promise((r) => setImmediate(r));
    expect(la.list()).toEqual([]);
  });

  it('survives a restart', () => {
    const { dir, la } = setup(); dirs.push(dir);
    la.register({ token: TOKEN, env: 'production', ...ref, content: { steps: 2, activity: 'Reading a.ts' } });
    const again = new LiveActivities(dir, async () => ({ status: 200 }), () => 1_000_000_000_000 + 60_000);
    expect(again.list()).toEqual([expect.objectContaining({ ...ref, content: expect.objectContaining({ steps: 2, activity: 'Reading a.ts' }) })]);
  });
});
