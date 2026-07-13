import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyEvent } from '../detector.js';
import { fetchUsage } from '../quota.js';
import { startTurn } from '../turn.js';
import { DEFAULT_CONTINUE_PROMPT } from '../provider.js';
import type { AccountIdentity, ActivityEvent, ProviderAdapter } from '../provider.js';
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
};
