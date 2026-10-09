import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { ClaudeTransport } from '../src/persistent-transport.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { JevService, JEV_POLICY, EFFORT_QUESTION, LEAN_BARS, applyPolicy, leanBars, applySubagentPolicy, decisionState, effortQuestion, modelQuestion, subagentEffortQuestion, subagentModelQuestion, type JevDecision, type JevDecisionInput } from '../server/jev.js';
import { decisionsRequest } from '../server/openai-decisions.js';
import { CLAUDE_DEFAULT_EFFORT, advisorFor, jevCandidates, teamCandidates } from '../server/decision-maker.js';
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
  // Codex model confidence ran at a median 0.42 (10 of 258 picks moved the
  // model): only its RAISE bar is lower, by 0.1 at every lean.
  it('Codex: a lower bar to raise the model, the same bars to lower it; Claude unchanged', () => {
    const models = [{ id: 'gpt-6-luna', about: 'l' }, { id: 'gpt-5.6-terra', about: 't' }, { id: 'gpt-6-sol', about: 's' }, { id: 'gpt-6-astra', about: 'a' }];
    const cx = (lean?: 'low' | 'high') => input({ provider: 'codex', currentModel: 'gpt-6-sol', currentEffort: 'medium', models, ...(lean ? { lean } : {}) });
    const pick = (choice: string, confidence: number, lean?: 'low' | 'high') => applyPolicy({ ...base(), provider: 'codex' }, cx(lean), { model: { choice, confidence } }, []);
    expect(leanBars('medium', 'codex').modelUp).toBe(0.5);
    expect(leanBars('low', 'codex').modelUp).toBe(0.65);
    expect(leanBars('high', 'codex').modelUp).toBe(0.4);
    for (const l of ['low', 'medium', 'high'] as const) {
      expect(leanBars(l, 'codex')).toMatchObject({ modelDown: LEAN_BARS[l].modelDown, effortUp: LEAN_BARS[l].effortUp, effortDown: LEAN_BARS[l].effortDown });
      expect(leanBars(l, 'claude')).toEqual(LEAN_BARS[l]);
    }
    expect(pick('gpt-6-astra', 0.52).model).toBe('gpt-6-astra');
    expect(pick('gpt-6-astra', 0.48).notes.join()).toMatch(/needs 50%/);
    expect(pick('gpt-6-astra', 0.62, 'low').model).toBeUndefined();
    expect(pick('gpt-6-astra', 0.42, 'high').model).toBe('gpt-6-astra');
    // Down: still 65% at medium.
    expect(pick('gpt-6-luna', 0.6).model).toBeUndefined();
    expect(pick('gpt-6-luna', 0.66).model).toBe('gpt-6-luna');
    // Claude: opus over sonnet still needs 60%.
    expect(applyPolicy(base(), input({ currentModel: 'sonnet' }), { model: { choice: 'opus', confidence: 0.55 } }, []).model).toBeUndefined();
  });

  it('applies a confident effort, and a model only above the higher bar', () => {
    const cur = input({ currentModel: 'sonnet' });
    const d = applyPolicy(base(), cur, { effort: { choice: 'low', confidence: 0.9 }, model: { choice: 'opus', confidence: 0.95 } }, []);
    expect(d).toMatchObject({ effort: 'low', model: 'opus', pickedModel: 'opus', pickedEffort: 'low' });
    const unsure = applyPolicy(base(), cur, { effort: { choice: 'low', confidence: 0.5 }, model: { choice: 'opus', confidence: 0.55 } }, []);
    expect(unsure.effort).toBeUndefined();
    expect(unsure.model).toBeUndefined();
    expect(unsure.notes.join(' ')).toMatch(/only 55% sure/);
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
    const down = applyPolicy(base(), input({ currentModel: 'opus', currentEffort: 'high' }), { effort: { choice: 'medium', confidence: 0.6 }, model: { choice: 'sonnet', confidence: 0.62 } }, []);
    expect(down.effort).toBeUndefined();
    expect(down.model).toBeUndefined();
    expect(down.notes).toEqual(['model sonnet is below opus at only 62% (needs 65% to go lower); kept', 'effort medium is below high at only 60% (needs 65% to go lower); kept']);
    const up = applyPolicy(base(), input({ currentModel: 'sonnet', currentEffort: 'high' }), { effort: { choice: 'xhigh', confidence: 0.6 }, model: { choice: 'opus', confidence: 0.62 } }, []);
    expect(up).toMatchObject({ effort: 'xhigh', model: 'opus' });
  });

  // The slider: low errs toward cheaper, high toward stronger. Only the bars
  // for moving up or down change; medium is the policy above, unchanged.
  it('leans low: cheaper is easier to reach, stronger harder', () => {
    const cur = input({ currentModel: 'sonnet', currentEffort: 'high', lean: 'low' });
    const up = applyPolicy(base(), cur, { effort: { choice: 'xhigh', confidence: 0.6 }, model: { choice: 'opus', confidence: 0.7 } }, []);
    expect(up).toMatchObject({ lean: 'low' });
    expect(up.effort).toBeUndefined(); expect(up.model).toBeUndefined();
    expect(up.notes).toEqual(['model opus only 70% sure (needs 75%, leaning low); kept', 'effort xhigh only 60% sure (needs 65% to go higher, leaning low); kept']);
    const down = applyPolicy(base(), input({ currentModel: 'opus', currentEffort: 'high', lean: 'low' }), { effort: { choice: 'medium', confidence: 0.5 }, model: { choice: 'sonnet', confidence: 0.58 } }, []);
    expect(down).toMatchObject({ effort: 'medium', model: 'sonnet' });
  });

  it('leans high: stronger is easier to reach, cheaper harder', () => {
    const cur = input({ currentModel: 'sonnet', currentEffort: 'high', lean: 'high' });
    expect(applyPolicy(base(), cur, { effort: { choice: 'xhigh', confidence: 0.47 }, model: { choice: 'opus', confidence: 0.52 } }, [])).toMatchObject({ effort: 'xhigh', model: 'opus', lean: 'high' });
    const down = applyPolicy(base(), input({ currentModel: 'opus', currentEffort: 'high', lean: 'high' }), { effort: { choice: 'medium', confidence: 0.72 }, model: { choice: 'sonnet', confidence: 0.78 } }, []);
    expect(down.effort).toBeUndefined(); expect(down.model).toBeUndefined();
    expect(down.notes).toEqual(['model sonnet is below opus at only 78% (needs 80% to go lower, leaning high); kept', 'effort medium is below high at only 72% (needs 75% to go lower, leaning high); kept']);
    // A move the ranks cannot place (Fable) keeps the plain 60% bar.
    expect(applyPolicy(base(), input({ currentModel: 'fable', lean: 'high' }), { model: { choice: 'opus', confidence: 0.55 } }, []).model).toBeUndefined();
  });

  // No effort saved and not on Auto: the CLI runs its own default (Opus 5.5:
  // medium). Measured from nothing, every pick was a raise, and Low needed the
  // raise bar even to pick `low`.
  it('without a saved effort, measures up and down from the CLI default', () => {
    const auto = (lean: 'low' | 'high') => input({ currentModel: 'opus', currentEffort: undefined, baselineEffort: 'medium', lean });
    expect(applyPolicy(base(), auto('low'), { effort: { choice: 'low', confidence: 0.5 } }, []).effort).toBe('low');
    const highUp = applyPolicy(base(), auto('low'), { effort: { choice: 'high', confidence: 0.6 } }, []);
    expect(highUp.effort).toBeUndefined();
    expect(highUp.notes).toEqual(['effort high only 60% sure (needs 65% to go higher, leaning low); kept']);
    const lowDown = applyPolicy(base(), auto('high'), { effort: { choice: 'low', confidence: 0.72 } }, []);
    expect(lowDown.notes).toEqual(['effort low is below medium (the default) at only 72% (needs 75% to go lower, leaning high); kept']);
    expect(applyPolicy(base(), auto('high'), { effort: { choice: 'medium', confidence: 0.9 } }, []).notes).toEqual(['effort unchanged (medium is the default)']);
  });

  it('medium is the plain policy, with no lean recorded', () => {
    const d = applyPolicy(base(), input({ currentModel: 'sonnet', currentEffort: 'high', lean: 'medium' }), { effort: { choice: 'medium', confidence: 0.6 } }, []);
    expect(d.lean).toBeUndefined();
    expect(d.notes).toEqual(['effort medium is below high at only 60% (needs 65% to go lower); kept']);
  });

  // The bars are on Jev's confidence scale, which runs ~0.15 under its top
  // probability. Over the first 24 live picks the model confidence never
  // passed 0.70, so the old 0.8 / 0.9 bars let no model move at all.
  it('lets a typical confident pick through on a saved choice', () => {
    const d = applyPolicy(base(), input({ currentModel: 'opus', currentEffort: 'xhigh' }), { model: { choice: 'sonnet', confidence: 0.68 }, effort: { choice: 'high', confidence: 0.7 } }, []);
    expect(d).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  // Auto model / Auto effort with a picker on: "fully up to Jev".
  it('on Auto, the pick decides whatever its confidence', () => {
    const d = applyPolicy(base(), input({ currentModel: 'sonnet', currentEffort: undefined, auto: { model: true, effort: true } }), { model: { choice: 'opus', confidence: 0.3 }, effort: { choice: 'xhigh', confidence: 0.2 } }, []);
    expect(d).toMatchObject({ model: 'opus', effort: 'xhigh', auto: { model: true, effort: true } });
    expect(d.notes).toEqual(['model -> opus (auto)', 'effort -> xhigh (auto)']);
    // The baseline itself is named, so the row says what the turn ran on.
    expect(applyPolicy(base(), input({ currentModel: 'sonnet', auto: { model: true } }), { model: { choice: 'sonnet', confidence: 0.2 } }, []).model).toBe('sonnet');
    // An unknown model keeps the baseline; an effort the model lacks leaves its default.
    const odd = applyPolicy(base(), input({ currentModel: 'sonnet', currentEffort: undefined, auto: { model: true, effort: true }, models: [{ id: 'sonnet', about: 's', efforts: ['low', 'high'] }] }),
      { model: { choice: 'gpt-9', confidence: 0.9 }, effort: { choice: 'max', confidence: 0.9 } }, []);
    expect(odd.model).toBe('sonnet'); expect(odd.effort).toBeUndefined();
    // Auto on one side only: the other still meets its bar.
    const half = applyPolicy(base(), input({ currentModel: 'opus', currentEffort: 'high', auto: { model: true } }), { model: { choice: 'sonnet', confidence: 0.3 }, effort: { choice: 'low', confidence: 0.3 } }, []);
    expect(half).toMatchObject({ model: 'sonnet' }); expect(half.effort).toBeUndefined();
  });

  it('on Auto, a Claude model switch still waits the gap; Codex does not', () => {
    const history: JevDecision[] = [{ ...base(), baseModel: 'sonnet', model: 'opus', auto: { model: true } }];
    const d = applyPolicy(base(), input({ currentModel: 'opus', auto: { model: true } }), { model: { choice: 'sonnet', confidence: 0.9 } }, history);
    expect(d.model).toBe('opus');
    expect(d.notes[0]).toMatch(/switched 0 turn\(s\) ago/);
    const codex = input({ provider: 'codex', currentModel: 'gpt-a', auto: { model: true }, models: [{ id: 'gpt-a', about: 'a' }, { id: 'gpt-b', about: 'b' }] });
    expect(applyPolicy({ ...base(), provider: 'codex' }, codex, { model: { choice: 'gpt-b', confidence: 0.2 } }, [{ ...base(), baseModel: 'gpt-b', model: 'gpt-a' }]).model).toBe('gpt-b');
  });

  // Going back to the saved model respawns the process just the same.
  it('counts a return to the saved model as a switch', () => {
    const history: JevDecision[] = [{ ...base(), baseModel: 'opus', model: 'sonnet' }, { ...base(), baseModel: 'opus' }];
    const d = applyPolicy(base(), input({ currentModel: 'opus' }), { model: { choice: 'sonnet', confidence: 0.95 } }, history);
    expect(d.model).toBeUndefined();
    expect(d.notes[0]).toMatch(/switched 0 turn\(s\) ago/);
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
    // Saved on Fable by hand, so a pick of opus is neither the saved model nor
    // a stay: a switch, which the gap governs.
    // The last decision re-entered sonnet after two turns on Fable: a switch.
    const gap = applyPolicy(base(), input({ currentModel: 'fable', previousModel: 'sonnet' }), { model: { choice: 'opus', confidence: 0.95 } }, history);
    expect(gap.model).toBeUndefined();
    expect(gap.notes[0]).toMatch(/switched 0 turn\(s\) ago/);
    const stays: JevDecision[] = [{ ...base(), model: 'sonnet' }, { ...base(), model: 'sonnet' }, { ...base(), model: 'sonnet' }, { ...base(), model: 'sonnet' }];
    // Four turns on sonnet, switched only at the first: the gap has passed.
    expect(applyPolicy(base(), input({ currentModel: 'fable', previousModel: 'sonnet' }), { model: { choice: 'opus', confidence: 0.95 } }, stays).model).toBe('opus');
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

  it('knows Haiku 5.5 takes effort and defaults to medium', () => {
    expect(CLAUDE_DEFAULT_EFFORT.haiku).toBe('medium');
    expect(CLAUDE_DEFAULT_EFFORT['claude-haiku-5-5']).toBe('medium');
  });

  // Owner, 2026-10-09: Haiku 5.5 has a 1M context, so Jev may pick it again.
  it('offers Haiku on Claude; a confident pick is applied, a weak one keeps the base', async () => {
    expect(jevCandidates('claude', []).models.map((m) => m.id)).toContain('haiku');
    const sure = applyPolicy(base(), input({ currentModel: 'opus' }), { model: { choice: 'haiku', confidence: 0.9 } }, []);
    expect(sure.model).toBe('haiku');
    const weak = applyPolicy(base(), input({ currentModel: 'opus' }), { model: { choice: 'haiku', confidence: 0.5 } }, []);
    expect(weak.model).toBeUndefined();
    expect(weak.pickedModel).toBe('haiku');
    // Both backends' requests list it.
    const bodies: { questions: Record<string, { criteria: Record<string, string> }> }[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ answers: {} }), { status: 200 }); }) as unknown as typeof fetch;
    await new JevService(jevState(), fetchFn).decide('s-0000000a', input());
    expect(Object.keys(bodies[0].questions.model.criteria)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    const openai = decisionsRequest(input()) as { questions: { id: string; options: { value: string }[] }[] };
    expect(openai.questions.find((q) => q.id === 'model')!.options.map((o) => o.value)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
  });

  it('never applies an unknown model or an effort the chosen model does not offer', () => {
    const d = applyPolicy(base(), input({ models: [{ id: 'opus', about: 'x', efforts: ['low', 'high'] }] }),
      { model: { choice: 'gpt-9', confidence: 0.99 }, effort: { choice: 'max', confidence: 0.99 } }, []);
    expect(d.model).toBeUndefined();
    expect(d.effort).toBeUndefined();
  });
});

describe('Jev policy: the agent team\'s subagents', () => {
  const claudeTeam = (over: Partial<JevDecisionInput> = {}) => { const c = jevCandidates('claude', []); return input({ ...over, team: teamCandidates('claude', c.models) }); };
  const codexModels = [
    { id: 'gpt-6-astra', about: 'strongest', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-6-luna', about: 'cheap', efforts: ['low', 'medium'] },
  ];
  const codexTeam = (over: Partial<JevDecisionInput> = {}) => input({ provider: 'codex', currentModel: 'gpt-6-astra', currentEffort: 'medium', models: codexModels, efforts: { low: 'l', medium: 'm', high: 'h', xhigh: 'x' }, team: teamCandidates('codex', codexModels), ...over });

  it('offers Codex only the luna/terra/sol/astra families, never a legacy slug', () => {
    const slugs = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra', 'gpt-5.5'].map((slug) => ({ slug, label: slug, efforts: ['low', 'medium'] }));
    expect(jevCandidates('codex', slugs as never).models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-terra']);
  });
  it('Claude: Opus at medium is the base; candidates low/medium/high and the main model list', () => {
    const t = teamCandidates('claude', jevCandidates('claude', []).models);
    expect(t).toMatchObject({ baseModel: 'opus', baseEffort: 'medium' });
    expect(Object.keys(t.efforts)).toEqual(['low', 'medium', 'high']);
    expect(t.models.map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus', 'fable']);
    // Codex: up to xhigh, and the base model follows the main session.
    const c = teamCandidates('codex', codexModels);
    expect(Object.keys(c.efforts)).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(c.baseModel).toBeUndefined();
  });

  it('applies the lean bars up and down, per lean', () => {
    for (const lean of ['low', 'medium', 'high'] as const) {
      const bars = LEAN_BARS[lean];
      const up = (conf: number) => applyPolicy(base(), claudeTeam({ lean }), { subagent_effort: { choice: 'high', confidence: conf } }, []).team!;
      expect(up(bars.effortUp).effort).toBe('high');
      expect(up(bars.effortUp - 0.01).effort).toBe('medium');
      const down = (conf: number) => applyPolicy(base(), claudeTeam({ lean }), { subagent_model: { choice: 'sonnet', confidence: conf } }, []).team!;
      expect(down(bars.modelDown).model).toBe('sonnet');
      expect(down(bars.modelDown - 0.01).model).toBe('opus');
    }
    const kept = applyPolicy(base(), claudeTeam({ lean: 'low' }), { subagent_model: { choice: 'sonnet', confidence: 0.5 } }, []);
    expect(kept.notes).toContain('team model sonnet only 50% sure (needs 55% to go lower, leaning low); kept');
    const raised = applyPolicy(base(), claudeTeam(), { subagent_effort: { choice: 'high', confidence: 0.7 } }, []);
    expect(raised.notes).toContain('team effort -> high');
    expect(raised.team).toMatchObject({ model: 'opus', effort: 'high', base: { model: 'opus', effort: 'medium' }, pickedEffort: 'high', effortConfidence: 0.7 });
  });

  it('falls back to the base on a missing, off-list or weak pick', () => {
    expect(applyPolicy(base(), claudeTeam(), {}, []).team).toEqual({ model: 'opus', effort: 'medium', base: { model: 'opus', effort: 'medium' } });
    const off = applyPolicy(base(), claudeTeam(), { subagent_model: { choice: 'gpt-9', confidence: 0.99 }, subagent_effort: { choice: 'max', confidence: 0.99 } }, []);
    expect(off.team).toMatchObject({ model: 'opus', effort: 'medium', pickedModel: 'gpt-9', pickedEffort: 'max' });
    expect(off.notes).toEqual(expect.arrayContaining(['team model gpt-9 is not a candidate; kept', 'team effort max is not a candidate; kept']));
    const weak = applyPolicy(base(), claudeTeam(), { subagent_effort: { choice: 'low', confidence: 0.3 } }, []);
    expect(weak.team!.effort).toBe('medium');
    // No team input: no team on the row.
    expect(applyPolicy(base(), input(), { subagent_effort: { choice: 'low', confidence: 0.99 } }, []).team).toBeUndefined();
  });

  it('Codex: the base model is the one the main session runs on, and effort is filtered by the chosen model', () => {
    // The main pick moved to luna; the team's base follows it.
    const d = applyPolicy(base(), codexTeam({ auto: { model: true } }), { model: { choice: 'gpt-6-luna', confidence: 0.9 } }, []);
    expect(d.team!.base.model).toBe('gpt-6-luna');
    const moved = applyPolicy(base(), codexTeam(), { subagent_model: { choice: 'gpt-6-luna', confidence: 0.9 }, subagent_effort: { choice: 'xhigh', confidence: 0.9 } }, []);
    expect(moved.team).toMatchObject({ model: 'gpt-6-luna', effort: 'medium', base: { model: 'gpt-6-astra' } });
    expect(moved.notes).toContain('team effort xhigh not offered by gpt-6-luna; kept');
    const ok = applyPolicy(base(), codexTeam(), { subagent_effort: { choice: 'xhigh', confidence: 0.9 } }, []);
    expect(ok.team).toMatchObject({ model: 'gpt-6-astra', effort: 'xhigh' });
  });

  it('has no Claude switching gap: nothing respawns', () => {
    const history: JevDecision[] = [{ ...base(), baseModel: 'opus', model: 'sonnet' }];
    const d = applyPolicy(base(), claudeTeam(), { subagent_model: { choice: 'sonnet', confidence: 0.95 }, model: { choice: 'sonnet', confidence: 0.95 } }, history);
    expect(d.model).toBeUndefined(); // the main switch waits the gap
    expect(d.team!.model).toBe('sonnet');
    // Right after a main switch the team still moves: applySubagentPolicy takes no history at all.
    expect(applySubagentPolicy(base(), claudeTeam({ currentModel: 'sonnet' }), { subagent_model: { choice: 'sonnet', confidence: 0.95 } }).team!.model).toBe('sonnet');
  });

  it('asks both team questions in the same Jev call, written per lean', async () => {
    expect(subagentEffortQuestion('low')).toMatch(/COST EFFICIENCY/);
    expect(subagentModelQuestion('high')).toMatch(/BEST RESULT/);
    expect(subagentEffortQuestion('medium')).not.toMatch(/COST EFFICIENCY|BEST RESULT/);
    const bodies: { questions: Record<string, { instructions: string; criteria: Record<string, string> }> }[] = [];
    const fetchFn = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(JSON.stringify({ answers: { effort: { choice: 'high', confidence: 0.9 }, subagent_model: { choice: 'sonnet', confidence: 0.9 }, subagent_effort: { choice: 'high', confidence: 0.9 } }, usage: { input_tokens: 10 } }), { status: 200 }); }) as unknown as typeof fetch;
    const d = await new JevService(jevState(), fetchFn).decide('s-00000009', claudeTeam({ lean: 'high' }));
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0].questions)).toEqual(['effort', 'model', 'subagent_model', 'subagent_effort']);
    expect(bodies[0].questions.subagent_effort.instructions).toBe(subagentEffortQuestion('high'));
    expect(d.team).toMatchObject({ model: 'sonnet', effort: 'high' });
    // One candidate model: no model question.
    const one = decisionsRequest({ ...claudeTeam(), team: { ...teamCandidates('claude', [{ id: 'opus', about: 'x' }]) } }) as { questions: { id: string }[] };
    expect(one.questions.map((q) => q.id)).toEqual(['effort', 'model', 'subagent_effort']);
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
    // The key makes Jev the DEFAULT picker; keep that off the network.
    (mgr as unknown as { jevService: JevService }).jevService = new JevService(stateDir, (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch);
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
    const decide = vi.spyOn(mgr.jev(), 'decide').mockResolvedValue({ ...base(), sessionId: sid, model: 'opus', effort: 'low', notes: ['model -> opus'] });
    mgr.setDecisionMaker(p.id, sid, 'jev');
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(calls[2]).toMatchObject({ model: 'opus', effort: 'low' });
    expect(calls[2].advisor).toBeUndefined();
    expect(seen.some((e) => e.kind === 'jev_decision')).toBe(true);
    // Jev is told what the conversation is in the middle of, not just the message.
    expect(decide.mock.calls[0][1].context).toMatchObject({ project: 'P', origin: 'the user' });
    expect(decide.mock.calls[0][1].lean).toBeUndefined();
    // Sonnet saved with no effort: Jev is told what the CLI runs with.
    expect(decide.mock.calls[0][1]).toMatchObject({ currentModel: 'sonnet', baselineEffort: 'medium', auto: { model: false, effort: true } });
    // The user's own saved choice is untouched by Jev's per-turn pick.
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.model).toBe('sonnet');
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.decisionMaker).toBe('jev');
  });

  it('Auto model with a picker on: Jev decides, the house default is the fallback', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('A', dir);
    const sid = mgr.start('first', undefined, { model: '', effort: '' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setDecisionMaker(p.id, sid, 'jev');
    // Jev unreachable: the turn runs on the house default, not the CLI's own.
    const decide = vi.spyOn(mgr.jev(), 'decide').mockImplementation(async (s, i) => ({ ...base(), sessionId: s, baseModel: i.currentModel, auto: i.auto, error: 'Jev unreachable' }));
    mgr.continueSession(p.id, sid, 'second', { model: '', effort: '' });
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(decide.mock.calls[0][1]).toMatchObject({ currentModel: 'sonnet', auto: { model: true, effort: true } });
    expect(calls[1].model).toBe('sonnet');
    expect(calls[1].effort).toBeUndefined();
    // A pick at any confidence is the turn's model; the next turn starts from it.
    decide.mockRestore();
    const jev = new JevService(join(dir, 'state'), (async () => new Response(JSON.stringify({ answers: { model: { choice: 'opus', confidence: 0.31 }, effort: { choice: 'xhigh', confidence: 0.28 } } }), { status: 200 })) as unknown as typeof fetch);
    (mgr as unknown as { jevService: JevService }).jevService = jev;
    const spy = vi.spyOn(jev, 'decide');
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    expect(calls[2]).toMatchObject({ model: 'opus', effort: 'xhigh' });
    mgr.continueSession(p.id, sid, 'fourth', {});
    await waitFor(() => calls.length === 4);
    expect(spy.mock.calls[1][1].currentModel).toBe('opus');
    // The conversation stays on Auto.
    const conv = mgr.listConversations(p.id).find((c) => c.sessionId === sid);
    expect(conv?.model || '').toBe(''); expect(conv?.effort || '').toBe('');
  });

  it('Auto on ChatGPT: the Codex house default is the fallback, and a pick decides', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('X', dir, 'codex');
    const sid = mgr.start('first', undefined, { model: '', effort: '' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setDecisionMaker(p.id, sid, 'jev');
    const decide = vi.spyOn(mgr.jev(), 'decide').mockImplementation(async (s, i) => ({ ...base(), provider: 'codex', sessionId: s, baseModel: i.currentModel, auto: i.auto, error: 'Jev unreachable' }));
    mgr.continueSession(p.id, sid, 'second', { model: '', effort: '' });
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(decide.mock.calls[0][1]).toMatchObject({ provider: 'codex', currentModel: 'gpt-5.6-terra', auto: { model: true, effort: true } });
    expect(calls[1].model).toBe('gpt-5.6-terra');
    decide.mockImplementation(async (s, i) => ({ ...base(), provider: 'codex', sessionId: s, baseModel: i.currentModel, auto: i.auto, model: 'gpt-6-astra', effort: 'max', notes: ['model -> gpt-6-astra (auto)'] }));
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    expect(calls[2]).toMatchObject({ model: 'gpt-6-astra', effort: 'max' });
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.model || '').toBe('');
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
      (async () => new Response(JSON.stringify({ answers: { effort: { choice: 'low', confidence: 0.95 }, model: { choice: 'opus', confidence: 0.99 } } }), { status: 200 })) as unknown as typeof fetch);
    const p = mgr.createProject('D', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setDecisionMaker(p.id, sid, 'decisions');
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'rename x to count', {});
    await waitFor(() => calls.length === 2);
    expect(calls[1]).toMatchObject({ model: 'opus', effort: 'low' });
    // The first turn ran the Jev default (the key is set); this turn's pick is the last.
    const d = seen.filter((e) => e.kind === 'jev_decision').at(-1)?.data as { backend?: string } | undefined;
    expect(d?.backend).toBe('openai');
    expect(mgr.jev().decisions(sid).at(-1)?.backend).toBe('openai');
  });
});
