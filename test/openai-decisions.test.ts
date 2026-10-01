import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JevService, type JevDecisionInput } from '../server/jev.js';
import { teamCandidates } from '../server/decision-maker.js';
import { decisionsAnswers, decisionsRequest, OpenAIDecisionsService } from '../server/openai-decisions.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function state(key?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-decisions-')); dirs.push(dir);
  if (key) { mkdirSync(join(dir, 'secrets'), { recursive: true }); writeFileSync(join(dir, 'secrets', 'openai.json'), JSON.stringify({ apiKey: key })); }
  return dir;
}
const input: JevDecisionInput = {
  provider: 'codex', prompt: 'Fix the flaky login test', currentModel: 'gpt-6.1-sol', currentEffort: 'medium',
  models: [{ id: 'gpt-6.1-sol', about: 'workhorse', efforts: ['low', 'medium', 'high'] }, { id: 'gpt-6-luna', about: 'cheap', efforts: ['low', 'medium'] }],
  efforts: { low: 'Trivial.', medium: 'Ordinary.', high: 'Hard.' },
};
const reply = (status: number, body: unknown, seen?: { url?: string; init?: RequestInit }) =>
  (async (url: string, init?: RequestInit) => { if (seen) { seen.url = url; seen.init = init; } return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;

describe('OpenAI Decisions picks the agent team like Jev', () => {
  it('asks the same team questions and lands on the same team pick', async () => {
    const withTeam: JevDecisionInput = { ...input, lean: 'low', team: teamCandidates('codex', input.models) };
    const body = decisionsRequest(withTeam) as { questions: { id: string; instructions: string; options: { value: string }[] }[] };
    expect(body.questions.map((q) => q.id)).toEqual(['effort', 'model', 'subagent_model', 'subagent_effort']);
    expect(body.questions[3].options.map((o) => o.value)).toEqual(['low', 'medium', 'high']);
    expect(body.questions.every((q) => /COST EFFICIENCY/.test(q.instructions))).toBe(true);
    const answers = { effort: { choice: 'medium', confidence: 0.9 }, subagent_model: { choice: 'gpt-6-luna', confidence: 0.8 }, subagent_effort: { choice: 'low', confidence: 0.8 } };
    const dir = state('sk-test');
    mkdirSync(join(dir, 'secrets'), { recursive: true }); writeFileSync(join(dir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' }));
    const jev = new JevService(dir, reply(200, { answers, usage: { input_tokens: 5 } }));
    const openai = new OpenAIDecisionsService(dir, jev, reply(200, { answers: Object.entries(answers).map(([id, a]) => ({ id, ...a })), usage: { input_tokens: 5 } }));
    const a = await jev.decide('s-00000011', withTeam), b = await openai.decide('s-00000012', withTeam);
    expect(a.team).toEqual({ model: 'gpt-6-luna', effort: 'low', base: { model: 'gpt-6.1-sol', effort: 'medium' }, pickedModel: 'gpt-6-luna', pickedEffort: 'low', modelConfidence: 0.8, effortConfidence: 0.8 });
    expect(b.team).toEqual(a.team);
    expect(b.backend).toBe('openai');
  });
});

describe('OpenAI Decisions request and reply mapping', () => {
  it('asks the effort question always and the model question when there is a choice', () => {
    const body = decisionsRequest(input) as { input: { text: string }[]; questions: { id: string; options: { value: string }[] }[] };
    expect(body.questions.map((q) => q.id)).toEqual(['effort', 'model']);
    expect(body.questions[1].options.map((o) => o.value)).toEqual(['gpt-6.1-sol', 'gpt-6-luna']);
    expect(body.input[0].text).toContain('new_message: Fix the flaky login test');
    expect(decisionsRequest({ ...input, models: [input.models[0]] }).questions).toHaveLength(1);
  });

  it('reads answers keyed by id or listed, with confidence from any of the usual names', () => {
    expect(decisionsAnswers({ answers: { effort: { choice: 'high', confidence: 0.9 } } })).toEqual({ effort: { choice: 'high', confidence: 0.9 } });
    expect(decisionsAnswers({ decisions: [{ question: 'effort', answer: { value: 'low' }, probability: 0.7 }] })).toEqual({ effort: { choice: 'low', confidence: 0.7 } });
    expect(decisionsAnswers({ output: [{ id: 'model', value: 'gpt-6-luna', options: [{ value: 'gpt-6-luna', probability: 0.85 }, { value: 'gpt-6.1-sol', probability: 0.15 }] }] }))
      .toEqual({ model: { choice: 'gpt-6-luna', confidence: 0.85, probabilities: { 'gpt-6-luna': 0.85, 'gpt-6.1-sol': 0.15 } } });
    expect(decisionsAnswers({ something: 'else' })).toEqual({});
  });
});

describe('OpenAIDecisionsService', () => {
  it('is off without a key, and says so without calling out', async () => {
    const dir = state();
    let called = false;
    const svc = new OpenAIDecisionsService(dir, new JevService(dir), (async () => { called = true; return new Response('{}'); }) as unknown as typeof fetch);
    expect(svc.configured()).toBe(false);
    const d = await svc.decide('sess-00000001', input);
    expect(d).toMatchObject({ backend: 'openai', error: 'No OpenAI API key configured' });
    expect(called).toBe(false);
  });

  it('applies the shared policy and writes into the store Jev reads', async () => {
    const dir = state('sk-test-000000000000');
    const store = new JevService(dir), seen: { url?: string; init?: RequestInit } = {};
    const svc = new OpenAIDecisionsService(dir, store, reply(200, { answers: [{ id: 'effort', choice: 'high', confidence: 0.92 }, { id: 'model', choice: 'gpt-6-luna', confidence: 0.4 }], usage: { input_tokens: 120, output_tokens: 3 } }, seen));
    const d = await svc.decide('sess-00000002', input);
    expect(seen.url).toBe('https://api.openai.com/v1/decisions');
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-000000000000');
    expect(d).toMatchObject({ backend: 'openai', effort: 'high', pickedModel: 'gpt-6-luna', inputTokens: 120 });
    expect(d.model).toBeUndefined(); // 40% is under the model threshold
    expect(store.decisions('sess-00000002')).toHaveLength(1);
    expect(svc.status()).toMatchObject({ configured: true, calls: 1, failures: 0, inputTokens: 120 });
  });

  it('keeps OpenAI\'s error message, which is how a wrong request shape shows up', async () => {
    const dir = state('sk-test-000000000000');
    const svc = new OpenAIDecisionsService(dir, new JevService(dir), reply(400, { error: { message: "Unknown parameter: 'questions'." } }));
    const d = await svc.decide('sess-00000003', input);
    expect(d.error).toBe("OpenAI Decisions answered HTTP 400: Unknown parameter: 'questions'.");
    expect(d.model).toBeUndefined(); expect(d.effort).toBeUndefined();
    expect(svc.status().lastError?.message).toBe(d.error);
  });

  it('a reply it cannot read changes nothing', async () => {
    const dir = state('sk-test-000000000000');
    const d = await new OpenAIDecisionsService(dir, new JevService(dir), reply(200, { id: 'dec_1', result: 42 })).decide('sess-00000004', input);
    expect(d.error).toMatch(/shape the gateway cannot read/);
    expect(d.effort).toBeUndefined();
  });

  it('probe returns the raw reply without recording a decision', async () => {
    const dir = state('sk-test-000000000000');
    const store = new JevService(dir);
    const r = await new OpenAIDecisionsService(dir, store, reply(200, { answers: { effort: 'low' }, echo: 'sk-proj-abcdefghijklmnop' })).probe();
    expect(r).toMatchObject({ status: 200, answers: { effort: { choice: 'low' } }, body: { echo: '[redacted]' } });
  });
});
