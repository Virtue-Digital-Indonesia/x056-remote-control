import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { ClaudeTransport } from '../src/persistent-transport.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { JevService, JEV_POLICY, EFFORT_QUESTION, applyPolicy, decisionState, effortQuestion, modelQuestion, type JevDecision, type JevDecisionInput } from '../server/jev.js';
import { decisionsRequest } from '../server/openai-decisions.js';
import { advisorFor, jevCandidates } from '../server/decision-maker.js';
import { OpenAIDecisionsService } from '../server/openai-decisions.js';

const input = (over: Partial<JevDecisionInput> = {}): JevDecisionInput => ({
  provider: 'claude', prompt: 'rename a variable', currentModel: 'opus', currentEffort: 'high', ...jevCandidates('claude', []), ...over,
});
const base = (): JevDecision => ({ at: 't', sessionId: 's-00000001', provider: 'claude', notes: [], latencyMs: 1 });

describe('advisor pairing', () => {
  // Verified on 2.1.280: an Opus advisor on a Fable main model is silently
  // NOT attached -- it would read as "on" while doing nothing.
  it('pairs Fable with Fable and everything else with Opus; Codex gets none', () => {
    expect(advisorFor('claude', 'claude-fable-5-1')).toBe('fable');
    expect(advisorFor('claude', 'sonnet')).toBe('opus');
    expect(advisorFor('claude', undefined)).toBe('opus');
    expect(advisorFor('codex', 'gpt-6-astra')).toBeUndefined();
  });

  it('reaches the CLI argv and the persistent process identity', () => {
    const t = new ClaudeTransport();
    const o = { configDir: '/c', cwd: '/w', sessionId: 's', mode: 'new' as const, prompt: 'p', onEvent: () => {} };
    const args = t.spawnSpec({ ...o, advisor: 'opus' }).args;
    expect(args[args.indexOf('--advisor') + 1]).toBe('opus');
    expect(t.spawnSpec(o).args).not.toContain('--advisor');
    expect(t.identity({ ...o, advisor: 'opus' })).not.toBe(t.identity(o)); // toggling respawns the process
  });
});

describe('Jev policy', () => {
  it('applies a confident effort, and a model only above the higher bar', () => {
    const d = applyPolicy(base(), input(), { effort: { choice: 'low', confidence: 0.9 }, model: { choice: 'haiku', confidence: 0.95 } }, []);
    expect(d).toMatchObject({ effort: 'low', model: 'haiku', pickedModel: 'haiku', pickedEffort: 'low' });
    const unsure = applyPolicy(base(), input(), { effort: { choice: 'low', confidence: 0.5 }, model: { choice: 'haiku', confidence: 0.7 } }, []);
    expect(unsure.effort).toBeUndefined();
    expect(unsure.model).toBeUndefined();
    expect(unsure.notes.join(' ')).toMatch(/only 70% sure/);
  });

  // Seen live 2026-09-30: the previous turn's pick was medium, the saved
  // effort xhigh; Jev picked medium at 71% and the policy called it
  // "unchanged", so the turn ran on xhigh. A pick lasts one turn: compare it
  // with what this turn runs with otherwise.
  it('applies a pick that equals the previous pick but not the turn\'s own effort', () => {
    const history: JevDecision[] = [{ ...base(), effort: 'medium' }];
    const d = applyPolicy(base(), input({ currentModel: 'opus', currentEffort: 'xhigh' }), { effort: { choice: 'medium', confidence: 0.85 } }, history);
    expect(d.effort).toBe('medium');
    expect(d.notes).toContain('effort -> medium');
  });

  // Lowering is the costly mistake (quality, a human round trip); raising
  // only costs tokens. So going below the turn's own choice needs more.
  it('needs more confidence to go lower than to go higher', () => {
    const cur = input({ currentModel: 'sonnet', currentEffort: 'high' });
    const down = applyPolicy(base(), cur, { effort: { choice: 'medium', confidence: 0.71 }, model: { choice: 'haiku', confidence: 0.85 } }, []);
    expect(down.effort).toBeUndefined();
    expect(down.model).toBeUndefined();
    expect(down.notes).toEqual(['model haiku is below sonnet at only 85% (needs 90% to go lower); kept', 'effort medium is below high at only 71% (needs 80% to go lower); kept']);
    const up = applyPolicy(base(), cur, { effort: { choice: 'xhigh', confidence: 0.71 }, model: { choice: 'opus', confidence: 0.85 } }, []);
    expect(up).toMatchObject({ effort: 'xhigh', model: 'opus' });
  });

  // The slider: low errs toward cheaper, high toward stronger. Only the bars
  // for moving up or down change; medium is the policy above, unchanged.
  it('leans low: cheaper is easier to reach, stronger harder', () => {
    const cur = input({ currentModel: 'sonnet', currentEffort: 'high', lean: 'low' });
    const up = applyPolicy(base(), cur, { effort: { choice: 'xhigh', confidence: 0.7 }, model: { choice: 'opus', confidence: 0.85 } }, []);
    expect(up).toMatchObject({ lean: 'low' });
    expect(up.effort).toBeUndefined(); expect(up.model).toBeUndefined();
    expect(up.notes).toEqual(['model opus only 85% sure (needs 90%, leaning low); kept', 'effort xhigh only 70% sure (needs 80% to go higher, leaning low); kept']);
    const down = applyPolicy(base(), cur, { effort: { choice: 'medium', confidence: 0.65 }, model: { choice: 'haiku', confidence: 0.82 } }, []);
    expect(down).toMatchObject({ effort: 'medium', model: 'haiku' });
  });

  it('leans high: stronger is easier to reach, cheaper harder', () => {
    const cur = input({ currentModel: 'sonnet', currentEffort: 'high', lean: 'high' });
    expect(applyPolicy(base(), cur, { effort: { choice: 'xhigh', confidence: 0.62 }, model: { choice: 'opus', confidence: 0.72 } }, [])).toMatchObject({ effort: 'xhigh', model: 'opus', lean: 'high' });
    const down = applyPolicy(base(), cur, { effort: { choice: 'medium', confidence: 0.85 }, model: { choice: 'haiku', confidence: 0.92 } }, []);
    expect(down.effort).toBeUndefined(); expect(down.model).toBeUndefined();
    expect(down.notes).toEqual(['model haiku is below sonnet at only 92% (needs 95% to go lower, leaning high); kept', 'effort medium is below high at only 85% (needs 90% to go lower, leaning high); kept']);
    // A move the ranks cannot place (Fable) keeps the plain 80% bar.
    expect(applyPolicy(base(), input({ currentModel: 'fable', lean: 'high' }), { model: { choice: 'opus', confidence: 0.75 } }, []).model).toBeUndefined();
  });

  // "Auto effort" saves none; the CLI then runs its own default (Opus 5.5:
  // medium). Measured from nothing, every pick was a raise, and Low needed 80%
  // even to pick `low`.
  it('with Auto effort, measures up and down from the CLI default', () => {
    const auto = (lean: 'low' | 'high') => input({ currentModel: 'opus', currentEffort: undefined, baselineEffort: 'medium', lean });
    expect(applyPolicy(base(), auto('low'), { effort: { choice: 'low', confidence: 0.65 } }, []).effort).toBe('low');
    const highUp = applyPolicy(base(), auto('low'), { effort: { choice: 'high', confidence: 0.7 } }, []);
    expect(highUp.effort).toBeUndefined();
    expect(highUp.notes).toEqual(['effort high only 70% sure (needs 80% to go higher, leaning low); kept']);
    const lowDown = applyPolicy(base(), auto('high'), { effort: { choice: 'low', confidence: 0.85 } }, []);
    expect(lowDown.notes).toEqual(['effort low is below medium (the default) at only 85% (needs 90% to go lower, leaning high); kept']);
    expect(applyPolicy(base(), auto('high'), { effort: { choice: 'medium', confidence: 0.9 } }, []).notes).toEqual(['effort unchanged (medium is the default)']);
  });

  it('medium reads exactly as before, with no lean recorded', () => {
    const d = applyPolicy(base(), input({ currentModel: 'sonnet', currentEffort: 'high', lean: 'medium' }), { effort: { choice: 'medium', confidence: 0.71 } }, []);
    expect(d.lean).toBeUndefined();
    expect(d.notes).toEqual(['effort medium is below high at only 71% (needs 80% to go lower); kept']);
  });

  it('tells both backends which way to lean', () => {
    expect(effortQuestion('medium')).toBe(EFFORT_QUESTION);
    expect(effortQuestion('low')).toMatch(/COST EFFICIENCY/);
    expect(modelQuestion('high')).toMatch(/BEST RESULT/);
    const body = decisionsRequest(input({ lean: 'low' })) as { questions: { id: string; instructions: string }[] };
    expect(body.questions.every((q) => /COST EFFICIENCY/.test(q.instructions))).toBe(true);
  });

  it('tells the picker what the conversation is in the middle of', () => {
    const state = decisionState(input({ prompt: 'yes, deploy it', title: 'Delegates', context: { project: 'X056 Remote Control', origin: 'the user', previousRequest: 'Build Delegates', previousReply: 'x'.repeat(2000) + 'Want me to deploy?', lastTurn: '48 min, 212 steps' } }));
    expect(state).toMatchObject({ project: 'X056 Remote Control', message_from: 'the user', previous_request: 'Build Delegates', previous_turn_size: '48 min, 212 steps', new_message: 'yes, deploy it' });
    expect(state.previous_reply.startsWith('…')).toBe(true);
    expect(state.previous_reply.endsWith('Want me to deploy?')).toBe(true);
    expect(Object.keys(state).at(-1)).toBe('new_message');
    expect(EFFORT_QUESTION).toMatch(/short follow-up/);
  });

  it('stays on a model a pick already moved to without the switching bar', () => {
    const history: JevDecision[] = [{ ...base(), model: 'sonnet' }];
    const stay = applyPolicy(base(), input({ currentModel: 'opus', previousModel: 'sonnet' }), { model: { choice: 'sonnet', confidence: 0.69 } }, history);
    expect(stay.model).toBe('sonnet');
    expect(stay.notes).toContain('model stays sonnet');
    // Under the effort bar it goes back to the saved model.
    expect(applyPolicy(base(), input({ currentModel: 'opus', previousModel: 'sonnet' }), { model: { choice: 'sonnet', confidence: 0.4 } }, history).model).toBeUndefined();
  });

  it('counts a run of stays as ONE switch for the gap', () => {
    const history: JevDecision[] = [{ ...base(), model: 'sonnet' }, base(), base(), { ...base(), model: 'sonnet' }];
    // The last decision re-entered sonnet after two turns on opus: a switch.
    expect(applyPolicy(base(), input({ currentModel: 'opus', previousModel: 'sonnet' }), { model: { choice: 'haiku', confidence: 0.95 } }, history).model).toBeUndefined();
    const stays: JevDecision[] = [{ ...base(), model: 'sonnet' }, { ...base(), model: 'sonnet' }, { ...base(), model: 'sonnet' }, { ...base(), model: 'sonnet' }];
    // Four turns on sonnet, switched only at the first: the gap has passed.
    expect(applyPolicy(base(), input({ currentModel: 'opus', previousModel: 'sonnet' }), { model: { choice: 'haiku', confidence: 0.95 } }, stays).model).toBe('haiku');
  });

  // A Claude model switch respawns the process and drops the prompt cache.
  it('waits a few turns between Claude model switches; Codex has no such gap', () => {
    const switched: JevDecision[] = [{ ...base(), model: 'haiku' }];
    const pick = { model: { choice: 'opus', confidence: 0.95 } };
    expect(applyPolicy(base(), input({ currentModel: 'haiku' }), pick, switched).model).toBeUndefined();
    const later = [...switched, ...Array.from({ length: JEV_POLICY.claudeModelGapTurns }, base)];
    expect(applyPolicy(base(), input({ currentModel: 'haiku' }), pick, later).model).toBe('opus');
    const codex = input({ provider: 'codex', currentModel: 'gpt-a', models: [{ id: 'gpt-a', about: 'a' }, { id: 'gpt-b', about: 'b' }] });
    expect(applyPolicy({ ...base(), provider: 'codex' }, codex, { model: { choice: 'gpt-b', confidence: 0.9 } }, [{ ...base(), model: 'gpt-a' }]).model).toBe('gpt-b');
  });

  it('never applies an unknown model or an effort the chosen model does not offer', () => {
    const d = applyPolicy(base(), input({ models: [{ id: 'opus', about: 'x', efforts: ['low', 'high'] }] }),
      { model: { choice: 'gpt-9', confidence: 0.99 }, effort: { choice: 'max', confidence: 0.99 } }, []);
    expect(d.model).toBeUndefined();
    expect(d.effort).toBeUndefined();
  });
});

function jevState(key = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'x056-jev-'));
  if (key) { mkdirSync(join(dir, 'secrets')); writeFileSync(join(dir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' })); }
  return dir;
}
const okFetch = (answers: object, input_tokens = 1_000_000) => (async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens, output_tokens: 20 } }), { status: 200 })) as unknown as typeof fetch;

describe('JevService', () => {
  it('meters each call and reports what is left of the synced balance', async () => {
    const s = new JevService(jevState(), okFetch({ effort: { type: 'choice', choice: 'low', confidence: 0.96 } }));
    s.syncBalance(10);
    const d = await s.decide('s-00000001', input());
    expect(d).toMatchObject({ effort: 'low', inputTokens: 1_000_000 });
    expect(s.status()).toMatchObject({ configured: true, balance: 10, spentSinceSync: 0.042, estimatedLeft: 9.958, callsSinceSync: 1 });
    expect(s.decisions('s-00000001')).toHaveLength(1);
    // A re-sync from the console resets the meter but keeps the lifetime total.
    expect(s.syncBalance(9.9)).toMatchObject({ estimatedLeft: 9.9, spentSinceSync: 0, totalSpent: 0.042 });
  });

  it('never throws and changes nothing when Jev fails, is slow, or there is no key', async () => {
    const http500 = new JevService(jevState(), (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch);
    expect(await http500.decide('s-00000001', input())).toMatchObject({ error: 'Jev answered HTTP 500' });
    const slow = new JevService(jevState(), ((_u: string, init: { signal: AbortSignal }) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch, 50);
    expect((await slow.decide('s-00000001', input())).error).toMatch(/did not answer within 50 ms/);
    const nokey = new JevService(jevState(false), okFetch({}));
    expect((await nokey.decide('s-00000001', input())).error).toMatch(/No Jev API key/);
    for (const d of [await http500.decide('s-00000002', input())]) { expect(d.model).toBeUndefined(); expect(d.effort).toBeUndefined(); }
  });
});

describe('SessionManager: exactly one decision maker per conversation', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'x056-dm-'));
    const stateDir = join(dir, 'state');
    mkdirSync(join(stateDir, 'secrets'), { recursive: true });
    writeFileSync(join(stateDir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' }));
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    return { mgr, calls, dir };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('advisor passes --advisor to the run; switching to jev removes it (one field)', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setDecisionMaker(p.id, sid, 'advisor');
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2);
    expect(calls[1].advisor).toBe('opus');
    await waitFor(() => !mgr.snapshot().running);
    const decide = vi.spyOn(mgr.jev(), 'decide').mockResolvedValue({ ...base(), sessionId: sid, model: 'haiku', effort: 'low', notes: ['model -> haiku'] });
    mgr.setDecisionMaker(p.id, sid, 'jev');
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(calls[2]).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(calls[2].advisor).toBeUndefined();
    expect(seen.some((e) => e.kind === 'jev_decision')).toBe(true);
    // Jev is told what the conversation is in the middle of, not just the message.
    expect(decide.mock.calls[0][1].context).toMatchObject({ project: 'P', origin: 'the user' });
    expect(decide.mock.calls[0][1].lean).toBeUndefined();
    // Sonnet saved with no effort: Jev is told what the CLI runs with.
    expect(decide.mock.calls[0][1]).toMatchObject({ currentModel: 'sonnet', baselineEffort: 'high' });
    // The user's own saved choice is untouched by Jev's per-turn pick.
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.model).toBe('sonnet');
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.decisionMaker).toBe('jev');
  });

  it('accepts the advisor on a ChatGPT conversation (gateway-built) and refuses anything but none|advisor|jev|decisions', () => {
    const { mgr, dir } = fixture();
    const p = mgr.createProject('C', dir, 'codex');
    const sid = mgr.start('hi', undefined, undefined, p.id);
    expect(() => mgr.setDecisionMaker(p.id, sid, 'advisor')).not.toThrow();
    expect(() => mgr.setDecisionMaker(p.id, sid, 'both' as never)).toThrow(/none, advisor, jev or decisions/);
    // OpenAI Decisions replaces Jev only once there is a key to call it with.
    expect(() => mgr.setDecisionMaker(p.id, sid, 'decisions')).toThrow(/No OpenAI API key/);
  });

  it('OpenAI Decisions picks the turn\'s model and effort in place of Jev', async () => {
    const { mgr, calls, dir } = fixture();
    const stateDir = join(dir, 'state');
    writeFileSync(join(stateDir, 'secrets', 'openai.json'), JSON.stringify({ apiKey: 'sk-test-000000000000' }));
    (mgr as unknown as { openaiDecisionsService: OpenAIDecisionsService }).openaiDecisionsService = new OpenAIDecisionsService(stateDir, mgr.jev(),
      (async () => new Response(JSON.stringify({ answers: { effort: { choice: 'low', confidence: 0.95 }, model: { choice: 'haiku', confidence: 0.99 } } }), { status: 200 })) as unknown as typeof fetch);
    const p = mgr.createProject('D', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setDecisionMaker(p.id, sid, 'decisions');
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'rename x to count', {});
    await waitFor(() => calls.length === 2);
    expect(calls[1]).toMatchObject({ model: 'haiku', effort: 'low' });
    const d = seen.find((e) => e.kind === 'jev_decision')?.data as { backend?: string } | undefined;
    expect(d?.backend).toBe('openai');
    expect(mgr.jev().decisions(sid).at(-1)?.backend).toBe('openai');
  });
});
