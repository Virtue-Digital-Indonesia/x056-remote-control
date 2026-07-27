import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent } from '../detector.js';
import { fetchUsage } from '../quota.js';
import { stripAsk, stripAskInstructions } from '../question.js';
import { startTurn } from '../turn.js';
import { DEFAULT_CONTINUE_PROMPT } from '../provider.js';
import type { AccountIdentity, ActivityEvent, HistoryEntry, ProviderAdapter } from '../provider.js';
import type { RawEvent } from '../types.js';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function base(path: unknown): string {
  const s = typeof path === 'string' ? path : '';
  const parts = s.split('/');
  return parts[parts.length - 1] || s;
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Human label for a tool call, mirroring Claude Code's inline activity rows. */
function labelFor(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
      return 'Running: ' + truncate(String(input.command ?? input.description ?? ''));
    case 'Edit':
      return 'Editing ' + base(input.file_path);
    case 'Write':
      return 'Writing ' + base(input.file_path);
    case 'Read':
      return 'Reading ' + base(input.file_path);
    case 'Grep':
      return 'Searching: ' + truncate(String(input.pattern ?? ''));
    case 'Glob':
      return 'Finding files: ' + truncate(String(input.pattern ?? ''));
    case 'Task':
    case 'Agent':
      return 'Subagent: ' + truncate(String(input.description ?? input.prompt ?? 'working'));
    case 'WebFetch':
      return 'Fetching ' + truncate(String(input.url ?? ''));
    case 'WebSearch':
      return 'Searching the web: ' + truncate(String(input.query ?? ''));
    case 'TodoWrite':
      return 'Updating the task list';
    default:
      return 'Used ' + tool;
  }
}

/** Map one raw Claude stream-json event to zero or more UI activity events. */
function toActivity(e: RawEvent): ActivityEvent[] {
  const parent = (e.parent_tool_use_id as string | undefined) ?? null;
  const msg = e.message as { content?: unknown } | undefined;
  const content = Array.isArray(msg?.content) ? (msg!.content as unknown[]) : [];
  const out: ActivityEvent[] = [];

  if (e.type === 'assistant') {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_use') {
        const b = block as { id?: string; name?: string; input?: Record<string, unknown> };
        const tool = b.name ?? 'tool';
        out.push({
          toolUseId: b.id ?? '',
          parentToolUseId: parent,
          tool,
          label: labelFor(tool, b.input ?? {}),
          status: 'start',
          isSubagent: SUBAGENT_TOOLS.has(tool),
        });
      }
    }
  } else if (e.type === 'user') {
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result') {
        const b = block as { tool_use_id?: string; is_error?: boolean };
        out.push({
          toolUseId: b.tool_use_id ?? '',
          parentToolUseId: parent,
          tool: '',
          label: '',
          status: b.is_error ? 'error' : 'done',
          isSubagent: false,
        });
      }
    }
  }
  return out;
}

/** The main-turn model on an assistant event (e.g. "claude-fable-5"). Ignores
 *  subagent messages (they carry parent_tool_use_id and may run a different
 *  model) so the live indicator tracks the MAIN turn, not each subagent reply. */
function activeModel(e: RawEvent): string | undefined {
  if (e.type !== 'assistant' || e.parent_tool_use_id != null) return undefined;
  const model = (e.message as { model?: unknown } | undefined)?.model;
  return typeof model === 'string' ? model : undefined;
}

/** The assistant's displayable text blocks on an assistant event. */
function assistantText(e: RawEvent): string[] {
  if (e.type !== 'assistant') return [];
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) out.push(text);
    }
  }
  return out;
}

/** The human-facing identity a `claude` login stores in <configDir>/.claude.json. */
function readIdentity(configDir: string): AccountIdentity {
  try {
    const o = (JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { displayName?: string; emailAddress?: string };
    }).oauthAccount;
    return { displayName: o?.displayName, email: o?.emailAddress };
  } catch {
    return {};
  }
}

/** Locate <sessionId>.jsonl anywhere under any of the config dirs' projects
 *  trees. Exported separately from readHistory because the manager's session
 *  ADOPTION check (a Claude-only concept — there's no equivalent for Codex)
 *  needs just the existence check, not the parsed history. */
export function findTranscript(configDirs: string[], sessionId: string): string | null {
  const target = `${sessionId}.jsonl`;
  for (const configDir of configDirs) {
    const projects = join(configDir, 'projects');
    if (!existsSync(projects)) continue;
    let names: string[];
    try {
      names = readdirSync(projects, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith(target)) return join(projects, name);
    }
  }
  return null;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const t = (block as { text?: unknown }).text;
      if (typeof t === 'string') parts.push(t);
    }
  }
  return parts.join('\n');
}

/**
 * Read the human-readable conversation (user prompts + assistant text) from an
 * adopted transcript. Skips tool calls, thinking, synthetic/error entries, and
 * command/meta wrappers so the panel shows what a person would recognize.
 * Returns the last `limit` entries.
 */
export function readHistory(configDirs: string[], sessionId: string, limit = 100): HistoryEntry[] {
  const file = findTranscript(configDirs, sessionId);
  if (!file) return [];
  // Only the TAIL is ever needed (we return the last `limit` entries), and these
  // files grow without bound — a long-running conversation that screenshots a lot
  // reaches hundreds of MB, because every base64 image lands in the transcript.
  // Reading the whole thing cost seconds per request AND would eventually throw:
  // past V8's ~512MB max string length readFileSync(utf8) fails outright, whereupon
  // the caller's catch turned a live conversation into a blank panel. So walk
  // backwards from the end, widening only until enough entries are found.
  let size: number;
  try { size = statSync(file).size; } catch { return []; }
  let window = Math.min(TAIL_START_BYTES, size);
  for (;;) {
    const atStart = window >= size;
    const rows = parseTranscript(readTail(file, window), !atStart);
    if (rows.length >= limit || atStart || window >= TAIL_MAX_BYTES) return rows.slice(-limit);
    window = Math.min(window * 4, size);
  }
}

/** Start small (most reads want a handful of recent messages) and widen. */
const TAIL_START_BYTES = 1 << 21; // 2 MB
const TAIL_MAX_BYTES = 1 << 27; // 128 MB — far under the string limit, still ample

/** Read the last `bytes` bytes of a file as text (no whole-file allocation). */
function readTail(file: string, bytes: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Parse transcript lines into displayable history. `partial` drops the first
 *  line, which a mid-file window almost certainly cut in half. */
function parseTranscript(raw: string, partial: boolean): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  let lastModel: string | undefined;
  const lines = raw.split('\n');
  if (partial) lines.shift();
  for (const line of lines) {
    if (line.trim() === '') continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = entry.type;
    if (type !== 'user' && type !== 'assistant') continue;
    if (entry.isApiErrorMessage || entry.isMeta) continue;
    const message = entry.message as { role?: string; content?: unknown; model?: unknown } | undefined;
    if (!message) continue;
    const ts = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;
    // Record model switches on the MAIN turn (ignore subagents/sidechains, which
    // may run a different model) so the timeline shows what handled each part.
    if (type === 'assistant' && entry.isSidechain !== true && typeof message.model === 'string' && message.model !== '<synthetic>') {
      if (message.model !== lastModel) {
        out.push({ role: 'model', text: message.model, ts });
        lastModel = message.model;
      }
    }
    if (type === 'assistant' && message.model === '<synthetic>') continue;
    const text = textFromContent(message.content).trim();
    if (text === '') continue;
    // Skip system-injected content Claude Code records as "user" turns:
    // command wrappers, task/agent notifications, system reminders, caveats.
    if (
      type === 'user' &&
      /^\s*(<(command-|local-command|task-notification|system-reminder|teammate-message)|Caveat:)/.test(text)
    ) {
      continue;
    }
    // Users' prompts carry the appended ASK convention; assistants' final
    // messages carry the raw <<<ASK>>> block — strip both so neither leaks into
    // the rendered transcript on reload. Drop a message that was only an ASK.
    const shown = type === 'user' ? stripAskInstructions(text) : stripAsk(text);
    if (shown === '') continue;
    out.push({ role: type, text: shown, ts });
  }
  return out;
}

/**
 * Anthropic `claude` CLI adapter — the original, reference behavior. Every method
 * here is the logic that used to live inline in turn.ts / detector.ts /
 * failover.ts / server/activity.ts, now behind the ProviderAdapter seam so a
 * second provider (codex) can slot in beside it.
 */
export const claudeAdapter: ProviderAdapter = {
  id: 'claude',
  label: 'Claude',
  configEnvVar: 'CLAUDE_CONFIG_DIR',
  continuePrompt: DEFAULT_CONTINUE_PROMPT,

  startTurn,

  classify: classifyEvent,
  isResult: (e) => e.type === 'result',
  resultOk: (e) => e.type === 'result' && e.is_error === false,
  resultText: (e) => (typeof e.result === 'string' ? e.result : undefined),
  // The CLI emits a tool-result-bearing `user` event or the final `result` event
  // at each resumable boundary; interrupting there leaves a clean transcript.
  isDrainBoundary: (e) => e.type === 'user' || e.type === 'result',
  toActivity,
  activeModel,
  assistantText,

  readIdentity,
  fetchUsage,
  readHistory,
};
