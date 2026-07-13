import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONTINUE_PROMPT } from '../provider.js';
import { spawnJsonlTurn } from '../turn.js';
import type { TurnHandle, TurnOptions } from '../turn.js';
import type { AccountIdentity, ActivityEvent, ProviderAdapter } from '../provider.js';
import type { RawEvent, Verdict } from '../types.js';

/*
 * OpenAI `codex` CLI adapter (ChatGPT-plan / GPT models).
 *
 * The event model below was CAPTURED from codex-cli 0.144.3: the flag surface
 * (`codex exec --help`, `codex exec resume --help`), an unauthenticated
 * `codex exec --json` run (real thread/turn/error events), and the serde type
 * tags embedded in the shipped binary. What's confirmed vs. still-VERIFY:
 *
 *  CONFIRMED
 *   - `--json` emits flat JSONL, one event per line, dotted `type` names:
 *     thread.started {thread_id} · turn.started · turn.completed · turn.failed
 *     {error} · thread.failed · item.started/updated/completed {item:{id,type}}
 *   - The SESSION ID is `thread.started.thread_id` (codex assigns it — we don't
 *     dictate one; the manager must capture it to resume. See captureSessionId.)
 *   - Terminal success = turn.completed; terminal failure = turn.failed.
 *   - turn.failed reason codes include `usage_limit_exceeded` (the ChatGPT-plan
 *     limit), `context_window_exceeded`, `server_overloaded`, etc.
 *   - Pre-terminal `{type:"error", message:"Reconnecting… 401…"}` events are
 *     transient retry chatter — NOT a failover trigger (only turn.failed is).
 *   - item types: agent_message, reasoning, command_execution (command, cwd,
 *     exit_code, status, aggregated_output), file_change (changes),
 *     mcp_tool_call, web_search, todo_list, error.
 *   - argv: `exec [--json --dangerously-bypass-approvals-and-sandbox
 *     --skip-git-repo-check -m MODEL -c model_reasoning_effort=…] PROMPT`;
 *     resume: `exec resume SESSION_ID [same flags] PROMPT` (--json supported).
 *
 *  VERIFY (needs an AUTHENTICATED run — no ChatGPT creds in the build sandbox)
 *   - exact field carrying the turn.failed reason code (`error.code` vs `.type`)
 *   - the `rate_limits` object: presence, which event carries it, field casing
 *     (usedPercent/used_percent, resets_in_seconds, windowDurationMins)
 *   - whether item.started fires for commands or only item.completed
 *   - the agent_message item's text field name (final-answer text)
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

function startCodexTurn(opts: TurnOptions): TurnHandle {
  const flags = [
    '--json',
    // This gateway's container IS the sandbox, so run without codex's own.
    '--dangerously-bypass-approvals-and-sandbox',
    // Sessions run in arbitrary workspace dirs that may not be git repos.
    '--skip-git-repo-check',
    ...(opts.model ? ['-m', opts.model] : []),
    // TOML value; a bare word parses as a string. VERIFY the key name.
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
  // No pollable usage endpoint on ChatGPT plans — usage arrives inline on
  // turn.completed's rate_limits — so no fetchUsage (UI shows no bars for codex).
};
