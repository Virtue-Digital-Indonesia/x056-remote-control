import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripAskInstructions } from './question.js';

export interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
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
    out.push({ role: type, text: type === 'user' ? stripAskInstructions(text) : text });
  }
  return out.slice(-limit);
}
