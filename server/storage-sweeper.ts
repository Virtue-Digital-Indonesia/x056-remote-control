import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { localParts, parseBriefAt } from './bot.js';

/**
 * Storage sweeper (docs/storage-sweeper-contract.md).
 *
 * Three classes of thing on the disk:
 *   AUTO       regenerable (dependencies of a finished worktree, pure caches,
 *              container caches, the old dind build cache): removed without
 *              asking, each re-checked right before it goes.
 *   MANIFEST   everything else that looks unused: listed in a dry-run
 *              manifest, removed only after the owner approves the items with a
 *              passkey (storage.controller.ts holds that gate).
 *   PROTECTED  never deleted and never offered: transcripts, uploads, the
 *              gateway's own checkout, worktrees whose git metadata is gone,
 *              detached HEADs no ref contains, anything a live process or a
 *              busy conversation uses. Reported with sizes so they are seen.
 *
 * SAFETY, in the order it is enforced:
 *  - Symlinks are never followed: the walk reads dirent types (a symlink is
 *    never a directory there), every target is lstat'ed, and its realpath must
 *    equal its own path, so no component of it is a link.
 *  - The realpath must be inside an IN root and outside (and not containing)
 *    every PROTECTED realpath, at plan time AND again at delete time. Protected
 *    realpaths are computed per run from the account dirs in accounts.json, so
 *    the transcripts are protected by where they really are, never by name.
 *  - A target holding a mount point is refused (fs.rm would cross it).
 *  - git runs only read-only commands while planning, always with
 *    `-c core.fsmonitor=false` and GIT_OPTIONAL_LOCKS=0. It never runs
 *    `worktree prune`, `gc` or `clean`; the one write is an approved
 *    `git worktree remove` (M3), without --force.
 *  - A dry run cannot delete: its command runner refuses anything that is not
 *    on the read-only list, and the remover is never called.
 *  - Every live-use source fails CLOSED: an unreadable process table, mount
 *    table, project list or dind bind list aborts the whole run.
 *  - Real runs (scheduled, manual, approved) are refused when the workspace
 *    root is the dev instance's poc-ahu-ai tree; a dry run is still allowed.
 */

export const STORAGE_SWEEPER = Symbol('x056-storage-sweeper');

const DAY = 86_400_000;
const GIB = 1024 ** 3;
/** Idle thresholds, days. */
export const SWEEP_IDLE = { auto: 7, outputs: 14, worktree: 30, tmpCache: 3, tmpUnknown: 7 } as const;
/** Items are searched at most this deep below their checkout (web/node_modules = 2). */
const ITEM_DEPTH = 4;
/** The discovery walk stops this deep below a root. */
const WALK_DEPTH = 8;
const WALK_MAX_DIRS = 400_000;
const NM = 'node_modules';
const NM_CACHES = ['.vite', '.vite-temp', '.cache'];
const A2_DIRS = new Set(['.turbo', '.parcel-cache', '.pytest_cache']);
const M2_DIRS = new Set(['dist', 'build', 'target', 'out', 'coverage']);
/** Not counted when deciding whether a checkout is idle (contract A1). */
const IDLE_EXCLUDE = ['node_modules', '.next', 'dist', 'build', 'target', '.turbo', 'coverage', '.git'];
/** Never descended into by the discovery walk. */
const NO_DESCEND = new Set([NM, '.git', '.next', 'dist', 'build', 'target', 'out', 'coverage', '.turbo', '.parcel-cache', '.pytest_cache', '.venv', 'venv', '__pycache__', '.gradle', '.terraform']);
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];
/**
 * A HINT only, never a reason to delete without approval: the volume's name
 * ENDS in a cache segment (`docintel-audit-gocache`, `obs-gomod2`). Anchored at
 * the end so `ergomodel_pg` and `verdaccio-npm-cache-storage` get no hint.
 */
export const CACHE_VOLUME_HINT = /(?:^|[-_.])(gocache|gomod|go-cache|go-mod|npm-cache|pnpm-store|pip-cache)\d*$/;
/** A stopped container whose writable layer holds more than this holds data. */
export const CONTAINER_DATA_BYTES = 50 * 1024 ** 2;
const CONTAINER_KEEP_NAME = /before|rollback|backup/i;
/**
 * Ignored paths `git worktree remove` may take with it (M3): anything at or
 * inside one of these names, or a `*.pyc`. Any other ignored path (`.env`,
 * `local/notes.md`) is data only that worktree has, so M3 is refused.
 */
const REGENERABLE = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'target', 'coverage', '.turbo', '.parcel-cache', '.pytest_cache', '.vite', '.vite-temp', '.cache', '__pycache__', '.gradle', '.angular']);
export function regenerablePath(rel: string): boolean {
  const segs = rel.replace(/\/+$/, '').split('/').filter(Boolean);
  return segs.some((x) => REGENERABLE.has(x)) || /\.pyc$/.test(segs[segs.length - 1] ?? '');
}
/** How much of the reflog (logs/HEAD) must be reachable from a ref before M3. */
const REFLOG_LINES = 200;
/** Index flags / ignored listings bigger than this are not trusted (refused). */
const GIT_LIST_MAX = 256 * 1024 ** 2;
const M5_MIN_BYTES = 500 * 1024 ** 2;
const MANIFEST_TTL_MS = 7 * DAY;
/** A manifest with this much approvable earns a (quiet) notice. */
export const MANIFEST_NOTICE_BYTES = GIB;
const RUNS_SHOWN = 20;
/**
 * Protected by default. `{stateDir}`, `{workspaceRoot}` and a `*` inside one
 * segment are expanded. `<dataDir>/config.json` {protectedPaths} ADDS to these
 * (it can never remove a default).
 *  - the UAT detached checkout;
 *  - poc-ahu-ai: the dev instance (x056-devs) works in this same tree, and its
 *    processes, turns and containers are invisible from here, so none of the
 *    live-use checks could protect its work (the contract puts the dev
 *    instance OUT).
 *  - ahu-codebase: the same reason. The dev instance's compose.override.yaml
 *    (on the host, not in git) bind-mounts `<workspace>/ahu-codebase` into its
 *    containers at `poc-ahu-ai/ahu-codebase`, so production sees that tree
 *    here, outside poc-ahu-ai, while the dev devs work in it.
 */
export const DEFAULT_PROTECTED_PATHS = ['{stateDir}/chats/c06d266a*/work/uat/qol-chatbot/worktree', '{workspaceRoot}/poc-ahu-ai', '{workspaceRoot}/ahu-codebase'];
/** Outside every IN root already; listed so the protected report names them. */
const OUT_PATHS = ['/home/efran/backups', '/home/efran/x056-devs', '/home/efran/dev-workspace'];
const STATE_OUT = ['uploads', 'artifacts', 'project-files', 'file-staging', 'frontend-releases', 'codex-sessions', 'conversation-journal', 'secrets', 'accounts'];
/** Env vars whose value is a cache a live process writes into. */
const CACHE_ENV = ['GOCACHE', 'GOMODCACHE', 'GOTMPDIR', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'npm_config_store_dir', 'PNPM_STORE_DIR', 'PIP_CACHE_DIR'];
const GO_PROCS = new Set(['go', 'gopls', 'compile', 'link', 'vet', 'asm', 'cgo']);

export type SweepRule = 'A1' | 'A2' | 'A3' | 'A4' | 'M1' | 'M2' | 'M3' | 'M4' | 'M5';
export type SweepAction = 'rm' | 'rm-children' | 'git-worktree-remove' | 'command' | 'docker';
export const RULE_LABELS: Record<SweepRule, string> = {
  A1: 'Dependencies in finished worktrees',
  A2: 'Build caches in finished worktrees',
  A3: 'Container caches',
  A4: 'Docker build cache',
  M1: 'Dependencies and caches in idle checkouts',
  M2: 'Ignored build outputs',
  M3: 'Whole finished worktrees',
  M4: 'Docker containers, images and volumes',
  M5: 'Large old /tmp directories',
};

export interface SweepItem {
  id: string;
  rule: SweepRule;
  class: 'auto' | 'manifest';
  target: string;
  bytes: number;
  reason: string;
  evidence: Record<string, unknown>;
  action: SweepAction;
  /** What to re-plan before acting: checkout:<root> | plain:<root> | cache | docker. */
  unit: string;
  /** False = listed for information only (needsBundle, a missing tool). */
  executable: boolean;
  command?: string[];
  /** rm-children: these children stay. */
  keep?: string[];
  locked?: boolean;
  needsBundle?: boolean;
  mayHoldData?: boolean;
  projectId?: string;
}

export interface ProtectedEntry {
  category: string;
  target: string;
  bytes: number | null;
  reason: string;
  projectId?: string;
}

export interface SweepPlan {
  items: SweepItem[];
  protected: ProtectedEntry[];
  notes: { target?: string; reason: string }[];
  truncated: boolean;
  scanned: { roots: number; checkouts: number; units: number; dirs: number; active: number };
}

export interface Manifest {
  id: string;
  createdAt: number;
  expiresAt: number;
  runId: string;
  digest: string;
  items: SweepItem[];
  protected: ProtectedEntry[];
  /** AUTO items a dry run found (not approvable; the daily run takes them). */
  auto: SweepItem[];
  notes: { target?: string; reason: string }[];
  truncated: boolean;
  /** itemId -> runId that executed it. */
  executed?: Record<string, string>;
}

export type RunTrigger = 'scheduled' | 'manual' | 'approval';
export type RunMode = 'auto' | 'dry-run' | 'approved';

export interface Receipt {
  id: string;
  rule: SweepRule;
  target: string;
  bytes: number;
  action: SweepAction;
  result: 'deleted' | 'would-delete' | 'listed' | 'skipped' | 'error';
  reason?: string;
  error?: string;
}

export interface RunRecord {
  runId: string;
  trigger: RunTrigger;
  mode: RunMode;
  startedAt: number;
  endedAt: number;
  items: number;
  deleted: number;
  skipped: number;
  estimatedBytes: number;
  reclaimedBytes: number;
  df: { before: Record<string, number>; after: Record<string, number> };
  manifestId?: string;
  aborted?: string;
  truncated?: boolean;
}

export interface CmdResult { code: number; stdout: string; stderr: string; timedOut?: boolean; /** stdout passed maxBytes and was cut. */ truncated?: boolean }
export interface CmdOptions { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string; maxBytes?: number }
export type CommandRunner = (cmd: string, args: string[], opts?: CmdOptions) => Promise<CmdResult>;

export interface LiveProcess {
  pid: number;
  comm: string;
  argv?: string[];
  /** cwd, open files, cache dirs from its environment: absolute paths. */
  paths: string[];
}

export interface StorageSweeperOptions {
  stateDir: string;
  /** Where runs, manifests and the lock live. Default `<stateDir>/storage-sweeper`. */
  dataDir?: string;
  /** The workspace root (X056_WORKSPACE_ROOT), an IN root. */
  workspaceRoot?: string;
  accountsFile?: string;
  /** Added to the default and configured protectedPaths (never replaces them). */
  protectedPaths?: string[];
  /** The gateway's own checkout(s): OUT. Default `<workspaceRoot>/x056-remote-control`. */
  gatewayCheckouts?: string[];
  home?: string;
  tmpDir?: string;
  /** Sweep the container caches and /tmp (A3, M5). */
  containerCaches?: boolean;
  /** Sweep dind through the docker CLI (A4, M4). */
  dind?: boolean;
  /** Daily schedule on (opt-in: X056_SWEEP=on, see sweepScheduleEnabled). */
  schedule?: boolean;
  sweepAt?: string;
  tz?: string;
  /** Default time budget of a run. */
  budgetMs?: number;
  run?: CommandRunner;
  docker?: CommandRunner;
  processes?: () => LiveProcess[];
  mounts?: () => string[];
  /** Is a conversation of this project busy (turn, background, queue, cron, workflow)? */
  activity?: (projectId: string) => { busy: boolean; reason?: string };
  /** Workspace projects and their cwd, to map a path to its owner. */
  projects?: () => { id: string; cwd: string }[];
  remove?: (path: string) => Promise<void>;
  emit?: (kind: string, data: Record<string, unknown>) => void;
  /** Where storage_sweep / storage_manifest are appended. Default `<stateDir>/events.jsonl`. */
  eventsFile?: string;
  now?: () => number;
  log?: (msg: string) => void;
  concurrency?: number;
}

// ---- small helpers --------------------------------------------------------

export function inside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
}
function real(p: string): string | null { try { return realpathSync(p); } catch { return null; } }
function itemId(rule: string, target: string): string { return createHash('sha256').update(rule + '\0' + target).digest('hex').slice(0, 16); }
/** `checkout:<root>` -> root; anything else has no own checkout. */
function unitRoot(unit: string): string | null { return unit.startsWith('checkout:') ? unit.slice('checkout:'.length) : null; }
function exists(p: string): boolean { try { lstatSync(p); return true; } catch { return false; } }
function isRealDir(p: string): boolean { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } }
function mtime(p: string): number { try { return lstatSync(p).mtimeMs; } catch { return 0; } }
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
export interface FsSample { dev: string; bsize: number; blocks: number; files: number; bavail: number }
/** Free bytes, ONE entry per filesystem, named by the first device seen on it.
 *  A device id is not a filesystem: in the container the workspace bind
 *  (ext4, dev 64512) and the overlay root holding /tmp and the caches
 *  (dev 5242955) are the same disk, and overlay's statfs reports the backing
 *  filesystem's numbers. Keyed by device, the first AUTO run (2026-10-28) counted
 *  that disk twice: reclaimedBytes 42.4 GB against a df delta of 21.2 GB. So
 *  block size + total blocks + total inodes identify the filesystem (free
 *  counts move between two calls, so they are left out). */
export function freeByFilesystem(samples: FsSample[]): Record<string, number> {
  const out: Record<string, number> = {};
  const seen = new Set<string>();
  for (const s of samples) {
    const fs = `${s.bsize}:${s.blocks}:${s.files}`;
    if (out[s.dev] != null || seen.has(fs)) continue;
    seen.add(fs);
    out[s.dev] = s.bavail * s.bsize;
  }
  return out;
}
function writeJson(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
function readJson<T>(file: string): T | null { try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return null; } }
/** The daily schedule is opt-in: only `X056_SWEEP=on` turns it on (unset = off). */
export function sweepScheduleEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.X056_SWEEP === 'on';
}
/**
 * The dev instance's tree: its workspace root IS `poc-ahu-ai`, where the
 * default protected `{workspaceRoot}/poc-ahu-ai` does not exist and
 * production's turns, processes and dind binds are invisible. Returns the
 * offending path when the root is, or is inside, a `poc-ahu-ai` directory.
 */
export function devTreeRoot(workspaceRoot?: string): string | null {
  if (!workspaceRoot) return null;
  for (const p of [resolve(workspaceRoot), real(workspaceRoot)]) if (p && p.split('/').includes('poc-ahu-ai')) return p;
  return null;
}
function onPath(bin: string): boolean {
  for (const d of (process.env.PATH ?? '').split(delimiter)) { try { if (statSync(join(d, bin)).isFile()) return true; } catch { /* next */ } }
  return false;
}

/** The manifest digest: what an approval must name exactly. */
export function manifestDigest(items: SweepItem[]): string {
  const canon = items.map((i) => [i.id, i.rule, i.target, i.bytes, i.reason, i.action, i.executable]);
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}
/** What a passkey assertion is bound to for one approval. */
export function approvalPurpose(manifestId: string, digest: string, itemIds: string[]): string {
  const ids = [...new Set(itemIds)].sort();
  return 'storage-approve:' + createHash('sha256').update(`${manifestId}|${digest}|${ids.join(',')}`).digest('hex');
}

/** Read-only commands a dry run may run; anything else is refused. */
export function readOnlyCommand(cmd: string, args: string[]): boolean {
  const name = basename(cmd);
  if (name === 'du') return true;
  // find can write and run things too: -delete, -exec*, -ok*, -fprint*, -fls.
  if (name === 'find') return !args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a));
  if (name === 'nice' || name === 'ionice') {
    const i = args.findIndex((a) => !a.startsWith('-') && !/^\d+$/.test(a));
    return i >= 0 && readOnlyCommand(args[i], args.slice(i + 1));
  }
  if (name === 'git') {
    const sub = args.filter((a, i) => !(a === '-c' || args[i - 1] === '-c' || a === '-C' || args[i - 1] === '-C' || a.startsWith('--git-dir')))[0];
    if (['rev-parse', 'symbolic-ref', 'for-each-ref', 'status', 'check-ignore', 'ls-files', 'rev-list'].includes(sub)) return true;
    return sub === 'worktree' && args.includes('list');
  }
  if (name === 'docker') {
    const [a, b] = args;
    if (['version', 'ps', 'inspect', 'images'].includes(a)) return true;
    return (a === 'volume' && (b === 'ls' || b === 'inspect')) || (a === 'image' && (b === 'ls' || b === 'inspect')) || (a === 'system' && b === 'df');
  }
  if (name === 'go') return args[0] === 'env';
  return false;
}

export function defaultRunner(): CommandRunner {
  return (cmd, args, o = {}) => new Promise((done) => {
    let out = '', err = '', timedOut = false, settled = false, truncated = false;
    const max = o.maxBytes ?? 32 * 1024 * 1024;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, stdio: [o.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (e) { done({ code: 127, stdout: '', stderr: (e as Error).message }); return; }
    const finish = (code: number) => { if (settled) return; settled = true; clearTimeout(timer); done({ code, stdout: out, stderr: err, ...(timedOut ? { timedOut } : {}), ...(truncated ? { truncated } : {}) }); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, o.timeoutMs ?? 60_000);
    child.stdout?.on('data', (d: Buffer) => { if (out.length < max) out += d.toString(); else truncated = true; });
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 64 * 1024) err += d.toString(); });
    child.on('error', (e) => { err += e.message; finish(127); });
    child.on('close', (code) => finish(timedOut ? 124 : code ?? -1));
    if (o.input != null) { child.stdin?.end(o.input); }
  });
}

/**
 * Every process's cwd, open files and cache env: what is in use right now.
 * THROWS when the process table cannot be read: an empty list would read as
 * "nothing is in use" and fail open. A single process vanishing is normal.
 */
export function listProcesses(procDir = '/proc'): LiveProcess[] {
  const out: LiveProcess[] = [];
  let pids: string[];
  try { pids = readdirSync(procDir).filter((n) => /^\d+$/.test(n)); } catch (e) { throw new Error(`cannot read ${procDir}: ${(e as Error).message}`); }
  if (!pids.length) throw new Error(`${procDir} lists no processes`);
  for (const p of pids) {
    const pid = Number(p), paths: string[] = [];
    let comm = '', argv: string[] = [];
    try { comm = readFileSync(`${procDir}/${p}/comm`, 'utf8').trim(); } catch { continue; }
    try { argv = readFileSync(`${procDir}/${p}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(0, 4); } catch { /* gone */ }
    try { paths.push(readlinkSync(`${procDir}/${p}/cwd`)); } catch { /* gone or not ours */ }
    try {
      for (const fd of readdirSync(`${procDir}/${p}/fd`)) {
        try { const t = readlinkSync(`${procDir}/${p}/fd/${fd}`); if (t.startsWith('/')) paths.push(t.replace(/ \(deleted\)$/, '')); } catch { /* closed */ }
      }
    } catch { /* not ours */ }
    try {
      for (const kv of readFileSync(`${procDir}/${p}/environ`, 'utf8').split('\0')) {
        const i = kv.indexOf('=');
        if (i > 0 && CACHE_ENV.includes(kv.slice(0, i)) && kv.slice(i + 1).startsWith('/')) paths.push(kv.slice(i + 1));
      }
    } catch { /* not ours */ }
    out.push({ pid, comm, argv, paths });
  }
  return out;
}

/** Every mount point. THROWS when the table cannot be read (an empty list would fail open). */
export function listMounts(file = '/proc/self/mountinfo'): string[] {
  let raw: string;
  try { raw = readFileSync(file, 'utf8'); } catch (e) { throw new Error(`cannot read ${file}: ${(e as Error).message}`); }
  const out = raw.split('\n').filter(Boolean)
    .map((l) => l.split(' ')[4]).filter(Boolean)
    .map((m) => m.replace(/\\(\d{3})/g, (_s, o: string) => String.fromCharCode(parseInt(o, 8))));
  if (!out.length) throw new Error(`${file} lists no mounts`);
  return out;
}

/** Expand `{stateDir}` and a `*` within one path segment. */
export function expandPattern(pattern: string, stateDir: string, workspaceRoot?: string): string[] {
  if (pattern.includes('{workspaceRoot}') && !workspaceRoot) return [];
  const p = pattern.replace('{stateDir}', stateDir).replace('{workspaceRoot}', workspaceRoot ?? '');
  const segs = p.split('/');
  let acc = [segs[0] === '' ? '/' : segs[0]];
  for (const seg of segs.slice(1)) {
    if (!seg) continue;
    if (!seg.includes('*')) { acc = acc.map((a) => join(a, seg)); continue; }
    const re = new RegExp('^' + seg.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    const next: string[] = [];
    for (const a of acc) { try { for (const n of readdirSync(a)) if (re.test(n)) next.push(join(a, n)); } catch { /* none */ } }
    acc = next;
  }
  return acc;
}

/** Sorted list + prefix scan: is any live path at or under `dir`? */
class LiveIndex {
  private readonly paths: { path: string; pid: number; comm: string }[];
  constructor(procs: LiveProcess[], extra: string[] = []) {
    const all: { path: string; pid: number; comm: string }[] = [];
    for (const p of procs) for (const path of p.paths) all.push({ path, pid: p.pid, comm: p.comm });
    for (const path of extra) all.push({ path, pid: 0, comm: 'docker-bind' });
    all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    this.paths = all;
  }
  user(dir: string): { pid: number; comm: string; path: string } | null {
    let lo = 0, hi = this.paths.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.paths[m].path < dir) lo = m + 1; else hi = m; }
    for (let i = lo; i < this.paths.length && this.paths[i].path.startsWith(dir); i++) {
      if (inside(this.paths[i].path, dir)) return this.paths[i];
    }
    return null;
  }
}

// ---- context of one run ---------------------------------------------------

interface Root { path: string; kind: 'chat' | 'workspace' | 'cache' | 'tmp'; projectId?: string }
interface Guarded { path: string; category: string; reason: string }

interface Ctx {
  now: number;
  deadline: number;
  /** Planning stops here; the rest of the budget sizes the protected list. */
  planDeadline: number;
  /** dir -> why its whole tree is protected (null = it is not), for nested checkouts. */
  ancestors: Map<string, string | null>;
  dry: boolean;
  roots: Root[];
  stateReal: string | null;
  protect: Guarded[];
  live: LiveIndex;
  liveAt: number;
  procs: LiveProcess[];
  mounts: string[];
  projects: { id: string; cwd: string }[];
  dockerBinds: string[];
  run: CommandRunner;
  docker: CommandRunner;
  busyMemo: Map<string, string | null>;
  /** A live-use source could not be read (processes, mounts, projects, dind binds): nothing runs. */
  failed: string | null;
}

interface Candidate { path: string; kind: 'nm' | 'cache' | 'output' | 'next' }
interface Unit { root: string; kind: 'checkout' | 'plain'; candidates: Candidate[] }
interface UnitResult { items: SweepItem[]; protected: ProtectedEntry[]; notes: { target?: string; reason: string }[]; active?: boolean; evidence?: Record<string, unknown> }

class StopRequested extends Error {}

// ---- approvers -------------------------------------------------------------

/**
 * Passkeys registered before this moment predate the sweeper, so no session
 * could have registered one in order to pass this gate. They are the seed.
 */
export const APPROVER_TRUST_BEFORE = Date.parse('2026-10-26T00:00:00Z');

export interface ApproverPin { id: string; key: string; label?: string; addedAt: number; by: string }
export interface PasskeyKey { id: string; label: string; createdAt: number; key: string }

/**
 * Which passkeys may approve a manifest. Registering a passkey takes only the
 * bearer token, which every session holds, so "any passkey" is not a human
 * gate. An approver is pinned by credential id AND public-key fingerprint:
 *  - seed: a passkey registered before APPROVER_TRUST_BEFORE, pinned the
 *    first time it is seen (its key is fixed from then on);
 *  - afterwards a passkey joins only with an assertion from an approver
 *    (storage.controller.ts).
 * A session that removes the owner's passkey and registers its own key under
 * the same id fails the fingerprint; one that registers a new passkey is not
 * pinned. No approver at all = no approval (fail closed, never the token).
 */
export class StorageApprovers {
  constructor(private readonly stateDir: string, private readonly trustBefore = APPROVER_TRUST_BEFORE) {}
  private get file(): string { return join(this.stateDir, 'storage-sweeper', 'approvers.json'); }
  private read(): { approvers: ApproverPin[]; history: unknown[] } {
    const j = readJson<{ approvers?: ApproverPin[]; history?: unknown[] }>(this.file) ?? {};
    const approvers = (Array.isArray(j.approvers) ? j.approvers : []).filter((p) => p && typeof p.id === 'string' && typeof p.key === 'string');
    return { approvers, history: Array.isArray(j.history) ? j.history : [] };
  }
  pins(): ApproverPin[] { return this.read().approvers; }
  /** The (id, key) pairs that may approve now, given the passkeys that exist. */
  allowed(keys: PasskeyKey[]): { id: string; key: string }[] {
    const cur = this.read();
    const out: { id: string; key: string }[] = [];
    const seed: ApproverPin[] = [];
    for (const k of keys) {
      const pin = cur.approvers.find((p) => p.id === k.id);
      if (pin) { if (pin.key === k.key) out.push({ id: k.id, key: k.key }); continue; }
      if (Number.isFinite(k.createdAt) && k.createdAt < this.trustBefore) {
        seed.push({ id: k.id, key: k.key, label: k.label, addedAt: Date.now(), by: `registered before ${new Date(this.trustBefore).toISOString()}` });
        out.push({ id: k.id, key: k.key });
      }
    }
    if (seed.length) writeJson(this.file, { approvers: [...cur.approvers, ...seed], history: [...cur.history, { at: Date.now(), added: seed.map((p) => p.id), by: 'seed' }] });
    return out;
  }
  has(id: string, key: string): boolean { return this.pins().some((p) => p.id === id && p.key === key); }
  add(k: { id: string; key: string; label?: string }, by: string): void {
    const cur = this.read();
    const approvers = [...cur.approvers.filter((p) => p.id !== k.id), { id: k.id, key: k.key, ...(k.label ? { label: k.label } : {}), addedAt: Date.now(), by }];
    writeJson(this.file, { approvers, history: [...cur.history, { at: Date.now(), added: [k.id], by }] });
  }
}

// ---- the sweeper ------------------------------------------------------------

export class StorageSweeper {
  private timer?: ReturnType<typeof setInterval>;
  private active: { runId: string; mode: RunMode; trigger: RunTrigger; startedAt: number; phase: string } | null = null;
  private readonly run: CommandRunner;
  private readonly docker: CommandRunner;

  constructor(private readonly opts: StorageSweeperOptions) {
    this.run = opts.run ?? defaultRunner();
    this.docker = opts.docker ?? ((cmd, args, o) => this.run(cmd, args, o));
  }

  get dir(): string { return this.opts.dataDir ?? join(this.opts.stateDir, 'storage-sweeper'); }
  private get now(): number { return (this.opts.now ?? Date.now)(); }
  private log(m: string): void { (this.opts.log ?? ((x) => console.log(x)))(`[storage] ${m}`); }
  private get sweepAt(): string { return this.opts.sweepAt && parseBriefAt(this.opts.sweepAt) != null ? this.opts.sweepAt : '04:00'; }
  private get tz(): string { return this.opts.tz || 'Asia/Jakarta'; }
  /** Non-null on the dev instance's tree: only a dry run is allowed there. */
  private devRefusal(): string | null {
    const p = devTreeRoot(this.opts.workspaceRoot);
    return p ? `the workspace root ${p} is the dev instance's poc-ahu-ai tree, where production's turns, processes and dind binds are invisible: only a dry run is allowed` : null;
  }

  // ---- schedule ----
  start(): void {
    if (this.timer || !this.opts.schedule) return;
    const dev = this.devRefusal();
    if (dev) { this.log('daily schedule not started: ' + dev); return; }
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { this.log('tick failed: ' + (e as Error).message); } }, 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  /** Once a day at sweepAt in tz; a swap inside the next two hours catches up. */
  tick(): void {
    if (!this.opts.schedule || this.active || this.devRefusal()) return;
    const at = parseBriefAt(this.sweepAt)!;
    const { date, minutes } = localParts(this.now, this.tz);
    const st = this.state();
    if (st.lastScheduledDate === date || minutes < at || minutes >= at + 120) return;
    this.saveState({ ...st, lastScheduledDate: date });
    try {
      const { done } = this.sweep({ trigger: 'scheduled', dryRun: false });
      done.catch((e) => this.log('scheduled run failed: ' + (e as Error).message));
    } catch (e) { this.log('scheduled run not started: ' + (e as Error).message); }
  }

  private state(): { lastScheduledDate?: string; currentManifest?: string } { return readJson(join(this.dir, 'state.json')) ?? {}; }
  private saveState(s: { lastScheduledDate?: string; currentManifest?: string }): void { writeJson(join(this.dir, 'state.json'), s); }

  // ---- read side ----
  runs(limit = RUNS_SHOWN): RunRecord[] {
    let lines: string[] = [];
    try { lines = readFileSync(join(this.dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { return []; }
    const out: RunRecord[] = [];
    for (const l of lines.slice(-limit).reverse()) { try { out.push(JSON.parse(l) as RunRecord); } catch { /* torn line */ } }
    return out;
  }
  receipts(runId: string): { runId: string; receipts: Receipt[] } | null {
    if (!/^[\w-]{1,80}$/.test(runId)) return null;
    return readJson(join(this.dir, 'runs', `${runId}.json`));
  }
  manifest(id?: string): Manifest | null {
    const mid = id ?? this.state().currentManifest;
    if (!mid || !/^[\w-]{1,80}$/.test(mid)) return null;
    return readJson<Manifest>(join(this.dir, 'manifests', `${mid}.json`));
  }
  status(): Record<string, unknown> {
    const m = this.manifest();
    const pending = m ? m.items.filter((i) => !m.executed?.[i.id]) : [];
    const byRule: Record<string, { items: number; bytes: number }> = {};
    for (const i of pending) { const r = (byRule[i.rule] ??= { items: 0, bytes: 0 }); r.items++; r.bytes += i.bytes; }
    return {
      schedule: { enabled: !!this.opts.schedule, at: this.sweepAt, tz: this.tz },
      running: this.active,
      stopFile: existsSync(join(this.dir, 'STOP')),
      runs: this.runs(),
      manifest: m ? {
        id: m.id, createdAt: m.createdAt, expiresAt: m.expiresAt, expired: m.expiresAt < this.now, digest: m.digest,
        items: pending.length, executable: pending.filter((i) => i.executable).length,
        bytes: pending.filter((i) => i.executable).reduce((s, i) => s + i.bytes, 0), byRule, protected: m.protected.length, truncated: m.truncated,
      } : null,
    };
  }

  // ---- approval checks (the gate itself is in storage.controller.ts) ----
  /** Validate an approval request; throws a plain message when it cannot go ahead. */
  approval(manifestId: string, digest: string, itemIds: string[]): { manifest: Manifest; items: SweepItem[]; bytes: number; purpose: string } {
    if (typeof manifestId !== 'string' || typeof digest !== 'string' || !Array.isArray(itemIds) || !itemIds.length) throw new Error('manifestId, digest and itemIds required');
    const m = this.manifest(manifestId);
    if (!m) throw new Error('unknown manifest');
    if (m.expiresAt < this.now) throw new Error('this manifest has expired; run a new dry run');
    if (m.digest !== digest || manifestDigest(m.items) !== digest) throw new Error('digest does not match this manifest');
    const ids = [...new Set(itemIds)];
    const items: SweepItem[] = [];
    for (const id of ids) {
      const it = m.items.find((i) => i.id === id);
      if (!it) throw new Error(`item ${id} is not in this manifest`);
      if (!it.executable) throw new Error(`item ${id} cannot be approved: ${it.reason}`);
      if (m.executed?.[id]) throw new Error(`item ${id} was already executed`);
      items.push(it);
    }
    return { manifest: m, items, bytes: items.reduce((s, i) => s + i.bytes, 0), purpose: approvalPurpose(manifestId, digest, ids) };
  }

  // ---- runs ----
  /** Start a run. Throws (synchronously) when one is already going. */
  sweep(o: { trigger: RunTrigger; dryRun: boolean; budgetMs?: number }): { runId: string; done: Promise<RunRecord> } {
    const dev = o.dryRun ? null : this.devRefusal();
    if (dev) throw new Error(dev);
    const runId = this.begin(o.trigger, o.dryRun ? 'dry-run' : 'auto');
    const done = this.runSweep(runId, o).finally(() => this.end());
    return { runId, done };
  }

  /** Execute approved manifest items. The caller has verified the human gate. */
  executeApproved(manifestId: string, digest: string, itemIds: string[], budgetMs?: number): { runId: string; done: Promise<RunRecord> } {
    const dev = this.devRefusal();
    if (dev) throw new Error(dev);
    const { manifest, items } = this.approval(manifestId, digest, itemIds);
    const runId = this.begin('approval', 'approved');
    const done = this.runApproved(runId, manifest, items, budgetMs).finally(() => this.end());
    return { runId, done };
  }

  private lockFile(): string { return join(this.dir, 'lock'); }
  private begin(trigger: RunTrigger, mode: RunMode): string {
    if (this.active) throw new Error('a sweep is already running');
    mkdirSync(this.dir, { recursive: true });
    const runId = `${new Date(this.now).toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const lock = this.lockFile();
    const take = () => { const fd = openSync(lock, 'wx'); writeSync(fd, JSON.stringify({ pid: process.pid, runId, at: Date.now() })); closeSync(fd); };
    try { take(); } catch {
      const held = readJson<{ pid?: number; at?: number }>(lock);
      let alive = false;
      try { if (held?.pid && held.pid !== process.pid) { process.kill(held.pid, 0); alive = true; } } catch { alive = false; }
      if (alive && Date.now() - (held?.at ?? 0) < 6 * 3600_000) throw new Error('a sweep is already running (lock held)');
      try { unlinkSync(lock); } catch { /* raced */ }
      take();
    }
    this.active = { runId, mode, trigger, startedAt: this.now, phase: 'starting' };
    return runId;
  }
  private end(): void { this.active = null; try { unlinkSync(this.lockFile()); } catch { /* gone */ } }
  private phase(p: string): void { if (this.active) this.active.phase = p; }
  private checkStop(ctx: Ctx, until = ctx.deadline): void {
    if (existsSync(join(this.dir, 'STOP'))) throw new StopRequested('STOP file present');
    if (this.now > until) throw new StopRequested('time budget used up');
  }
  /** Fail closed: without the account list the transcripts cannot be located, so nothing runs. */
  private essentials(ctx: Ctx): string | null {
    if (ctx.failed) return ctx.failed;
    const file = this.opts.accountsFile ?? join(this.opts.stateDir, 'accounts.json');
    const accounts = readJson<{ accounts?: { configDir?: string }[] }>(file)?.accounts;
    if (!Array.isArray(accounts) || !accounts.some((a) => typeof a?.configDir === 'string')) return `cannot read the accounts in ${file}: the transcripts cannot be protected, so nothing runs`;
    if (!ctx.roots.length) return 'no sweep root exists';
    return null;
  }

  private async runSweep(runId: string, o: { trigger: RunTrigger; dryRun: boolean; budgetMs?: number }): Promise<RunRecord> {
    const startedAt = this.now;
    const ctx = await this.context(o.dryRun, o.budgetMs ?? this.opts.budgetMs ?? (o.dryRun ? 15 : 30) * 60_000);
    const dfBefore = this.df(ctx.roots);
    const missing = this.essentials(ctx);
    if (missing) {
      this.log(missing);
      return this.finishRun(runId, o.trigger, o.dryRun ? 'dry-run' : 'auto', startedAt, ctx, dfBefore, [], { aborted: missing });
    }
    this.phase('planning');
    let plan: SweepPlan;
    try { plan = await this.plan(ctx); }
    catch (e) {
      // A bug, not a stop: record the run, write no manifest, delete nothing.
      this.log('plan failed: ' + (e as Error).stack);
      return this.finishRun(runId, o.trigger, o.dryRun ? 'dry-run' : 'auto', startedAt, ctx, dfBefore, [], { aborted: 'plan failed: ' + (e as Error).message });
    }
    const receipts: Receipt[] = [];
    let aborted: string | undefined;
    const auto = plan.items.filter((i) => i.class === 'auto');
    const manifestItems = plan.items.filter((i) => i.class === 'manifest');
    if (o.dryRun) {
      for (const i of auto) receipts.push(this.receipt(i, i.executable ? 'would-delete' : 'skipped', i.executable ? undefined : i.reason));
    } else {
      this.phase('deleting');
      for (const i of auto) {
        try { this.checkStop(ctx); } catch (e) { aborted = (e as Error).message; receipts.push(this.receipt(i, 'skipped', aborted)); continue; }
        receipts.push(await this.execute(ctx, i, 'quick'));
      }
    }
    for (const i of manifestItems) receipts.push(this.receipt(i, 'listed', i.reason));
    // The manifest: what a human may approve next.
    const m: Manifest = {
      id: runId, createdAt: this.now, expiresAt: this.now + MANIFEST_TTL_MS, runId,
      digest: manifestDigest(manifestItems), items: manifestItems, protected: plan.protected,
      auto: o.dryRun ? auto : [], notes: plan.notes, truncated: plan.truncated,
    };
    writeJson(join(this.dir, 'manifests', `${m.id}.json`), m);
    this.saveState({ ...this.state(), currentManifest: m.id });
    const rec = this.finishRun(runId, o.trigger, o.dryRun ? 'dry-run' : 'auto', startedAt, ctx, dfBefore, receipts, { manifestId: m.id, aborted, truncated: plan.truncated });
    const approvable = manifestItems.filter((i) => i.executable);
    const bytes = approvable.reduce((s, i) => s + i.bytes, 0);
    if (bytes >= MANIFEST_NOTICE_BYTES) this.emit('storage_manifest', { manifestId: m.id, items: approvable.length, bytes, at: new Date(this.now).toISOString() });
    return rec;
  }

  private async runApproved(runId: string, m: Manifest, items: SweepItem[], budgetMs?: number): Promise<RunRecord> {
    const startedAt = this.now;
    const ctx = await this.context(false, budgetMs ?? this.opts.budgetMs ?? 30 * 60_000);
    const dfBefore = this.df(ctx.roots);
    const missing = this.essentials(ctx);
    if (missing) this.log(missing);
    if (missing) return this.finishRun(runId, 'approval', 'approved', startedAt, ctx, dfBefore, items.map((i) => this.receipt(i, 'skipped', missing)), { manifestId: m.id, aborted: missing });
    this.phase('deleting');
    const receipts: Receipt[] = [];
    let aborted: string | undefined;
    const executed = { ...(m.executed ?? {}) };
    for (const i of items) {
      try { this.checkStop(ctx); } catch (e) { aborted = (e as Error).message; receipts.push(this.receipt(i, 'skipped', aborted)); continue; }
      const r = await this.execute(ctx, i, 'full');
      receipts.push(r);
      if (r.result === 'deleted') executed[i.id] = runId;
    }
    writeJson(join(this.dir, 'manifests', `${m.id}.json`), { ...m, executed });
    return this.finishRun(runId, 'approval', 'approved', startedAt, ctx, dfBefore, receipts, { manifestId: m.id, aborted });
  }

  private receipt(i: SweepItem, result: Receipt['result'], reason?: string, error?: string): Receipt {
    return { id: i.id, rule: i.rule, target: i.target, bytes: i.bytes, action: i.action, result, ...(reason ? { reason } : {}), ...(error ? { error } : {}) };
  }

  private finishRun(runId: string, trigger: RunTrigger, mode: RunMode, startedAt: number, ctx: Ctx, dfBefore: Record<string, number>, receipts: Receipt[], extra: { manifestId?: string; aborted?: string; truncated?: boolean }): RunRecord {
    const dfAfter = this.df(ctx.roots);
    let reclaimed = 0;
    for (const k of Object.keys(dfBefore)) if (dfAfter[k] != null) reclaimed += dfAfter[k] - dfBefore[k];
    const rec: RunRecord = {
      runId, trigger, mode, startedAt, endedAt: this.now,
      items: receipts.length,
      deleted: receipts.filter((r) => r.result === 'deleted').length,
      skipped: receipts.filter((r) => r.result === 'skipped' || r.result === 'error').length,
      estimatedBytes: receipts.filter((r) => r.result === 'deleted' || r.result === 'would-delete' || (mode === 'dry-run' && r.result === 'listed')).reduce((s, r) => s + r.bytes, 0),
      reclaimedBytes: mode === 'dry-run' ? 0 : Math.max(0, reclaimed),
      df: { before: dfBefore, after: dfAfter },
      ...(extra.manifestId ? { manifestId: extra.manifestId } : {}),
      ...(extra.aborted ? { aborted: extra.aborted } : {}),
      ...(extra.truncated ? { truncated: true } : {}),
    };
    writeJson(join(this.dir, 'runs', `${runId}.json`), { runId, receipts });
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, 'runs.jsonl'), JSON.stringify(rec) + '\n');
    this.emit('storage_sweep', { runId, mode, reclaimedBytes: rec.reclaimedBytes, deleted: rec.deleted, at: new Date(this.now).toISOString() });
    this.log(`${mode} run ${runId}: ${rec.deleted} deleted, ${rec.skipped} skipped, ${fmtBytes(rec.reclaimedBytes)} reclaimed`);
    return rec;
  }
  private emit(kind: string, data: Record<string, unknown>): void {
    try { appendFileSync(this.opts.eventsFile ?? join(this.opts.stateDir, 'events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: kind, ...data }) + '\n'); } catch { /* logging only */ }
    try { this.opts.emit?.(kind, data); } catch { /* never break a run */ }
  }

  /** Free bytes per filesystem holding the roots (see `freeByFilesystem`). */
  private df(roots: Root[]): Record<string, number> {
    const samples: FsSample[] = [];
    for (const r of roots) {
      try {
        const s = statfsSync(r.path);
        samples.push({ dev: String(statSync(r.path).dev), bsize: Number(s.bsize), blocks: Number(s.blocks), files: Number(s.files), bavail: Number(s.bavail) });
      } catch { /* gone */ }
    }
    return freeByFilesystem(samples);
  }

  // ---- context ----
  private async context(dry: boolean, budgetMs: number): Promise<Ctx> {
    const run: CommandRunner = dry
      ? (cmd, args, o) => readOnlyCommand(cmd, args) ? this.run(cmd, args, o) : Promise.reject(new Error(`dry run refuses: ${cmd} ${args.join(' ')}`))
      : this.run;
    const docker: CommandRunner = dry
      ? (cmd, args, o) => readOnlyCommand(cmd, args) ? this.docker(cmd, args, o) : Promise.reject(new Error(`dry run refuses: ${cmd} ${args.join(' ')}`))
      : this.docker;
    // Every live-use source fails CLOSED: an unreadable one aborts the run
    // (essentials), never reads as "nothing in use".
    const failed: string[] = [];
    const attempt = <T>(what: string, f: () => T, fallback: T): T => { try { return f(); } catch (e) { failed.push(`${what}: ${(e as Error).message}`); return fallback; } };
    const procs = attempt('cannot list processes', () => (this.opts.processes ?? listProcesses)(), [] as LiveProcess[]);
    const mounts = attempt('cannot read the mount table', () => (this.opts.mounts ?? listMounts)(), [] as string[]);
    const projects = attempt('cannot list the workspace projects for the busy check', () => (this.opts.projects?.() ?? []).map((p) => ({ id: p.id, cwd: real(p.cwd) ?? p.cwd })), [] as { id: string; cwd: string }[]);
    const ctx: Ctx = {
      now: this.now, deadline: this.now + budgetMs, planDeadline: this.now + budgetMs - Math.min(budgetMs * 0.2, 180_000), ancestors: new Map(), dry,
      roots: this.roots(), stateReal: real(this.opts.stateDir), protect: this.protectedPaths(),
      procs, live: new LiveIndex(procs), liveAt: Date.now(), mounts, projects,
      dockerBinds: [], run, docker, busyMemo: new Map(), failed: null,
    };
    if (this.opts.dind) {
      try { ctx.dockerBinds = await this.runningBindSources(ctx); }
      catch (e) { failed.push(`cannot list the bind mounts of running dind containers: ${(e as Error).message}`); }
      ctx.live = new LiveIndex(procs, ctx.dockerBinds);
    }
    if (failed.length) ctx.failed = `${failed.join('; ')}: what is in use cannot be known, so nothing runs`;
    return ctx;
  }
  /** Throws (leaving ctx as it was) when the process table cannot be read. */
  private refreshLive(ctx: Ctx): void {
    if (Date.now() - ctx.liveAt < 5000) return;
    const procs = (this.opts.processes ?? listProcesses)();
    ctx.procs = procs;
    ctx.live = new LiveIndex(ctx.procs, ctx.dockerBinds);
    ctx.liveAt = Date.now();
    ctx.busyMemo.clear();
  }

  private home(): string { return this.opts.home ?? process.env.HOME ?? '/root'; }
  private pnpmStores(): string[] { return [join(this.opts.stateDir, '.pnpm-store'), join(this.home(), '.local', 'share', 'pnpm', 'store')]; }
  private goCacheDir(): string { return process.env.GOCACHE && process.env.GOCACHE.startsWith('/') ? process.env.GOCACHE : join(this.home(), '.cache', 'go-build'); }

  roots(): Root[] {
    const out: Root[] = [];
    const chats = join(this.opts.stateDir, 'chats');
    try {
      for (const id of readdirSync(chats)) {
        const work = join(chats, id, 'work');
        if (!isRealDir(join(chats, id)) || !isRealDir(work)) continue;
        const r = real(work); if (r) out.push({ path: r, kind: 'chat', projectId: id });
      }
    } catch { /* no chats */ }
    if (this.opts.workspaceRoot) { const r = real(this.opts.workspaceRoot); if (r) out.push({ path: r, kind: 'workspace' }); }
    if (this.opts.containerCaches) {
      for (const p of [this.goCacheDir(), join(this.home(), '.cache', 'pip'), join(this.home(), '.npm', '_cacache'), ...this.pnpmStores()]) { const r = isRealDir(p) ? real(p) : null; if (r) out.push({ path: r, kind: 'cache' }); }
      const t = real(this.opts.tmpDir ?? '/tmp'); if (t) out.push({ path: t, kind: 'tmp' });
    }
    return out;
  }

  protectedPaths(): Guarded[] {
    const out: Guarded[] = [];
    const add = (p: string, category: string, reason: string) => { const r = real(p); if (r && !out.some((g) => g.path === r)) out.push({ path: r, category, reason }); };
    const accounts = readJson<{ accounts?: { name?: string; configDir?: string; provider?: string }[] }>(this.opts.accountsFile ?? join(this.opts.stateDir, 'accounts.json'));
    for (const a of accounts?.accounts ?? []) {
      if (!a.configDir) continue;
      add(join(a.configDir, 'projects'), 'transcripts', `transcripts (account ${a.name ?? '?'})`);
      add(join(a.configDir, 'sessions'), 'transcripts', `Codex rollouts (account ${a.name ?? '?'})`);
      add(a.configDir, 'account', `account ${a.name ?? '?'} config`);
    }
    for (const s of STATE_OUT) add(join(this.opts.stateDir, s), 'state', `gateway state: ${s}`);
    const gw = this.opts.gatewayCheckouts ?? (this.opts.workspaceRoot ? [join(this.opts.workspaceRoot, 'x056-remote-control')] : []);
    for (const g of gw) add(g, 'gateway', "the gateway's own checkout and .deploy");
    for (const o of OUT_PATHS) add(o, 'out', 'out of scope');
    // Additive: config.json (and the option) can only add, never drop a default.
    const fromConfig = readJson<{ protectedPaths?: unknown }>(join(this.dir, 'config.json'))?.protectedPaths;
    const configured = [...new Set([...DEFAULT_PROTECTED_PATHS, ...(this.opts.protectedPaths ?? []), ...(Array.isArray(fromConfig) ? fromConfig.filter((x): x is string => typeof x === 'string') : [])])];
    for (const pat of configured) for (const p of expandPattern(pat, this.opts.stateDir, this.opts.workspaceRoot)) add(p, 'configured', `configured protectedPaths (${pat})`);
    return out;
  }

  /** Null when `target` may be touched; otherwise why not. Checked at plan AND delete time. */
  private refusal(ctx: Ctx, target: string, allowRootItself = false): string | null {
    const r = real(target);
    if (!r) return 'missing';
    if (r !== resolve(target)) return 'path goes through a symlink';
    const root = ctx.roots.find((x) => inside(r, x.path) && (r !== x.path || (allowRootItself && x.kind === 'cache')));
    if (!root) return 'outside every sweep root';
    // Inside the state dir only a chat's work tree, or a cache root itself (the
    // pnpm store, acted on by command), may be touched.
    if (ctx.stateReal && inside(r, ctx.stateReal) && !ctx.roots.some((x) => (x.kind === 'chat' && inside(r, x.path) && r !== x.path) || (allowRootItself && x.kind === 'cache' && r === x.path))) return 'inside the gateway state';
    for (const g of ctx.protect) {
      if (inside(r, g.path)) return `protected: ${g.reason}`;
      if (inside(g.path, r)) return `contains protected ${g.reason}`;
    }
    if (ctx.mounts.some((m) => inside(m, r))) return 'holds a mount point';
    return null;
  }

  private ownerOf(ctx: Ctx, path: string): string[] {
    const ids: string[] = [];
    for (const r of ctx.roots) if (r.kind === 'chat' && inside(path, r.path) && r.projectId) ids.push(r.projectId);
    for (const p of ctx.projects) if (inside(path, p.cwd) || inside(p.cwd, path)) ids.push(p.id);
    return [...new Set(ids)];
  }
  private busy(ctx: Ctx, path: string): string | null {
    for (const id of this.ownerOf(ctx, path)) {
      if (!ctx.busyMemo.has(id)) {
        let reason: string | null = null;
        try { const a = this.opts.activity?.(id); if (a?.busy) reason = a.reason || 'busy'; } catch (e) { reason = 'activity unknown: ' + (e as Error).message; }
        ctx.busyMemo.set(id, reason);
      }
      const why = ctx.busyMemo.get(id);
      if (why) return `conversation busy (${why}) in project ${id}`;
    }
    return null;
  }
  private inUse(ctx: Ctx, path: string): string | null {
    const u = ctx.live.user(path);
    return u ? (u.pid ? `in use by pid ${u.pid} (${u.comm}): ${u.path}` : `bind-mounted by a running dind container: ${u.path}`) : null;
  }

  // ---- plan ----
  async plan(ctx: Ctx): Promise<SweepPlan> {
    const plan: SweepPlan = { items: [], protected: [], notes: [], truncated: false, scanned: { roots: 0, checkouts: 0, units: 0, dirs: 0, active: 0 } };
    const addResult = (r: UnitResult) => {
      for (const i of r.items) if (!plan.items.some((x) => x.id === i.id)) plan.items.push(i);
      for (const p of r.protected) if (!plan.protected.some((x) => x.target === p.target && x.category === p.category)) plan.protected.push(p);
      plan.notes.push(...r.notes);
      if (r.active) plan.scanned.active++;
    };
    try {
      // 1. Checkouts and plain dirs under the chat and workspace roots.
      const units = new Map<string, Unit>();
      for (const root of ctx.roots.filter((r) => r.kind === 'chat' || r.kind === 'workspace')) {
        this.checkStop(ctx, ctx.planDeadline);
        plan.scanned.roots++;
        plan.scanned.dirs += await this.discover(ctx, root.path, units);
      }
      plan.scanned.units = units.size;
      plan.scanned.checkouts = [...units.values()].filter((u) => u.kind === 'checkout').length;
      // Shallow first: the workspace's own projects before deep chat trees.
      const list = [...units.values()].sort((a, b) => a.root.split('/').length - b.root.split('/').length);
      let next = 0, stopped: StopRequested | null = null;
      const worker = async () => {
        while (next < list.length && !stopped) {
          const u = list[next++];
          try { this.checkStop(ctx, ctx.planDeadline); addResult(await this.evalUnit(ctx, u)); }
          catch (e) { if (e instanceof StopRequested) { stopped = e; return; } throw e; }
        }
      };
      // Every worker has returned before the plan is used: none adds late.
      const settled = await Promise.allSettled(Array.from({ length: Math.max(1, this.opts.concurrency ?? 3) }, worker));
      const failed = settled.find((x): x is PromiseRejectedResult => x.status === 'rejected');
      if (failed) throw failed.reason;
      if (stopped) throw stopped;
      // 2. Container caches and /tmp.
      if (this.opts.containerCaches) { this.checkStop(ctx, ctx.planDeadline); this.phase('planning caches'); addResult(await this.evalCaches(ctx)); }
      // 3. dind.
      if (this.opts.dind) { this.checkStop(ctx, ctx.planDeadline); this.phase('planning docker'); addResult(await this.evalDocker(ctx)); }
    } catch (e) {
      if (!(e instanceof StopRequested)) throw e;
      plan.truncated = true;
      plan.notes.push({ reason: `plan stopped early: ${e.message}` });
    }
    // 4. Sizes of what is protected, while the budget lasts.
    this.phase('sizing protected');
    for (const g of ctx.protect) if (!plan.protected.some((p) => p.target === g.path)) plan.protected.push({ category: g.category, target: g.path, bytes: null, reason: g.reason });
    // The per-checkout entries first: the account and state trees are the
    // biggest to walk, and a timed-out du loses only what it had not printed.
    const last = new Set(['transcripts', 'account', 'state', 'gateway', 'out']);
    const unsized = plan.protected.filter((p) => p.bytes == null && p.target.startsWith('/'))
      .sort((a, b) => Number(last.has(a.category)) - Number(last.has(b.category)));
    for (let i = 0; i < unsized.length && this.now < ctx.deadline; i += 8) {
      const chunk = unsized.slice(i, i + 8);
      const sizes = await this.du(ctx, chunk.map((p) => p.target), Math.min(120_000, Math.max(1000, ctx.deadline - this.now)));
      for (const p of chunk) p.bytes = sizes.get(p.target) ?? null;
    }
    plan.items.sort((a, b) => a.rule.localeCompare(b.rule) || b.bytes - a.bytes);
    plan.protected.sort((a, b) => a.category.localeCompare(b.category) || (b.bytes ?? 0) - (a.bytes ?? 0));
    return plan;
  }

  /** Bounded readdir walk: checkouts and the candidates inside them. Returns dirs visited.
   *  Yields to the event loop every few hundred directories: the gateway keeps serving. */
  private async discover(ctx: Ctx, rootPath: string, units: Map<string, Unit>): Promise<number> {
    let visited = 0;
    const stack: { dir: string; depth: number; co: string | null }[] = [{ dir: rootPath, depth: 0, co: null }];
    while (stack.length) {
      if (visited >= WALK_MAX_DIRS || this.now > ctx.planDeadline) throw new StopRequested(visited >= WALK_MAX_DIRS ? 'directory walk limit reached' : 'time budget used up');
      if (visited % 200 === 199) await new Promise((r) => setImmediate(r));
      const { dir, depth, co: parentCo } = stack.pop()!;
      visited++;
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const git = entries.find((e) => e.name === '.git' && (e.isFile() || e.isDirectory()));
      const co = git ? dir : parentCo;
      if (git && !units.has(dir)) units.set(dir, { root: dir, kind: 'checkout', candidates: [] });
      for (const e of entries) {
        if (!e.isDirectory()) continue; // a symlink is never a directory here
        const p = join(dir, e.name);
        let kind: Candidate['kind'] | null = e.name === NM ? 'nm' : e.name === '.next' ? 'next' : A2_DIRS.has(e.name) ? 'cache' : M2_DIRS.has(e.name) ? 'output' : null;
        // A checkout that happens to be called `out` or `build` is a checkout.
        const isCheckout = (kind || NO_DESCEND.has(e.name)) && e.name !== '.git' ? exists(join(p, '.git')) : false;
        if (isCheckout) kind = null;
        if (kind) {
          if (co) {
            if (relative(co, p).split('/').length <= ITEM_DEPTH) units.get(co)!.candidates.push({ path: p, kind });
          } else if (kind === 'nm' || kind === 'cache') {
            const key = dir;
            if (!units.has(key)) units.set(key, { root: dir, kind: 'plain', candidates: [] });
            units.get(key)!.candidates.push({ path: p, kind });
          }
        }
        if ((!isCheckout && (kind || NO_DESCEND.has(e.name))) || depth + 1 > WALK_DEPTH) continue;
        stack.push({ dir: p, depth: depth + 1, co });
      }
    }
    // A plain unit that sits inside a checkout belongs to it (cannot happen by
    // construction, but never let one escape the git checks).
    for (const [k, u] of units) if (u.kind === 'plain' && [...units.values()].some((c) => c.kind === 'checkout' && inside(u.root, c.root))) units.delete(k);
    return visited;
  }

  private gitEnv = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  private git(ctx: Ctx, dir: string, args: string[], o: CmdOptions = {}): Promise<CmdResult> {
    return ctx.run('git', ['-c', 'core.fsmonitor=false', '-C', dir, ...args], { timeoutMs: 120_000, ...o, env: { ...this.gitEnv, ...(o.env ?? {}) } })
      .catch((e: Error) => ({ code: 126, stdout: '', stderr: e.message }));
  }
  private nice(cmd: string, args: string[]): [string, string[]] {
    return onPath('ionice') && onPath('nice') ? ['nice', ['-n', '10', 'ionice', '-c', '3', cmd, ...args]] : [cmd, args];
  }

  /** Newest file mtime under root (outside the excluded dirs), stopping at the first newer than `stopAbove`. */
  private newestFile(root: string, stopAbove: number, timeoutMs: number): Promise<{ newest: number; bytes: number; stopped: boolean; error?: string }> {
    const prune: string[] = [];
    IDLE_EXCLUDE.forEach((n, i) => { if (i) prune.push('-o'); prune.push('-name', n); });
    const findArgs = [root, '-mindepth', '1', '(', ...prune, ')', '-prune', '-o', '(', '-type', 'f', '-o', '-type', 'l', ')', '-printf', '%T@ %s\\n'];
    const [cmd, args] = this.nice('find', findArgs);
    return new Promise((done) => {
      let newest = 0, bytes = 0, stopped = false, buf = '', err = '', settled = false;
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (error?: string) => { if (settled) return; settled = true; clearTimeout(timer); done({ newest, bytes, stopped, ...(error ? { error } : {}) }); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish('timed out'); }, timeoutMs);
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const l of lines) {
          const sp = l.indexOf(' ');
          const t = Number(l.slice(0, sp)) * 1000, s = Number(l.slice(sp + 1));
          if (t > newest) newest = t;
          if (Number.isFinite(s)) bytes += s;
          if (newest > stopAbove && !stopped) { stopped = true; child.kill('SIGKILL'); break; }
        }
      });
      child.stderr.on('data', (d: Buffer) => { if (err.length < 4096) err += d.toString(); });
      child.on('error', (e) => finish(e.message));
      child.on('close', (code) => finish(stopped || code === 0 ? undefined : (err.trim().split('\n')[0] || `find exited ${code}`)));
    });
  }

  /** `du -sb -x` of several paths in one call: path -> bytes. */
  private async du(ctx: Ctx, paths: string[], timeoutMs = 300_000): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!paths.length) return out;
    const [cmd, args] = this.nice('du', ['-s', '-b', '-x', '--', ...paths]);
    const r = await ctx.run(cmd, args, { timeoutMs }).catch(() => null);
    for (const l of (r?.stdout ?? '').split('\n')) {
      const tab = l.indexOf('\t');
      if (tab > 0) out.set(l.slice(tab + 1), Number(l.slice(0, tab)) || 0);
    }
    return out;
  }

  /**
   * `linked` = a linked worktree (`git worktree add`): only its gitdir holds a
   * `commondir` file. A submodule also has a `.git` FILE, pointing into
   * `<parent>/.git/modules/<name>`, but no `commondir`: it is a checkout of its
   * own, never M3 (`git worktree remove` refuses it: "is not a working tree").
   */
  private gitInfo(root: string): { type: 'dir' | 'file' | null; gitdir?: string; gitdirExists?: boolean; commondir?: string; locked?: boolean; linked?: boolean } {
    let st; try { st = lstatSync(join(root, '.git')); } catch { return { type: null }; }
    if (st.isDirectory()) return { type: 'dir', gitdir: join(root, '.git'), gitdirExists: true, commondir: join(root, '.git') };
    if (!st.isFile()) return { type: null };
    let raw = ''; try { raw = readFileSync(join(root, '.git'), 'utf8'); } catch { return { type: 'file', gitdirExists: false }; }
    const m = /^gitdir:\s*(.+)\s*$/m.exec(raw);
    if (!m) return { type: 'file', gitdirExists: false };
    const gitdir = resolve(root, m[1].trim());
    let isDir = false; try { isDir = statSync(gitdir).isDirectory(); } catch { /* missing */ }
    if (!isDir) return { type: 'file', gitdir, gitdirExists: false };
    let commondir = gitdir, linked = false;
    try { commondir = resolve(gitdir, readFileSync(join(gitdir, 'commondir'), 'utf8').trim()); linked = true; } catch { /* not a linked one (a submodule) */ }
    if (!existsSync(join(commondir, 'HEAD'))) return { type: 'file', gitdir, gitdirExists: false, commondir, linked };
    return { type: 'file', gitdir, gitdirExists: true, commondir, linked, locked: existsSync(join(gitdir, 'locked')) };
  }

  private lockfileFor(nmParent: string, stopAt: string): string | null {
    for (let d = nmParent; ; d = dirname(d)) {
      try { for (const n of readdirSync(d)) if (LOCKFILES.includes(n) || n.startsWith('bun.lock')) return join(d, n); } catch { /* unreadable */ }
      if (d === stopAt || !inside(d, stopAt) || d === dirname(d)) return null;
    }
  }

  async evalUnit(ctx: Ctx, u: Unit, opts: { skipIdleScan?: boolean } = {}): Promise<UnitResult> {
    return u.kind === 'checkout' ? this.evalCheckout(ctx, u, opts) : this.evalPlain(ctx, u);
  }

  /** The unit-level gates both kinds share: protected, busy, in use. */
  private unitGate(ctx: Ctx, root: string, res: UnitResult): boolean {
    for (const g of ctx.protect) if (inside(root, g.path)) { res.protected.push({ category: g.category, target: g.path, bytes: null, reason: g.reason }); return false; }
    const busy = this.busy(ctx, root);
    if (busy) { res.protected.push({ category: 'busy', target: root, bytes: null, reason: busy }); return false; }
    const used = this.inUse(ctx, root);
    if (used) { res.protected.push({ category: 'in-use', target: root, bytes: null, reason: used }); return false; }
    return true;
  }

  private async evalPlain(ctx: Ctx, u: Unit): Promise<UnitResult> {
    const res: UnitResult = { items: [], protected: [], notes: [] };
    if (!this.unitGate(ctx, u.root, res)) return res;
    const idle = await this.newestFile(u.root, ctx.now - SWEEP_IDLE.auto * DAY, Math.max(1000, ctx.deadline - this.now));
    if (idle.error) { res.notes.push({ target: u.root, reason: `could not scan: ${idle.error}` }); return res; }
    if (idle.stopped) return { ...res, active: true };
    const idleDays = idle.newest ? Math.floor((ctx.now - idle.newest) / DAY) : null;
    const targets: { path: string }[] = [];
    for (const c of u.candidates) if (c.kind === 'nm' || c.kind === 'cache') targets.push({ path: c.path });
    await this.addItems(ctx, res, targets.map((t) => ({ path: t.path, rule: 'M1' as const, reason: 'not a git checkout', unit: `plain:${u.root}`, evidence: { idleDays } })));
    return res;
  }

  private async evalCheckout(ctx: Ctx, u: Unit, opts: { skipIdleScan?: boolean } = {}): Promise<UnitResult> {
    const res: UnitResult = { items: [], protected: [], notes: [] };
    const root = u.root;
    if (!this.unitGate(ctx, root, res)) return res;
    const gi = this.gitInfo(root);
    const unit = `checkout:${root}`;
    // Idle: no file outside the build dirs, and none of the gitdir's index /
    // HEAD / logs/HEAD, is younger than 7 days.
    const gitFiles = gi.gitdir && gi.gitdirExists ? ['index', 'HEAD', 'logs/HEAD'].map((f) => mtime(join(gi.gitdir!, f))) : [];
    const gitNewest = Math.max(0, ...gitFiles);
    let newest = gitNewest, outsideBytes = 0;
    if (gitNewest > ctx.now - SWEEP_IDLE.auto * DAY) return { ...res, active: true };
    if (!opts.skipIdleScan) {
      const scan = await this.newestFile(root, ctx.now - SWEEP_IDLE.auto * DAY, Math.max(1000, ctx.deadline - this.now));
      if (scan.error) { res.notes.push({ target: root, reason: `could not scan: ${scan.error}` }); return res; }
      if (scan.stopped) return { ...res, active: true };
      newest = Math.max(newest, scan.newest);
      outsideBytes = scan.bytes;
    }
    const idleDays = newest ? Math.floor((ctx.now - newest) / DAY) : 9999;
    const ev = { idleDays, gitdir: gi.gitdir ?? null };
    const nmCaches = (nm: string) => NM_CACHES.map((c) => join(nm, c)).filter(isRealDir);
    const nextCache = (n: string) => (isRealDir(join(n, 'cache')) ? [join(n, 'cache')] : []);

    // Missing git metadata: the source is protected, only deps/caches are offered.
    if (gi.type === 'file' && !gi.gitdirExists) {
      res.protected.push({ category: 'missing-gitdir', target: root, bytes: null, reason: `worktree git metadata is missing (${gi.gitdir ?? 'no gitdir line'}); its source is kept` });
      const t: Parameters<StorageSweeper['addItems']>[2] = [];
      for (const c of u.candidates) {
        if (c.kind === 'nm' || c.kind === 'cache') t.push({ path: c.path, rule: 'M1', reason: 'git metadata missing', unit, evidence: ev });
        if (c.kind === 'next') for (const p of nextCache(c.path)) t.push({ path: p, rule: 'M1', reason: 'git metadata missing', unit, evidence: ev });
      }
      await this.addItems(ctx, res, t);
      return res;
    }
    if (!gi.type) return res;

    const head = await this.git(ctx, root, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.code !== 0) { res.notes.push({ target: root, reason: 'git could not read HEAD: ' + (head.stderr.trim().split('\n')[0] || `exit ${head.code}`) }); return res; }
    const headSha = head.stdout.trim();
    const detached = (await this.git(ctx, root, ['symbolic-ref', '-q', 'HEAD'])).code !== 0;
    const refsR = await this.git(ctx, root, ['for-each-ref', '--contains', headSha, '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes']);
    if (refsR.code !== 0) { res.notes.push({ target: root, reason: 'git for-each-ref failed: ' + refsR.stderr.trim().split('\n')[0] }); return res; }
    const refs = refsR.stdout.split('\n').filter(Boolean);
    if (detached && !refs.length) {
      res.protected.push({ category: 'detached-unreachable', target: root, bytes: null, reason: `detached HEAD ${headSha.slice(0, 12)} is in no branch, tag or remote; the whole tree is kept` });
      return res;
    }
    const st = await this.git(ctx, root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
    if (st.code !== 0) { res.notes.push({ target: root, reason: 'git status failed: ' + st.stderr.trim().split('\n')[0] }); return res; }
    const dirty = st.stdout.length > 0;
    const shared = refs.some((r) => r.startsWith('refs/tags/') || r.startsWith('refs/remotes/'));
    const linked = gi.type === 'file' && gi.linked === true;
    const why: string[] = [];
    if (!linked) why.push(gi.type === 'file' ? 'submodule checkout, not a linked worktree' : 'main checkout, not a linked worktree');
    if (dirty) why.push('uncommitted changes');
    if (!shared) why.push(refs.length ? 'HEAD only on local branches' : 'HEAD in no ref');
    const finished = why.length === 0;
    const evid = { ...ev, head: headSha, refs: refs.slice(0, 5), dirty, linked };

    // Which candidates git calls ignored, and which hold tracked files: an
    // untracked or tracked path is source and is never deleted.
    const rels = u.candidates.map((c) => relative(root, c.path));
    const ign = rels.length ? await this.git(ctx, root, ['check-ignore', '-z', '--stdin'], { input: rels.join('\0') + '\0' }) : { code: 1, stdout: '', stderr: '' };
    const ignored = new Set(ign.stdout.split('\0').filter(Boolean));
    const tr: CmdResult = rels.length ? await this.git(ctx, root, ['ls-files', '-z', '--', ...rels], { maxBytes: GIT_LIST_MAX }) : { code: 0, stdout: '', stderr: '' };
    // Without a trustworthy answer from git, every candidate may be source.
    const gitFailed = ign.code > 1 ? `git check-ignore failed: ${ign.stderr.trim().split('\n')[0] || 'exit ' + ign.code}`
      : tr.code !== 0 || tr.truncated ? `git ls-files failed: ${tr.truncated ? 'output too large' : tr.stderr.trim().split('\n')[0] || 'exit ' + tr.code}` : null;
    if (gitFailed) {
      for (const c of u.candidates) res.protected.push({ category: 'refused', target: c.path, bytes: null, reason: gitFailed });
      res.notes.push({ target: root, reason: gitFailed });
      return res;
    }
    const tracked = tr.stdout.split('\0').filter(Boolean);
    const hasTracked = (rel: string) => tracked.some((t) => inside(t, rel));
    const t: Parameters<StorageSweeper['addItems']>[2] = [];
    for (const c of u.candidates) {
      const rel = relative(root, c.path);
      if (!ignored.has(rel) || hasTracked(rel)) {
        res.protected.push({ category: 'uncommitted-source', target: c.path, bytes: null, reason: hasTracked(rel) ? 'holds tracked files' : 'not ignored by git (untracked content)' });
        continue;
      }
      if (c.kind === 'nm') {
        const lock = this.lockfileFor(dirname(c.path), root);
        // A1 holds only for a node_modules git cannot vouch for being a pure
        // install: a repository inside it, or patch-package edits not yet
        // extracted, are invisible to git status. Those wait for approval.
        const holds = finished && lock ? await this.nodeModulesHolds(ctx, root, c.path) : [];
        if (finished && lock && !holds.length) t.push({ path: c.path, rule: 'A1', reason: 'finished worktree, idle ' + idleDays + ' days', unit, evidence: { ...evid, lockfile: lock } });
        else {
          t.push({ path: c.path, rule: 'M1', reason: [...why, ...(lock ? [] : ['no lockfile']), ...holds].join('; '), unit, evidence: { ...evid, lockfile: lock } });
          if (finished && !holds.length) for (const p of nmCaches(c.path)) t.push({ path: p, rule: 'A2', reason: 'pure cache in a finished worktree', unit, evidence: evid });
        }
      } else if (c.kind === 'cache') {
        t.push({ path: c.path, rule: finished ? 'A2' : 'M1', reason: finished ? 'pure cache in a finished worktree' : why.join('; '), unit, evidence: evid });
      } else if (c.kind === 'next') {
        for (const p of nextCache(c.path)) t.push({ path: p, rule: finished ? 'A2' : 'M1', reason: finished ? 'pure cache in a finished worktree' : why.join('; '), unit, evidence: evid });
        let others: string[] = []; try { others = readdirSync(c.path).filter((n) => n !== 'cache'); } catch { /* gone */ }
        if (idleDays >= SWEEP_IDLE.outputs && others.length) t.push({ path: c.path, rule: 'M2', reason: `ignored build output, idle ${idleDays} days (cache kept)`, unit, evidence: evid, action: 'rm-children', keep: ['cache'] });
      } else if (c.kind === 'output' && idleDays >= SWEEP_IDLE.outputs) {
        t.push({ path: c.path, rule: 'M2', reason: `ignored build output, idle ${idleDays} days`, unit, evidence: evid });
      }
    }
    await this.addItems(ctx, res, t);
    // M3: the whole linked worktree, clean and idle 30 days.
    if (linked && !dirty && idleDays >= SWEEP_IDLE.worktree) {
      const common = gi.commondir ? real(gi.commondir) : null;
      const commonRefusal = common ? this.refusal(ctx, common) : 'unreadable';
      const refusal = this.refusal(ctx, root) ?? await this.worktreeOnlyData(ctx, root, gi.gitdir!) ?? await this.ancestorRefusal(ctx, root, root) ?? await this.nestedRepo(ctx, root);
      if (refusal) res.notes.push({ target: root, reason: `M3 not offered: ${refusal}` });
      else if (commonRefusal) res.notes.push({ target: root, reason: `M3 not offered: its main repository ${common ?? ''} is ${commonRefusal}` });
      else {
        const itemBytes = res.items.filter((i) => inside(i.target, root)).reduce((s, i) => s + i.bytes, 0);
        res.items.push(this.item({
          rule: 'M3', target: root, bytes: outsideBytes + itemBytes, unit, action: 'git-worktree-remove',
          reason: shared ? `finished worktree, idle ${idleDays} days` : `clean but HEAD only on local branches: needs a bundle first`,
          evidence: { ...evid, commondir: common }, executable: shared,
          ...(gi.locked ? { locked: true } : {}), ...(!shared ? { needsBundle: true } : {}),
        }));
      }
    }
    return res;
  }

  private item(p: Omit<SweepItem, 'id' | 'class' | 'executable'> & { executable?: boolean }): SweepItem {
    return { ...p, id: itemId(p.rule, p.target), class: p.rule.startsWith('A') ? 'auto' : 'manifest', executable: p.executable ?? true };
  }

  /**
   * Is `target` inside ANOTHER checkout whose whole tree is protected (git
   * metadata missing, or a detached HEAD no ref contains)? Those are recorded
   * per unit, so a checkout nested inside one would otherwise be planned on
   * its own. Walks from the target's parent up to its IN root; `ownRoot` is
   * judged by its own unit. Checked at plan time and again at delete time.
   */
  private async ancestorRefusal(ctx: Ctx, target: string, ownRoot: string | null): Promise<string | null> {
    const root = ctx.roots.find((x) => inside(target, x.path));
    if (!root) return 'outside every sweep root';
    for (let d = dirname(target); inside(d, root.path); d = dirname(d)) {
      if (d !== ownRoot) {
        let why = ctx.ancestors.get(d);
        if (why === undefined) { why = await this.wholeTreeProtection(ctx, d); ctx.ancestors.set(d, why); }
        if (why) return why;
      }
      if (d === root.path || d === dirname(d)) break;
    }
    return null;
  }
  private async wholeTreeProtection(ctx: Ctx, dir: string): Promise<string | null> {
    const gi = this.gitInfo(dir);
    if (!gi.type) return null;
    if (gi.type === 'file' && !gi.gitdirExists) return `inside ${dir}, a worktree whose git metadata is missing`;
    const head = await this.git(ctx, dir, ['rev-parse', '--verify', '-q', 'HEAD']);
    if (head.code !== 0) return `inside ${dir}, a checkout whose HEAD git cannot read`;
    if ((await this.git(ctx, dir, ['symbolic-ref', '-q', 'HEAD'])).code === 0) return null;
    const refs = await this.git(ctx, dir, ['for-each-ref', '--contains', head.stdout.trim(), '--format=%(refname)', 'refs/heads', 'refs/tags', 'refs/remotes']);
    if (refs.code !== 0) return `inside ${dir}: git for-each-ref failed`;
    return refs.stdout.trim() ? null : `inside ${dir}, whose detached HEAD no ref contains`;
  }
  /**
   * M3: what `git worktree remove` would take that git status does not show.
   * Measured on git 2.39.5: with status empty it deleted an ignored `.env`, an
   * ignored `local/notes.md`, a skip-worktree edit and an assume-unchanged edit,
   * and the worktree's own reflog and refs/worktree/* go with its gitdir. Null
   * when none of that holds; checked at plan time and in the approval re-plan.
   */
  private async worktreeOnlyData(ctx: Ctx, root: string, gitdir: string): Promise<string | null> {
    const first = (r: CmdResult) => (r.truncated ? 'output too large' : r.stderr.trim().split('\n')[0] || `exit ${r.code}`);
    // 1. Index flags: lowercase = assume-unchanged, S/s = skip-worktree.
    const lf = await this.git(ctx, root, ['ls-files', '-v', '-z'], { maxBytes: GIT_LIST_MAX });
    if (lf.code !== 0 || lf.truncated) return 'could not read the index flags: ' + first(lf);
    for (const l of lf.stdout.split('\0')) {
      if (l.length < 3 || l[1] !== ' ') continue;
      const tag = l[0];
      if (tag === 'S' || (tag >= 'a' && tag <= 'z')) return `${tag === 'S' || tag === 's' ? 'a skip-worktree' : 'an assume-unchanged'} file (${l.slice(2)}) may hold edits git status does not show`;
    }
    // 2. Ignored files: only regenerable ones may go.
    const st = await this.git(ctx, root, ['status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal'], { maxBytes: GIT_LIST_MAX });
    if (st.code !== 0 || st.truncated) return 'could not list ignored files: ' + first(st);
    const recs = st.stdout.split('\0');
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      if (!r) continue;
      if (!r.startsWith('!! ')) return `uncommitted change ${r.slice(3)}`;
      if (!regenerablePath(r.slice(3))) return `ignored ${r.slice(3)} is not a regenerable build or dependency dir (git worktree remove would delete it)`;
    }
    // 3. Refs that live in this worktree only.
    const wr = await this.git(ctx, root, ['for-each-ref', '--format=%(refname)', 'refs/worktree', 'refs/bisect', 'refs/rewritten']);
    if (wr.code !== 0) return 'could not list per-worktree refs: ' + first(wr);
    const own = wr.stdout.split('\n').filter(Boolean);
    if (own.length) return `per-worktree ref ${own[0]} would be lost`;
    // 4. The worktree's reflog: every commit in its last entries must be in a
    //    branch, tag or remote ref, or it is reachable from nowhere after removal.
    let log = '';
    try { log = readFileSync(join(gitdir, 'logs', 'HEAD'), 'utf8'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'could not read its reflog: ' + (e as Error).message; }
    const shas = new Set<string>();
    for (const l of log.split('\n').filter(Boolean).slice(-REFLOG_LINES)) {
      for (const x of l.split(' ').slice(0, 2)) if (/^[0-9a-f]{40,64}$/.test(x) && !/^0+$/.test(x)) shas.add(x);
    }
    if (shas.size) {
      const rl = await this.git(ctx, root, ['rev-list', '-n', '1', ...shas, '--not', '--branches', '--tags', '--remotes']);
      if (rl.code !== 0) return 'could not check its reflog against the refs: ' + first(rl);
      const lost = rl.stdout.trim().split('\n')[0];
      if (lost) return `its reflog holds commit ${lost.slice(0, 12)}, which no branch, tag or remote contains`;
    }
    return null;
  }

  /**
   * A1: a node_modules git cannot vouch for. A repository inside it (bounded
   * find), or patch-package in use (a `patches/` dir or the dependency in
   * package.json at the checkout root or beside node_modules): edits made
   * there and not yet extracted are invisible to git. Empty = pure install.
   */
  private async nodeModulesHolds(ctx: Ctx, root: string, nm: string): Promise<string[]> {
    const holds: string[] = [];
    for (const d of new Set([root, dirname(nm)])) {
      if (isRealDir(join(d, 'patches'))) { holds.push(`${join(d, 'patches')} exists: patch-package edits in node_modules are invisible to git`); break; }
      let pkg = ''; try { pkg = readFileSync(join(d, 'package.json'), 'utf8'); } catch { /* none */ }
      if (pkg.includes('patch-package')) { holds.push(`${join(d, 'package.json')} uses patch-package: edits in node_modules are invisible to git`); break; }
    }
    const [cmd, args] = this.nice('find', [nm, '-maxdepth', '3', '-name', '.git', '-print', '-quit']);
    const r = await ctx.run(cmd, args, { timeoutMs: Math.max(1000, Math.min(120_000, ctx.deadline - this.now)) }).catch((e: Error) => ({ code: 126, stdout: '', stderr: e.message }));
    if (r.code !== 0) holds.push('could not check node_modules for a repository: ' + (r.stderr.trim().split('\n')[0] || `exit ${r.code}`));
    else if (r.stdout.trim()) holds.push(`a git repository inside node_modules (${dirname(r.stdout.trim().split('\n')[0])})`);
    return holds;
  }

  /** M2/M3/M5: another repository below the root (ignored, so status is clean) would go with rm or `git worktree remove`. node_modules is searched too. */
  private async nestedRepo(ctx: Ctx, root: string): Promise<string | null> {
    const [cmd, args] = this.nice('find', [root, '-mindepth', '1', '-path', join(root, '.git'), '-prune', '-o', '-name', '.git', '-print', '-quit']);
    const r = await ctx.run(cmd, args, { timeoutMs: Math.max(1000, Math.min(120_000, ctx.deadline - this.now)) }).catch((e: Error) => ({ code: 126, stdout: '', stderr: e.message }));
    if (r.code !== 0) return 'could not check for nested repositories: ' + (r.stderr.trim().split('\n')[0] || `exit ${r.code}`);
    const hit = r.stdout.trim().split('\n')[0];
    return hit ? `another repository inside it (${dirname(hit)})` : null;
  }

  /** Gate each path (plan-time refusal, in use), size them in one du, and add them. */
  private async addItems(ctx: Ctx, res: UnitResult, list: { path: string; rule: SweepRule; reason: string; unit: string; evidence: Record<string, unknown>; action?: SweepAction; keep?: string[] }[]): Promise<void> {
    const ok: typeof list = [];
    for (const x of list) {
      if (!isRealDir(x.path)) continue;
      const refusal = this.refusal(ctx, x.path);
      if (refusal) { res.protected.push({ category: refusal.startsWith('protected') || refusal.startsWith('contains') ? 'protected-path' : 'refused', target: x.path, bytes: null, reason: refusal }); continue; }
      const used = this.inUse(ctx, x.path);
      if (used) { res.protected.push({ category: 'in-use', target: x.path, bytes: null, reason: used }); continue; }
      const outer = await this.ancestorRefusal(ctx, x.path, unitRoot(x.unit));
      if (outer) { res.protected.push({ category: 'protected-path', target: x.path, bytes: null, reason: outer }); continue; }
      // A build output is plain rm: a repository someone cloned into it goes too.
      const nested = x.rule === 'M2' ? await this.nestedRepo(ctx, x.path) : null;
      if (nested) { res.protected.push({ category: 'nested-repo', target: x.path, bytes: null, reason: nested }); continue; }
      // Nested inside another item of the same unit that goes with it: redundant.
      if (list.some((y) => y !== x && y.rule === x.rule && inside(x.path, y.path) && x.path !== y.path)) continue;
      if (x.rule === 'A2' && list.some((y) => y.rule === 'A1' && inside(x.path, y.path))) continue;
      ok.push(x);
    }
    const sizes = await this.du(ctx, ok.flatMap((x) => (x.keep ? [x.path, ...x.keep.map((k) => join(x.path, k)).filter(isRealDir)] : [x.path])), Math.max(1000, Math.min(600_000, ctx.deadline - this.now)));
    for (const x of ok) {
      let bytes = sizes.get(x.path) ?? 0;
      for (const k of x.keep ?? []) bytes -= sizes.get(join(x.path, k)) ?? 0;
      res.items.push(this.item({ rule: x.rule, target: x.path, bytes: Math.max(0, bytes), reason: x.reason, unit: x.unit, evidence: x.evidence, action: x.action ?? 'rm', ...(x.keep ? { keep: x.keep } : {}), projectId: this.ownerOf(ctx, x.path)[0] }));
    }
  }

  private procNamed(ctx: Ctx, names: (p: LiveProcess) => boolean): LiveProcess | undefined { return ctx.procs.find(names); }
  private isGo = (p: LiveProcess) => GO_PROCS.has(p.comm);
  private isNpm = (p: LiveProcess) => p.comm === 'npm' || p.comm === 'npx' || (p.argv ?? []).slice(0, 2).some((a) => /(^|\/)(npm|npx)(-cli\.js)?$/.test(a));
  private isPnpm = (p: LiveProcess) => p.comm === 'pnpm' || (p.argv ?? []).slice(0, 2).some((a) => /(^|\/)pnpm(\.c?js)?$/.test(a));

  private async evalCaches(ctx: Ctx, skipUnknownTmp = false): Promise<UnitResult> {
    const res: UnitResult = { items: [], protected: [], notes: [] };
    const home = this.home(), tmp = this.opts.tmpDir ?? '/tmp';
    const cmdItem = async (rule: SweepRule, target: string, command: string[], reason: string, proc: (p: LiveProcess) => boolean, procName: string, sizeUnknown = false) => {
      if (!isRealDir(target)) return;
      const refusal = this.refusal(ctx, target, true);
      if (refusal) { res.protected.push({ category: 'refused', target, bytes: null, reason: refusal }); return; }
      const p = this.procNamed(ctx, proc);
      if (p) { res.protected.push({ category: 'in-use', target, bytes: null, reason: `a ${procName} process is running (pid ${p.pid})` }); return; }
      const used = this.inUse(ctx, target);
      if (used) { res.protected.push({ category: 'in-use', target, bytes: null, reason: used }); return; }
      const bytes = sizeUnknown ? 0 : (await this.du(ctx, [target], 120_000)).get(target) ?? 0;
      res.items.push(this.item({ rule, target, bytes, reason, unit: 'cache', action: command.length ? 'command' : 'rm', evidence: sizeUnknown ? { sizeUnknown: true } : {}, ...(command.length ? { command } : {}) }));
    };
    await cmdItem('A3', this.goCacheDir(), ['go', 'clean', '-cache'], 'Go build cache (go clean -cache)', this.isGo, 'go');
    await cmdItem('A3', join(home, '.cache', 'pip'), [], 'pip cache', () => false, 'pip');
    await cmdItem('A3', join(home, '.npm', '_cacache'), ['npm', 'cache', 'clean', '--force'], 'npm cache (npm cache clean --force)', this.isNpm, 'npm');
    // The pnpm stores pass the same refusal and in-use gates as every path.
    for (const store of this.pnpmStores()) {
      if (!isRealDir(store)) continue;
      if (!onPath('pnpm')) { res.notes.push({ target: store, reason: 'pnpm store not pruned: pnpm is not installed in the container' }); continue; }
      await cmdItem('A3', store, ['pnpm', 'store', 'prune', '--store-dir', store], 'pnpm store prune (unreferenced packages only)', this.isPnpm, 'pnpm', true);
    }
    // /tmp: Go caches older than 3 days (AUTO), other big old dirs (M5).
    let names: string[] = [];
    try { names = readdirSync(tmp); } catch { /* none */ }
    const others: string[] = [];
    for (const n of names) {
      const p = join(tmp, n);
      if (!isRealDir(p)) continue;
      if (/^go-build|^gocache-/.test(n)) {
        const scan = await this.newestAny(p, ctx.now - SWEEP_IDLE.tmpCache * DAY, ctx);
        if (scan.stopped || scan.error) continue;
        await this.addItems(ctx, res, [{ path: p, rule: 'A3', reason: `Go cache in /tmp, idle ${Math.floor((ctx.now - (scan.newest || mtime(p))) / DAY)} days`, unit: 'cache', evidence: {} }]);
      } else if (!skipUnknownTmp) others.push(p);
    }
    for (let i = 0; i < others.length && this.now < ctx.deadline; i += 16) {
      const chunk = others.slice(i, i + 16);
      const sizes = await this.du(ctx, chunk, Math.max(1000, Math.min(300_000, ctx.deadline - this.now)));
      for (const p of chunk) {
        const bytes = sizes.get(p) ?? 0;
        if (bytes < M5_MIN_BYTES) continue;
        const scan = await this.newestAny(p, ctx.now - SWEEP_IDLE.tmpUnknown * DAY, ctx);
        if (scan.stopped || scan.error) continue;
        const refusal = this.refusal(ctx, p) ?? this.inUse(ctx, p) ?? await this.nestedRepo(ctx, p);
        if (refusal) { res.protected.push({ category: 'in-use', target: p, bytes, reason: refusal }); continue; }
        res.items.push(this.item({ rule: 'M5', target: p, bytes, reason: `unknown /tmp directory, idle ${Math.floor((ctx.now - (scan.newest || mtime(p))) / DAY)} days`, unit: 'cache', action: 'rm', evidence: {} }));
      }
    }
    return res;
  }
  /** Like newestFile but counts every file (nothing excluded): for /tmp. */
  private newestAny(root: string, stopAbove: number, ctx: Ctx): Promise<{ newest: number; stopped: boolean; error?: string }> {
    const [cmd, args] = this.nice('find', [root, '-mindepth', '1', '-printf', '%T@ 0\\n']);
    return new Promise((done) => {
      let newest = 0, stopped = false, buf = '', settled = false;
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      const finish = (error?: string) => { if (settled) return; settled = true; clearTimeout(timer); done({ newest, stopped, ...(error ? { error } : {}) }); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish('timed out'); }, Math.max(1000, Math.min(300_000, ctx.deadline - this.now)));
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString(); const lines = buf.split('\n'); buf = lines.pop() ?? '';
        for (const l of lines) { const t = Number(l.slice(0, l.indexOf(' '))) * 1000; if (t > newest) newest = t; if (newest > stopAbove) { stopped = true; child.kill('SIGKILL'); break; } }
      });
      child.on('error', (e) => finish(e.message));
      child.on('close', () => finish());
    });
  }

  // ---- dind ----
  private async dockerJson(ctx: Ctx, args: string[], timeoutMs = 60_000): Promise<unknown[]> {
    const r = await ctx.docker('docker', args, { timeoutMs });
    if (r.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(' ')}: ${r.stderr.trim().split('\n')[0] || 'exit ' + r.code}`);
    const t = r.stdout.trim();
    if (!t) return [];
    if (t.startsWith('[')) return JSON.parse(t) as unknown[];
    return t.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);
  }
  /** `withSize` adds `--size` (SizeRw): slow, so only for the stopped candidates. */
  private async inspectContainers(ctx: Ctx, ids: string[], withSize = false): Promise<Record<string, any>[]> {
    const out: Record<string, any>[] = [];
    for (let i = 0; i < ids.length; i += 50) out.push(...(await this.dockerJson(ctx, ['inspect', '--type', 'container', ...(withSize ? ['--size'] : []), ...ids.slice(i, i + 50)], withSize ? 300_000 : 60_000)) as Record<string, any>[]);
    return out;
  }
  private async runningBindSources(ctx: Ctx): Promise<string[]> {
    const ps = await this.dockerJson(ctx, ['ps', '--no-trunc', '--format', '{{json .ID}}'], 30_000) as string[];
    if (!ps.length) return [];
    const info = await this.inspectContainers(ctx, ps);
    return info.flatMap((c) => (c.Mounts ?? []).filter((m: any) => m.Type === 'bind' && typeof m.Source === 'string').map((m: any) => m.Source as string));
  }

  private async evalDocker(ctx: Ctx): Promise<UnitResult> {
    const res: UnitResult = { items: [], protected: [], notes: [] };
    try {
      const v = await ctx.docker('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
      if (v.code !== 0) { res.notes.push({ reason: 'dind unreachable: ' + (v.stderr.trim().split('\n')[0] || 'exit ' + v.code) }); return res; }
      // Containers.
      const all = await this.dockerJson(ctx, ['ps', '-a', '--no-trunc', '--format', '{{json .ID}}'], 30_000) as string[];
      const info = all.length ? await this.inspectContainers(ctx, all) : [];
      const usedImages = new Set(info.map((c) => String(c.Image ?? '')));
      const counts = { running: 0, pin: 0, restart: 0, mounts: 0 };
      const stopped: string[] = [];
      for (const c of info) {
        const hold = containerHold(c, false);
        if (hold && hold.kind in counts) { counts[hold.kind as keyof typeof counts]++; continue; }
        const name = String(c.Name ?? '').replace(/^\//, '');
        if (hold) { res.protected.push({ category: 'docker', target: `docker:container:${name}`, bytes: null, reason: hold.reason }); continue; }
        stopped.push(String(c.Id));
      }
      // Only the stopped candidates are sized: a writable layer is data until
      // shown otherwise (exciting_pike: 2.6 GB, read as 0 B without --size).
      for (const c of stopped.length ? await this.inspectContainers(ctx, stopped, true) : []) {
        const name = String(c.Name ?? '').replace(/^\//, '');
        const state = String(c.State?.Status ?? '');
        const hold = containerHold(c, true);
        if (hold) { res.protected.push({ category: 'docker', target: `docker:container:${name}`, bytes: typeof c.SizeRw === 'number' ? c.SizeRw : null, reason: hold.reason }); continue; }
        res.items.push(this.item({ rule: 'M4', target: `docker:container:${name}`, bytes: Number(c.SizeRw), reason: `${state} container with no mounts, writable layer ${fmtBytes(Number(c.SizeRw))} (image ${String(c.Config?.Image ?? '?')})`, unit: 'docker', action: 'docker', command: ['docker', 'rm', String(c.Id)], evidence: { id: c.Id, name, state, created: c.Created, sizeRw: c.SizeRw } }));
      }
      const { running, pin: pinned, restart, mounts: withMounts } = counts;
      if (running) res.protected.push({ category: 'docker', target: 'docker:containers:running', bytes: null, reason: `${running} running container(s)` });
      if (pinned) res.protected.push({ category: 'docker', target: 'docker:containers:pin', bytes: null, reason: `${pinned} pin-* container(s)` });
      if (restart) res.protected.push({ category: 'docker', target: 'docker:containers:restart-policy', bytes: null, reason: `${restart} stopped container(s) with a restart policy` });
      if (withMounts) res.protected.push({ category: 'docker', target: 'docker:containers:mounts', bytes: null, reason: `${withMounts} stopped container(s) with mounts (fixtures/DBs)` });
      // Volume sizes (slow on a busy daemon: unknown rather than blocking).
      const volSize = new Map<string, number>();
      try {
        const df = await this.dockerJson(ctx, ['system', 'df', '-v', '--format', '{{json .}}'], 120_000) as Record<string, any>[];
        for (const vol of (df[0]?.Volumes ?? []) as Record<string, any>[]) volSize.set(String(vol.Name), parseSize(String(vol.Size ?? '0')));
      } catch (e) { res.notes.push({ reason: 'docker volume sizes unknown: ' + (e as Error).message }); }
      // Volumes no container references.
      const vols = await this.dockerJson(ctx, ['volume', 'ls', '-f', 'dangling=true', '--format', '{{json .Name}}'], 30_000) as string[];
      // Every unused volume waits for approval (none is AUTO): a name is only
      // a hint, and a loose match once put `ergomodel_pg` among the caches.
      for (const name of vols) {
        const bytes = volSize.get(name) ?? 0;
        const anon = /^[0-9a-f]{64}$/.test(name);
        const hint = anon ? null : CACHE_VOLUME_HINT.exec(name)?.[1] ?? null;
        const ev = { name, ...(volSize.has(name) ? {} : { sizeUnknown: true }), ...(hint ? { looksLikeCache: hint } : {}) };
        const reason = anon ? 'unused anonymous volume' : hint ? `unused named volume; looks like a build cache (${hint}), may still hold data` : 'unused named volume: may hold data';
        res.items.push(this.item({ rule: 'M4', target: `docker:volume:${name}`, bytes, reason, unit: 'docker', action: 'docker', command: ['docker', 'volume', 'rm', name], evidence: ev, ...(anon ? {} : { mayHoldData: true }) }));
      }
      // Dangling images older than 72h that no container uses.
      const imgs = await this.dockerJson(ctx, ['images', '-f', 'dangling=true', '--no-trunc', '--format', '{{json .}}'], 30_000) as Record<string, any>[];
      for (const im of imgs) {
        const id = String(im.ID ?? '');
        const created = dockerTime(String(im.CreatedAt ?? ''));
        if (usedImages.has(id)) continue;
        if (!Number.isFinite(created) || ctx.now - created < 72 * 3600_000) continue;
        res.items.push(this.item({ rule: 'M4', target: `docker:image:${id}`, bytes: parseSize(String(im.Size ?? '0')), reason: 'dangling image older than 72 hours', unit: 'docker', action: 'docker', command: ['docker', 'rmi', id], evidence: { id, createdAt: im.CreatedAt } }));
      }
      const tags = await ctx.docker('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { timeoutMs: 30_000 });
      const rollback = tags.stdout.split('\n').filter((t) => /rollback/i.test(t));
      if (rollback.length) res.protected.push({ category: 'docker', target: 'docker:images:rollback', bytes: null, reason: `${rollback.length} image(s) tagged *rollback*` });
      if (usedImages.size) res.protected.push({ category: 'docker', target: 'docker:images:in-use', bytes: null, reason: `${usedImages.size} image(s) referenced by a container` });
      // Build cache older than 7 days.
      res.items.push(this.item({ rule: 'A4', target: 'docker:builder', bytes: 0, reason: 'build cache older than 7 days', unit: 'docker', action: 'docker', command: ['docker', 'builder', 'prune', '-f', '--filter', 'until=168h'], evidence: { sizeUnknown: true } }));
    } catch (e) {
      res.notes.push({ reason: 'docker planning stopped: ' + (e as Error).message });
    }
    return res;
  }

  /** Re-check one docker item against the daemon now; the docker arguments to run, built from the target. */
  private async dockerStillValid(ctx: Ctx, i: SweepItem): Promise<{ args: string[] } | { bad: string }> {
    const [scheme, kind, ...rest] = i.target.split(':');
    const name = rest.join(':');
    if (scheme !== 'docker') return { bad: 'not a docker item' };
    try {
      if (kind === 'volume') {
        const v = await this.dockerJson(ctx, ['volume', 'ls', '-f', 'dangling=true', '--format', '{{json .Name}}'], 30_000) as string[];
        return v.includes(name) ? { args: ['volume', 'rm', name] } : { bad: 'volume is in use or gone' };
      }
      if (kind === 'container') {
        const [c] = await this.inspectContainers(ctx, [name], true).catch(() => []);
        if (!c) return { bad: 'container gone' };
        const hold = containerHold(c, true);
        if (hold) return { bad: `container is now protected: ${hold.reason}` };
        return { args: ['rm', String(c.Id)] };
      }
      if (kind === 'image') {
        const imgs = await this.dockerJson(ctx, ['images', '-f', 'dangling=true', '--no-trunc', '--format', '{{json .ID}}'], 30_000) as string[];
        if (!imgs.includes(name)) return { bad: 'image is no longer dangling' };
        const all = await this.dockerJson(ctx, ['ps', '-a', '--no-trunc', '--format', '{{json .ID}}'], 30_000) as string[];
        const info = all.length ? await this.inspectContainers(ctx, all) : [];
        return info.some((c) => c.Image === name) ? { bad: 'image is used by a container' } : { args: ['rmi', name] };
      }
      if (kind === 'builder') return { args: ['builder', 'prune', '-f', '--filter', 'until=168h'] };
    } catch (e) { return { bad: 'docker re-check failed: ' + (e as Error).message }; }
    return { bad: 'unknown docker item' };
  }

  // ---- execute ----
  private unitCache = new WeakMap<Ctx, Map<string, Promise<UnitResult>>>();
  private freshUnit(ctx: Ctx, key: string, quick: boolean): Promise<UnitResult> {
    let m = this.unitCache.get(ctx); if (!m) { m = new Map(); this.unitCache.set(ctx, m); }
    const k = `${quick ? 'q' : 'f'}:${key}`;
    if (!m.has(k)) {
      let p: Promise<UnitResult>;
      if (key === 'cache') p = this.evalCaches(ctx, quick);
      else if (key.startsWith('checkout:') || key.startsWith('plain:')) {
        const root = key.slice(key.indexOf(':') + 1);
        const kind = key.startsWith('checkout:') ? 'checkout' : 'plain';
        const units = new Map<string, Unit>();
        try { this.discoverUnit(root, kind, units); } catch { /* fall through */ }
        const u = units.get(root) ?? { root, kind, candidates: [] };
        p = this.evalUnit(ctx, u, { skipIdleScan: quick });
      } else p = Promise.resolve({ items: [], protected: [], notes: [] });
      m.set(k, p);
    }
    return m.get(k)!;
  }
  /** Rediscover one unit's candidates (bounded to ITEM_DEPTH below it). */
  private discoverUnit(root: string, kind: 'checkout' | 'plain', units: Map<string, Unit>): void {
    const u: Unit = { root, kind, candidates: [] };
    units.set(root, u);
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (stack.length) {
      const { dir, depth } = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (dir !== root && entries.some((e) => e.name === '.git' && (e.isFile() || e.isDirectory()))) continue; // a nested checkout is its own unit
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(dir, e.name);
        let ck: Candidate['kind'] | null = e.name === NM ? 'nm' : e.name === '.next' ? 'next' : A2_DIRS.has(e.name) ? 'cache' : M2_DIRS.has(e.name) ? 'output' : null;
        if (ck && exists(join(p, '.git'))) continue; // a nested checkout is its own unit
        if (ck && (kind === 'checkout' || ck === 'nm' || ck === 'cache') && (kind === 'checkout' ? depth + 1 <= ITEM_DEPTH : depth === 0)) u.candidates.push({ path: p, kind: ck });
        if (ck || NO_DESCEND.has(e.name) || depth + 1 >= ITEM_DEPTH || kind === 'plain') continue;
        stack.push({ dir: p, depth: depth + 1 });
      }
    }
  }

  /**
   * Re-check, then act. `quick`: the plan is seconds old (an AUTO item in the
   * run that planned it): the unit's git state, owner and users are checked
   * again, but its tree is not re-scanned. `full`: an approval days later: the
   * unit is re-planned from scratch and must still yield this exact item.
   */
  private async execute(ctx: Ctx, i: SweepItem, level: 'quick' | 'full'): Promise<Receipt> {
    if (ctx.dry) return this.receipt(i, 'skipped', 'dry run');
    try { this.refreshLive(ctx); } catch (e) { return this.receipt(i, 'skipped', 'cannot list processes: ' + (e as Error).message); }
    try {
      if (i.action === 'docker' || i.target.startsWith('docker:')) {
        if (!this.opts.dind) return this.receipt(i, 'skipped', 'dind sweeping is off');
        // The command is rebuilt from the target and the daemon's answer now,
        // never taken from the stored manifest.
        const v = await this.dockerStillValid(ctx, i);
        if ('bad' in v) return this.receipt(i, 'skipped', 'conditions changed: ' + v.bad);
        const r = await ctx.docker('docker', v.args, { timeoutMs: 300_000 });
        return r.code === 0 ? this.receipt(i, 'deleted') : this.receipt(i, 'error', undefined, r.stderr.trim().split('\n')[0] || `exit ${r.code}`);
      }
      // Re-plan the unit and require the same item back.
      const fresh = await this.freshUnit(ctx, i.unit, level === 'quick');
      const again = fresh.items.find((x) => x.id === i.id);
      if (!again || !again.executable) {
        const why = fresh.protected.find((p) => inside(i.target, p.target) || inside(p.target, i.target))?.reason ?? (fresh.active ? 'the checkout was used in the last 7 days' : fresh.notes[0]?.reason ?? 'no longer a candidate');
        return this.receipt(i, 'skipped', 'conditions changed: ' + why);
      }
      // From here on, act on the re-plan, never on the stored copy: a
      // manifest file is only as trustworthy as the disk it sits on.
      const x = again;
      if (x.action === 'command') {
        if (!x.command?.length) return this.receipt(i, 'skipped', 'no command');
        // The same delete-time guard as a path: the command empties x.target.
        const g = this.guard(ctx, x.target, true);
        if (g) return this.receipt(i, 'skipped', g);
        const r = await ctx.run(x.command[0], x.command.slice(1), { timeoutMs: 600_000 });
        return r.code === 0 ? this.receipt(i, 'deleted') : this.receipt(i, 'error', undefined, r.stderr.trim().split('\n')[0] || `exit ${r.code}`);
      }
      // A path: the delete-time guard, every time.
      const guard = this.guard(ctx, x.target, x.unit === 'cache') ?? await this.ancestorRefusal(ctx, x.target, unitRoot(x.unit));
      if (guard) return this.receipt(i, 'skipped', guard);
      if (x.action === 'git-worktree-remove') {
        const common = typeof x.evidence.commondir === 'string' ? x.evidence.commondir : null;
        if (!common || this.refusal(ctx, common)) return this.receipt(i, 'skipped', 'main repository is outside the sweep roots or protected');
        if (x.locked) {
          const u = await ctx.run('git', ['-c', 'core.fsmonitor=false', `--git-dir=${common}`, 'worktree', 'unlock', x.target], { timeoutMs: 60_000, env: this.gitEnv });
          if (u.code !== 0) return this.receipt(i, 'error', undefined, 'unlock failed: ' + u.stderr.trim().split('\n')[0]);
        }
        const r = await ctx.run('git', ['-c', 'core.fsmonitor=false', `--git-dir=${common}`, 'worktree', 'remove', x.target], { timeoutMs: 600_000, env: this.gitEnv });
        return r.code === 0 ? this.receipt(i, 'deleted') : this.receipt(i, 'error', undefined, r.stderr.trim().split('\n')[0] || `exit ${r.code}`);
      }
      const remove = this.opts.remove ?? ((p: string) => rm(p, { recursive: true, force: false }));
      if (x.action === 'rm-children') {
        for (const n of readdirSync(x.target)) {
          if (x.keep?.includes(n)) continue;
          const p = join(x.target, n);
          const g = this.guard(ctx, p, false, true);
          if (g) return this.receipt(i, 'error', undefined, `${n}: ${g}`);
          await remove(p);
        }
        return this.receipt(i, 'deleted');
      }
      if (x.action !== 'rm') return this.receipt(i, 'skipped', `unknown action ${x.action}`);
      await remove(x.target);
      return this.receipt(i, 'deleted');
    } catch (e) {
      return this.receipt(i, 'error', undefined, (e as Error).message);
    }
  }

  /** Delete-time: lstat (no symlink), realpath, roots, protected, mounts, users, owner. */
  private guard(ctx: Ctx, target: string, allowRootItself: boolean, fileOk = false): string | null {
    let st; try { st = lstatSync(target); } catch { return 'gone'; }
    if (st.isSymbolicLink()) return 'is a symlink';
    if (!st.isDirectory() && !fileOk) return 'not a directory';
    const refusal = this.refusal(ctx, target, allowRootItself);
    if (refusal) return refusal;
    const used = this.inUse(ctx, target);
    if (used) return used;
    const busy = this.busy(ctx, target);
    if (busy) return busy;
    return null;
  }
}

/**
 * Why a dind container must stay (null = it may be offered as M4). Without
 * `sized` the writable layer is not judged (the cheap first pass); with it,
 * an unknown SizeRw is data too.
 */
export function containerHold(c: Record<string, any>, sized: boolean): { kind: 'running' | 'pin' | 'restart' | 'mounts' | 'state' | 'name' | 'size'; reason: string } | null {
  const name = String(c.Name ?? '').replace(/^\//, '');
  const state = String(c.State?.Status ?? '');
  const rp = String(c.HostConfig?.RestartPolicy?.Name ?? '');
  if (state === 'running' || state === 'restarting' || state === 'paused') return { kind: 'running', reason: `container is ${state}` };
  if (name.startsWith('pin-')) return { kind: 'pin', reason: 'pin-* container' };
  if (rp && rp !== 'no') return { kind: 'restart', reason: `restart policy ${rp}` };
  if (((c.Mounts ?? []) as unknown[]).length) return { kind: 'mounts', reason: 'has mounts (fixtures/DBs)' };
  if (!['exited', 'created', 'dead'].includes(state)) return { kind: 'state', reason: `container is ${state || 'in an unknown state'}` };
  if (CONTAINER_KEEP_NAME.test(name)) return { kind: 'name', reason: `its name (${name}) says before/rollback/backup` };
  if (!sized) return null;
  if (typeof c.SizeRw !== 'number' || !Number.isFinite(c.SizeRw)) return { kind: 'size', reason: 'writable layer size unknown: may hold data' };
  if (c.SizeRw > CONTAINER_DATA_BYTES) return { kind: 'size', reason: `writable layer holds ${fmtBytes(c.SizeRw)}: data` };
  return null;
}

/** docker's "2026-10-20 10:11:12 +0000 UTC" -> epoch ms (NaN when unreadable). */
export function dockerTime(s: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-])(\d{2})(\d{2})/.exec(s.trim());
  return m ? Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`) : Date.parse(s);
}

/** "1.2GB" / "512kB" / "0B" (docker's human sizes) -> bytes. */
export function parseSize(s: string): number {
  const m = /^([\d.]+)\s*([kKMGTP]?i?B)?$/.exec(s.trim());
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toUpperCase().replace('I', '');
  const pow = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 }[unit] ?? 0;
  return Math.round(n * (unit === 'B' ? 1 : 1000 ** pow));
}
