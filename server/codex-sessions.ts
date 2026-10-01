import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import type { DatabaseSync as SQLiteDatabase } from 'node:sqlite';
import { codexHomePreparing, markCodexHomePreparing } from '../src/codex-home.js';
import { codexAppServerArgs } from '../src/codex-marketplace-args.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof SQLiteDatabase };

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
 * Whether a Codex home has finished its one-time index of the shared store:
 * `backfill_state.status` in its newest `state_N.sqlite`. undefined when that
 * cannot be told (never started, or a schema this does not know), so a caller
 * only acts on a definite "no".
 */
export function codexHomeIndexed(configDir: string): boolean | undefined {
  let db: string | undefined;
  try {
    db = readdirSync(configDir).filter((f) => /^state_\d+\.sqlite$/.test(f))
      .sort((a, b) => Number(b.slice(6, -7)) - Number(a.slice(6, -7)))[0];
  } catch { return undefined; }
  if (!db) return undefined;
  try {
    const conn = new DatabaseSync(join(configDir, db), { readOnly: true });
    try {
      const row = conn.prepare('select status from backfill_state').get() as { status?: string } | undefined;
      return row ? row.status === 'complete' : undefined;
    } finally { conn.close(); }
  } catch { return undefined; }
}

/** Renames a home's `state_N.sqlite` (and its -wal/-shm) out of the way, kept
 *  for a look later, so the next start builds the index from scratch. */
export function setAsideCodexState(configDir: string): string[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'), moved: string[] = [];
  let files: string[] = [];
  try { files = readdirSync(configDir).filter((f) => /^state_\d+\.sqlite(-wal|-shm)?$/.test(f)); } catch { return moved; }
  for (const f of files) {
    try { renameSync(join(configDir, f), join(configDir, `${f}.unfinished-${stamp}`)); moved.push(f); } catch { /* leave it */ }
  }
  if (moved.length) console.log(`[codex-sessions] ${configDir}: unfinished index set aside (${moved.join(', ')})`);
  return moved;
}

/**
 * Runs Codex's one-time index of the shared store for a home, outside any
 * turn's timeout, and keeps the account out of routing until it is done.
 *
 * The first `codex app-server` in a CODEX_HOME performs a "state db backfill"
 * over everything under `sessions/` -- after linking, the whole gateway store
 * -- and answers nothing, `initialize` included, until it has finished
 * (measured 2026-09-30: 3.5 GB, 205 threads, 224 s). The 30 s turn handshake
 * killed it part-way every time, so the account failed every turn after
 * exactly 30 s with exit 1 and no message, and each start began the index
 * again (`backfill_state = running`, no watermark). Seen on `j` (2026-09-17)
 * and on `g` after a re-login (2026-09-30).
 *
 * So one app-server is held open until `initialize` answers -- which is the
 * index being complete -- and then let go with stdin closed, so it exits on
 * its own rather than being killed around a token refresh. It used to be
 * `codex migrate-rollouts --apply`, which on 0.159 is a different migration
 * (legacy sessions to paginated history) and never finished this index.
 */
export function prepareCodexHome(configDir: string, codexPath = 'codex', timeoutMs = 20 * 60_000): Promise<boolean> {
  if (codexHomePreparing(configDir)) return Promise.resolve(false);
  markCodexHomePreparing(configDir, true);
  // "running" with nobody running it -- a start killed part-way -- makes every
  // later start, this one included, wait 30 s for it and exit 1: "timed out
  // waiting for state db backfill ... (status: running)" (reproduced from g's
  // state, 2026-09-30). A home that never finished its index has never served
  // a turn, so that file holds nothing but the partial index: set it aside.
  if (codexHomeIndexed(configDir) === false) setAsideCodexState(configDir);
  const started = Date.now();
  return new Promise((done) => {
    let settled = false, answered = false, buf = '';
    let child: ChildProcess | undefined;
    const finish = (ok: boolean, why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      markCodexHomePreparing(configDir, false);
      console.log(`[codex-sessions] ${configDir}: rollout index ${ok ? 'complete' : why} after ${Math.round((Date.now() - started) / 1000)}s`);
      done(ok);
    };
    const kill = () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { kill(); finish(false, 'timed out'); }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn(codexPath, codexAppServerArgs(configDir), { env: { ...process.env, CODEX_HOME: configDir }, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    } catch (err) { finish(false, 'could not start (' + (err as Error).message + ')'); return; }
    child.on('error', (err) => finish(false, 'failed to start (' + err.message + ')'));
    child.on('exit', (code) => finish(answered, 'exited ' + code));
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n'); buf = lines.pop() ?? '';
      if (answered || !lines.some((l) => { try { return (JSON.parse(l) as { id?: unknown }).id === 1; } catch { return false; } })) return;
      answered = true;
      // Done: close stdin and let it exit by itself; kill it only if it lingers.
      try { child?.stdin?.end(); } catch { /* gone */ }
      setTimeout(() => { kill(); finish(true, ''); }, 15_000).unref?.();
    });
    child.stdin?.on('error', () => { /* a dead pipe */ });
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'x056-index', version: '1' } } }) + '\n');
    child.unref();
  });
}
