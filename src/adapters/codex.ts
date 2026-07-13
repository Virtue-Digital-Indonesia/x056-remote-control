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
 * ⚠️ SCHEMA-VERIFY: The exact `codex exec --json` event stream could not be
 * confirmed from a live run when this was written (no codex binary + ChatGPT
 * auth available in the build sandbox). Everything below reflects the
 * best-documented shape of the openai/codex protocol and is deliberately
 * DEFENSIVE — it unwraps an optional `{ id, msg: {...} }` envelope, tolerates
 * both `msg.type` and a flat `type`, and matches limit/auth by structured
 * fields first then message text. Each assumption is tagged `VERIFY`. When a
 * real stream is captured, correct the tagged spots; the failover/activity
 * machinery around it does not change.
 *
 * Known-good facts (from docs): `codex exec` is the non-interactive mode;
 * `--json` emits JSONL events; sessions are rollout-*.jsonl under
 * $CODEX_HOME/sessions/…; resume via `--resume-session-id <id>`; ChatGPT-plan
 * limits meter messages over rolling 5h + weekly windows and typically let the
 * CURRENT turn finish, biting at the next turn.
 */

/** Unwrap Codex's `{ id, msg: { type, ... } }` envelope to the inner payload,
 *  tolerating a flat event that already has `type` at the top level. */
function inner(e: RawEvent): Record<string, unknown> {
  const msg = e.msg;
  if (msg && typeof msg === 'object' && 'type' in (msg as object)) return msg as Record<string, unknown>;
  return e;
}
function evType(e: RawEvent): string {
  const t = inner(e).type;
  return typeof t === 'string' ? t : '';
}

const LIMIT_RE = /rate.?limit|usage limit|quota|limit reached|too many requests|429/i;
const AUTH_RE = /not logged in|unauthor|unauthenticated|401|please (run )?.*login|sign in|invalid api key|no api key/i;

/**
 * How long until this account's limit clears, RELATIVE — Codex reports a
 * countdown (`rate_limits.primary.resets_in_seconds`), not an absolute time, so
 * runSession converts it with its own clock. Shape per docs/observation:
 * `rate_limits.primary.{used_percent, resets_in_seconds, window_minutes}` plus a
 * `secondary` for the weekly window. VERIFY field names.
 */
function resetsInSeconds(e: RawEvent): number | undefined {
  const rl = inner(e).rate_limits as { primary?: { resets_in_seconds?: number } } | undefined;
  const secs = rl?.primary?.resets_in_seconds;
  return typeof secs === 'number' && secs > 0 ? Math.floor(secs) : undefined;
}

export function classifyCodexEvent(e: RawEvent): Verdict {
  const t = evType(e);
  const m = inner(e);
  const text = typeof m.message === 'string' ? m.message : '';

  // A terminal error is where a ChatGPT-plan limit or a dead login surfaces. VERIFY:
  // the exact event `type` for a hard limit ('error' | 'stream_error' | 'turn_failed').
  if (t === 'error' || t === 'stream_error' || t === 'turn_failed') {
    if (AUTH_RE.test(text)) return { kind: 'auth_required', source: 'codex_error' };
    if (LIMIT_RE.test(text)) return { kind: 'limited', resetsInSeconds: resetsInSeconds(e), source: 'codex_error' };
    return { kind: 'irrelevant', source: 'codex_error' };
  }

  // Some builds surface the limit as a typed event rather than a text error. VERIFY.
  if (t === 'rate_limit_exceeded' || t === 'usage_limit_reached') {
    return { kind: 'limited', resetsInSeconds: resetsInSeconds(e), source: 'codex_rate_limit' };
  }

  // A usage-meter tick that's already at/over the cap is a near-limit warning
  // (the turn keeps going, but the next one may be rejected — mirrors Claude's
  // allowed_warning). VERIFY field name `used_percent`.
  if (t === 'token_count') {
    const rl = m.rate_limits as { primary?: { used_percent?: number } } | undefined;
    const pct = rl?.primary?.used_percent;
    if (typeof pct === 'number' && pct >= 100) {
      return { kind: 'warning', resetsInSeconds: resetsInSeconds(e), source: 'codex_token_count' };
    }
  }
  return { kind: 'irrelevant', source: 'none' };
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

/** Map one raw Codex event to zero or more UI activity rows, mirroring the
 *  Claude adapter's start/done/error rows so the panel renders both the same. */
function toActivity(e: RawEvent): ActivityEvent[] {
  const t = evType(e);
  const m = inner(e);
  const callId = firstStr(m.call_id, m.id);
  const out: ActivityEvent[] = [];

  switch (t) {
    // --- shell commands (Codex's main "tool") ---
    case 'exec_command_begin': {
      const cmd = Array.isArray(m.command) ? (m.command as unknown[]).map(String).join(' ') : String(m.command ?? '');
      out.push({ toolUseId: callId, parentToolUseId: null, tool: 'Bash', label: 'Running: ' + truncate(cmd), status: 'start', isSubagent: false });
      break;
    }
    case 'exec_command_end':
      out.push({ toolUseId: callId, parentToolUseId: null, tool: '', label: '', status: m.exit_code === 0 || m.exit_code === undefined ? 'done' : 'error', isSubagent: false });
      break;
    // --- file edits (apply_patch) ---
    case 'patch_apply_begin': {
      const changes = m.changes && typeof m.changes === 'object' ? Object.keys(m.changes as object) : [];
      const label = changes.length ? 'Editing ' + base(changes[0]) + (changes.length > 1 ? ` (+${changes.length - 1})` : '') : 'Applying patch';
      out.push({ toolUseId: callId, parentToolUseId: null, tool: 'Edit', label, status: 'start', isSubagent: false });
      break;
    }
    case 'patch_apply_end':
      out.push({ toolUseId: callId, parentToolUseId: null, tool: '', label: '', status: m.success === false ? 'error' : 'done', isSubagent: false });
      break;
    // --- MCP tool calls ---
    case 'mcp_tool_call_begin': {
      const name = firstStr(m.tool, (m.invocation as { tool?: string } | undefined)?.tool, 'tool');
      out.push({ toolUseId: callId, parentToolUseId: null, tool: name, label: 'Tool: ' + truncate(name), status: 'start', isSubagent: false });
      break;
    }
    case 'mcp_tool_call_end':
      out.push({ toolUseId: callId, parentToolUseId: null, tool: '', label: '', status: m.is_error || m.success === false ? 'error' : 'done', isSubagent: false });
      break;
    default:
      break;
  }
  return out;
}

/** Read the ChatGPT identity Codex stores in $CODEX_HOME/auth.json. For a
 *  ChatGPT login the email lives in the JWT id_token's payload; for an API-key
 *  login there's no email. VERIFY exact field names. Best-effort — returns {} on
 *  any miss, never throws. */
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
  // VERIFY: flag names/subcommands against the installed codex version.
  //  - `exec --json`         : non-interactive JSONL stream
  //  - bypass approvals/sandbox: this gateway's container IS the sandbox
  //  - `-m` model, effort via `-c model_reasoning_effort=...`
  //  - resume: `--resume-session-id <id>` (codex assigns ids on a NEW run, so
  //    for mode:'new' we do NOT force one — the manager maps our key to the id
  //    surfaced in the stream; this mapping is the main live-integration TODO).
  const args = [
    'exec',
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.effort ? ['-c', `model_reasoning_effort="${opts.effort}"`] : []),
    ...(opts.mode === 'resume' ? ['--resume-session-id', opts.sessionId] : []),
    opts.prompt,
  ];
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

  classify: (e) => classifyCodexEvent(e),
  // Codex's terminal success event. VERIFY: 'task_complete' vs 'turn_complete'.
  isResult: (e) => evType(e) === 'task_complete',
  resultOk: (e) => evType(e) === 'task_complete',
  resultText: (e) => {
    const m = inner(e);
    return firstStr(m.last_agent_message, m.message) || undefined;
  },
  // Interrupt only after a tool round closes (or the turn completes) — the same
  // "transcript is in a resumable state" rule the Claude adapter uses.
  isDrainBoundary: (e) => ['exec_command_end', 'patch_apply_end', 'mcp_tool_call_end', 'task_complete'].includes(evType(e)),
  toActivity,

  readIdentity,
  // No pollable usage endpoint on ChatGPT plans — usage arrives inline via
  // token_count events, not a REST fetch — so no fetchUsage (UI shows no bars).
};
