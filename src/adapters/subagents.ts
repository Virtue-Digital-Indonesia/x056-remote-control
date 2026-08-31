import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findTranscript, readFilePage, type HistoryPage } from './claude.js';

/**
 * Subagents, as Claude Code already records them.
 *
 * A Task/Agent call does NOT inline its work into the parent transcript — the
 * CLI writes each subagent its own complete transcript beside the session:
 *
 *   <configDir>/projects/<projectDir>/<sessionId>/subagents/
 *       agent-<agentId>.jsonl        full transcript, same entry shapes
 *       agent-<agentId>.meta.json    {agentType, description, toolUseId, spawnDepth}
 *
 * So a per-subagent view needs no reconstruction from the event stream: it is a
 * second file, read by the same pager. `toolUseId` ties each one back to the
 * exact Task call in the parent, and `spawnDepth` distinguishes a subagent the
 * conversation spawned from one that another subagent spawned.
 */

export interface SubagentMeta {
  agentId: string;
  agentType: string;
  description: string;
  /** The parent's Task tool_use this subagent belongs to. */
  toolUseId?: string;
  /** 1 = spawned by the conversation; 2+ = spawned by another subagent. */
  spawnDepth: number;
  startedAt?: number;
  updatedAt?: number;
  /** Transcript size in bytes — cheap "did anything happen" signal. */
  bytes: number;
}

/** The transcript file for one subagent, or null. */
export function subagentFile(configDirs: string[], sessionId: string, agentId: string): string | null {
  const dir = subagentDir(configDirs, sessionId);
  if (!dir) return null;
  if (!listSubagents(configDirs, sessionId).some((s) => s.agentId === agentId)) return null;
  return join(dir, `agent-${agentId}.jsonl`);
}

/** The parent session's own transcript, for its usage totals and Task results. */
export function parentTranscript(configDirs: string[], sessionId: string): string | null {
  return findTranscript(configDirs, sessionId);
}

/**
 * The brief a subagent was given: the first user entry of its transcript.
 *
 * Read from the HEAD, unlike history paging which reads the tail — the brief is
 * the very first thing written and would otherwise need the whole file.
 */
export function subagentBrief(file: string, maxBytes = 96 * 1024): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(maxBytes, size);
    if (!len) return '';
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, 0);
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line || line.charCodeAt(0) !== 0x7b) continue;
      let d: { type?: string; message?: { role?: string; content?: unknown } };
      try { d = JSON.parse(line) as typeof d; } catch { continue; }
      if (d.type !== 'user') continue;
      const c = d.message?.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) {
        const t = c.find((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text');
        if (t) return String((t as { text?: unknown }).text ?? '');
      }
    }
    return '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/** Where a session's subagent transcripts live, across every account's tree. */
export function subagentDir(configDirs: string[], sessionId: string): string | null {
  for (const configDir of configDirs) {
    const projects = join(configDir, 'projects');
    if (!existsSync(projects)) continue;
    let names: string[];
    try { names = readdirSync(projects); } catch { continue; }
    for (const name of names) {
      const dir = join(projects, name, sessionId, 'subagents');
      if (existsSync(dir)) return dir;
    }
  }
  return null;
}

function readMeta(dir: string, agentId: string): Partial<SubagentMeta> {
  try {
    const raw = JSON.parse(readFileSync(join(dir, `agent-${agentId}.meta.json`), 'utf8')) as Record<string, unknown>;
    return {
      agentType: typeof raw.agentType === 'string' ? raw.agentType : undefined,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      toolUseId: typeof raw.toolUseId === 'string' ? raw.toolUseId : undefined,
      spawnDepth: typeof raw.spawnDepth === 'number' ? raw.spawnDepth : undefined,
    };
  } catch {
    // The transcript is the real artifact; meta is a label. A subagent still
    // running may not have flushed its meta yet, and losing the whole row over
    // a missing label would hide exactly the one being watched.
    return {};
  }
}

/** Every subagent of a session, oldest first. */
export function listSubagents(configDirs: string[], sessionId: string): SubagentMeta[] {
  const dir = subagentDir(configDirs, sessionId);
  if (!dir) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: SubagentMeta[] = [];
  for (const name of names) {
    const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name);
    if (!m) continue;
    const agentId = m[1];
    let bytes = 0;
    let startedAt: number | undefined;
    let updatedAt: number | undefined;
    try {
      const st = statSync(join(dir, name));
      bytes = st.size;
      startedAt = st.birthtimeMs || st.ctimeMs;
      updatedAt = st.mtimeMs;
    } catch { continue; }
    const meta = readMeta(dir, agentId);
    out.push({
      agentId,
      agentType: meta.agentType ?? 'agent',
      description: meta.description ?? '',
      toolUseId: meta.toolUseId,
      spawnDepth: meta.spawnDepth ?? 1,
      startedAt,
      updatedAt,
      bytes,
    });
  }
  return out.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/**
 * One page of a subagent's own history.
 *
 * agentId is matched against the directory listing rather than pasted into a
 * path: it arrives from an HTTP query, and building a filename out of it
 * directly would let `../` walk out of the session's directory.
 */
export function readSubagentPage(
  configDirs: string[],
  sessionId: string,
  agentId: string,
  limit = 200,
  before?: number,
): HistoryPage {
  const dir = subagentDir(configDirs, sessionId);
  if (!dir) return { rows: [], cursor: 0, done: true };
  const known = listSubagents(configDirs, sessionId).some((s) => s.agentId === agentId);
  if (!known) return { rows: [], cursor: 0, done: true };
  return readFilePage(join(dir, `agent-${agentId}.jsonl`), limit, before);
}
