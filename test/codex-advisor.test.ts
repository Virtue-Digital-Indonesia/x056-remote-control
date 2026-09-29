import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { readMessageSender } from '../src/message-sender.js';
import { CodexAdvisor, TurnWatcher, type AdvisorExec } from '../server/codex-advisor.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';

const cmd = (command: string, exit_code: number, out = '') => ({ type: 'item.completed', item: { type: 'command_execution', command, exit_code, aggregated_output: out } });
const plan = { type: 'item.completed', item: { type: 'todo_list', items: [{ text: 'restart db', completed: false }] } };

describe('TurnWatcher: the three moments', () => {
  it('consults once on the first plan, once when the same command fails twice, once at done', () => {
    const fired: string[] = [];
    const w = new TurnWatcher('fix /login 500', (t) => fired.push(t));
    w.observe(plan); w.observe(plan);
    w.observe(cmd('curl /login', 22)); w.observe(cmd('docker restart db', 0)); w.observe(cmd('curl /login', 22));
    w.observe({ type: 'turn.completed' });
    expect(fired).toEqual(['plan', 'stuck', 'done']);
    expect(w.transcript()).toMatch(/USER REQUEST: fix \/login 500[\s\S]*AGENT RAN: curl \/login -> exit 22/);
  });

  it('treats three failures in a row as stuck, and resets on a success', () => {
    const fired: string[] = [];
    const w = new TurnWatcher('x', (t) => fired.push(t));
    w.observe(cmd('a', 1)); w.observe(cmd('b', 1)); w.observe(cmd('ok', 0)); w.observe(cmd('c', 1));
    expect(fired).toEqual([]);
    w.observe(cmd('d', 1)); w.observe(cmd('e', 1));
    expect(fired).toEqual(['stuck']);
  });

  // The advisor's own follow-up turn is never reviewed again, so the two cannot loop.
  it('skips the done review when told to', () => {
    const fired: string[] = [];
    new TurnWatcher('x', (t) => fired.push(t), { reviewDone: false }).observe({ type: 'turn.completed' });
    expect(fired).toEqual([]);
  });
});

const fakeExec = (answer: unknown, extra: Partial<{ code: number; timedOut: boolean }> = {}): AdvisorExec => async (_dir, args) => {
  const out = args[args.indexOf('-o') + 1];
  if (answer !== undefined) writeFileSync(out, JSON.stringify(answer));
  expect(args).toEqual(expect.arrayContaining(['exec', '--ephemeral', '--sandbox', 'read-only', '--output-schema']));
  return { code: extra.code ?? 0, stdout: JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 14424, output_tokens: 63 } }) + '\n', lastMessage: '', timedOut: extra.timedOut };
};

describe('CodexAdvisor.consult', () => {
  it('returns the verdict and advice with usage, read-only and ephemeral', async () => {
    const a = new CodexAdvisor(mkdtempSync(join(tmpdir(), 'x056-adv-')), fakeExec({ verdict: 'adjust', advice: 'Stop restarting the database; read the /login stack trace.' }));
    const c = await a.consult('s-00000001', { trigger: 'stuck', transcript: 't', model: 'gpt-6-astra', effort: 'high', configDir: '/cfg/g', account: 'g' });
    expect(c).toMatchObject({ verdict: 'adjust', advice: /stack trace/, inputTokens: 14424, account: 'g', model: 'gpt-6-astra' });
  });

  it('never throws: an unusable answer or a timeout becomes an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-adv-'));
    expect((await new CodexAdvisor(dir, fakeExec({ verdict: 'maybe', advice: 'x' })).consult('s-00000001', { trigger: 'plan', transcript: 't', model: 'm', effort: 'high', configDir: '/c' })).error).toMatch(/no usable answer/);
    expect((await new CodexAdvisor(dir, fakeExec(undefined, { timedOut: true }), 1000).consult('s-00000001', { trigger: 'plan', transcript: 't', model: 'm', effort: 'high', configDir: '/c' })).error).toMatch(/did not answer within 1 s/);
  });
});

describe('SessionManager: the ChatGPT advisor end to end', () => {
  it('steers mid-turn advice into the running turn and queues ONE follow-up after done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-advm-')), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'g', configDir: join(dir, 'g'), provider: 'codex' }]);
    let release: () => void = () => {};
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => {
      calls.push(o);
      if (calls.length === 2) {
        o.tap?.(plan as never);
        o.tap?.(cmd('curl /login', 22) as never); o.tap?.(cmd('curl /login', 22) as never);
        await new Promise<void>((r) => { release = r; }); // the turn stays running while the advisor answers
        o.tap?.({ type: 'turn.completed' } as never);
      }
      return { status: 'completed', finalAccount: 'g', failovers: 0 } as SessionResult;
    }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    const p = mgr.createProject('C', dir, 'codex');
    const sid = mgr.start('first', undefined, undefined, p.id);
    for (let i = 0; i < 100 && mgr.snapshot().running; i++) await new Promise((r) => setTimeout(r, 10));
    mgr.setDecisionMaker(p.id, sid, 'advisor');
    const consult = vi.spyOn(mgr.codexAdvisor(), 'consult').mockImplementation(async (_s, input) => ({
      at: new Date().toISOString(), sessionId: sid, trigger: input.trigger, model: input.model, latencyMs: 5, delivered: 'none',
      verdict: input.trigger === 'done' ? 'concern' : 'adjust', advice: input.trigger === 'done' ? 'You never re-ran the login test.' : 'Read the stack trace first.',
    }));
    const steer = vi.spyOn(mgr, 'steerSession').mockReturnValue(true);
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'fix /login', {});
    for (let i = 0; i < 100 && consult.mock.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(consult.mock.calls.map((c) => c[1].trigger)).toEqual(['plan', 'stuck']);
    await new Promise((r) => setTimeout(r, 20));
    expect(steer).toHaveBeenCalledWith(p.id, sid, expect.stringMatching(/^\[Advisor · gpt-6-astra\] Read the stack trace first\./));
    release();
    for (let i = 0; i < 200 && consult.mock.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(consult.mock.calls[2][1].trigger).toBe('done');
    for (let i = 0; i < 200 && calls.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    // The follow-up ran as the Advisor, and its own turn is not reviewed again.
    const follow = readMessageSender(calls[2].prompt);
    expect(follow.sender?.kind).toBe('advisor');
    expect(follow.text).toMatch(/You never re-ran the login test/);
    await new Promise((r) => setTimeout(r, 50));
    expect(consult.mock.calls.filter((c) => c[1].trigger === 'done')).toHaveLength(1);
    expect(seen.filter((e) => e.kind === 'advisor_consult').map((e) => e.data.delivered)).toEqual(['steered', 'steered', 'queued']);
    expect(mgr.codexAdvisor().consultations(sid)).toHaveLength(3);
  });
});
