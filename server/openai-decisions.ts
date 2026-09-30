import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState, writeState } from './workspace-store.js';
import { applyPolicy, decisionState, EFFORT_QUESTION, forkVerdict, MODEL_QUESTION, type DecisionAnswer, type ForkDecision, type ForkInput, type JevDecision, type JevDecisionInput } from './jev.js';

/**
 * OpenAI's Decisions API as the per-turn model/effort picker: the same job as
 * Jev, so it answers the same two questions, goes through the same policy
 * (`applyPolicy`) and writes into the same decision store. Either one can be a
 * conversation's helper; switching between them keeps the Claude switching
 * gap honest because the history is shared.
 *
 * PROVISIONAL. Announced at DevDay 2026-09-29 as a limited preview ("define
 * questions with a limited set of predefined answers, pass in context as text
 * or images, get an answer back"; GPT-6 Luna underneath, ~10x faster). The
 * endpoint exists -- POST /v1/decisions answers 401 "A valid API key is
 * required" where a made-up path answers 404 -- but no reference is published
 * yet (docs, llms-full.txt and SDK openai@7.24.0 / 3.21.0 carry nothing). So
 * the request shape is a best guess kept in `decisionsRequest`, the reply is
 * read by a tolerant `decisionsAnswers`, and `probe()` sends one real call and
 * returns the raw reply so the mapping can be corrected the moment a key with
 * preview access exists. Until then the backend is disabled.
 *
 * Config (0600, never returned by any route): state/secrets/openai.json
 *   { "apiKey": "sk-...", "model"?: "...", "endpoint"?: "https://..." }
 */

const DEFAULT_ENDPOINT = 'https://api.openai.com/v1/decisions';

interface Config { apiKey?: string; model?: string; endpoint?: string }
interface Ledger { calls: number; failures: number; inputTokens: number; outputTokens: number; lastOkAt?: string; lastError?: { at: string; message: string } }

export interface DecisionStore { decisions(sessionId: string): JevDecision[]; record(d: JevDecision): void; recordFork(d: ForkDecision): void }

/** The request, in one place so a published schema is a one-function change. */
export function decisionsRequest(input: JevDecisionInput, model?: string): Record<string, unknown> {
  const state = decisionState(input);
  const context = Object.entries(state).map(([k, v]) => `${k}: ${v}`).join('\n');
  const options = (criteria: Record<string, string>) => Object.entries(criteria).map(([value, description]) => ({ value, description }));
  const questions: Record<string, unknown>[] = [{ id: 'effort', instructions: EFFORT_QUESTION, options: options(input.efforts) }];
  const models = input.models.filter((m) => m.id);
  if (models.length > 1) questions.push({ id: 'model', instructions: MODEL_QUESTION, options: options(Object.fromEntries(models.map((m) => [m.id, m.about]))) });
  return { ...(model ? { model } : {}), input: [{ type: 'input_text', text: context }], questions };
}

/**
 * Answers keyed by question id, from whichever shape the reply takes: an
 * object keyed by id (Jev's shape) or a list of `{id|question, answer|choice|
 * value|option, confidence|probability}`, under `answers`, `decisions`,
 * `results` or `output`.
 */
export function decisionsAnswers(body: unknown): Record<string, DecisionAnswer> {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const src = b.answers ?? b.decisions ?? b.results ?? b.output;
  const out: Record<string, DecisionAnswer> = {};
  const read = (v: unknown): DecisionAnswer | undefined => {
    if (typeof v === 'string') return { choice: v };
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    const raw = o.choice ?? o.answer ?? o.value ?? o.option ?? o.decision ?? o.label;
    const choice = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? String((raw as Record<string, unknown>).value ?? (raw as Record<string, unknown>).label ?? '') || undefined : undefined;
    const conf = [o.confidence, o.probability, o.score].find((x) => typeof x === 'number') as number | undefined;
    let probabilities: Record<string, number> | undefined;
    if (o.probabilities && typeof o.probabilities === 'object' && !Array.isArray(o.probabilities)) probabilities = o.probabilities as Record<string, number>;
    else if (Array.isArray(o.probabilities ?? o.options)) {
      probabilities = {};
      for (const p of (o.probabilities ?? o.options) as Record<string, unknown>[]) {
        const k = p?.value ?? p?.label ?? p?.option, n = p?.probability ?? p?.confidence ?? p?.score;
        if (typeof k === 'string' && typeof n === 'number') probabilities[k] = n;
      }
      if (!Object.keys(probabilities).length) probabilities = undefined;
    }
    const confidence = conf ?? (choice && probabilities ? probabilities[choice] : undefined);
    return choice ? { choice, ...(confidence !== undefined ? { confidence } : {}), ...(probabilities ? { probabilities } : {}) } : undefined;
  };
  if (Array.isArray(src)) {
    for (const item of src as Record<string, unknown>[]) {
      const id = item?.id ?? item?.question ?? item?.question_id ?? item?.name;
      const a = read(item);
      if (typeof id === 'string' && a) out[id] = a;
    }
  } else if (src && typeof src === 'object') {
    for (const [id, v] of Object.entries(src as Record<string, unknown>)) { const a = read(v); if (a) out[id] = a; }
  }
  return out;
}

export class OpenAIDecisionsService {
  constructor(private readonly stateDir: string, private readonly store: DecisionStore, private readonly fetchFn: typeof fetch = fetch, private readonly timeoutMs = 3000) {}

  private config(): Config {
    try { return JSON.parse(readFileSync(join(this.stateDir, 'secrets', 'openai.json'), 'utf8')) as Config; } catch { return {}; }
  }
  configured(): boolean { return !!this.config().apiKey; }

  private ledgerFile() { return join(this.stateDir, 'openai-decisions', 'ledger.json'); }
  private ledger(): Ledger { return readState<Ledger>(this.ledgerFile(), { calls: 0, failures: 0, inputTokens: 0, outputTokens: 0 }); }
  private note(ok: boolean, inputTokens = 0, outputTokens = 0, error?: string): void {
    const l = this.ledger();
    l.calls++; l.inputTokens += inputTokens; l.outputTokens += outputTokens;
    if (ok) l.lastOkAt = new Date().toISOString(); else { l.failures++; l.lastError = { at: new Date().toISOString(), message: error ?? 'failed' }; }
    writeState(this.ledgerFile(), l);
  }

  /** No price is published for the preview, so this counts calls and tokens
   *  rather than inventing dollars. */
  status(): { configured: boolean; provisional: true; calls: number; failures: number; inputTokens: number; outputTokens: number; lastOkAt?: string; lastError?: { at: string; message: string } } {
    const l = this.ledger();
    return { configured: this.configured(), provisional: true, calls: l.calls, failures: l.failures, inputTokens: l.inputTokens, outputTokens: l.outputTokens, lastOkAt: l.lastOkAt, lastError: l.lastError };
  }

  private async call(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown>; latencyMs: number }> {
    const cfg = this.config();
    if (!cfg.apiKey) throw new Error('No OpenAI API key configured');
    const started = Date.now(), ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(cfg.endpoint || DEFAULT_ENDPOINT, { method: 'POST', signal: ctl.signal, headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json, latencyMs: Date.now() - started };
    } catch (e) {
      throw new Error((e as Error).name === 'AbortError' ? `OpenAI Decisions did not answer within ${this.timeoutMs} ms` : 'OpenAI Decisions unreachable: ' + (e as Error).message);
    } finally { clearTimeout(timer); }
  }

  /** Ask, apply the shared policy, record. Never throws. */
  async decide(sessionId: string, input: JevDecisionInput): Promise<JevDecision> {
    const started = Date.now();
    const base: JevDecision = { at: new Date().toISOString(), sessionId, provider: input.provider, backend: 'openai', notes: [], latencyMs: 0, baseModel: input.currentModel, baseEffort: input.currentEffort };
    const finish = (d: JevDecision) => { this.store.record(d); return d; };
    if (!this.configured()) return finish({ ...base, error: 'No OpenAI API key configured' });
    let r: Awaited<ReturnType<OpenAIDecisionsService['call']>>;
    try { r = await this.call(decisionsRequest(input, this.config().model)); }
    catch (e) { this.note(false, 0, 0, (e as Error).message); return finish({ ...base, latencyMs: Date.now() - started, error: (e as Error).message }); }
    const usage = (r.json.usage ?? {}) as Record<string, number>;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0, outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    if (r.status < 200 || r.status >= 300) {
      // OpenAI's errors name the offending parameter; keep that, it is how a
      // wrong guess at the request shape shows up.
      const msg = ((r.json.error as Record<string, unknown> | undefined)?.message as string | undefined)?.slice(0, 300);
      const error = `OpenAI Decisions answered HTTP ${r.status}` + (msg ? ': ' + msg : '');
      this.note(false, 0, 0, error);
      return finish({ ...base, latencyMs: r.latencyMs, error });
    }
    const answers = decisionsAnswers(r.json);
    if (!Object.keys(answers).length) {
      const error = 'OpenAI Decisions answered, but in a shape the gateway cannot read yet';
      this.note(false, inputTokens, outputTokens, error);
      return finish({ ...base, latencyMs: r.latencyMs, inputTokens, outputTokens, error });
    }
    this.note(true, inputTokens, outputTokens);
    return finish(applyPolicy({ ...base, latencyMs: r.latencyMs, inputTokens, outputTokens }, input, answers, this.store.decisions(sessionId)));
  }

  /** One fork (see JevService.fork), same verdict rule. Never throws. */
  async fork(sessionId: string, input: ForkInput): Promise<ForkDecision> {
    const started = Date.now();
    const base: ForkDecision = { at: new Date().toISOString(), sessionId, backend: 'openai', question: input.question, options: input.options, latencyMs: 0 };
    const done = (d: ForkDecision) => { this.store.recordFork(d); return d; };
    if (!this.configured()) return done({ ...base, verdict: 'split', error: 'No OpenAI API key configured' });
    const body = { ...(this.config().model ? { model: this.config().model } : {}), input: [{ type: 'input_text', text: input.context || input.question }],
      questions: [{ id: 'fork', instructions: input.question, options: input.options.map((value) => ({ value, description: value })) }] };
    let r: Awaited<ReturnType<OpenAIDecisionsService['call']>>;
    try { r = await this.call(body); }
    catch (e) { this.note(false, 0, 0, (e as Error).message); return done({ ...base, verdict: 'split', latencyMs: Date.now() - started, error: (e as Error).message }); }
    const usage = (r.json.usage ?? {}) as Record<string, number>;
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const a = decisionsAnswers(r.json).fork;
    if (r.status < 200 || r.status >= 300 || !a?.choice || !input.options.includes(a.choice)) {
      const msg = ((r.json.error as Record<string, unknown> | undefined)?.message as string | undefined)?.slice(0, 300);
      const error = r.status >= 200 && r.status < 300 ? 'OpenAI Decisions gave no usable answer' : `OpenAI Decisions answered HTTP ${r.status}` + (msg ? ': ' + msg : '');
      this.note(false, inputTokens, 0, error);
      return done({ ...base, verdict: 'split', latencyMs: r.latencyMs, inputTokens, error });
    }
    this.note(true, inputTokens, usage.output_tokens ?? 0);
    return done({ ...base, choice: a.choice, confidence: a.confidence, probabilities: a.probabilities, verdict: forkVerdict(a.confidence), latencyMs: r.latencyMs, inputTokens });
  }

  /** One real call on a fixed question, raw reply included -- for checking
   *  the provisional mapping against the live API. Nothing is recorded. */
  async probe(): Promise<{ status: number; latencyMs: number; answers: Record<string, DecisionAnswer>; body: unknown }> {
    const input: JevDecisionInput = { provider: 'claude', prompt: 'Rename the variable `x` to `count` in utils.ts.', models: [], efforts: { low: 'Trivial.', high: 'Hard.' } };
    const r = await this.call(decisionsRequest(input, this.config().model));
    return { status: r.status, latencyMs: r.latencyMs, answers: decisionsAnswers(r.json), body: redactDeep(r.json) };
  }
}

/** A reply is shown to the operator as-is, minus anything that looks like a key. */
function redactDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return /^sk-[A-Za-z0-9_-]{10,}/.test(v) ? '[redacted]' : v.slice(0, 2000);
  if (Array.isArray(v)) return depth > 8 ? '[…]' : v.slice(0, 50).map((x) => redactDeep(x, depth + 1));
  if (v && typeof v === 'object') return depth > 8 ? '[…]' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, depth + 1)]));
  return v;
}

