import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState, writeState } from './workspace-store.js';

/**
 * Jev (TypeSafe AI's "System One" decision model) as a per-turn model/effort
 * picker. One HTTPS call before a turn, two Choice questions, ~0.3 s.
 *
 * It picks, it does not run anything: the gateway applies the pick to that one
 * turn and never writes it over the user's saved model/effort, which stay the
 * fallback whenever Jev is unsure, slow, or unreachable.
 *
 * Credits: TypeSafe has no balance API (every balance-style path 404s, with and
 * without a key, and the console is Cloudflare-blocked for server traffic). So
 * the gateway meters each call itself from the `usage` the API returns, and
 * "left" is the balance the owner last read off the console minus what was
 * metered since. Price: $0.042 per 1M input tokens, output free (docs, Models).
 */

export const JEV_USD_PER_MTOK_INPUT = 0.042;
const API = 'https://api.typesafe.ai/v1/systemone';

export interface JevCandidate { id: string; about: string; efforts?: string[] }
export interface JevDecisionInput {
  provider: 'claude' | 'codex';
  prompt: string;
  title?: string;
  /** What THIS turn runs with unless a pick is applied: the conversation's
   *  saved choice. A pick lasts one turn, so this -- not the last pick -- is
   *  what "unchanged" means. */
  currentModel?: string;
  currentEffort?: string;
  /** The model the previous turn ran on, when a pick moved it off
   *  `currentModel`. Staying there is not a switch. */
  previousModel?: string;
  /** Low = err toward cheaper, high = err toward stronger; absent = medium. */
  lean?: Lean;
  /** What the conversation is in the middle of, built in code (never by a
   *  model): a short "yes, deploy" or an autopilot "continue" carries the
   *  weight of the task it continues, which the message alone does not show. */
  context?: DecisionContext;
  models: JevCandidate[];
  efforts: Record<string, string>;
}
export interface JevDecision {
  at: string;
  sessionId: string;
  provider: 'claude' | 'codex';
  /** Who decided: Jev, or OpenAI's Decisions API. Absent on rows written
   *  before there was a choice, which were all Jev. */
  backend?: 'jev' | 'openai';
  /** What the turn actually runs with (after policy). Undefined = unchanged. */
  model?: string;
  effort?: string;
  /** Jev's raw picks and confidence, whether or not they were applied. */
  pickedModel?: string;
  pickedEffort?: string;
  modelConfidence?: number;
  effortConfidence?: number;
  modelProbabilities?: Record<string, number>;
  effortProbabilities?: Record<string, number>;
  /** Why a pick was or was not applied. */
  notes: string[];
  /** The lean the pick was made under, when not medium. */
  lean?: 'low' | 'high';
  /** The turn's own model/effort before any pick (what it runs with when
   *  `model`/`effort` are absent). */
  baseModel?: string;
  baseEffort?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  error?: string;
}
interface Ledger {
  balance?: { amount: number; syncedAt: string };
  since: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
  total: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
}
const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

/** Thresholds for applying a pick. A Claude model switch respawns the process
 *  and drops the prompt cache, so it needs more confidence and a gap. */
export const JEV_POLICY = {
  effortMin: 0.6, modelMin: 0.8, claudeModelGapTurns: 3, forkSharp: 0.75,
  // Lowering costs quality and a human round trip when wrong; raising costs
  // tokens. So a pick BELOW the turn's own choice needs more confidence.
  effortDownMin: 0.8, modelDownMin: 0.9,
};

/**
 * The user's lean (the slider next to the picker): which way to err when the
 * picker is unsure. Only the bars for moving UP or DOWN change; medium is
 * exactly JEV_POLICY. A model move between unranked models (Fable, an unknown
 * Codex slug) keeps JEV_POLICY.modelMin whatever the lean, and the "model
 * stays" rule and the Claude switching gap are never relaxed by it.
 */
export type Lean = 'low' | 'medium' | 'high';
export const LEAN_BARS: Record<Lean, { effortUp: number; effortDown: number; modelUp: number; modelDown: number }> = {
  low: { effortUp: 0.8, effortDown: 0.6, modelUp: 0.9, modelDown: 0.8 },
  medium: { effortUp: JEV_POLICY.effortMin, effortDown: JEV_POLICY.effortDownMin, modelUp: JEV_POLICY.modelMin, modelDown: JEV_POLICY.modelDownMin },
  high: { effortUp: 0.6, effortDown: 0.9, modelUp: 0.7, modelDown: 0.95 },
};
const LEAN_WORD: Record<Lean, string> = { low: 'leaning low', medium: '', high: 'leaning high' };

/** One small fork the agent team hands off (`quick_decision`): which file,
 *  which tool or subagent, retry or stop. SHARP = confident enough to follow;
 *  SPLIT = close call, the main model decides. */
export interface ForkInput { question: string; options: string[]; context?: string }
export interface ForkDecision {
  at: string;
  sessionId: string;
  backend: 'jev' | 'openai';
  question: string;
  options: string[];
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  verdict?: 'sharp' | 'split';
  latencyMs: number;
  inputTokens?: number;
  costUsd?: number;
  error?: string;
}

/** Validate what an agent sent; throws a message the agent can act on. */
export function checkFork(input: ForkInput): ForkInput {
  const question = String(input?.question ?? '').trim();
  const options = [...new Set((Array.isArray(input?.options) ? input.options : []).map((o) => String(o).trim()).filter(Boolean))];
  if (!question) throw new Error('question is required');
  if (question.length > 500) throw new Error('question is too long (500 characters max): a fork is a small question');
  if (options.length < 2 || options.length > 6) throw new Error('give 2 to 6 distinct options');
  if (options.some((o) => o.length > 200)) throw new Error('keep each option under 200 characters');
  return { question, options, context: input.context ? String(input.context).slice(0, 2000) : undefined };
}

export function forkVerdict(confidence: number | undefined): 'sharp' | 'split' {
  return (confidence ?? 0) >= JEV_POLICY.forkSharp ? 'sharp' : 'split';
}

export class JevService {
  private readonly dir: string;
  constructor(private readonly stateDir: string, private readonly fetchFn: typeof fetch = fetch, private readonly timeoutMs = 3000) {
    this.dir = join(stateDir, 'jev');
  }

  private key(): string | undefined {
    try { return (JSON.parse(readFileSync(join(this.stateDir, 'secrets', 'typesafe.json'), 'utf8')) as { apiKey?: string }).apiKey || undefined; } catch { return undefined; }
  }
  configured(): boolean { return !!this.key(); }

  private ledgerFile() { return join(this.dir, 'ledger.json'); }
  private ledger(): Ledger { return readState<Ledger>(this.ledgerFile(), { since: zero(), total: zero() }); }

  /** Owner read the console: "this much is left right now". Resets the meter. */
  syncBalance(amount: number): ReturnType<JevService['status']> {
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter the balance shown in the TypeSafe console (a number, 0 or more)');
    const l = this.ledger();
    l.balance = { amount, syncedAt: new Date().toISOString() };
    l.since = zero();
    writeState(this.ledgerFile(), l);
    return this.status();
  }

  status(): { configured: boolean; balance?: number; syncedAt?: string; spentSinceSync: number; estimatedLeft?: number; callsSinceSync: number; totalSpent: number; totalCalls: number; pricePerMTokInputUsd: number } {
    const l = this.ledger();
    return {
      configured: this.configured(),
      balance: l.balance?.amount,
      syncedAt: l.balance?.syncedAt,
      spentSinceSync: round(l.since.costUsd),
      estimatedLeft: l.balance ? round(Math.max(0, l.balance.amount - l.since.costUsd)) : undefined,
      callsSinceSync: l.since.calls,
      totalSpent: round(l.total.costUsd),
      totalCalls: l.total.calls,
      pricePerMTokInputUsd: JEV_USD_PER_MTOK_INPUT,
    };
  }

  private meter(inputTokens: number, outputTokens: number): number {
    const cost = (inputTokens / 1e6) * JEV_USD_PER_MTOK_INPUT;
    const l = this.ledger();
    for (const b of [l.since, l.total]) { b.calls++; b.inputTokens += inputTokens; b.outputTokens += outputTokens; b.costUsd += cost; }
    writeState(this.ledgerFile(), l);
    return cost;
  }

  /** Every decision for a conversation, oldest first -- the terminal view and
   *  the switching gap both read it. */
  decisions(sessionId: string): JevDecision[] {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return [];
    const f = join(this.dir, 'decisions', sessionId + '.jsonl');
    if (!existsSync(f)) return [];
    try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as JevDecision); } catch { return []; }
  }
  forks(sessionId: string): ForkDecision[] {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return [];
    const f = join(this.dir, 'forks', sessionId + '.jsonl');
    if (!existsSync(f)) return [];
    try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as ForkDecision); } catch { return []; }
  }
  recordFork(d: ForkDecision): void {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(d.sessionId)) return;
    mkdirSync(join(this.dir, 'forks'), { recursive: true });
    appendFileSync(join(this.dir, 'forks', d.sessionId + '.jsonl'), JSON.stringify(d) + '\n', { mode: 0o600 });
  }

  /** One fork on Jev. Never throws; an unreachable Jev is a SPLIT with an error,
   *  so the agent simply decides itself. */
  async fork(sessionId: string, input: ForkInput): Promise<ForkDecision> {
    return this.choose(sessionId, { label: input.question, instructions: input.question, criteria: Object.fromEntries(input.options.map((o) => [o, o])), state: { context: input.context || '' } });
  }

  /**
   * One Choice question, recorded in the conversation's fork log like a fork
   * (the terminal view shows both). `label` is what the log calls it;
   * `criteria` maps each option to what it means. Never throws.
   */
  async choose(sessionId: string, q: { label: string; instructions: string; criteria: Record<string, string>; state: Record<string, unknown> }): Promise<ForkDecision> {
    const started = Date.now();
    const options = Object.keys(q.criteria);
    const base: ForkDecision = { at: new Date().toISOString(), sessionId, backend: 'jev', question: q.label, options, latencyMs: 0 };
    const done = (d: ForkDecision) => { this.recordFork(d); return d; };
    const key = this.key();
    if (!key) return done({ ...base, verdict: 'split', error: 'No Jev API key configured' });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchFn(API, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state: q.state, questions: { fork: { type: 'choice', instructions: q.instructions, criteria: q.criteria } } }) });
    } catch (e) {
      return done({ ...base, verdict: 'split', latencyMs: Date.now() - started, error: (e as Error).name === 'AbortError' ? `Jev did not answer within ${this.timeoutMs} ms` : 'Jev unreachable: ' + (e as Error).message });
    } finally { clearTimeout(timer); }
    const body = (await res.json().catch(() => ({}))) as { answers?: Record<string, DecisionAnswer>; usage?: { input_tokens?: number; output_tokens?: number } };
    const latencyMs = Date.now() - started;
    if (!res.ok) return done({ ...base, verdict: 'split', latencyMs, error: `Jev answered HTTP ${res.status}` });
    const inputTokens = body.usage?.input_tokens ?? 0;
    const costUsd = round(this.meter(inputTokens, body.usage?.output_tokens ?? 0), 8);
    const a = body.answers?.fork;
    if (!a?.choice || !options.includes(a.choice)) return done({ ...base, verdict: 'split', latencyMs, inputTokens, costUsd, error: 'Jev gave no usable answer' });
    return done({ ...base, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, verdict: forkVerdict(a.confidence), latencyMs, inputTokens, costUsd });
  }

  /** Every backend records here, so the Claude switching gap counts a model
   *  switch no matter which of them made it. */
  record(d: JevDecision): void {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(d.sessionId)) return;
    mkdirSync(join(this.dir, 'decisions'), { recursive: true });
    appendFileSync(join(this.dir, 'decisions', d.sessionId + '.jsonl'), JSON.stringify(d) + '\n', { mode: 0o600 });
  }

  /** Ask Jev, apply the policy, record and meter. Never throws: a failed call
   *  returns a decision with `error` and no changes. */
  async decide(sessionId: string, input: JevDecisionInput): Promise<JevDecision> {
    const started = Date.now();
    const base: JevDecision = { at: new Date().toISOString(), sessionId, provider: input.provider, backend: 'jev', notes: [], latencyMs: 0, baseModel: input.currentModel, baseEffort: input.currentEffort, ...leanField(input.lean) };
    const key = this.key();
    if (!key) { const d = { ...base, error: 'No Jev API key configured' }; this.record(d); return d; }
    const models = input.models.filter((m) => m.id);
    const questions: Record<string, unknown> = {
      effort: { type: 'choice', instructions: effortQuestion(input.lean), criteria: input.efforts },
    };
    if (models.length > 1) {
      questions.model = { type: 'choice', instructions: modelQuestion(input.lean), criteria: Object.fromEntries(models.map((m) => [m.id, m.about])) };
    }
    const state = decisionState(input);
    let res: Response;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      res = await this.fetchFn(API, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions }) });
    } catch (e) {
      clearTimeout(timer);
      const d = { ...base, latencyMs: Date.now() - started, error: (e as Error).name === 'AbortError' ? `Jev did not answer within ${this.timeoutMs} ms` : 'Jev unreachable: ' + (e as Error).message };
      this.record(d); return d;
    }
    clearTimeout(timer);
    const body = (await res.json().catch(() => ({}))) as { answers?: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>; usage?: { input_tokens?: number; output_tokens?: number }; detail?: unknown };
    const latencyMs = Date.now() - started;
    if (!res.ok) { const d = { ...base, latencyMs, error: `Jev answered HTTP ${res.status}` }; this.record(d); return d; }
    const inputTokens = body.usage?.input_tokens ?? 0, outputTokens = body.usage?.output_tokens ?? 0;
    const costUsd = this.meter(inputTokens, outputTokens);
    const d = applyPolicy({ ...base, latencyMs, inputTokens, outputTokens, costUsd: round(costUsd, 8) }, input, body.answers ?? {}, this.decisions(sessionId));
    this.record(d);
    return d;
  }
}

export const EFFORT_QUESTION = 'How much reasoning effort does the NEXT turn of this coding/assistant conversation need? Judge the new message IN THE CONTEXT of the work in progress: a short follow-up ("yes", "continue", "deploy it", an answer to a question) continues the previous task and needs that task\'s effort, not the effort its length suggests. Only a genuinely small, self-contained request needs little.';
export const MODEL_QUESTION = 'Which model should handle the NEXT turn? Prefer the cheapest model that will do it well, judged by the work in progress (see the previous request, reply and turn size), not by the length of the new message.';

/** The questions under a lean; medium is the plain text above. */
export function effortQuestion(lean: Lean = 'medium'): string {
  return EFFORT_QUESTION + (lean === 'low' ? ' The user wants COST EFFICIENCY: choose the lowest effort that will still do this adequately, and raise it only when clearly necessary.'
    : lean === 'high' ? ' The user wants the BEST RESULT: when in doubt choose more effort; cost is secondary.' : '');
}
export function modelQuestion(lean: Lean = 'medium'): string {
  return MODEL_QUESTION + (lean === 'low' ? ' The user wants COST EFFICIENCY: choose the cheapest model that will do this adequately.'
    : lean === 'high' ? ' The user wants the BEST RESULT: when in doubt choose the stronger model; cost is secondary.' : '');
}
export const leanField = (lean?: Lean): { lean?: 'low' | 'high' } => (lean === 'low' || lean === 'high' ? { lean } : {});

export interface DecisionContext {
  project?: string;
  /** Who sent the new message: the user, autopilot, a delegate report, ... */
  origin?: string;
  previousRequest?: string;
  previousReply?: string;
  /** The previous turn's size, e.g. "6 min, 41 steps". */
  lastTurn?: string;
}

/** Ranks for "is this pick a downgrade?". Unknown ids are never ranked. */
const EFFORT_RANK = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const MODEL_RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, 'gpt-6-luna': 1, 'gpt-5.6-terra': 2, 'gpt-6-sol': 3, 'gpt-6.1-sol': 3, 'gpt-6-astra': 4 };
const lower = (rank: (x: string) => number, pick: string, cur?: string) => { if (!cur) return false; const a = rank(pick), b = rank(cur); return a >= 0 && b >= 0 && a < b; };
const higher = (rank: (x: string) => number, pick: string, cur?: string) => { if (!cur) return false; const a = rank(pick), b = rank(cur); return a >= 0 && b >= 0 && a > b; };
const effortRank = (e: string) => EFFORT_RANK.indexOf(e);
const modelRank = (m: string) => MODEL_RANK[m] ?? -1;

/** What a decision backend is told about the turn. */
export function decisionState(input: JevDecisionInput): Record<string, string> {
  const c = input.context ?? {};
  const out: Record<string, string> = {
    provider: input.provider,
    conversation_title: (input.title || '').slice(0, 200),
    current_model: input.currentModel || 'provider default',
    current_effort: input.currentEffort || 'provider default',
  };
  if (c.project) out.project = c.project.slice(0, 120);
  if (c.origin) out.message_from = c.origin;
  if (c.previousRequest) out.previous_request = c.previousRequest.slice(0, 1200);
  if (c.previousReply) out.previous_reply = c.previousReply.length > 1500 ? '…' + c.previousReply.slice(-1500) : c.previousReply;
  if (c.lastTurn) out.previous_turn_size = c.lastTurn;
  out.new_message = input.prompt.slice(0, 6000);
  return out;
}

/** Decide what actually changes, given a backend's answers and what came before. */
export function applyPolicy(
  d: JevDecision,
  input: JevDecisionInput,
  answers: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>,
  history: JevDecision[],
): JevDecision {
  const out: JevDecision = { ...d, notes: [...d.notes], ...leanField(input.lean) };
  const m = answers.model, e = answers.effort;
  const lean: Lean = input.lean ?? 'medium', bars = LEAN_BARS[lean];
  const leanNote = LEAN_WORD[lean] ? ', ' + LEAN_WORD[lean] : '';
  let model = input.currentModel;
  if (m?.choice) {
    out.pickedModel = m.choice; out.modelConfidence = m.confidence; out.modelProbabilities = m.probabilities;
    const known = input.models.some((c) => c.id === m.choice);
    // Up and down are judged by rank; a move the ranks cannot place keeps
    // the plain bar. The first bar a downgrade meets is the lower of the two,
    // so medium reads exactly as it did before there was a lean.
    const modelDown = lower(modelRank, m.choice, input.currentModel), modelUp = higher(modelRank, m.choice, input.currentModel);
    const modelFloor = modelUp ? bars.modelUp : modelDown ? Math.min(JEV_POLICY.modelMin, bars.modelDown) : JEV_POLICY.modelMin;
    // `model` is set on a decision only when a pick moved the turn off its
    // own model; a switch is a decision whose model differs from the turn
    // before. The gap is the number of decisions recorded since the last one.
    const lastSwitch = history.map((h, i) => !!h.model && (i === 0 || history[i - 1].model !== h.model)).lastIndexOf(true);
    const turnsSinceSwitch = lastSwitch < 0 ? Infinity : history.length - 1 - lastSwitch;
    if (!known) out.notes.push(`model ${m.choice} is not a candidate; kept`);
    else if (m.choice === input.currentModel) out.notes.push('model unchanged');
    // Already running there since the last turn: no respawn, no cache loss,
    // so the switching bar does not apply -- the effort bar does.
    else if (m.choice === input.previousModel && (m.confidence ?? 0) >= JEV_POLICY.effortMin) { out.model = m.choice; model = m.choice; out.notes.push(`model stays ${m.choice}`); }
    else if ((m.confidence ?? 0) < modelFloor) out.notes.push(`model ${m.choice} only ${pct(m.confidence)} sure (needs ${pct(modelFloor)}${leanNote}); kept`);
    else if (modelDown && (m.confidence ?? 0) < bars.modelDown) out.notes.push(`model ${m.choice} is below ${input.currentModel} at only ${pct(m.confidence)} (needs ${pct(bars.modelDown)} to go lower${leanNote}); kept`);
    else if (input.provider === 'claude' && turnsSinceSwitch < JEV_POLICY.claudeModelGapTurns) out.notes.push(`model switched ${turnsSinceSwitch} turn(s) ago; waiting ${JEV_POLICY.claudeModelGapTurns} to keep the prompt cache`);
    else { out.model = m.choice; model = m.choice; out.notes.push(`model -> ${m.choice}`); }
  }
  if (e?.choice) {
    out.pickedEffort = e.choice; out.effortConfidence = e.confidence; out.effortProbabilities = e.probabilities;
    const allowed = input.models.find((c) => c.id === model)?.efforts;
    const effortDown = lower(effortRank, e.choice, input.currentEffort);
    // With no saved effort there is no "down"; a pick is treated as a raise.
    const effortFloor = effortDown ? Math.min(JEV_POLICY.effortMin, bars.effortDown) : e.choice === input.currentEffort ? JEV_POLICY.effortMin : bars.effortUp;
    if ((e.confidence ?? 0) < effortFloor) out.notes.push(effortFloor === JEV_POLICY.effortMin ? `effort ${e.choice} only ${pct(e.confidence)} sure; kept` : `effort ${e.choice} only ${pct(e.confidence)} sure (needs ${pct(effortFloor)} to go higher${leanNote}); kept`);
    else if (effortDown && (e.confidence ?? 0) < bars.effortDown) out.notes.push(`effort ${e.choice} is below ${input.currentEffort} at only ${pct(e.confidence)} (needs ${pct(bars.effortDown)} to go lower${leanNote}); kept`);
    else if (allowed && allowed.length && !allowed.includes(e.choice)) out.notes.push(`effort ${e.choice} not offered by ${model}; kept`);
    else if (e.choice === input.currentEffort) out.notes.push('effort unchanged');
    else { out.effort = e.choice; out.notes.push(`effort -> ${e.choice}`); }
  }
  return out;
}

export type DecisionAnswer = { choice?: string; confidence?: number; probabilities?: Record<string, number> };

const pct = (n?: number) => `${Math.round((n ?? 0) * 100)}%`;
function round(n: number, places = 6): number { const f = 10 ** places; return Math.round(n * f) / f; }
