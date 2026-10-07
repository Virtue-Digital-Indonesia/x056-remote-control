import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateCost } from './transcript-stats.js';

/**
 * Each Claude turn's final `result`, per conversation (and, since
 * 2026-10-07, each Codex turn's equivalent: see `CodexTurnMeter`).
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
  /** Absent = Claude (every row before Codex turns were recorded). */
  provider?: 'codex';
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

  /** A Codex turn, from what `CodexTurnMeter` saw: Codex has no `result`
   *  event, so its size, time and price are assembled from the stream. */
  recordCodex(sessionId: string, m: { ok: boolean; durationMs?: number; steps: number; model?: string; usage: CodexTurnUsage | null }): TurnResult | undefined {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return undefined;
    const u = m.usage, model = m.model || 'unknown';
    let costUsd: number | undefined;
    if (u) {
      // Same split as the transcript scanner: cached and written input are
      // billed apart, so they come out of the plain input count.
      const c = estimateCost({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0,
        byModel: { [model]: { input: Math.max(0, u.input - u.cached - u.written), output: u.output, cacheRead: u.cached, cacheWrite: u.written } } });
      if (!c.unpriced.length) costUsd = c.usd;
    }
    const r: TurnResult = {
      at: new Date().toISOString(),
      sessionId,
      provider: 'codex',
      ok: m.ok,
      durationMs: m.durationMs,
      numTurns: m.steps,
      totalCostUsd: costUsd,
      models: u ? [{ model, costUsd, inputTokens: u.input, outputTokens: u.output }] : [],
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

export interface CodexTurnUsage { input: number; output: number; cached: number; written: number }

/**
 * One Codex turn's size and token use, read off its event stream.
 *
 * - Persistent (app-server): `thread.tokenUsage.updated {threadId, tokenUsage:
 *   {total, last}}` after each model response. Children run in the same
 *   app-server, so only the conversation's own thread is counted. The turn's
 *   use is the growth of `total` since the turn began (the first update's
 *   total minus its last); a total that shrinks is a counter reset after
 *   compaction and starts a new segment, as in the transcript scanner.
 * - One-shot (`exec --json`): `turn.completed {usage}` holds the turn's use.
 * Steps = completed tool items (commands, edits, MCP and web calls, spawns),
 * the nearest thing Codex has to Claude's `num_turns`.
 */
export class CodexTurnMeter {
  private steps = 0;
  private byThread = new Map<string, { prev: CodexTurnUsage; sum: CodexTurnUsage }>();
  private execUsage: CodexTurnUsage | null = null;

  observe(e: Record<string, unknown>): void {
    const t = String(e.type ?? '');
    if (t === 'item.completed') {
      const it = (e.item ?? {}) as Record<string, unknown>;
      if (TOOL_ITEMS.has(String(it.type ?? ''))) this.steps++;
    } else if (t === 'thread.tokenUsage.updated') {
      const tu = (e.tokenUsage ?? {}) as Record<string, unknown>;
      const total = breakdown(tu.total), last = breakdown(tu.last);
      if (!total) return;
      const id = String(e.threadId ?? '');
      let s = this.byThread.get(id);
      if (!s) {
        const before = last ? sub(total, last) : total;
        s = { prev: before, sum: { input: 0, output: 0, cached: 0, written: 0 } };
        this.byThread.set(id, s);
      }
      const reset = total.input < s.prev.input || total.output < s.prev.output;
      const d = reset ? total : sub(total, s.prev);
      s.sum = add(s.sum, d); s.prev = total;
    } else if (t === 'turn.completed') {
      const u = (e.usage ?? null) as Record<string, unknown> | null;
      if (u && typeof u.input_tokens === 'number') {
        this.execUsage = { input: u.input_tokens, output: Number(u.output_tokens ?? 0), cached: Number(u.cached_input_tokens ?? 0), written: 0 };
      }
    }
  }

  /** The turn's figures for `threadId` (the conversation's own thread). */
  result(threadId?: string): { steps: number; usage: CodexTurnUsage | null } {
    if (this.execUsage) return { steps: this.steps, usage: this.execUsage };
    let s = threadId ? this.byThread.get(threadId) : undefined;
    // Before the thread id is stored (a first turn), the only thread seen is it.
    if (!s && this.byThread.size === 1) s = [...this.byThread.values()][0];
    return { steps: this.steps, usage: s ? s.sum : null };
  }
}

const TOOL_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'collab_agent_tool_call', 'view_image']);
function breakdown(v: unknown): CodexTurnUsage | null {
  const b = (v ?? {}) as Record<string, unknown>;
  if (typeof b.inputTokens !== 'number') return null;
  return { input: b.inputTokens, output: Number(b.outputTokens ?? 0), cached: Number(b.cachedInputTokens ?? 0), written: Number(b.cacheWriteInputTokens ?? 0) };
}
const sub = (a: CodexTurnUsage, b: CodexTurnUsage): CodexTurnUsage => ({ input: Math.max(0, a.input - b.input), output: Math.max(0, a.output - b.output), cached: Math.max(0, a.cached - b.cached), written: Math.max(0, a.written - b.written) });
const add = (a: CodexTurnUsage, b: CodexTurnUsage): CodexTurnUsage => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, written: a.written + b.written });
