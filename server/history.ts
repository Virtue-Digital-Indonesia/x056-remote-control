import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripAsk, stripAskInstructions } from './question.js';

export interface HistoryEntry {
  /** 'model' is a synthetic marker recording that the main turn's model changed
   *  (text = the model id, e.g. "claude-sonnet-5"), so switches are visible on
   *  reload — derived from the transcript, no separate storage needed. */
  role: 'user' | 'assistant' | 'model';
  text: string;
  /** ISO timestamp from the transcript entry, when present — lets the panel
   *  interleave this message with live activity/subagent events by time
   *  instead of rendering them as two separate before/after blocks. */
  ts?: string;
}

/** Locate <sessionId>.jsonl anywhere under any of the config dirs' projects trees. */
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
export function readSessionHistory(configDirs: string[], sessionId: string, limit = 100): HistoryEntry[] {
  const file = findTranscript(configDirs, sessionId);
  if (!file) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: HistoryEntry[] = [];
  let lastModel: string | undefined;
  for (const line of raw.split('\n')) {
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
  return out.slice(-limit);
}
