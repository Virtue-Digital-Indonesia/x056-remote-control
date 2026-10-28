import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Can a Claude conversation be resumed? `claude -p --resume <id>` looks for
 * `<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<id>.jsonl`. When that file is
 * gone (Claude Code's own age-based cleanup, a moved checkout, a cwd that
 * reached the CLI under another spelling) the CLI answers "No conversation
 * found with session ID: <id>" and every turn of the conversation fails in a
 * second. Checked once per resuming turn in `SessionManager.launch()`:
 *
 * - `present`: the transcript is where the CLI will look. Resume as before.
 * - `relinked`: it was under ANOTHER project dir; it (and its `<id>/`
 *   subagents dir) is symlinked into the expected one. Resume as before.
 * - `missing`: it is nowhere. The caller starts a fresh session with a recap.
 * - `unknown`: the tree could not be read or the layout is not one this knows
 *   (no `projects/` dir at all, an over-long path the CLI hashes). FAIL OPEN:
 *   resume as before -- a transient read error must never throw away context.
 *
 * Cheap on the hot path: one `existsSync` per candidate. Only a miss lists the
 * top level of `projects/` (never recursively: transcripts always sit at depth
 * 1, and the recursive walk descends into every subagents dir).
 */
export type TranscriptVerdict =
  | { decision: 'present'; path: string }
  | { decision: 'relinked'; from: string; to: string[]; dryRun?: boolean }
  | { decision: 'missing' }
  | { decision: 'unknown'; reason: string };

/** The CLI's own encoding of a project dir: every non-alphanumeric -> '-'. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** The CLI hashes longer names; such a dir cannot be predicted here. */
const MAX_DIR_NAME = 200;
const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/;

function realOr(p: string): string { try { return realpathSync(p); } catch { return p; } }
function isFile(p: string): boolean { try { return statSync(p).isFile(); } catch { return false; } }
function isDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }
/** Something (even a dangling symlink) occupies this name. */
function occupied(p: string): boolean { try { lstatSync(p); return true; } catch { return false; } }

export interface ResolveTranscriptInput {
  /** Every Claude account's config dir, in routing order. */
  configDirs: string[];
  cwd: string;
  /** The CLI's session id (the conversation's providerSessionId). */
  sessionId: string;
  /** Report the decision without creating anything. */
  dryRun?: boolean;
}

export function resolveClaudeTranscript(input: ResolveTranscriptInput): TranscriptVerdict {
  const { sessionId } = input;
  if (!SESSION_ID.test(sessionId)) return { decision: 'unknown', reason: 'unexpected session id' };
  const file = `${sessionId}.jsonl`;
  // The projects trees, deduped: every account links to ONE shared tree.
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const dir of input.configDirs) {
    const root = join(dir, 'projects');
    if (!isDir(root)) continue;
    const real = realOr(root);
    if (seen.has(real)) continue;
    seen.add(real); roots.push(root);
  }
  if (!roots.length) return { decision: 'unknown', reason: 'no readable projects tree' };
  // The CLI runs with the real path as its cwd; the configured spelling too.
  const primary = claudeProjectDirName(realOr(input.cwd));
  if (primary.length > MAX_DIR_NAME) return { decision: 'unknown', reason: 'project path too long to predict' };
  const names = [...new Set([primary, claudeProjectDirName(input.cwd)])];
  for (const root of roots) {
    for (const name of names) {
      const p = join(root, name, file);
      if (isFile(p)) return { decision: 'present', path: p };
    }
  }
  // A miss: look one level deep in every tree for the same id elsewhere.
  let found: string | undefined;
  try {
    for (const root of roots) {
      for (const d of readdirSync(root, { withFileTypes: true })) {
        if (!d.isDirectory() && !d.isSymbolicLink()) continue;
        const p = join(root, d.name, file);
        if (isFile(p)) { found = p; break; }
      }
      if (found) break;
    }
  } catch (e) {
    return { decision: 'unknown', reason: 'could not list projects: ' + (e as Error).message };
  }
  if (!found) return { decision: 'missing' };
  // Link to the real file, not to a path through some account's projects/ link.
  const from = realOr(found);
  const siblingDir = realOr(found.slice(0, -'.jsonl'.length));
  const to: string[] = [];
  const plan = roots.map((root) => join(root, primary));
  if (input.dryRun) return { decision: 'relinked', from, to: plan.map((d) => join(d, file)), dryRun: true };
  try {
    for (const dir of plan) {
      const target = join(dir, file);
      if (isFile(target)) continue; // a shared tree already linked through another root
      mkdirSync(dir, { recursive: true });
      // A dangling link would make symlinkSync fail with EEXIST.
      if (occupied(target)) unlinkSync(target);
      symlinkSync(from, target);
      to.push(target);
      const siblingTarget = join(dir, sessionId);
      if (isDir(siblingDir) && !occupied(siblingTarget)) symlinkSync(siblingDir, siblingTarget);
    }
  } catch (e) {
    return { decision: 'unknown', reason: 'could not relink: ' + (e as Error).message };
  }
  return { decision: 'relinked', from, to };
}

// ---- the recap a fresh session starts with ----

const RECAP_START = "[Recovered context: this conversation's saved transcript was not found, so it continues in a fresh session. Earlier messages, oldest first:]\n";
const RECAP_END = '\n[End of recovered context]\n\nCurrent message:\n';

export interface RecapRow { role: string; text: string; ts?: string; steered?: boolean }

export const RECAP_LIMITS = { messages: 20, perMessage: 600, total: 12_000 };

/**
 * The recap from what the gateway still holds (the conversation journal:
 * every prompt it dispatched; assistant rows when there are any). Bounded:
 * the last 20 user/assistant messages, each cut to 600 chars, at most 12k
 * chars in all (oldest dropped first). Empty text when there is nothing.
 */
export function buildRecap(rows: RecapRow[], limits = RECAP_LIMITS): { text: string; count: number } {
  const picked = rows.filter((r) => (r.role === 'user' || r.role === 'assistant') && typeof r.text === 'string' && r.text.trim()).slice(-limits.messages);
  const lines = picked.map((r) => {
    const t = r.text.replace(/\s+/g, ' ').trim();
    const cut = t.length > limits.perMessage ? t.slice(0, limits.perMessage - 1) + '…' : t;
    const when = r.ts && Number.isFinite(Date.parse(r.ts)) ? ` (${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC)` : '';
    return `${r.role === 'user' ? 'User' : 'Assistant'}${when}: ${cut}`;
  });
  while (lines.length && lines.join('\n').length > limits.total) lines.shift();
  return { text: lines.join('\n'), count: lines.length };
}

/** Prepends the recap block. Never on a slash command (it must reach the CLI as typed). */
export function withRecoveredContext(prompt: string, recap: string): string {
  return recap && !prompt.trimStart().startsWith('/') ? RECAP_START + recap + RECAP_END + prompt : prompt;
}

/** Removes a leading recap block, wherever a prompt is read back. */
export function stripRecoveredContext(text: string): string {
  if (!text.startsWith(RECAP_START)) return text;
  const end = text.indexOf(RECAP_END, RECAP_START.length);
  return end < 0 ? text : text.slice(end + RECAP_END.length);
}

/** The one line the chat shows for a fresh start. */
export function sessionResetText(count: number): string {
  return count
    ? `No saved transcript for this conversation, so it continued in a fresh session with a recap of the last ${count} message${count === 1 ? '' : 's'}.`
    : 'No saved transcript for this conversation, so it continued in a fresh session (nothing earlier was available for a recap).';
}
