import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ForkDecision, JevDecision } from './jev.js';
import { stripMemoryContext } from '../src/memory-context.js';
import { stripTeamLine } from '../src/message-sender.js';

/**
 * The agent tree: one conversation's whole working setup at a glance -- the
 * main session, its advisor, the Jev fork layer, its workers (team subagents
 * and delegates) and what just passed between them.
 *
 * Built from cheap reads only (log TAILS, the delegate roster, turn results),
 * because the view polls it. The subagent list is NOT part of it: that scan
 * does per-file stats and once blocked the event loop at a 5 s poll; the view
 * reads it from its own endpoint.
 */

const ID = /^[A-Za-z0-9_-]{1,80}$/;

/** The last `n` JSON lines of a file, reading at most `maxBytes` from its end.
 *  The fork and decision logs grow without bound; the tree only needs recent. */
export function tailJsonl<T>(file: string, n: number, maxBytes = 512 * 1024): T[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (len < size) lines.shift(); // the first line was cut by the window
    const out: T[] = [];
    for (const l of lines.filter(Boolean).slice(-n)) { try { out.push(JSON.parse(l) as T); } catch { /* a partial line */ } }
    return out;
  } finally { closeSync(fd); }
}

/** Claude's advisor calls, as the turn's own stream shows them. The advice is
 *  encrypted and the timing model-driven, so a call and its outcome are all
 *  there is to log. Main session only: calls made inside subagents land in
 *  their own transcripts. Logged from 2026-09-30 on. */
export interface ClaudeAdvisorCall { at: string; model: string; status: string; error?: string }
export class ClaudeAdvisorLog {
  private readonly dir: string;
  constructor(stateDir: string) { this.dir = join(stateDir, 'advisor'); }
  record(sessionId: string, call: ClaudeAdvisorCall): void {
    if (!ID.test(sessionId)) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, sessionId + '.claude.jsonl'), JSON.stringify(call) + '\n', { mode: 0o600 });
  }
  tail(sessionId: string, n = 20): ClaudeAdvisorCall[] {
    return ID.test(sessionId) ? tailJsonl<ClaudeAdvisorCall>(join(this.dir, sessionId + '.claude.jsonl'), n) : [];
  }
}

/** The delegate report gate writes into the fork log too, labelled like this.
 *  It is not a fork: counting it would inflate the fork layer's numbers. */
export const isGate = (f: Pick<ForkDecision, 'question'>) => /^report gate · /.test(f.question || '');

export function forkSummary(recent: ForkDecision[]): { total: number; sharp: number; split: number; recent: ForkDecision[]; gates: ForkDecision[] } {
  const forks = recent.filter((f) => !isGate(f)), gates = recent.filter(isGate);
  return {
    total: forks.length,
    sharp: forks.filter((f) => f.verdict === 'sharp').length,
    split: forks.filter((f) => f.verdict !== 'sharp').length,
    recent: forks.slice(-12),
    gates: gates.slice(-12),
  };
}

/** What the main session runs with this turn: a pick made for it wins over the
 *  saved choice. `turnStartedAt` separates this turn's pick from older ones. */
export function mainRun(saved: { model?: string; effort?: string }, picks: JevDecision[], turnStartedAt?: string): { model?: string; effort?: string; pickedBy?: 'jev' | 'openai'; lean?: 'low' | 'high' } {
  const pick = turnStartedAt ? [...picks].reverse().find((d) => d.at >= turnStartedAt && !d.error) : undefined;
  if (!pick) return { model: saved.model || undefined, effort: saved.effort || undefined };
  return {
    model: pick.model ?? pick.baseModel ?? (saved.model || undefined),
    effort: pick.effort ?? pick.baseEffort ?? (saved.effort || undefined),
    pickedBy: pick.backend === 'openai' ? 'openai' : 'jev',
    ...(pick.lean ? { lean: pick.lean } : {}),
  };
}

/** What the agent team's subagents run with: this turn's team pick when the
 *  picker made one (the latest, when no turn start is known), else the fixed
 *  default -- Opus at medium on Claude, the main model at medium on Codex. */
export function teamRun(provider: 'claude' | 'codex', picks: JevDecision[], turnStartedAt?: string): { model?: string; effort: string; pickedBy?: 'jev' | 'openai'; confidence?: number; roles: string[] } {
  const roles = provider === 'claude' ? ['explorer', 'worker', 'researcher'] : ['explorer', 'worker', 'default'];
  const pick = [...picks].reverse().find((d) => !d.error && d.team && (!turnStartedAt || d.at >= turnStartedAt));
  if (!pick?.team) return { effort: 'medium', model: provider === 'claude' ? 'opus' : undefined, roles };
  const t = pick.team;
  const confidence = t.effort !== t.base.effort ? t.effortConfidence : t.model !== t.base.model ? t.modelConfidence : t.effortConfidence ?? t.modelConfidence;
  return { ...(t.model ? { model: t.model } : {}), effort: t.effort, pickedBy: pick.backend === 'openai' ? 'openai' : 'jev', ...(confidence != null ? { confidence } : {}), roles };
}

/** A subagent's status, as the tree's contract spells it: `done` only with a
 *  result, `failed` / `stopped` / `ended` for the ways it can end without
 *  one, `running` only on live evidence. */
export type SubagentStatus = 'running' | 'done' | 'failed' | 'stopped' | 'ended' | 'unknown';

/**
 * A Claude subagent's status from its Task record (the transcript fold in
 * transcript-stats.ts), the live process's own view of it (`subagentRunning`:
 * true / false / undefined = not tracked), whether a gateway turn runs, and
 * whether its transcript was written to recently.
 *
 *  - The process saying it runs wins: a subagent that outlives its parent
 *    turn used to read "stopped".
 *  - A finished record is final (the fold already told done from failed,
 *    stopped and ended).
 *  - A background agent's launch ack is not an ending; it runs until its
 *    task-notification, as long as its transcript is fresh. That does NOT
 *    need a gateway turn -- a turn ending is exactly when these keep going.
 *  - A sync Task with no result runs only inside a live turn, else it never
 *    came back.
 */
export function claudeSubagentStatus(
  task: { done: boolean; outcome?: string; isError?: boolean; async?: boolean } | undefined,
  live: boolean | undefined,
  turnRunning: boolean,
  fresh: boolean,
): SubagentStatus {
  if (live === true) return 'running';
  if (task?.done) {
    const o = task.outcome;
    return o === 'done' || o === 'failed' || o === 'stopped' || o === 'ended' ? o : task.isError ? 'failed' : 'done';
  }
  if (task?.async || task?.outcome === 'running') return fresh ? 'running' : 'stopped';
  if (task) return turnRunning && fresh ? 'running' : 'stopped';
  return turnRunning && fresh ? 'running' : 'unknown';
}

/** One turn of a conversation, for the tree's per-turn view. */
export interface TurnWindow {
  /** 1-based position in the returned window. No absolute index: the journal
   *  keeps its last 200 rows, so no count it could give would be true. */
  n: number;
  messageId?: string;
  startedAt: string;
  endedAt: string | null;
  prompt: string;
  running: boolean;
}

type Instant = string | number | null | undefined;
const instant = (v: Instant): number => (v == null || v === '' ? NaN : typeof v === 'number' ? v : Date.parse(v));

/**
 * The turn membership rule, pinned here so the panel and the tests agree:
 * a node belongs to a turn iff it started before the turn ended, AND it is
 * still running or it ended (else was last written) at or after the turn
 * began. So work spanning turns shows in each of them, and a background
 * agent still running shows in the turn it outlived. Times are ISO strings
 * or epoch ms, mixed freely.
 */
export function inTurn(
  node: { startedAt?: Instant; endedAt?: Instant; updatedAt?: Instant; status?: string },
  turn: { startedAt: Instant; endedAt?: Instant },
): boolean {
  const turnEnd = turn.endedAt == null ? Infinity : instant(turn.endedAt);
  if (!(instant(node.startedAt) < turnEnd)) return false;
  if (node.status === 'running') return true;
  return instant(node.endedAt ?? node.updatedAt) >= instant(turn.startedAt);
}

/**
 * The conversation's turns, oldest first, at most `limit`: each gateway
 * turn's prompt is a journal `user` row. A turn ends where the next begins;
 * the last one is open while a turn runs, else ends at the first recorded
 * turn end after it began, else at `fallbackEnd` (the latest thing known to
 * have happened after it), else stays open.
 */
export function buildTurns(
  rows: { role: string; ts?: string; text: string; messageId?: string; steered?: boolean }[],
  ends: string[],
  running: boolean,
  fallbackEnd?: string,
  limit = 50,
): TurnWindow[] {
  const prompts = rows.filter((r) => r.role === 'user' && !r.steered && r.ts && Number.isFinite(Date.parse(r.ts)))
    .sort((a, b) => Date.parse(a.ts!) - Date.parse(b.ts!))
    .slice(-limit);
  return prompts.map((r, i) => {
    const next = prompts[i + 1];
    let endedAt: string | null = next ? next.ts! : null;
    if (!next && !running) {
      const start = Date.parse(r.ts!);
      endedAt = ends.filter((e) => Date.parse(e) >= start).sort((a, b) => Date.parse(a) - Date.parse(b))[0]
        // Strictly after: the fallback may be this very prompt's row.
        ?? (fallbackEnd && Date.parse(fallbackEnd) > start ? fallbackEnd : null);
    }
    // displayPrompt is cleaned when it is journalled; older rows predate the
    // team line, so strip what is cheap to strip again.
    const prompt = stripMemoryContext(stripTeamLine(r.text)).replace(/\s+/g, ' ').trim();
    return {
      n: i + 1,
      ...(r.messageId ? { messageId: r.messageId } : {}),
      startedAt: r.ts!,
      endedAt,
      prompt: prompt.length > 140 ? prompt.slice(0, 139) + '…' : prompt,
      running: !next && running,
    };
  });
}
