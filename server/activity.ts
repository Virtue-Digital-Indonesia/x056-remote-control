import type { RawEvent } from '../src/types.js';

/**
 * A single tool invocation surfaced to the UI. Emitted as `start` when the
 * model calls a tool and `done`/`error` when its result comes back. Subagent
 * spawns (Task/Agent) are flagged so the panel can render them as a live tree
 * and count "N running tasks". `parentToolUseId` links a tool run to the
 * subagent that issued it (the CLI stamps sub-turn events with it).
 */
export interface ActivityEvent {
  toolUseId: string;
  parentToolUseId: string | null;
  tool: string;
  label: string;
  status: 'start' | 'done' | 'error';
  isSubagent: boolean;
}

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

/** Map one raw stream-json event to zero or more UI activity events. */
export function toActivity(e: RawEvent): ActivityEvent[] {
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
