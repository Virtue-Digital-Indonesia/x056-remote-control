import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTINUE_PROMPT } from '../provider.js';
import { stripAsk, stripAskInstructions } from '../question.js';
import { spawnJsonlTurn } from '../turn.js';
import type { TurnHandle, TurnOptions } from '../turn.js';
import type { AccountIdentity, ActivityEvent, HistoryEntry, ProviderAdapter, ProviderModel } from '../provider.js';
import type { RawEvent, Verdict } from '../types.js';

/*
 * OpenAI `codex` CLI adapter (ChatGPT-plan / GPT models).
 *
 * The event model below is CONFIRMED against codex-cli 0.144.3 with a real
 * ChatGPT login: the flag surface, an authenticated `codex exec --json` run
 * (agent_message + command_execution + turn.completed), and a verified
 * `codex exec resume <thread_id>` that continued the session with full context.
 *
 *  CONFIRMED (authenticated capture)
 *   - `--json` emits flat JSONL, dotted `type` names: thread.started {thread_id}
 *     · turn.started · item.started/completed {item:{id,type,…}} · turn.completed
 *     {usage:{input_tokens,output_tokens,cached_input_tokens,reasoning_output_tokens}}.
 *   - SESSION ID = `thread.started.thread_id`; codex ASSIGNS it (no id we dictate).
 *     `exec resume <thread_id>` resumes the same thread with context intact.
 *   - agent_message item: `item.text` (arrives as item.completed, no item.started).
 *   - command_execution item: `command` is a STRING, plus cwd/exit_code/status
 *     ("in_progress"→"completed"); emits BOTH item.started and item.completed.
 *   - Terminal success = turn.completed. Failure = turn.failed {error}.
 *   - Pre-terminal `{type:"error", message:"Reconnecting… 401…"}` is transient
 *     retry chatter — NOT a failover trigger (only turn.failed is).
 *   - Sessions persist at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<id>.jsonl.
 *
 *  VERIFY (couldn't be triggered on a healthy authed turn — needs the condition)
 *   - `rate_limits` was ABSENT from a normal turn.completed (only token `usage`
 *     was present) — it likely only appears near/at a limit; field casing and
 *     which event still unconfirmed, so the near-limit `warning` path is dormant
 *     until then (safe: it no-ops when the object is absent).
 *   - the exact turn.failed reason-code field (`error.code` vs `.type`) for
 *     `usage_limit_exceeded` — matched by code OR message regex either way.
 */

function evType(e: RawEvent): string {
  return typeof e.type === 'string' ? e.type : '';
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function firstStr(...vals: unknown[]): string {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return '';
}
function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function base(path: unknown): string {
  const s = typeof path === 'string' ? path : '';
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

// `usage_limit_exceeded`/`rate_limit_exceeded` (codes) AND free-text limit phrasing.
const LIMIT_RE = /rate.?limit|usage.?limit|quota|limit reached|limit_exceeded|too many requests|\b429\b/i;
const AUTH_RE = /not logged in|unauthor|unauthenticated|\b401\b|please (run )?.*login|sign in|invalid api key|no api key/i;

/** Codex reports usage as a rolling-window meter (rate_limits.primary). Field
 *  casing is unconfirmed, so read snake_case and camelCase. VERIFY on a real run. */
function rateLimits(e: RawEvent): Record<string, unknown> {
  const rl = asObj(e.rate_limits ?? (asObj(e.usage).rate_limits as unknown) ?? e.rateLimits);
  return asObj(rl.primary);
}
function resetsInSeconds(e: RawEvent): number | undefined {
  const p = rateLimits(e);
  const secs = p.resets_in_seconds ?? p.resetsInSeconds;
  return typeof secs === 'number' && secs > 0 ? Math.floor(secs) : undefined;
}
function usedPercent(e: RawEvent): number | undefined {
  const p = rateLimits(e);
  const pct = p.used_percent ?? p.usedPercent;
  return typeof pct === 'number' ? pct : undefined;
}

export function classifyCodexEvent(e: RawEvent): Verdict {
  const t = evType(e);

  // The one authoritative terminal-failure event carries the real reason.
  if (t === 'turn.failed' || t === 'thread.failed') {
    const err = asObj(e.error);
    const code = firstStr(err.code, err.type, typeof e.error === 'string' ? e.error : '');
    const msg = firstStr(err.message, e.message);
    if (code === 'usage_limit_exceeded' || LIMIT_RE.test(code) || LIMIT_RE.test(msg)) {
      return { kind: 'limited', resetsInSeconds: resetsInSeconds(e), source: 'codex_turn_failed' };
    }
    if (AUTH_RE.test(code) || AUTH_RE.test(msg)) {
      return { kind: 'auth_required', source: 'codex_turn_failed' };
    }
    // context_window_exceeded / server_overloaded / internal_server_error / … —
    // real failures, but not a "switch accounts" limit; the turn just fails.
    return { kind: 'irrelevant', source: 'codex_turn_failed' };
  }

  // A usage meter already at/over the cap is a near-limit warning (mirrors
  // Claude's allowed_warning): the turn finished, but the next may be rejected.
  if (t === 'turn.completed') {
    const pct = usedPercent(e);
    if (pct != null && pct >= 100) return { kind: 'warning', resetsInSeconds: resetsInSeconds(e), source: 'codex_rate_limits' };
  }

  // Pre-terminal reconnect chatter (`{type:"error", message:"Reconnecting…"}`)
  // is a retry, not quota exhaustion — like Claude's api_retry. Never fail over.
  if (t === 'error') return { kind: 'transient', source: 'codex_reconnect' };

  return { kind: 'irrelevant', source: 'none' };
}

function changePaths(changes: unknown): string[] {
  if (Array.isArray(changes)) return changes.map((c) => firstStr((asObj(c)).path, typeof c === 'string' ? c : '')).filter(Boolean);
  if (changes && typeof changes === 'object') return Object.keys(changes as object);
  return [];
}

/** Map one raw Codex event to zero+ UI activity rows. Codex surfaces tools as
 *  thread ITEMS (item.started → running, item.completed → done), so pair them by
 *  item id, mirroring the Claude adapter's start/done/error rows. */
function toActivity(e: RawEvent): ActivityEvent[] {
  const t = evType(e);
  if (t !== 'item.started' && t !== 'item.completed') return [];
  const it = asObj(e.item);
  const id = firstStr(it.id, it.call_id);
  const started = t === 'item.started';
  const row = (tool: string, label: string, status: ActivityEvent['status']): ActivityEvent[] => [
    { toolUseId: id, parentToolUseId: null, tool, label, status, isSubagent: false },
  ];
  const failed = it.status === 'failed' || (typeof it.exit_code === 'number' && it.exit_code !== 0) || Boolean(it.error);

  switch (firstStr(it.type)) {
    case 'command_execution': {
      if (started) {
        const cmd = Array.isArray(it.command) ? (it.command as unknown[]).map(String).join(' ') : String(it.command ?? '');
        return row('Bash', 'Running: ' + truncate(cmd), 'start');
      }
      return row('', '', failed ? 'error' : 'done');
    }
    case 'file_change': {
      if (started) {
        const files = changePaths(it.changes);
        const label = files.length ? 'Editing ' + base(files[0]) + (files.length > 1 ? ` (+${files.length - 1})` : '') : 'Applying changes';
        return row('Edit', label, 'start');
      }
      return row('', '', failed ? 'error' : 'done');
    }
    case 'mcp_tool_call': {
      const name = firstStr(it.tool, it.server, 'tool');
      return started ? row(name, 'Tool: ' + truncate(name), 'start') : row('', '', failed ? 'error' : 'done');
    }
    case 'web_search':
      return started ? row('WebSearch', 'Searching the web: ' + truncate(firstStr(it.query)), 'start') : row('', '', 'done');
    default:
      // agent_message / reasoning / todo_list / error — text, not a tool row.
      return [];
  }
}

/** The assistant's displayable text — codex streams it as `agent_message`
 *  items. VERIFY the text field name against an authed run (`text` vs `message`). */
function assistantText(e: RawEvent): string[] {
  if (evType(e) !== 'item.completed') return [];
  const it = asObj(e.item);
  if (firstStr(it.type) !== 'agent_message') return [];
  const text = firstStr(it.text, it.message);
  return text ? [text] : [];
}

/** The session id codex assigned (thread.started.thread_id). The manager reads
 *  this off the stream on a NEW turn — unlike Claude, codex won't take an id we
 *  dictate — and later passes it to `exec resume <id>` for failover. Returns ''
 *  for any other event. */
export function captureSessionId(e: RawEvent): string {
  return evType(e) === 'thread.started' ? firstStr(e.thread_id) : '';
}

/** Read the ChatGPT identity from $CODEX_HOME/auth.json. For a ChatGPT login the
 *  email is in the id_token JWT payload; API-key logins have none. VERIFY exact
 *  fields. Best-effort — returns {} on any miss, never throws. */
function readIdentity(configDir: string): AccountIdentity {
  try {
    const auth = JSON.parse(readFileSync(join(configDir, 'auth.json'), 'utf8')) as {
      tokens?: { id_token?: string; account_id?: string };
      email?: string;
    };
    if (auth.email) return { email: auth.email };
    const idToken = auth.tokens?.id_token;
    if (idToken) {
      const payload = idToken.split('.')[1];
      if (payload) {
        const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
          email?: string; name?: string;
          'https://api.openai.com/profile'?: { email?: string };
        };
        const email = claims.email ?? claims['https://api.openai.com/profile']?.email;
        if (email) return { email, displayName: claims.name };
      }
    }
  } catch {
    // no/garbled auth.json — no identity to show
  }
  return {};
}

/** Locate a thread's rollout file — $CODEX_HOME/sessions/YYYY/MM/DD/
 *  rollout-<timestamp>-<thread_id>.jsonl (confirmed via a real authed run: see
 *  the adapter header). The thread id is the FILENAME's suffix, not embedded
 *  content to grep for, so match on that. */
function findRollout(configDirs: string[], providerSessionId: string): string | null {
  const suffix = `-${providerSessionId}.jsonl`;
  for (const configDir of configDirs) {
    const sessions = join(configDir, 'sessions');
    if (!existsSync(sessions)) continue;
    let names: string[];
    try {
      names = readdirSync(sessions, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(suffix)) return join(sessions, name);
    }
  }
  return null;
}

/**
 * Read the human-readable conversation (user prompts + assistant replies) from
 * a thread's rollout file. The rollout is an append-only log of the WHOLE
 * thread (every resume keeps writing to the same file), so this reconstructs
 * the full history across failovers/continuations, not just one turn.
 *
 * Confirmed against real rollouts (both a normal run and a failed one — see the
 * adapter header): each line is `{timestamp, type, payload}`; the two payload
 * shapes that matter here are `event_msg` with `payload.type === "user_message"`
 * (the prompt, in `payload.message`) and `payload.type === "task_complete"` (the
 * turn's final answer, in `payload.last_agent_message` — null when the turn
 * ended without producing one, e.g. it crashed first).
 */
function readHistory(configDirs: string[], providerSessionId: string, limit = 100): HistoryEntry[] {
  const file = findRollout(configDirs, providerSessionId);
  if (!file) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let entry: { timestamp?: unknown; type?: unknown; payload?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'event_msg') continue;
    const payload = asObj(entry.payload);
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    if (payload.type === 'user_message' && typeof payload.message === 'string') {
      const shown = stripAskInstructions(payload.message.trim());
      if (shown) out.push({ role: 'user', text: shown, ts });
    } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
      const shown = stripAsk(payload.last_agent_message.trim());
      if (shown) out.push({ role: 'assistant', text: shown, ts });
    }
  }
  return out.slice(-limit);
}

/** The models this ChatGPT account can use. Codex caches the account's own
 *  catalog at $CODEX_HOME/models_cache.json (fetched from the API), so read that
 *  rather than hardcode ids — it stays correct per-account and as OpenAI ships
 *  new models. `visibility: "list"` is the catalog's own "show this to the user"
 *  flag (internal entries like codex-auto-review are marked "hide"). */
function listModels(configDir: string): ProviderModel[] {
  try {
    const cache = JSON.parse(readFileSync(join(configDir, 'models_cache.json'), 'utf8')) as {
      models?: {
        slug?: string; display_name?: string; description?: string; visibility?: string;
        default_reasoning_level?: string;
        supported_reasoning_levels?: { effort?: string }[];
      }[];
    };
    return (cache.models ?? [])
      .filter((m) => m.slug && m.visibility === 'list')
      .map((m) => ({
        slug: m.slug as string,
        label: m.display_name || (m.slug as string),
        description: m.description,
        efforts: (m.supported_reasoning_levels ?? []).map((e) => e.effort).filter((e): e is string => !!e),
        defaultEffort: m.default_reasoning_level,
      }));
  } catch {
    // no cache yet (account never ran a turn) — the UI falls back to Auto only
    return [];
  }
}

function startCodexTurn(opts: TurnOptions): TurnHandle {
  const flags = [
    '--json',
    // This gateway's container IS the sandbox, so run without codex's own.
    '--dangerously-bypass-approvals-and-sandbox',
    // Sessions run in arbitrary workspace dirs that may not be git repos.
    '--skip-git-repo-check',
    ...(opts.model ? ['-m', opts.model] : []),
    // Confirmed against a real authenticated run: the resulting rollout's
    // turn_context.collaboration_mode.settings.reasoning_effort held the exact
    // value passed here (tested "high" and "ultra" — a level only some GPT
    // models support, e.g. gpt-5.6-sol; Claude has no equivalent).
    ...(opts.effort ? ['-c', `model_reasoning_effort="${opts.effort}"`] : []),
  ];
  // NEW: codex assigns the thread id (surfaced via captureSessionId).
  // RESUME: `exec resume <id>` continues that thread on this account's CODEX_HOME.
  const args =
    opts.mode === 'resume'
      ? ['exec', 'resume', opts.sessionId, ...flags, opts.prompt]
      : ['exec', ...flags, opts.prompt];
  return spawnJsonlTurn(
    opts.binPath ?? 'codex',
    args,
    opts.cwd,
    { ...process.env, CODEX_HOME: opts.configDir },
    opts.onEvent,
  );
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',
  label: 'ChatGPT (Codex)',
  configEnvVar: 'CODEX_HOME',
  continuePrompt: DEFAULT_CONTINUE_PROMPT,

  startTurn: startCodexTurn,
  captureSessionId,

  classify: classifyCodexEvent,
  isResult: (e) => evType(e) === 'turn.completed',
  resultOk: (e) => evType(e) === 'turn.completed',
  // The final answer streams as agent_message ITEMS, not a field on
  // turn.completed, so there's no single result string to return here — the UI
  // shows the text from the item stream (the manager's tap). VERIFY.
  resultText: () => undefined,
  // A completed item (tool round) or the completed turn is a resumable point.
  isDrainBoundary: (e) => evType(e) === 'item.completed' || evType(e) === 'turn.completed',
  toActivity,
  assistantText,
  // Codex doesn't stamp a per-event model on the stream the way Claude does; the
  // UI shows the model the project requested. (activeModel intentionally omitted.)

  readIdentity,
  listModels,
  readHistory,
  // No pollable usage endpoint on ChatGPT plans — usage arrives inline on
  // turn.completed's rate_limits — so no fetchUsage (UI shows no bars for codex).
};
