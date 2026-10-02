import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { readMessageSender } from '../src/message-sender.js';
import type { AdvisorConsult } from '../server/codex-advisor.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const done = (resultText = 'working'): SessionResult => ({ status: 'completed', finalAccount: 'g', failovers: 0, resultText });
const plan = { type: 'item.completed', item: { type: 'todo_list', items: [{ text: 'step', completed: false }] } };

/** A gateway whose turns are a scripted stub. `turn(text, o)` decides each one. */
function fixture(provider: 'codex' | 'claude', turn: (text: string, o: RunSessionOptions, n: number) => Promise<SessionResult>, opts: { intervalMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-apadv-')), stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), provider === 'codex'
    ? [{ name: 'g', configDir: join(dir, 'g'), provider: 'codex' }]
    : [{ name: 'a', configDir: join(dir, 'a') }]);
  const texts: string[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    const text = readMessageSender(o.prompt).text;
    texts.push(text);
    return turn(text, o, texts.length);
  }) as unknown as typeof import('../src/failover.js').runSession;
  const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn, autopilotIntervalMs: opts.intervalMs ?? 20 });
  const p = mgr.createProject('P', dir, provider);
  const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
  return { mgr, p, texts, seen };
}
const idle = (mgr: SessionManager) => waitFor(() => !mgr.snapshot().running);
function consultAs(mgr: SessionManager, sid: string, answer: (trigger: string, n: number) => { verdict: AdvisorConsult['verdict']; advice: string; delayMs: number }) {
  let n = 0;
  return vi.spyOn(mgr.codexAdvisor(), 'consult').mockImplementation(async (_s, input) => {
    const a = answer(input.trigger, n++);
    await sleep(a.delayMs);
    return { at: new Date().toISOString(), sessionId: sid, trigger: input.trigger, model: input.model, latencyMs: a.delayMs, delivered: 'none', verdict: a.verdict, advice: a.advice };
  });
}

describe('autopilot with the ChatGPT advisor', () => {
  it('runs the advisor follow-up BEFORE the next autopilot step, and spends one step per autopilot prompt', async () => {
    const { mgr, p, texts, seen } = fixture('codex', async (_t, o) => { o.tap?.({ type: 'turn.completed' } as never); await sleep(5); return done(); });
    const sid = mgr.start('first', undefined, undefined, p.id);
    await idle(mgr);
    mgr.setDecisionMaker(p.id, sid, 'advisor');
    // The done review takes far longer than the autopilot interval (20 ms).
    let concerns = 0;
    consultAs(mgr, sid, (trigger) => trigger === 'done' && concerns++ === 0
      ? { verdict: 'concern', advice: 'You never ran the tests.', delayMs: 250 }
      : { verdict: 'looks_good', advice: 'fine', delayMs: 250 });
    mgr.setAutopilot(p.id, sid, { count: 2, prompt: 'AP_STEP' });
    mgr.continueSession(p.id, sid, 'the task', {});
    await waitFor(() => mgr.autopilotStatus()[sid] === undefined, 8000);
    await idle(mgr);
    expect(texts.slice(1).map((t) => /never ran the tests/.test(t) ? 'ADVISOR' : t.split('\n\n')[0])).toEqual(['the task', 'ADVISOR', 'AP_STEP', 'AP_STEP']);
    const ap = seen.filter((e) => e.kind === 'autopilot').map((e) => e.data);
    expect(ap.at(-1)).toMatchObject({ active: false, reason: 'exhausted' });
    // Spent at send time: 2 -> 1 -> 0, once per AP_STEP actually sent.
    expect([...new Set(ap.filter((d) => d.active).map((d) => d.remaining))]).toEqual([2, 1, 0]);
  }, 15000);

  it('a plan review that lands after its turn ended is too-late, and is never steered into the next turn', async () => {
    let release: () => void = () => {};
    const { mgr, p, seen } = fixture('codex', async (text, o) => {
      if (text === 'turn two') { o.tap?.(plan as never); o.tap?.({ type: 'turn.completed' } as never); }
      if (text === 'turn three') await new Promise<void>((r) => { release = r; });
      return done();
    });
    const sid = mgr.start('first', undefined, undefined, p.id);
    await idle(mgr);
    mgr.setDecisionMaker(p.id, sid, 'advisor');
    consultAs(mgr, sid, (trigger) => trigger === 'plan' ? { verdict: 'adjust', advice: 'Check X.', delayMs: 250 } : { verdict: 'looks_good', advice: 'ok', delayMs: 1 });
    const steer = vi.spyOn(mgr, 'steerSession').mockReturnValue(true);
    mgr.continueSession(p.id, sid, 'turn two', {});
    await idle(mgr);
    mgr.continueSession(p.id, sid, 'turn three', {});
    await waitFor(() => seen.some((e) => e.kind === 'advisor_consult' && e.data.trigger === 'plan'));
    expect(seen.find((e) => e.kind === 'advisor_consult' && e.data.trigger === 'plan')!.data.delivered).toBe('too-late');
    expect(steer).not.toHaveBeenCalled();
    expect(mgr.codexAdvisor().consultations(sid).find((c) => c.trigger === 'plan')?.delivered).toBe('too-late');
    release();
    await idle(mgr);
  }, 10000);
});

describe('autopilot verdicts survive a queue drain', () => {
  function held(first: SessionResult) {
    let release: () => void = () => {};
    const f = fixture('claude', async (text) => {
      if (text === 'kick off') { await new Promise<void>((r) => { release = r; }); return first; }
      return done();
    });
    return { ...f, release: () => release() };
  }

  it('a stop phrase disarms autopilot even though a queued message drained after it', async () => {
    const { mgr, p, texts, release } = held(done('all finished AUTOPILOT_DONE'));
    const sid = mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, sid, { count: 5, prompt: 'AP_STEP' });
    mgr.enqueue(p.id, { text: 'REAL MESSAGE', sessionId: sid });
    release();
    await waitFor(() => texts.includes('REAL MESSAGE'));
    await idle(mgr);
    await sleep(150);
    expect(mgr.autopilotStatus()[sid]).toBeUndefined();
    expect(texts.some(t => t.startsWith('AP_STEP'))).toBe(false);
  });

  it('a failed turn pauses autopilot even though a queued message drained after it', async () => {
    const { mgr, p, texts, release } = held({ status: 'failed', failovers: 0, reason: 'boom' } as SessionResult);
    const sid = mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, sid, { count: 5, prompt: 'AP_STEP' });
    mgr.enqueue(p.id, { text: 'REAL MESSAGE', sessionId: sid });
    release();
    await waitFor(() => texts.includes('REAL MESSAGE'));
    await idle(mgr);
    await sleep(150);
    expect(mgr.autopilotStatus()[sid]).toMatchObject({ paused: true, pauseReason: 'failed', remaining: 5 });
    expect(texts.some(t => t.startsWith('AP_STEP'))).toBe(false);
  });

  it('a step skipped because a queued message was running is not spent', async () => {
    // Interval 600 ms; the queued message drains after 400 ms and runs 400 ms,
    // so the autopilot tick finds the conversation busy.
    const { mgr, p, texts } = fixture('claude', async (text) => { await sleep(text === 'REAL MESSAGE' ? 400 : 5); return done(); }, { intervalMs: 600 });
    const sid = mgr.start('kick off', undefined, undefined, p.id);
    mgr.setAutopilot(p.id, sid, { count: 3, prompt: 'AP_STEP' });
    await idle(mgr);
    mgr.enqueue(p.id, { text: 'REAL MESSAGE', sessionId: sid });
    await waitFor(() => mgr.autopilotStatus()[sid] === undefined, 10000);
    await idle(mgr);
    expect(texts.filter((t) => t.startsWith('AP_STEP\n\n'))).toHaveLength(3);
    expect(texts.indexOf('REAL MESSAGE')).toBeLessThan(texts.findIndex(t => t.startsWith('AP_STEP\n\n')));
  }, 15000);
});

describe('steer origin and the relay brakes', () => {
  it('an advisor steer keeps the relay chain and self streak; a panel steer clears them', async () => {
    const { mgr, p } = fixture('claude', async () => done());
    const sid = mgr.start('kick off', undefined, undefined, p.id);
    await idle(mgr);
    const inner = mgr as unknown as { pools: () => unknown[]; relayChains: Map<string, unknown>; selfQueueStreak: Map<string, number> };
    vi.spyOn(inner, 'pools').mockReturnValue([{ injectMessage: () => true }]);
    inner.relayChains.set(sid, { id: 'chain', depth: 3, from: 'other' });
    inner.selfQueueStreak.set(sid, 2);
    expect(mgr.steerSession(p.id, sid, '[Advisor] check X', { humanOrigin: false })).toBe(true);
    expect(mgr.relayDepth(sid)).toBe(3);
    expect(inner.selfQueueStreak.get(sid)).toBe(2);
    expect(mgr.steerSession(p.id, sid, 'from the panel')).toBe(true);
    expect(mgr.relayDepth(sid)).toBe(0);
    expect(inner.selfQueueStreak.get(sid)).toBeUndefined();
  });
});
