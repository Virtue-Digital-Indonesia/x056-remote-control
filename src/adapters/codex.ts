import { spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { Usage } from '../quota.js';
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
 *  ALSO CONFIRMED: `codex app-server` (JSON-RPC/stdio) `account/rateLimits/read`
 *  returns the account's real usage meters (camelCase: usedPercent,
 *  windowDurationMins, resetsAt absolute unix secs, planType) — the basis of
 *  fetchUsage below, verified live against a team-plan login.
 *
 *  VERIFY (couldn't be triggered on a healthy authed turn — needs the condition)
 *   - whether/where the STREAM carries rate_limits near a limit; classify()
 *     accepts it on any event, both casings, so wherever it lands it's caught.
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

/** Codex reports usage as a rolling-window meter (rate_limits.primary). The
 *  authoritative shape is CONFIRMED from the app-server's account/rateLimits/read
 *  (camelCase: usedPercent, windowDurationMins, resetsAt = ABSOLUTE unix secs,
 *  rateLimitReachedType) — the stream may carry the snake_case variant
 *  (resets_in_seconds relative), so read both. */
function rateLimits(e: RawEvent): Record<string, unknown> {
  const rl = asObj(e.rate_limits ?? (asObj(e.usage).rate_limits as unknown) ?? e.rateLimits);
  return asObj(rl.primary);
}
function resetsInSeconds(e: RawEvent): number | undefined {
  const p = rateLimits(e);
  const secs = p.resets_in_seconds ?? p.resetsInSeconds;
  return typeof secs === 'number' && secs > 0 ? Math.floor(secs) : undefined;
}
function resetsAtAbs(e: RawEvent): number | undefined {
  const p = rateLimits(e);
  const at = p.resets_at ?? p.resetsAt;
  return typeof at === 'number' && at > 0 ? Math.floor(at) : undefined;
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
      return { kind: 'limited', resetsAt: resetsAtAbs(e), resetsInSeconds: resetsInSeconds(e), source: 'codex_turn_failed' };
    }
    if (AUTH_RE.test(code) || AUTH_RE.test(msg)) {
      return { kind: 'auth_required', source: 'codex_turn_failed' };
    }
    // context_window_exceeded / server_overloaded / internal_server_error / … —
    // real failures, but not a "switch accounts" limit; the turn just fails.
    return { kind: 'irrelevant', source: 'codex_turn_failed' };
  }

  // A usage meter at/over the cap is a near-limit warning (mirrors Claude's
  // allowed_warning): the current turn keeps going, but the next may be
  // rejected. Checked on ANY event carrying rate_limits — healthy turns don't
  // carry the object at all (confirmed live), so wherever codex chooses to
  // surface it near the limit, this catches it rather than betting on one
  // event type.
  const pct = usedPercent(e);
  if (pct != null && pct >= 100 && t !== 'error') {
    return { kind: 'warning', resetsAt: resetsAtAbs(e), resetsInSeconds: resetsInSeconds(e), source: 'codex_rate_limits' };
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
  return readHistoryPage(configDirs, providerSessionId, limit).rows;
}

/** Start small (most reads want a handful of recent messages) and widen. */
const TAIL_START_BYTES = 1 << 20; // 1 MB
const TAIL_MAX_BYTES = 1 << 27; // 128 MB — far under V8's max string length
/** Extra bytes read BEFORE the page window, parsed only to recover the
 *  `lastAssistant` dedup state (see below). Never returned as rows. */
const DEDUP_CONTEXT_BYTES = 1 << 18; // 256 KB

/**
 * A page of history ending just before byte offset `before` (default: end of
 * file). Paged by byte offset so scrolling far back never reads the whole
 * rollout — these are append-only across every resume and grow without bound.
 *
 * Codex's parse is STATEFUL: a `task_complete` is dropped when it merely
 * repeats the preceding `agent_message`. A page boundary landing between that
 * pair would lose that context and emit a duplicate, so each window is parsed
 * with a short run-up whose rows are discarded — they exist only to restore
 * `lastAssistant`.
 */
export function readHistoryPage(
  configDirs: string[], providerSessionId: string, limit = 100, before?: number,
): { rows: HistoryEntry[]; cursor: number; done: boolean } {
  const file = findRollout(configDirs, providerSessionId);
  if (!file) return { rows: [], cursor: 0, done: true };
  let size: number;
  try { size = statSync(file).size; } catch { return { rows: [], cursor: 0, done: true }; }
  const end = before === undefined ? size : Math.max(0, Math.min(before, size));
  if (end <= 0) return { rows: [], cursor: 0, done: true };
  let window = Math.min(TAIL_START_BYTES, end);
  for (;;) {
    const start = Math.max(0, end - window);
    const from = Math.max(0, start - DEDUP_CONTEXT_BYTES);
    const parsed = parseRollout(readLines(file, from, end), start);
    const atStart = start === 0;
    if (parsed.rows.length >= limit || atStart || window >= TAIL_MAX_BYTES) {
      const cut = Math.max(0, parsed.rows.length - limit);
      const rows = parsed.rows.slice(cut);
      return { rows, cursor: rows.length ? parsed.offsets[cut] : start, done: atStart && cut === 0 };
    }
    window = Math.min(window * 4, end);
  }
}

interface RawLine { start: number; text: string }

/** Read byte range [from, to) as whole lines tagged with absolute offsets,
 *  dropping the leading partial line the window almost always cuts. */
function readLines(file: string, from: number, to: number): RawLine[] {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const len = Math.max(0, Math.min(to, fstatSync(fd).size) - from);
    if (len === 0) return [];
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, from);
    const out: RawLine[] = [];
    let lineStart = 0;
    for (let i = 0; i < len; i++) {
      if (buf[i] !== 0x0a) continue;
      if (!(from > 0 && lineStart === 0)) out.push({ start: from + lineStart, text: buf.toString('utf8', lineStart, i) });
      lineStart = i + 1;
    }
    if (lineStart < len && !(from > 0 && lineStart === 0)) out.push({ start: from + lineStart, text: buf.toString('utf8', lineStart, len) });
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Parse rollout lines; rows starting before `keepFrom` are context only. */
function parseRollout(input: RawLine[], keepFrom: number): { rows: HistoryEntry[]; offsets: number[] } {
  const out: HistoryEntry[] = [];
  const offsets: number[] = [];
  let lastAssistant = '';
  const push = (row: HistoryEntry, at: number): void => {
    if (at >= keepFrom) { out.push(row); offsets.push(at); }
  };
  for (const rawLine of input) {
    const line = rawLine.text;
    const at = rawLine.start;
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
      if (shown) push({ role: 'user', text: shown, ts }, at);
    } else if (payload.type === 'agent_message' && typeof payload.message === 'string') {
      // EVERY assistant message the turn streamed — confirmed live: a real
      // rollout held 154 phase:"commentary" + 20 phase:"final_answer" messages,
      // which is exactly what the panel showed while streaming. Reading only
      // task_complete (the previous behavior) dropped all the commentary, so a
      // reload "lost" almost the whole ChatGPT side of the conversation.
      const shown = stripAsk(payload.message.trim());
      if (shown) { push({ role: 'assistant', text: shown, ts }, at); lastAssistant = shown; }
    } else if (payload.type === 'task_complete' && typeof payload.last_agent_message === 'string') {
      // Normally a duplicate of the turn's final_answer agent_message (verified:
      // 20 of 20 in the live rollout) — only emit when it ISN'T, as a safety net
      // for builds that put the final text only here.
      const shown = stripAsk(payload.last_agent_message.trim());
      if (shown && shown !== lastAssistant) { push({ role: 'assistant', text: shown, ts }, at); lastAssistant = shown; }
    }
  }
  return { rows: out, offsets };
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

/**
 * Real usage/quota for a ChatGPT account. There's no REST endpoint like
 * Anthropic's oauth/usage, but `codex app-server` (JSON-RPC over stdio)
 * exposes `account/rateLimits/read` — confirmed live against a real team-plan
 * login: `{rateLimits:{primary:{usedPercent:62, windowDurationMins:10080,
 * resetsAt:<unix-secs>}, secondary:null, planType:"team", …}}`. Spawn it under
 * the account's CODEX_HOME, initialize, read, kill. Costs ~1-2s, which the
 * controller's existing 90s quota cache absorbs (same policy as Claude's poll).
 */
function fetchUsage(configDir: string): Promise<Usage> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('codex', ['app-server'], {
      env: { ...process.env, CODEX_HOME: configDir },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let settled = false;
    const finish = (err: Error | null, usage?: Usage) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { child.kill(); } catch { /* already gone */ }
      if (err) reject(err); else resolvePromise(usage as Usage);
    };
    const deadline = setTimeout(() => finish(new Error('codex app-server timed out')), 15_000);
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish(new Error('codex app-server exited before answering')));
    const windowLabel = (mins: unknown): string => {
      const m = typeof mins === 'number' ? mins : 0;
      if (m === 300) return '5-hour';
      if (m === 10080) return '7-day';
      if (m > 0 && m % 1440 === 0) return `${m / 1440}-day`;
      if (m > 0) return `${Math.round(m / 60)}-hour`;
      return 'usage';
    };
    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim().startsWith('{')) return;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.id !== 2) return;
      if (msg.error) return finish(new Error(msg.error.message || 'rateLimits read failed'));
      const rl2 = asObj(asObj(msg.result).rateLimits);
      const windows: NonNullable<Usage['windows']> = [];
      for (const key of ['primary', 'secondary']) {
        const w = asObj(rl2[key]);
        if (typeof w.usedPercent !== 'number') continue;
        windows.push({
          label: windowLabel(w.windowDurationMins),
          utilization: w.usedPercent / 100,
          resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : undefined,
        });
      }
      if (!windows.length) return finish(new Error('no rate-limit windows in app-server response'));
      finish(null, { windows });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x056', title: 'x056', version: '1.0' } } }) + '\n');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n');
  });
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
    // The gateway's MCP bridge, as config overrides (codex has no --mcp-config
    // file flag; -c takes dotted TOML keys, values parsed as TOML).
    ...(opts.mcp
      ? [
          '-c', `mcp_servers.x056.command=${JSON.stringify(opts.mcp.command)}`,
          '-c', `mcp_servers.x056.args=${JSON.stringify(opts.mcp.args)}`,
          '-c', `mcp_servers.x056.env={ ${Object.entries(opts.mcp.env).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }`,
        ]
      : []),
  ];
  // NEW: codex assigns the thread id (surfaced via captureSessionId).
  // RESUME: `exec resume <id>` continues that thread on this account's CODEX_HOME.
  // `--` ends option parsing so a prompt beginning with '-' (e.g. a markdown
  // bullet list, or literally "- " as its own line) is taken as the positional
  // prompt, not an unknown flag — confirmed live: without it, clap rejects such
  // a prompt with "error: unexpected argument '- ' found" and the process never
  // even reaches a real turn (no rollout is written at all). Same fix turn.ts
  // already applies for claude.
  const args =
    opts.mode === 'resume'
      ? ['exec', 'resume', opts.sessionId, ...flags, '--', opts.prompt]
      : ['exec', ...flags, '--', opts.prompt];
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
  readHistoryPage,
  fetchUsage,
};
