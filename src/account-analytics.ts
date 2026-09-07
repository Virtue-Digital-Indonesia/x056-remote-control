import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderId } from './provider.js';
import type { RawEvent } from './types.js';

type Tokens = { input: number; output: number; cached: number; cacheWrite: number };
export type AnalyticsRow = Tokens & { date: string; account: string; provider: ProviderId; model: string; attempts: number; completed: number; failed: number; interrupted: number; reported: number };
const zero = (): Tokens => ({ input: 0, output: 0, cached: 0, cacheWrite: 0 });
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;

/** Bounded daily aggregates, recorded at attempt completion. No transcript scans,
 * prompt text or credentials. Each failover attempt keeps its actual account. */
export class AccountAnalytics {
  private readonly dir: string;
  constructor(stateDir: string) { this.dir = join(stateDir, 'account-analytics'); }

  private coverage(): string {
    const file = join(this.dir, 'coverage.json');
    if (existsSync(file)) return (JSON.parse(readFileSync(file, 'utf8')) as { since: string }).since;
    mkdirSync(this.dir, { recursive: true });
    const since = new Date().toISOString();
    writeFileSync(file, JSON.stringify({ since }));
    return since;
  }

  summary(days = 7, provider?: ProviderId, now = new Date()) {
    const since = this.coverage();
    const rows: AnalyticsRow[] = [];
    const dates: string[] = [];
    for (let i = Math.min(30, Math.max(1, days)) - 1; i >= 0; i--) {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
      const date = d.toISOString().slice(0, 10); dates.push(date);
      const file = join(this.dir, date + '.json');
      if (existsSync(file)) rows.push(...(JSON.parse(readFileSync(file, 'utf8')) as AnalyticsRow[]).filter(r => !provider || r.provider === provider));
    }
    return { since, dates, rows, scope: 'Gateway attempts that ended since collection began. Retries and switches count separately. Tokens cover reported main-agent usage; background work and earlier history are excluded.' };
  }

  begin(account: string, provider: ProviderId, selectedModel?: string) {
    this.coverage();
    const entries = new Map<string, { model: string; tokens: Tokens }>();
    let sequence = 0, finished = false;
    const observe = (event: RawEvent) => {
      const message = obj(event.message);
      if (provider === 'claude' && event.type === 'assistant' && !event.parent_tool_use_id && message.usage) {
        const u = obj(message.usage);
        entries.set(String(message.id || event.uuid || ++sequence), { model: String(message.model || selectedModel || 'Unknown'), tokens: {
          input: num(u.input_tokens), output: num(u.output_tokens), cached: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens),
        } });
      }
      if (provider === 'codex') {
        // app-server sends per-request `last` plus session-cumulative `total`.
        // Never bill an adopted thread's historical total to its current account.
        const usage = obj(event.tokenUsage);
        const last = obj(usage.last);
        if (event.type === 'thread.tokenUsage.updated' && typeof last.inputTokens === 'number') {
          const t = obj(usage.total);
          const cached = num(last.cachedInputTokens);
          const key = 'rpc:' + String(event.turnId || '') + ':' + JSON.stringify(t);
          entries.set(key, { model: String(selectedModel || 'Unknown'), tokens: { input: Math.max(0, num(last.inputTokens) - cached), output: num(last.outputTokens), cached, cacheWrite: 0 } });
        } else if (event.type === 'turn.completed' && event.usage && !entries.size) {
          const u = obj(event.usage), cached = num(u.cached_input_tokens);
          entries.set('exec', { model: String(selectedModel || 'Unknown'), tokens: { input: Math.max(0, num(u.input_tokens) - cached), output: num(u.output_tokens), cached, cacheWrite: 0 } });
        }
      }
    };
    return { observe, finish: (outcome: 'completed' | 'failed' | 'interrupted') => {
      if (finished) return; finished = true;
      const date = new Date().toISOString().slice(0, 10);
      const byModel = new Map<string, Tokens>();
      for (const e of entries.values()) {
        const t = byModel.get(e.model) || zero();
        for (const k of Object.keys(t) as (keyof Tokens)[]) t[k] += e.tokens[k];
        byModel.set(e.model, t);
      }
      if (!byModel.size) byModel.set(selectedModel || 'Unknown', zero());
      const file = join(this.dir, date + '.json');
      const rows: AnalyticsRow[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as AnalyticsRow[] : [];
      let first = true;
      for (const [model, tokens] of byModel) {
        let r = rows.find(r => r.account === account && r.provider === provider && r.model === model);
        if (!r) { r = { date, account, provider, model, ...zero(), attempts: 0, completed: 0, failed: 0, interrupted: 0, reported: 0 }; rows.push(r); }
        for (const k of Object.keys(tokens) as (keyof Tokens)[]) r[k] += tokens[k];
        if (first) { r.attempts++; r[outcome]++; if (entries.size) r.reported++; first = false; }
      }
      writeFileSync(file + '.tmp', JSON.stringify(rows)); renameSync(file + '.tmp', file);
    } };
  }
}
