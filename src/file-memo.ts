import { readFileSync, statSync } from 'node:fs';

/**
 * Parse a small file once per version of it. GET /api/accounts reads every
 * account's identity file on every call (nine ~72 KB `.claude.json` parses plus
 * the Codex `auth.json` JWT decodes, ~19 ms of main-thread work), and those
 * files change only at a login. A `stat` is microseconds; the parse is redone
 * only when inode, mtime or size moved.
 *
 * Throws what `statSync` / `readFileSync` / `parse` throw, so callers keep
 * their own "missing or garbled" handling. A failure is never cached.
 */
const memo = new Map<string, { ino: number; mtimeMs: number; size: number; value: unknown }>();
const MAX = 200;

export function parseFileByStat<T>(path: string, parse: (text: string) => T): T {
  const st = statSync(path);
  const hit = memo.get(path);
  if (hit && hit.ino === st.ino && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value as T;
  const value = parse(readFileSync(path, 'utf8'));
  memo.delete(path);
  memo.set(path, { ino: st.ino, mtimeMs: st.mtimeMs, size: st.size, value });
  if (memo.size > MAX) memo.delete(memo.keys().next().value as string);
  return value;
}

/** Tests only. */
export function clearFileMemo(): void { memo.clear(); }
