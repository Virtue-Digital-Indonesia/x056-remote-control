import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawEvent } from '../src/types.js';

/**
 * The advisor for ChatGPT (Codex) conversations, built by the gateway because
 * Codex has none (0.156.1: no advisor tool, no equivalent config key).
 *
 * It mirrors Claude Code's advisor at the same three moments -- before a plan,
 * when the same error comes back, before "done" -- detected from the turn's
 * own event stream (`TurnWatcher`). A consultation is one read-only,
 * ephemeral `codex exec` on the strongest model the accounts offer, given a
 * condensed transcript of the turn and asked for a structured verdict.
 *
 * What happens to the advice is the manager's call: mid-turn advice that says
 * "adjust" is steered into the running turn; a post-turn "concern" becomes one
 * queued follow-up from the Advisor. `ephemeral` matters: without it every
 * consultation would write a rollout into the store all accounts share.
 */

export type AdvisorTrigger = 'plan' | 'stuck' | 'done';
export interface AdvisorConsult {
  at: string;
  sessionId: string;
  trigger: AdvisorTrigger;
  model: string;
  account?: string;
  verdict?: 'proceed' | 'adjust' | 'looks_good' | 'concern';
  advice?: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  /** What the gateway did with it. */
  delivered: 'steered' | 'queued' | 'none' | 'too-late';
  error?: string;
}

export interface ExecResult { code: number | null; lastMessage: string; stdout: string; timedOut?: boolean }
export type AdvisorExec = (configDir: string, args: string[], timeoutMs: number) => Promise<ExecResult>;

const QUESTIONS: Record<AdvisorTrigger, { ask: string; verdicts: [string, string] }> = {
  plan: { ask: 'The agent has just made its plan for this task. Is this the right approach? Use "proceed" if it is sound; "adjust" with the one concrete change it should make if not.', verdicts: ['proceed', 'adjust'] },
  stuck: { ask: 'A command keeps failing. Is the agent digging in the wrong place? Use "proceed" if its next step is still right; "adjust" with what to check or do instead.', verdicts: ['proceed', 'adjust'] },
  done: { ask: 'The agent has declared the task done. What did it miss? Use "looks_good" if nothing important is missing; "concern" with the specific gap it should fix.', verdicts: ['looks_good', 'concern'] },
};

export class CodexAdvisor {
  private readonly dir: string;
  constructor(stateDir: string, private readonly exec: AdvisorExec = defaultExec, private readonly timeoutMs = 180_000) {
    this.dir = join(stateDir, 'advisor');
  }

  consultations(sessionId: string): AdvisorConsult[] {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(sessionId)) return [];
    const f = join(this.dir, sessionId + '.jsonl');
    if (!existsSync(f)) return [];
    try { return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as AdvisorConsult); } catch { return []; }
  }
  record(c: AdvisorConsult): void {
    if (!/^[A-Za-z0-9-]{8,64}$/.test(c.sessionId)) return;
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, c.sessionId + '.jsonl'), JSON.stringify(c) + '\n', { mode: 0o600 });
  }

  /** One consultation. Never throws; `delivered` is filled in by the caller. */
  async consult(sessionId: string, input: { trigger: AdvisorTrigger; transcript: string; mainModel?: string; model: string; effort: string; configDir: string; account?: string }): Promise<AdvisorConsult> {
    const started = Date.now();
    const q = QUESTIONS[input.trigger];
    const base: AdvisorConsult = { at: new Date().toISOString(), sessionId, trigger: input.trigger, model: input.model, account: input.account, latencyMs: 0, delivered: 'none' };
    const work = mkdtempSync(join(tmpdir(), 'x056-advisor-'));
    try {
      const schema = join(work, 'schema.json'), out = join(work, 'out.json');
      writeFileSync(schema, JSON.stringify({ type: 'object', additionalProperties: false, required: ['verdict', 'advice'], properties: { verdict: { type: 'string', enum: q.verdicts }, advice: { type: 'string' } } }));
      const prompt = [
        `You are the ADVISOR to another coding agent (${input.mainModel || 'an OpenAI model'}). You do not act and you do not run tools; you read what it has done and advise.`,
        q.ask,
        'Be concrete and brief: at most 120 words. Name files, commands or checks. Answer only with the JSON the schema asks for.',
        '', 'TRANSCRIPT OF THE CURRENT TASK', input.transcript,
      ].join('\n');
      const args = ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-m', input.model,
        '-c', `model_reasoning_effort=${input.effort}`, '--output-schema', schema, '-o', out, prompt];
      const res = await this.exec(input.configDir, args, this.timeoutMs);
      const latencyMs = Date.now() - started;
      const usage = usageOf(res.stdout);
      if (res.timedOut) return { ...base, latencyMs, ...usage, error: `The advisor did not answer within ${Math.round(this.timeoutMs / 1000)} s` };
      let parsed: { verdict?: string; advice?: string } | undefined;
      try { parsed = JSON.parse(existsSync(out) ? readFileSync(out, 'utf8') : res.lastMessage); } catch { /* below */ }
      if (!parsed || !q.verdicts.includes(parsed.verdict ?? '') || typeof parsed.advice !== 'string') {
        return { ...base, latencyMs, ...usage, error: res.code ? `The advisor exited with code ${res.code}` : 'The advisor gave no usable answer' };
      }
      return { ...base, latencyMs, ...usage, verdict: parsed.verdict as AdvisorConsult['verdict'], advice: parsed.advice.trim().slice(0, 2000) };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}

function usageOf(stdout: string): { inputTokens?: number; outputTokens?: number } {
  for (const line of stdout.split('\n').reverse()) {
    if (!line.includes('turn.completed')) continue;
    try { const u = (JSON.parse(line) as { usage?: { input_tokens?: number; output_tokens?: number } }).usage; if (u) return { inputTokens: u.input_tokens, outputTokens: u.output_tokens }; } catch { /* next */ }
  }
  return {};
}

const defaultExec: AdvisorExec = (configDir, args, timeoutMs) => new Promise((resolve) => {
  // cwd is a scratch dir so the advisor never loads the project's AGENTS.md
  // as instructions -- it is reading the task, not joining it.
  const child = spawn('codex', args, { cwd: tmpdir(), env: { ...process.env, CODEX_HOME: configDir }, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  let stdout = '';
  child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 4_000_000) stdout += d.toString(); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, lastMessage: '', timedOut }); });
  child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, lastMessage: '', timedOut }); });
});

/**
 * Watches one turn's events (the flat `codex exec --json` shape the Codex
 * transport already produces) and says when to consult. At most `cap`
 * consultations per turn, and each trigger fires once.
 */
export class TurnWatcher {
  private lines: string[] = [];
  private fired = new Set<string>();
  private failures = new Map<string, number>();
  private consecutiveFailures = 0;
  private count = 0;
  constructor(request: string, private readonly onTrigger: (trigger: AdvisorTrigger, transcript: string) => void, private readonly opts: { reviewDone: boolean; cap?: number } = { reviewDone: true }) {
    this.lines.push('USER REQUEST: ' + clip(request, 4000));
  }

  observe(e: RawEvent): void {
    const t = String(e.type ?? '');
    if (t === 'turn.completed') { if (this.opts.reviewDone) this.fire('done'); return; }
    if (t !== 'item.completed') return;
    const it = (e.item ?? {}) as Record<string, unknown>;
    switch (String(it.type ?? '')) {
      case 'agent_message': this.lines.push('AGENT: ' + clip(String(it.text ?? ''), 1500)); break;
      case 'reasoning': break;
      case 'plan': case 'todo_list': {
        const items = Array.isArray(it.items) ? (it.items as { text?: string; step?: string; completed?: boolean; status?: string }[]).map((x) => '- ' + (x.text ?? x.step ?? '')).join('\n') : clip(String(it.text ?? ''), 1500);
        this.lines.push('AGENT PLAN:\n' + items);
        this.fire('plan');
        break;
      }
      case 'command_execution': {
        const cmd = Array.isArray(it.command) ? (it.command as unknown[]).map(String).join(' ') : String(it.command ?? '');
        const code = typeof it.exit_code === 'number' ? it.exit_code : undefined;
        this.lines.push(`AGENT RAN: ${clip(cmd, 400)} -> exit ${code ?? '?'}\n` + clip(String(it.aggregated_output ?? ''), 600));
        if (code !== undefined && code !== 0) {
          const key = cmd.replace(/\s+/g, ' ').trim();
          const n = (this.failures.get(key) ?? 0) + 1;
          this.failures.set(key, n);
          this.consecutiveFailures++;
          if (n >= 2 || this.consecutiveFailures >= 3) this.fire('stuck');
        } else if (code === 0) this.consecutiveFailures = 0;
        break;
      }
      case 'file_change': {
        const files = Array.isArray(it.changes) ? (it.changes as { path?: string }[]).map((c) => c.path).filter(Boolean).join(', ') : '';
        this.lines.push('AGENT EDITED: ' + clip(files, 600));
        break;
      }
      default: break;
    }
  }

  transcript(): string {
    // Keep the request and the most recent work; the middle goes first.
    let out = this.lines.join('\n\n');
    if (out.length <= 40_000) return out;
    const head = this.lines[0];
    const tail: string[] = [];
    let size = head.length;
    for (let i = this.lines.length - 1; i > 0 && size + this.lines[i].length < 38_000; i--) { tail.unshift(this.lines[i]); size += this.lines[i].length; }
    out = [head, '[… earlier steps omitted …]', ...tail].join('\n\n');
    return out;
  }

  private fire(trigger: AdvisorTrigger): void {
    if (this.fired.has(trigger) || this.count >= (this.opts.cap ?? 3)) return;
    this.fired.add(trigger); this.count++;
    this.onTrigger(trigger, this.transcript());
  }
}

function clip(s: string, n: number): string { return s.length > n ? s.slice(0, n) + ` … [+${s.length - n} chars]` : s; }
