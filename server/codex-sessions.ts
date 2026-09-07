import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * One rollout store for every Codex account.
 *
 * Codex files each thread's transcript ("rollout") under `$CODEX_HOME/sessions/`
 * and `thread/resume` looks it up THERE — an empty home resumes nothing, with
 * "no rollout found for thread id …" (verified on 0.153.4, and the reverse:
 * a home whose `sessions/` merely links to another home's resumes that home's
 * threads, preview and all).
 *
 * Failover depends on that lookup. A usage limit on account g kills the turn
 * and re-enters on account h with `thread/resume <same id>`; with a `sessions/`
 * per account, h has never heard of the thread and the conversation dies right
 * there — 300 ms after the switch, with no reason the panel could show. The
 * Claude accounts avoid this by symlinking every `projects/` into one tree;
 * this does the same for Codex: every account's `sessions/` is a symlink to
 * `<stateDir>/codex-sessions`, and whatever rollouts an account already had
 * are moved in first.
 */
export const CODEX_SESSIONS_DIRNAME = 'codex-sessions';

export function sharedCodexSessionsDir(stateDir: string): string {
  return join(stateDir, CODEX_SESSIONS_DIRNAME);
}

export interface ShareResult {
  account: string;
  /** A link was created (false when it was already in place). */
  linked: boolean;
  /** Rollouts moved from the account's own store into the shared one. */
  moved: number;
  /** Rollouts already present in the shared store (same name = same thread). */
  skipped: number;
  error?: string;
}

/** Point one account's `sessions/` at the shared store, merging what it had. Never throws. */
export function shareCodexSessions(stateDir: string, account: { name: string; configDir: string }): ShareResult {
  const shared = sharedCodexSessionsDir(stateDir);
  const target = join(account.configDir, 'sessions');
  const out: ShareResult = { account: account.name, linked: false, moved: 0, skipped: 0 };
  try {
    mkdirSync(shared, { recursive: true });
    let st: ReturnType<typeof lstatSync> | null = null;
    try { st = lstatSync(target); } catch { /* absent */ }
    if (st?.isSymbolicLink()) {
      if (resolve(account.configDir, readlinkSync(target)) === resolve(shared)) return out;
      unlinkSync(target); // points somewhere else — not a store this gateway made
    } else if (st?.isDirectory()) {
      const r = mergeInto(target, shared);
      out.moved = r.moved; out.skipped = r.skipped;
      rmSync(target, { recursive: true, force: true });
    } else if (st) {
      unlinkSync(target); // a stray file where the directory should be
    }
    mkdirSync(account.configDir, { recursive: true });
    symlinkSync(shared, target);
    out.linked = true;
  } catch (err) {
    out.error = (err as Error).message;
  }
  return out;
}

/**
 * Move every file under `from` to the same relative path under `to`. Rollout
 * names embed the timestamp and thread id, so a name already present at the
 * destination is the same thread — skipped, never overwritten.
 */
function mergeInto(from: string, to: string): { moved: number; skipped: number } {
  let moved = 0;
  let skipped = 0;
  for (const ent of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, ent.name);
    const dst = join(to, ent.name);
    if (ent.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      const r = mergeInto(src, dst);
      moved += r.moved; skipped += r.skipped;
    } else if (existsSync(dst)) {
      skipped++;
    } else {
      renameSync(src, dst);
      moved++;
    }
  }
  return { moved, skipped };
}
