import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { ForkDecision, JevDecision } from './jev.js';

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
