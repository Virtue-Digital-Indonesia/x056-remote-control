import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

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

/**
 * Runs Codex's one-time index of the shared store for a NEW home, outside any
 * turn's timeout. The first `codex app-server` in a fresh CODEX_HOME performs a
 * "state db backfill" over everything under `sessions/`, which after linking is
 * the whole gateway store (1.6 GB on 2026-09-17). The gateway's spawn timeouts
 * killed that part-way and left `backfill_state = running` with no process
 * behind it; every later start waited 30 s for the phantom and exited 1, so the
 * account failed every turn after exactly 30 s. `codex migrate-rollouts --apply`
 * is the CLI's own way to complete that index; it is fire-and-forget here and
 * only logged, so onboarding never blocks on it and a missing binary is harmless.
 */
export function prepareCodexHome(configDir: string, codexPath = 'codex'): void {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(codexPath, ['migrate-rollouts', '--apply', '--max-mib-per-second', '64'], {
      env: { ...process.env, CODEX_HOME: configDir },
      stdio: 'ignore',
      detached: true,
    });
  } catch (err) {
    console.warn(`[codex-sessions] ${configDir}: could not start the rollout index (${(err as Error).message})`);
    return;
  }
  const started = Date.now();
  child.on('error', (err) => console.warn(`[codex-sessions] ${configDir}: rollout index failed to start (${err.message})`));
  child.on('exit', (code) => console.log(`[codex-sessions] ${configDir}: rollout index ${code === 0 ? 'complete' : 'exited ' + code} after ${Math.round((Date.now() - started) / 1000)}s`));
  child.unref();
}
