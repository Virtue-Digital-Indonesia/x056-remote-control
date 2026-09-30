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
export const JEV_POLICY = { effortMin: 0.6, modelMin: 0.8, claudeModelGapTurns: 3 };

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
    const base: JevDecision = { at: new Date().toISOString(), sessionId, provider: input.provider, backend: 'jev', notes: [], latencyMs: 0, baseModel: input.currentModel, baseEffort: input.currentEffort };
    const key = this.key();
    if (!key) { const d = { ...base, error: 'No Jev API key configured' }; this.record(d); return d; }
    const models = input.models.filter((m) => m.id);
    const questions: Record<string, unknown> = {
      effort: { type: 'choice', instructions: EFFORT_QUESTION, criteria: input.efforts },
    };
    if (models.length > 1) {
      questions.model = { type: 'choice', instructions: MODEL_QUESTION, criteria: Object.fromEntries(models.map((m) => [m.id, m.about])) };
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

export const EFFORT_QUESTION = 'How much reasoning effort does the NEXT turn of this coding/assistant conversation need? Judge the new message, not the whole history.';
export const MODEL_QUESTION = 'Which model should handle the NEXT turn? Prefer the cheapest model that will do it well.';

/** What a decision backend is told about the turn. */
export function decisionState(input: JevDecisionInput): Record<string, string> {
  return {
    provider: input.provider,
    conversation_title: (input.title || '').slice(0, 200),
    current_model: input.currentModel || 'provider default',
    current_effort: input.currentEffort || 'provider default',
    new_message: input.prompt.slice(0, 6000),
  };
}

/** Decide what actually changes, given a backend's answers and what came before. */
export function applyPolicy(
  d: JevDecision,
  input: JevDecisionInput,
  answers: Record<string, { choice?: string; confidence?: number; probabilities?: Record<string, number> }>,
  history: JevDecision[],
): JevDecision {
  const out: JevDecision = { ...d, notes: [...d.notes] };
  const m = answers.model, e = answers.effort;
  let model = input.currentModel;
  if (m?.choice) {
    out.pickedModel = m.choice; out.modelConfidence = m.confidence; out.modelProbabilities = m.probabilities;
    const known = input.models.some((c) => c.id === m.choice);
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
    else if ((m.confidence ?? 0) < JEV_POLICY.modelMin) out.notes.push(`model ${m.choice} only ${pct(m.confidence)} sure (needs ${pct(JEV_POLICY.modelMin)}); kept`);
    else if (input.provider === 'claude' && turnsSinceSwitch < JEV_POLICY.claudeModelGapTurns) out.notes.push(`model switched ${turnsSinceSwitch} turn(s) ago; waiting ${JEV_POLICY.claudeModelGapTurns} to keep the prompt cache`);
    else { out.model = m.choice; model = m.choice; out.notes.push(`model -> ${m.choice}`); }
  }
  if (e?.choice) {
    out.pickedEffort = e.choice; out.effortConfidence = e.confidence; out.effortProbabilities = e.probabilities;
    const allowed = input.models.find((c) => c.id === model)?.efforts;
    if ((e.confidence ?? 0) < JEV_POLICY.effortMin) out.notes.push(`effort ${e.choice} only ${pct(e.confidence)} sure; kept`);
    else if (allowed && allowed.length && !allowed.includes(e.choice)) out.notes.push(`effort ${e.choice} not offered by ${model}; kept`);
    else if (e.choice === input.currentEffort) out.notes.push('effort unchanged');
    else { out.effort = e.choice; out.notes.push(`effort -> ${e.choice}`); }
  }
  return out;
}

export type DecisionAnswer = { choice?: string; confidence?: number; probabilities?: Record<string, number> };

const pct = (n?: number) => `${Math.round((n ?? 0) * 100)}%`;
function round(n: number, places = 6): number { const f = 10 ** places; return Math.round(n * f) / f; }
