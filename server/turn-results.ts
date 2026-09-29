import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Each Claude turn's final `result`, per conversation.
 *
 * The transcript never records it, so without this a turn's total and -- the
 * reason this exists -- what a Claude ADVISOR call cost appeared nowhere: the
 * advisor's tokens are only in `result.modelUsage` (e.g. Haiku $0.027 next to
 * an Opus advisor's $0.148 for one live turn), not in any message's usage.
 * The terminal view shows one line per turn from this, as `claude -p` does.
 */
export interface TurnResult {
  at: string;
  sessionId: string;
  ok: boolean;
  durationMs?: number;
  numTurns?: number;
  totalCostUsd?: number;
  /** Per model: cost and tokens, e.g. the main model and its advisor. */
  models: { model: string; costUsd?: number; inputTokens?: number; outputTokens?: number }[];
}

export class TurnResults {
  private readonly dir: string;
  constructor(stateDir: string) { this.dir = join(stateDir, 'turn-results'); }

  /** From a Claude stream `result` event. Ignores anything else. */
  record(sessionId: string, e: Record<string, unknown>): TurnResult | undefined {
    if (e.type !== 'result' || !/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return undefined;
    const usage = (e.modelUsage ?? {}) as Record<string, { costUSD?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
    const r: TurnResult = {
      at: new Date().toISOString(),
      sessionId,
      ok: e.is_error === false,
      durationMs: typeof e.duration_ms === 'number' ? e.duration_ms : undefined,
      numTurns: typeof e.num_turns === 'number' ? e.num_turns : undefined,
      totalCostUsd: typeof e.total_cost_usd === 'number' ? e.total_cost_usd : undefined,
      models: Object.entries(usage).map(([model, u]) => ({
        model, costUsd: u.costUSD,
        inputTokens: (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0),
        outputTokens: u.outputTokens,
      })),
    };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, sessionId + '.jsonl'), JSON.stringify(r) + '\n', { mode: 0o600 });
    return r;
  }

  list(sessionId: string): TurnResult[] {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return [];
    const f = join(this.dir, sessionId + '.jsonl');
    if (!existsSync(f)) return [];
    try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TurnResult); } catch { return []; }
  }
}
