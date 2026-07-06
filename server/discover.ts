import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** An interactive `claude` session found on disk, offered for resume. */
export interface AvailableSession {
  id: string;
  firstMessage: string;
  updatedAt: string;
  messages: number;
}

/** Claude Code derives a project's transcript directory by replacing `/` and
 *  `.` in the cwd with `-`; the interactive and failover trees munge alike. */
function munge(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

function summarize(file: string): { firstMessage: string; messages: number } {
  let firstMessage = '';
  let messages = 0;
  const raw = readFileSync(file, 'utf8');
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    messages++;
    if (!firstMessage && e.type === 'user' && !e.isMeta) {
      const c = (e.message as { content?: unknown } | undefined)?.content;
      const text =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c
                .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
                .map((b) => (b as { text?: string }).text ?? '')
                .join(' ')
            : '';
      const t = text.trim();
      if (t && !/^\s*(<(command-|local-command|task-notification|system-reminder|teammate-message)|Caveat:)/.test(t)) {
        firstMessage = t.slice(0, 120);
      }
    }
  }
  return { firstMessage, messages };
}

/** List the interactive sessions recorded for a given working directory. */
export function listInteractiveSessions(interactiveRoot: string, cwd: string): AvailableSession[] {
  const dir = join(interactiveRoot, munge(cwd));
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: AvailableSession[] = [];
  for (const f of files) {
    const file = join(dir, f);
    try {
      const { firstMessage, messages } = summarize(file);
      if (messages === 0) continue;
      out.push({ id: f.replace(/\.jsonl$/, ''), firstMessage, updatedAt: statSync(file).mtime.toISOString(), messages });
    } catch {
      // unreadable transcript — skip
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Copy an interactive session's transcript into the failover tree so the
 *  gateway can resume it under either account. */
export function adoptFromInteractive(
  interactiveRoot: string,
  failoverProjectsRoot: string,
  cwd: string,
  sessionId: string,
): void {
  const m = munge(cwd);
  const src = join(interactiveRoot, m, `${sessionId}.jsonl`);
  if (!existsSync(src)) throw new Error(`session ${sessionId} not found for ${cwd}`);
  const destDir = join(failoverProjectsRoot, m);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, join(destDir, `${sessionId}.jsonl`));
}
