import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readState, writeState } from './workspace-store.js';

/**
 * Delegates: an orchestrator conversation's workers, without the panel spam.
 *
 * The AHU "AI Progress Scoring" chat ran a team the only way the gateway then
 * allowed: 8 create_chat calls (8 chats in the sidebar), 74 send_chat_message
 * dispatches, 341 read_reply/read_chat/chat_status polls and 108 sleeps, and
 * each worker's report arrived as another turn. A delegate is the same worker
 * -- a real session, any provider and model, failover, context kept across
 * rounds -- but owned by its orchestrator the way the ChatGPT advisor's runs
 * are:
 *
 *   - it is NOT a project conversation: nothing in projects.json, so no
 *     sidebar row, strip entry, search hit or notification of its own;
 *   - its turns count as background work of the orchestrator conversation;
 *   - when a turn ends its final message is a REPORT. Jev gates it (done /
 *     needs the orchestrator / needs a person / blocked), and only what needs
 *     the orchestrator wakes it -- as ONE batched message, merged into any
 *     wake still waiting in its queue. No polling.
 *
 * Bounded, not approved (the owner chose that): at most MAX_DELEGATES per
 * orchestrator, one level deep (a delegate's x056 tools carry no identity of
 * its own, so it cannot delegate), and ROUND_LIMIT dispatches between two
 * human messages.
 */

export const MAX_DELEGATES = 8;
export const ROUND_LIMIT = 40;
export const REPORT_CLIP = 6000;

export type DelegateStatus = 'working' | 'idle' | 'failed' | 'stopped' | 'interrupted';
export type Gate = 'done' | 'needs_orchestrator' | 'needs_human' | 'blocked';

export interface Delegate {
  id: string;
  role: string;
  brief: string;
  provider: 'claude' | 'codex';
  model?: string;
  effort?: string;
  advisor?: boolean;
  /** Where it runs: a project's working directory (the orchestrator's by default). */
  projectId: string;
  cwd: string;
  /** The gateway's id for its CLI session; Codex's own thread id once known. */
  sessionId: string;
  providerSessionId?: string;
  status: DelegateStatus;
  createdAt: string;
  updatedAt: string;
  turns: number;
  /** Follow-ups that arrived while it was working, sent in order after. */
  pending: string[];
  account?: string;
  lastReport?: DelegateReport;
  /** Put away: hidden from the Delegates bar and out of the active limit, but
   *  kept with its reports and transcript. A follow-up revives it. `auto` =
   *  its DONE report was delivered and the orchestrator's turn on it ended. */
  dismissedAt?: string;
  dismissedBy?: 'auto' | 'user';
}

export interface DelegateReport {
  at: string;
  delegateId: string;
  role: string;
  turn: number;
  status: 'completed' | 'failed' | 'stopped' | 'interrupted';
  text: string;
  durationMs?: number;
  gate: Gate;
  gateConfidence?: number;
  /** Who gated it: Jev/OpenAI Decisions, a fixed rule, or nobody available. */
  gateBy: 'jev' | 'openai' | 'rule' | 'none';
  /** Whether the orchestrator has been handed this report. */
  woke: boolean;
  /** The queued wake message that carried it (absent on reports from before
   *  2026-10-02); once that item has left the queue the report was consumed. */
  queueId?: string;
}

interface Roster { parentProjectId: string; parentSessionId: string; delegates: Delegate[] }

const ID = /^[A-Za-z0-9_-]{1,80}$/; // a path segment: no separators, no dots

export class DelegateStore {
  private readonly dir: string;
  constructor(stateDir: string) { this.dir = join(stateDir, 'delegates'); }

  private file(parentSid: string) { return join(this.dir, parentSid + '.json'); }
  private reportsFile(parentSid: string) { return join(this.dir, parentSid + '.reports.jsonl'); }

  roster(parentPid: string, parentSid: string): Roster {
    if (!ID.test(parentSid)) throw new Error('invalid conversation id');
    return readState<Roster>(this.file(parentSid), { parentProjectId: parentPid, parentSessionId: parentSid, delegates: [] });
  }
  list(parentPid: string, parentSid: string): Delegate[] { return this.roster(parentPid, parentSid).delegates; }
  get(parentPid: string, parentSid: string, id: string): Delegate | undefined { return this.list(parentPid, parentSid).find((d) => d.id === id); }

  save(parentPid: string, parentSid: string, delegates: Delegate[]): void {
    mkdirSync(this.dir, { recursive: true });
    writeState(this.file(parentSid), { parentProjectId: parentPid, parentSessionId: parentSid, delegates });
  }
  update(parentPid: string, parentSid: string, id: string, patch: Partial<Delegate>): Delegate {
    const all = this.list(parentPid, parentSid);
    const d = all.find((x) => x.id === id);
    if (!d) throw new Error('unknown delegate ' + id);
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    this.save(parentPid, parentSid, all);
    return d;
  }

  reports(parentSid: string): DelegateReport[] {
    if (!ID.test(parentSid) || !existsSync(this.reportsFile(parentSid))) return [];
    try { return readFileSync(this.reportsFile(parentSid), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as DelegateReport); } catch { return []; }
  }
  addReport(parentSid: string, r: DelegateReport): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.reportsFile(parentSid), JSON.stringify(r) + '\n', { mode: 0o600 });
  }
  /** Mark reports as handed to the orchestrator. The log is small (one line
   *  per delegate turn), so it is rewritten whole, via a rename. */
  markWoke(parentSid: string, keys: Set<string>, queueId?: string): void {
    const all = this.reports(parentSid).map((r) => (keys.has(reportKey(r)) ? { ...r, woke: true, ...(queueId ? { queueId } : {}) } : r));
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.reportsFile(parentSid) + '.tmp';
    writeFileSync(tmp, all.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600 });
    renameSync(tmp, this.reportsFile(parentSid));
  }

  /** Whether this conversation has ever had a delegate (cheap: one stat). */
  has(parentSid: string): boolean { return ID.test(parentSid) && existsSync(this.file(parentSid)); }

  /** Every orchestrator with delegates, for boot-time recovery. */
  parents(): { parentProjectId: string; parentSessionId: string }[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => /^[A-Za-z0-9_-]{1,80}\.json$/.test(f)).map((f) => {
      const r = readState<Roster>(join(this.dir, f), { parentProjectId: '', parentSessionId: '', delegates: [] });
      return { parentProjectId: r.parentProjectId, parentSessionId: r.parentSessionId };
    }).filter((p) => p.parentProjectId && p.parentSessionId);
  }
}

/** Counts against the limit and holds its role name. */
export const isActive = (d: Pick<Delegate, 'status' | 'dismissedAt'>) => d.status !== 'stopped' && !d.dismissedAt;

/**
 * The auto-dismiss rule: a delegate is put away once its latest report was
 * gated DONE, handed to the orchestrator, and the message carrying it has left
 * the queue (dispatched) -- called when an orchestrator turn ends, so that
 * turn read it. Needs-orchestrator / needs-human / blocked reports stay: they
 * ask for action. A working delegate, or one with instructions waiting, stays.
 * `queuedIds` = the orchestrator's queue items still waiting; `delegateQueued`
 * = whether one of them is a delegate wake (for reports with no queueId).
 */
export function autoDismissible(d: Delegate, reports: Map<string, DelegateReport>, queuedIds: Set<string>, delegateQueued: boolean, working: boolean): boolean {
  if (d.dismissedAt || working || d.status !== 'idle' || d.pending.length || !d.lastReport) return false;
  const r = reports.get(reportKey(d.lastReport));
  if (!r || r.gate !== 'done' || !r.woke) return false;
  return r.queueId ? !queuedIds.has(r.queueId) : !delegateQueued;
}

export const reportKey = (r: Pick<DelegateReport, 'at' | 'delegateId'>) => r.delegateId + '@' + r.at;

/** Check what an orchestrator sent. */
export function checkRole(role: unknown): string {
  const r = String(role ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/.test(r)) throw new Error('role must be a short name (letters, digits, space, _ . -; up to 40 characters), e.g. "backend" or "reviewer"');
  return r;
}
export function checkBrief(brief: unknown, what = 'brief'): string {
  const b = String(brief ?? '').trim();
  if (!b) throw new Error(what + ' is required');
  if (b.length > 40_000) throw new Error(what + ' is too long (40,000 characters max): link files instead of pasting them');
  return b;
}

/** What a delegate is told about itself (appended to its system prompt). */
export function delegateInstructions(role: string): string {
  return [
    `DELEGATE MODE. You are "${role}", a worker delegated by an orchestrator conversation on this gateway. Your instructions come from the orchestrator (a person may occasionally step in); you do not talk to the user directly.`,
    'Work autonomously within your brief and keep your context: follow-ups continue the same task.',
    'Your final message of EVERY turn is your REPORT to the orchestrator. First line: one of DONE, NEEDS ORCHESTRATOR, NEEDS HUMAN or BLOCKED, then a one-line summary. Then the evidence: files changed, commands and their results, URLs, and exactly what you need if anything.',
    'Never end with a question block for the user; put what you need in the report. Do not deploy, push, or change shared or production systems unless your brief explicitly says so.',
    'You can read other conversations with the x056 tools, and message one when your brief calls for it (for example to hand a finding to the conversation that owns that code); report back to your orchestrator rather than coordinating the team yourself. You cannot start delegates of your own.',
  ].join('\n');
}

/** The Jev question that decides whether a report wakes the orchestrator. */
export const GATE_QUESTION = 'A worker agent just finished a turn and wrote this report for the orchestrator that assigned it the work. What does the report call for?';
export const GATE_OPTIONS: Record<Gate, string> = {
  done: 'It finished what it was asked. The report is informational; the orchestrator has nothing to do until the other workers finish.',
  needs_orchestrator: 'The orchestrator must act now: a decision, the next instruction, a conflict with the plan, or a result another worker needs.',
  needs_human: 'Only a person can unblock it: credentials or access, an approval, or a product or business decision.',
  blocked: 'It failed or cannot continue: errors it could not fix, missing inputs, or it stopped partway.',
};
export function gateState(d: Pick<Delegate, 'role' | 'brief'>, status: DelegateReport['status'], text: string): Record<string, string> {
  const t = text.trim();
  return {
    worker_role: d.role,
    worker_brief: d.brief.slice(0, 1500),
    turn_status: status,
    report_start: t.slice(0, 2500),
    report_end: t.length > 2500 ? t.slice(-1500) : '',
  };
}

/** Rules first (code decides what code can), then the model's answer if sure. */
export function decideGate(status: DelegateReport['status'], answer: { choice?: string; confidence?: number } | undefined, sharp: number): { gate: Gate; confidence?: number; by: DelegateReport['gateBy'] } {
  if (status !== 'completed') return { gate: 'blocked', by: 'rule' };
  if (!answer?.choice || !(answer.choice in GATE_OPTIONS)) return { gate: 'needs_orchestrator', by: 'none' };
  // A close call goes to the orchestrator, never to "done".
  if ((answer.confidence ?? 0) < sharp) return { gate: 'needs_orchestrator', confidence: answer.confidence, by: 'jev' };
  return { gate: answer.choice as Gate, confidence: answer.confidence, by: 'jev' };
}

/** Wake now, or let the report wait for the rest of the team. */
export function shouldWake(gate: Gate, othersWorking: boolean): boolean {
  if (gate === 'needs_orchestrator' || gate === 'blocked') return true;
  // "done" and "needs a person" are gathered until the whole team is quiet,
  // then handed over together -- one turn instead of one per worker.
  return !othersWorking;
}

const GATE_TITLE: Record<Gate, string> = { done: 'done', needs_orchestrator: 'needs you (orchestrator)', needs_human: 'needs a person', blocked: 'blocked' };

/** The one message that wakes the orchestrator for a batch of reports. */
export function digest(reports: DelegateReport[], roster: Delegate[]): string {
  const head = `[Delegates] ${reports.length} report${reports.length === 1 ? '' : 's'} from your delegates.`;
  const parts = reports.map((r) => {
    const d = roster.find((x) => x.id === r.delegateId);
    const who = d ? `${d.provider}${d.model ? ' · ' + d.model : ''}` : '';
    const clipped = r.text.length > REPORT_CLIP ? r.text.slice(0, REPORT_CLIP) + `\n… [${r.text.length - REPORT_CLIP} more characters: list_delegates {"id":"${r.delegateId}"} for the full report]` : r.text;
    return `## ${r.role} (${r.delegateId}) - ${GATE_TITLE[r.gate]}${r.gateConfidence != null ? ` (${Math.round(r.gateConfidence * 100)}%)` : ''}\n` +
      `<${who}${who ? ' · ' : ''}turn ${r.turn}${r.status !== 'completed' ? ' · ' + r.status : ''}>\n\n${clipped || '(no report text)'}`;
  });
  const state = roster.filter(isActive).map((d) => `${d.role} ${d.status}`).join(', ');
  return [head, ...parts, `Team now: ${state || 'none active'}. Continue one with delegate_followup, start another with delegate, or report to the user. Reports marked "needs a person" also reached the user as a notification.`].join('\n\n');
}
