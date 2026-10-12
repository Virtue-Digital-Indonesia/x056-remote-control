import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, BACKGROUND_RECAP_PROMPT, type GatewayEvent } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { readMessageSender } from '../src/message-sender.js';

/**
 * Endings the user used to miss: a Claude turn that ended while its
 * background agents ran on (the woken reply held the summary and the
 * question), and an autopilot run that swallowed every question.
 */
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); vi.useRealTimers(); vi.restoreAllMocks(); });

type Internals = {
  observeIdle: (adapter: unknown, sid: string, e: Record<string, unknown>) => void;
  adapterFor: (pid: string, sid: string) => unknown;
  onSettled: (data: Record<string, unknown>) => void;
  afterTurns: Map<string, unknown>;
  pendingQuestions: Map<string, { question: string; options: string[] }>;
  runs: Map<string, { pendingAdvice?: Promise<unknown> }>;
  disarmAutopilot: (p: string, s: string, r: string) => void;
};

function fixture(stateRoot?: string) {
  const root = stateRoot ?? mkdtempSync(join(tmpdir(), 'recap-manager-')), stateDir = join(root, 'state');
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
  const turns: { prompt: string; resolve: (r: SessionResult) => void }[] = [];
  const manager = new SessionManager({ stateDir, workspaceRoot: root, autopilotIntervalMs: 10, advisorWaitMs: 60_000,
    runSessionFn: (o: RunSessionOptions) => new Promise<SessionResult>((resolve) => {
      turns.push({ prompt: o.prompt, resolve }); o.control?.({ abort: () => resolve({ status: 'stopped', failovers: 0 }), forceSwitch: () => {} });
    }) });
  // Background work is whatever this says is running.
  let active: string[] = [];
  vi.spyOn(manager as never, 'pools').mockReturnValue([{
    activeSessions: () => active.map((sessionId) => ({ sessionId, busy: false, active: true, parentActive: false, agents: 1, tasks: 0 })),
    workingSessions: () => [], interruptSession: () => false, retireIdleSession: () => true, shutdown: () => {},
  }] as never);
  const events: GatewayEvent[] = []; manager.subscribe((e) => events.push(e));
  cleanups.push(() => { manager.onModuleDestroy(); if (!stateRoot) rmSync(root, { recursive: true, force: true }); });
  const m = manager as unknown as Internals;
  const setActive = (ids: string[]) => { active = ids; };
  return { manager, m, root, stateDir, turns, events, setActive };
}
const timers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const of = (events: GatewayEvent[], kind: string) => events.filter((e) => e.kind === kind);
const senderOf = (prompt: string) => readMessageSender(prompt).sender;

/** A human turn that ends with one agent still running in the background. */
async function turnWithBackgroundWork(f: ReturnType<typeof fixture>, pid: string) {
  const sid = f.manager.start('build the report', undefined, undefined, pid);
  f.setActive([sid]);
  await tick(60_000);
  f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'Started two agents; they are still running.' });
  await tick(50);
  const idle = (e: Record<string, unknown>) => f.m.observeIdle(f.m.adapterFor(pid, sid), sid, e);
  return { sid, idle };
}
const taskDone = { type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' };
const reply = (text: string) => [
  { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', result: text },
];

describe('the reply background work woke after the turn ended', () => {
  it('a woken question becomes the card, and replaces the done notice', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Reports', f.root).id;
    const { sid, idle } = await turnWithBackgroundWork(f, pid);
    idle(taskDone);
    for (const e of reply('Both agents finished: 12 files fixed.\n<<<ASK\nquestion: Ship it now?\noptions: Yes|Wait\n>>>')) idle(e);
    await tick(5000);
    expect(of(f.events, 'conversation_settled')).toHaveLength(0); // still working
    f.setActive([]);
    await tick(3000);
    const q = of(f.events, 'question');
    expect(q).toHaveLength(1);
    expect(q[0].data).toMatchObject({ projectId: pid, sessionId: sid, question: 'Ship it now?', options: ['Yes', 'Wait'] });
    expect((q[0].data.notice as { tier: string }).tier).toBe('urgent');
    expect(f.m.pendingQuestions.get(sid)).toMatchObject({ question: 'Ship it now?' });
    expect(of(f.events, 'conversation_settled')).toHaveLength(0);
    expect(f.turns).toHaveLength(1); // no recap: the ending was written
  });

  it('a woken reply without a question is what the settle notice quotes', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Reports', f.root).id;
    const { idle } = await turnWithBackgroundWork(f, pid);
    idle(taskDone);
    for (const e of reply('Both agents finished: twelve files fixed, tests green.')) idle(e);
    f.setActive([]);
    await tick(3000);
    const settled = of(f.events, 'conversation_settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].data).toMatchObject({ resultText: 'Both agents finished: twelve files fixed, tests green.', woken: true });
    expect((settled[0].data.notice as { body: string }).body).toMatch(/Both agents finished: twelve files fixed/);
    expect(f.turns).toHaveLength(1);
  });

  it('work that never got an ending gets ONE recap turn, and the silent settle does not buzz', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Reports', f.root).id;
    const { sid, idle } = await turnWithBackgroundWork(f, pid);
    idle(taskDone); // the task finished, and the model never wrote an ending
    f.setActive([]);
    await tick(3000);
    const settled = of(f.events, 'conversation_settled');
    expect(settled).toHaveLength(1);
    expect(settled[0].data).toMatchObject({ notificationSuppressed: true, recap: true });
    expect((settled[0].data.notice as { tier: string }).tier).toBe('none');
    await tick(1000); // the queue drains
    expect(f.turns).toHaveLength(2);
    expect(f.turns[1].prompt).toContain(BACKGROUND_RECAP_PROMPT);
    expect(f.turns[1].prompt).toContain('x056 question protocol');
    expect(senderOf(f.turns[1].prompt)).toMatchObject({ kind: 'recap', recap: 'background' });
    // The recap turn itself launches agents and ends without a reply: no second recap.
    f.setActive([sid]);
    f.turns[1].resolve({ status: 'completed', failovers: 0, resultText: 'Done: twelve files fixed. Nothing needs you.' });
    await tick(50);
    idle(taskDone);
    f.setActive([]);
    await tick(5000);
    expect(f.turns).toHaveLength(2);
    const last = of(f.events, 'conversation_settled').at(-1)!.data;
    expect(last.origin).toBe('recap');
    expect((last.notice as { tier: string }).tier).toBe('normal');
  });

  it('an ending older than the last finished task does not count', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Reports', f.root).id;
    const { idle } = await turnWithBackgroundWork(f, pid);
    idle(taskDone);
    for (const e of reply('First agent done.')) idle(e);
    idle({ ...taskDone, task_id: 't2' });
    f.setActive([]);
    await tick(4000);
    expect(of(f.events, 'conversation_settled')[0].data).toMatchObject({ recap: true });
    expect(f.turns).toHaveLength(2);
  });

  it('nothing changes for a turn without background work', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Reports', f.root).id;
    f.manager.start('go', undefined, undefined, pid);
    f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'Done.' });
    await tick(3000);
    expect(of(f.events, 'conversation_settled')[0].data).toMatchObject({ resultText: 'Done.' });
    expect(of(f.events, 'conversation_settled')[0].data.recap).toBeUndefined();
    expect(f.turns).toHaveLength(1);
  });

  describe('recap guards', () => {
    const settle = (f: ReturnType<typeof fixture>, pid: string, sid: string, extra: Record<string, unknown> = {}) => {
      f.m.afterTurns.set(sid, { sawWork: true, seq: 1, lastTaskDone: 1 });
      f.m.onSettled({ projectId: pid, sessionId: sid, status: 'completed', origin: 'human', ...extra });
      return of(f.events, 'conversation_settled').at(-1)!.data;
    };
    it('only after a human turn', async () => {
      const f = fixture(); const pid = f.manager.createProject('R', f.root).id;
      const sid = f.manager.start('go', undefined, undefined, pid);
      f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'ok' }); await new Promise((r) => setTimeout(r, 20));
      for (const origin of ['relay', 'cron', 'autopilot', 'recap', 'delegate']) {
        expect(settle(f, pid, sid, { origin }).recap).toBeUndefined();
      }
      expect(f.manager.queues()[pid] ?? []).toHaveLength(0);
    });
    it('not with a queue item waiting, a question pending, a turn running, autopilot armed or a stopped turn', async () => {
      const f = fixture(); const pid = f.manager.createProject('R', f.root).id;
      const sid = f.manager.start('go', undefined, undefined, pid);
      // running
      expect(settle(f, pid, sid).recap).toBeUndefined();
      f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'ok' }); await new Promise((r) => setTimeout(r, 20));
      // suppressed (a stopped turn)
      expect(settle(f, pid, sid, { notificationSuppressed: true }).recap).toBeUndefined();
      // a queue item waiting
      const item = f.manager.enqueue(pid, { sessionId: sid, text: 'later', paused: true });
      expect(settle(f, pid, sid).recap).toBeUndefined();
      f.manager.removeQueueItem(pid, item.id);
      expect(f.manager.queues()[pid] ?? []).toHaveLength(0);
      // a question pending
      f.m.pendingQuestions.set(sid, { question: 'x', options: [] });
      expect(settle(f, pid, sid).recap).toBeUndefined();
      f.m.pendingQuestions.delete(sid);
      // autopilot armed
      f.manager.setAutopilot(pid, sid, { count: 2 });
      expect(settle(f, pid, sid).recap).toBeUndefined();
      f.manager.stopAutopilot(sid);
      // and with every guard clear, it does recap
      expect(settle(f, pid, sid).recap).toBe(true);
      expect(f.turns).toHaveLength(1);
    });
  });
});

describe('the end of an autopilot run', () => {
  const ask = (q: string) => `Step done.\n<<<ASK\nquestion: ${q}\noptions: A|B\n>>>`;

  it('records the questions it swallowed, the final step included, and re-asks them in one recap', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Auto', f.root).id;
    const sid = f.manager.start('migrate the tables', undefined, undefined, pid);
    f.manager.setAutopilot(pid, sid, { count: 2 });
    f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: ask('Keep the old column?') });
    await tick(100);
    f.turns[1].resolve({ status: 'completed', failovers: 0, resultText: ask('Rename users to accounts?') });
    await tick(100);
    expect(f.turns).toHaveLength(3);
    f.turns[2].resolve({ status: 'completed', failovers: 0, resultText: ask('Drop the backup table?') });
    await tick(100);
    expect(of(f.events, 'question')).toHaveLength(0);
    const end = of(f.events, 'autopilot').filter((e) => e.data.active === false);
    expect(end).toHaveLength(1);
    expect(end[0].data).toMatchObject({ reason: 'exhausted', recap: true });
    expect((end[0].data.notice as { tier: string }).tier).toBe('quiet');
    await tick(3000);
    expect(f.turns).toHaveLength(4);
    const prompt = f.turns[3].prompt;
    expect(senderOf(prompt)).toMatchObject({ kind: 'recap', recap: 'autopilot' });
    expect(prompt).toContain('Autopilot finished (the step budget was used up, 2 steps)');
    for (const q of ['Keep the old column? (options: A | B)', 'Rename users to accounts? (options: A | B)', 'Drop the backup table? (options: A | B)']) expect(prompt).toContain('- ' + q);
    expect(prompt).toContain('x056 question protocol');
    // The recap's own question is the usual card.
    f.turns[3].resolve({ status: 'completed', failovers: 0, resultText: ask('Drop the backup table?') });
    await tick(100);
    expect(of(f.events, 'question')).toHaveLength(1);
    await tick(5000);
    expect(f.turns).toHaveLength(4);
  });

  it('done: waits for the last advisor review and for quiet, then queues one recap', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Auto', f.root).id;
    const sid = f.manager.start('go', undefined, undefined, pid);
    f.manager.setAutopilot(pid, sid, { count: 5 });
    let review!: () => void;
    f.m.runs.get(sid)!.pendingAdvice = new Promise<void>((r) => { review = r; });
    f.setActive([sid]);
    f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'All migrated. AUTOPILOT_DONE' });
    await tick(100);
    expect(of(f.events, 'autopilot').at(-1)!.data).toMatchObject({ active: false, reason: 'done', recap: true });
    f.setActive([]);
    await tick(10_000);
    expect(f.turns).toHaveLength(1); // the review is still running
    review();
    f.setActive([sid]);
    await tick(10_000);
    expect(f.turns).toHaveLength(1); // background work still running
    f.setActive([]);
    await tick(1000);
    expect(f.turns).toHaveLength(1); // quiet, but not for 2 s yet
    await tick(2500);
    expect(f.turns).toHaveLength(2);
    expect(f.turns[1].prompt).toContain('Autopilot finished (the stop phrase was reached, 0 steps)');
    expect(f.turns[1].prompt).toContain('No questions were recorded during the run.');
    // Disarming again for the same run is a no-op.
    expect(f.manager.autopilotStatus()[sid]).toBeUndefined();
  });

  it('a stop or a pause gets no recap', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Auto', f.root).id;
    const sid = f.manager.start('go', undefined, undefined, pid);
    f.manager.setAutopilot(pid, sid, { count: 3 });
    f.turns[0].resolve({ status: 'failed', failovers: 0, reason: 'boom' });
    await tick(5000);
    expect(f.manager.autopilotStatus()[sid]).toMatchObject({ paused: true });
    expect(of(f.events, 'autopilot').at(-1)!.data.recap).toBeUndefined();
    f.manager.stopAutopilot(sid);
    await tick(5000);
    expect(of(f.events, 'autopilot').at(-1)!.data).toMatchObject({ reason: 'stopped' });
    expect(of(f.events, 'autopilot').some((e) => e.data.recap)).toBe(false);
    expect(f.turns).toHaveLength(1);
  });

  it('re-arming, a stop or the user coming back cancels a pending recap', async () => {
    timers();
    const f = fixture(); const pid = f.manager.createProject('Auto', f.root).id;
    const sid = f.manager.start('go', undefined, undefined, pid);
    f.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'ok' });
    await tick(100);
    f.manager.setAutopilot(pid, sid, { count: 3 });
    f.m.disarmAutopilot(pid, sid, 'done');
    f.manager.setAutopilot(pid, sid, { count: 3 }); // re-armed
    await tick(5000);
    expect(f.turns).toHaveLength(1);
    f.m.disarmAutopilot(pid, sid, 'done');
    f.manager.stopAutopilot(sid); // stopped by the user
    await tick(5000);
    expect(f.turns).toHaveLength(1);
    f.manager.setAutopilot(pid, sid, { count: 3 });
    f.m.disarmAutopilot(pid, sid, 'exhausted');
    f.manager.continueSession(pid, sid, 'actually, do this instead'); // the user is back
    await tick(100);
    f.turns[1].resolve({ status: 'completed', failovers: 0, resultText: 'ok' });
    await tick(5000);
    expect(f.turns).toHaveLength(2);
    expect(f.turns.every((t) => senderOf(t.prompt)?.kind !== 'recap')).toBe(true);
  });

  it('a run whose budget ran out before a restart is ended at boot, with its recap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recap-boot-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const first = fixture(root); const pid = first.manager.createProject('Auto', root).id;
    const sid = first.manager.start('go', undefined, undefined, pid);
    first.turns[0].resolve({ status: 'completed', failovers: 0, resultText: 'ok' });
    await new Promise((r) => setTimeout(r, 30));
    first.manager.onModuleDestroy();
    writeFileSync(join(first.stateDir, 'autopilot.json'), JSON.stringify({ [sid]: { remaining: 0, count: 4, prompt: 'Continue', stopPhrase: 'AUTOPILOT_DONE', projectId: pid, startedAt: 1, questions: ['Keep the cache?'] } }));
    timers();
    const second = fixture(root);
    const replayed: GatewayEvent[] = []; second.manager.subscribe((e) => replayed.push(e), 0);
    expect(replayed.filter((e) => e.kind === 'autopilot').at(-1)!.data).toMatchObject({ sessionId: sid, active: false, reason: 'exhausted', recap: true, steps: 4 });
    expect(JSON.parse(readFileSync(join(second.stateDir, 'autopilot.json'), 'utf8'))[sid]).toBeUndefined();
    await tick(3500);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0].prompt).toContain('4 steps');
    expect(second.turns[0].prompt).toContain('- Keep the cache?');
  });
});
