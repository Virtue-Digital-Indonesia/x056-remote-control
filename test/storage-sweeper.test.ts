import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, lutimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  StorageApprovers, StorageSweeper, approvalPurpose, DEFAULT_PROTECTED_PATHS, manifestDigest, readOnlyCommand, parseSize, dockerTime,
  CACHE_VOLUME_HINT, defaultRunner, devTreeRoot, freeByFilesystem, listMounts, listProcesses, regenerablePath, sweepScheduleEnabled,
  type CmdResult, type LiveProcess, type Manifest, type RunRecord, type StorageSweeperOptions,
} from '../server/storage-sweeper.js';
import { StorageController, refuseAgentCaller } from '../server/storage.controller.js';
import { WebAuthnService } from '../server/webauthn.js';
import { addPasskey, assertion, registration, softwarePasskey, type TestPasskey } from './helpers/passkey.js';

const DAY = 86_400_000;
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', HOME: tmpdir() };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const write = (p: string, body = 'x') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); };

/** Every file, dir and link under `p` gets an mtime `days` ago. */
function age(p: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  const st = lstatSync(p);
  if (st.isSymbolicLink()) { lutimesSync(p, t, t); return; }
  if (st.isDirectory()) for (const n of readdirSync(p)) age(join(p, n), days);
  utimesSync(p, t, t);
}

interface World { base: string; state: string; ws: string; app: string; transcripts: string; procs: LiveProcess[]; busy: Map<string, string>; dockerCalls: string[][]; docker: (args: string[]) => CmdResult | undefined }

function world(): World {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-')));
  roots.push(base);
  const state = join(base, 'state'), ws = join(base, 'ws'), app = join(ws, 'app'), transcripts = join(ws, 'transcripts');
  mkdirSync(state, { recursive: true }); mkdirSync(app, { recursive: true });
  // The live transcripts sit INSIDE the workspace root here, reached through
  // the account's projects/ symlink: protected by realpath, never by name.
  write(join(transcripts, 'proj', 'session.jsonl'), '{"type":"user"}\n');
  write(join(transcripts, 'proj', 'node_modules', 'x', 'index.js'));
  mkdirSync(join(base, 'acct'));
  symlinkSync(transcripts, join(base, 'acct', 'projects'));
  writeFileSync(join(state, 'accounts.json'), JSON.stringify({ accounts: [{ name: 'a', provider: 'claude', configDir: join(base, 'acct') }] }));
  git(app, 'init', '-q', '-b', 'main');
  write(join(app, '.gitignore'), 'node_modules/\ndist/\n.next/\n.turbo/\n');
  write(join(app, 'package.json'), '{}');
  write(join(app, 'package-lock.json'), '{}');
  write(join(app, 'src', 'index.js'), 'console.log(1)');
  git(app, 'add', '-A'); git(app, 'commit', '-q', '-m', 'init');
  git(app, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  const w: World = { base, state, ws, app, transcripts, procs: [], busy: new Map(), dockerCalls: [], docker: () => undefined };
  return w;
}

/** A linked worktree of `app` with node_modules; returns its path. */
function worktree(w: World, name: string, o: { detach?: boolean } = {}): string {
  const dir = join(w.ws, name);
  if (o.detach) git(w.app, 'worktree', 'add', '-q', '--detach', dir);
  else git(w.app, 'worktree', 'add', '-q', '-b', name, dir);
  write(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1');
  write(join(dir, 'node_modules', '.cache', 'c.bin'));
  return dir;
}

function sweeper(w: World, o: Partial<StorageSweeperOptions> = {}): StorageSweeper {
  return new StorageSweeper({
    stateDir: w.state, workspaceRoot: w.ws, containerCaches: false, dind: false, gatewayCheckouts: [], protectedPaths: [],
    processes: () => w.procs, mounts: () => [],
    activity: (pid) => (w.busy.has(pid) ? { busy: true, reason: w.busy.get(pid) } : { busy: false }),
    projects: () => [], log: () => {},
    docker: async (_cmd, args) => { w.dockerCalls.push(args); return w.docker(args) ?? { code: 0, stdout: '', stderr: '' }; },
    ...o,
  });
}
async function sweep(s: StorageSweeper, dryRun: boolean): Promise<RunRecord> { return s.sweep({ trigger: 'manual', dryRun }).done; }
const manifestOf = (s: StorageSweeper) => s.manifest()!;

describe('AUTO: node_modules in a finished worktree (A1)', () => {
  it('removes a finished worktree\'s node_modules; a dirty one goes to M1 and a fresh one is left alone', async () => {
    const w = world();
    const done = worktree(w, 'done'), dirty = worktree(w, 'dirty'), fresh = worktree(w, 'fresh');
    write(join(dirty, 'src', 'index.js'), 'changed');
    age(w.ws, 40);
    write(join(fresh, 'src', 'new.js'), 'today'); // one fresh file outside node_modules
    git(fresh, 'add', 'src/new.js'); git(fresh, 'commit', '-q', '-m', 'wip'); git(w.app, 'update-ref', 'refs/remotes/origin/fresh', 'fresh');
    const s = sweeper(w);
    const rec = await sweep(s, false);
    expect(existsSync(join(done, 'node_modules'))).toBe(false);
    expect(existsSync(join(done, 'src', 'index.js'))).toBe(true);
    expect(existsSync(join(dirty, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(existsSync(join(fresh, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    const m = manifestOf(s);
    const m1 = m.items.find((i) => i.target === join(dirty, 'node_modules'))!;
    expect(m1.rule).toBe('M1');
    expect(m1.reason).toContain('uncommitted changes');
    expect(m.items.some((i) => i.target.startsWith(fresh))).toBe(false);
    expect(rec.deleted).toBeGreaterThanOrEqual(1);
    // Logged: one runs.jsonl line and the per-item receipts.
    const lines = readFileSync(join(w.state, 'storage-sweeper', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ runId: rec.runId, trigger: 'manual', mode: 'auto', deleted: rec.deleted });
    expect(lines[0].df.before).toBeTypeOf('object');
    const receipts = s.receipts(rec.runId)!.receipts;
    expect(receipts.find((r) => r.target === join(done, 'node_modules'))).toMatchObject({ rule: 'A1', result: 'deleted', action: 'rm' });
    expect(receipts.find((r) => r.target === join(dirty, 'node_modules'))).toMatchObject({ rule: 'M1', result: 'listed' });
  });

  it('a dry run deletes nothing and lists the AUTO items as would-delete', async () => {
    const w = world();
    const done = worktree(w, 'done');
    age(w.ws, 40);
    const s = sweeper(w);
    const rec = await sweep(s, true);
    expect(existsSync(join(done, 'node_modules', 'left-pad'))).toBe(true);
    expect(rec.mode).toBe('dry-run');
    expect(s.receipts(rec.runId)!.receipts.find((r) => r.target === join(done, 'node_modules'))?.result).toBe('would-delete');
    expect(manifestOf(s).auto.map((i) => i.rule)).toContain('A1');
  });

  it('needs a tag or remote ref: HEAD on a local branch only is M1', async () => {
    const w = world();
    const local = worktree(w, 'local');
    write(join(local, 'src', 'more.js')); git(local, 'add', '-A'); git(local, 'commit', '-q', '-m', 'local only');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(existsSync(join(local, 'node_modules'))).toBe(true);
    expect(manifestOf(s).items.find((i) => i.target === join(local, 'node_modules'))?.reason).toContain('HEAD only on local branches');
  });

  it('skips a candidate a live process uses (cwd, open file, cache env)', async () => {
    const w = world();
    const a = worktree(w, 'a'), b = worktree(w, 'b');
    age(w.ws, 40);
    w.procs = [{ pid: 42, comm: 'node', paths: [join(a, 'node_modules', 'left-pad')] }, { pid: 43, comm: 'vite', paths: [b] }];
    const s = sweeper(w);
    await sweep(s, false);
    expect(existsSync(join(a, 'node_modules', 'left-pad'))).toBe(true);
    expect(existsSync(join(b, 'node_modules', 'left-pad'))).toBe(true);
    const p = manifestOf(s).protected;
    expect(p.find((x) => x.target === a)?.reason ?? p.find((x) => x.target === join(a, 'node_modules'))?.reason).toContain('pid 42');
    expect(p.find((x) => x.target === b)?.reason).toContain('pid 43');
  });

  it('a process that appears between plan and delete still stops it (re-check)', async () => {
    const w = world();
    const a = worktree(w, 'a');
    age(w.ws, 40);
    let calls = 0;
    const s = sweeper(w, { processes: () => (++calls > 1 ? [{ pid: 7, comm: 'node', paths: [join(a, 'node_modules')] }] : []) });
    // The live list is refreshed at most every 5 s; make the second read count.
    const realNow = Date.now;
    let shift = 0; Date.now = () => realNow() + shift;
    try {
      const run = s.sweep({ trigger: 'manual', dryRun: false });
      shift = 10_000;
      const rec = await run.done;
      expect(s.receipts(rec.runId)!.receipts.find((r) => r.target === join(a, 'node_modules'))).toMatchObject({ result: 'skipped' });
    } finally { Date.now = realNow; }
    expect(existsSync(join(a, 'node_modules'))).toBe(true);
  });

  it('protects every checkout of a busy conversation (injected activity)', async () => {
    const w = world();
    const chatWork = join(w.state, 'chats', 'chat-1', 'work');
    write(join(chatWork, 'tool', 'node_modules', 'x', 'i.js'));
    write(join(chatWork, 'tool', 'package.json'));
    age(join(w.state, 'chats'), 40);
    w.busy.set('chat-1', 'turn running');
    const s = sweeper(w);
    await sweep(s, true);
    expect(manifestOf(s).items.some((i) => i.target.startsWith(chatWork))).toBe(false);
    expect(manifestOf(s).protected.find((p) => p.target.startsWith(chatWork))?.reason).toContain('turn running');
    w.busy.clear();
    await sweep(s, true);
    expect(manifestOf(s).items.find((i) => i.target === join(chatWork, 'tool', 'node_modules'))).toMatchObject({ rule: 'M1', reason: 'not a git checkout', projectId: 'chat-1' });
  });

  it('a STOP file aborts between items', async () => {
    const w = world();
    const a = worktree(w, 'a');
    age(w.ws, 40);
    mkdirSync(join(w.state, 'storage-sweeper'), { recursive: true });
    writeFileSync(join(w.state, 'storage-sweeper', 'STOP'), '');
    const s = sweeper(w);
    const rec = await sweep(s, false);
    expect(rec.deleted).toBe(0);
    expect(existsSync(join(a, 'node_modules'))).toBe(true);
  });
});

describe('PROTECTED', () => {
  it('a worktree whose git metadata is missing: the source is protected, node_modules is M1', async () => {
    const w = world();
    const orphan = worktree(w, 'orphan');
    rmSync(join(w.app, '.git', 'worktrees', 'orphan'), { recursive: true });
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(existsSync(join(orphan, 'src', 'index.js'))).toBe(true);
    expect(existsSync(join(orphan, 'node_modules'))).toBe(true);
    const m = manifestOf(s);
    expect(m.protected.find((p) => p.target === orphan)).toMatchObject({ category: 'missing-gitdir' });
    expect(m.items.find((i) => i.target === join(orphan, 'node_modules'))).toMatchObject({ rule: 'M1', reason: 'git metadata missing' });
    expect(m.items.some((i) => i.rule === 'M3' && i.target === orphan)).toBe(false);
  });

  it('a detached HEAD no ref contains is protected whole; so is a protectedPaths entry', async () => {
    const w = world();
    const det = worktree(w, 'det', { detach: true });
    write(join(det, 'src', 'only-here.js')); git(det, 'add', '-A'); git(det, 'commit', '-q', '-m', 'unreachable');
    const pinned = worktree(w, 'pinned');
    age(w.ws, 40);
    const s = sweeper(w, { protectedPaths: [join(w.ws, 'pin*')] });
    await sweep(s, false);
    for (const d of [det, pinned]) expect(existsSync(join(d, 'node_modules', 'left-pad'))).toBe(true);
    const m = manifestOf(s);
    expect(m.protected.find((p) => p.target === det)).toMatchObject({ category: 'detached-unreachable' });
    expect(m.protected.find((p) => p.target === pinned)).toMatchObject({ category: 'configured' });
    expect(m.items.some((i) => i.target.startsWith(det) || i.target.startsWith(pinned))).toBe(false);
  });

  it('never follows a symlinked node_modules; the target outside stays', async () => {
    const w = world();
    const linked = worktree(w, 'linked');
    rmSync(join(linked, 'node_modules'), { recursive: true });
    const outside = join(w.ws, 'shared-deps');
    write(join(outside, 'keep', 'index.js'), 'precious');
    symlinkSync(outside, join(linked, 'node_modules'));
    // And a link INSIDE a node_modules that is removed: only the link goes.
    const done = worktree(w, 'done');
    symlinkSync(outside, join(done, 'node_modules', 'escape'));
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(lstatSync(join(linked, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(done, 'node_modules'))).toBe(false);
    expect(readFileSync(join(outside, 'keep', 'index.js'), 'utf8')).toBe('precious');
    expect(manifestOf(s).items.some((i) => i.target === join(linked, 'node_modules'))).toBe(false);
  });

  it('never touches a transcript realpath under a root, directly or through a symlink', async () => {
    const w = world();
    const done = worktree(w, 'done');
    rmSync(join(done, 'node_modules'), { recursive: true });
    symlinkSync(w.transcripts, join(done, 'node_modules'));
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(readFileSync(join(w.transcripts, 'proj', 'session.jsonl'), 'utf8')).toContain('user');
    expect(existsSync(join(w.transcripts, 'proj', 'node_modules', 'x', 'index.js'))).toBe(true);
    const m = manifestOf(s);
    expect(m.items.some((i) => i.target.startsWith(w.transcripts))).toBe(false);
    expect(m.protected.find((p) => p.target === w.transcripts)).toMatchObject({ category: 'transcripts' });
  });

  it('ignored outputs are M2 only when untracked by git; tracked ones are protected', async () => {
    const w = world();
    const wt = worktree(w, 'out');
    write(join(wt, 'dist', 'bundle.js'));
    write(join(wt, 'build', 'tracked.js')); git(wt, 'add', '-f', 'build/tracked.js'); git(wt, 'commit', '-q', '-m', 'tracked build');
    git(w.app, 'update-ref', 'refs/remotes/origin/out', 'out');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    expect(m.items.find((i) => i.target === join(wt, 'dist'))).toMatchObject({ rule: 'M2' });
    expect(m.items.some((i) => i.target === join(wt, 'build'))).toBe(false);
    expect(m.protected.find((p) => p.target === join(wt, 'build'))?.category).toBe('uncommitted-source');
  });

  it('M3: a finished worktree idle 30 days is offered whole; local-only needs a bundle; a gateway-checkout worktree is not', async () => {
    const w = world();
    const old = worktree(w, 'old'), local = worktree(w, 'local');
    write(join(local, 'src', 'l.js')); git(local, 'add', '-A'); git(local, 'commit', '-q', '-m', 'l');
    git(w.app, 'worktree', 'lock', old);
    age(w.ws, 40);
    let s = sweeper(w);
    await sweep(s, true);
    const m3 = manifestOf(s).items.filter((i) => i.rule === 'M3');
    expect(m3.find((i) => i.target === old)).toMatchObject({ executable: true, locked: true, action: 'git-worktree-remove' });
    expect(m3.find((i) => i.target === local)).toMatchObject({ executable: false, needsBundle: true });
    s = sweeper(w, { gatewayCheckouts: [w.app] });
    await sweep(s, true);
    expect(manifestOf(s).items.some((i) => i.rule === 'M3')).toBe(false);
    expect(manifestOf(s).notes.some((n) => n.target === old && /main repository/.test(n.reason))).toBe(true);
  });

  it('M3: a submodule (.git file into .git/modules, no commondir) is never a linked worktree; a real worktree still is', async () => {
    const w = world();
    const src = join(w.base, 'subsrc');
    mkdirSync(src);
    git(src, 'init', '-q', '-b', 'main');
    write(join(src, '.gitignore'), 'node_modules/\n');
    write(join(src, 'package.json'), '{}');
    write(join(src, 'package-lock.json'), '{}');
    git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'sub');
    git(w.app, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, 'sub');
    git(w.app, 'commit', '-q', '-m', 'add sub');
    git(w.app, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    const sub = join(w.app, 'sub');
    expect(readFileSync(join(sub, '.git'), 'utf8')).toMatch(/modules\/sub/);
    write(join(sub, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1');
    const done = worktree(w, 'done');
    git(w.app, 'update-ref', 'refs/remotes/origin/done', 'done');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    const m3 = m.items.filter((i) => i.rule === 'M3').map((i) => i.target);
    expect(m3).toContain(done);
    expect(m3).not.toContain(sub);
    // The submodule's own deps follow the ordinary checkout rules: offered, never AUTO.
    expect(m.items.find((i) => i.target === join(sub, 'node_modules'))).toMatchObject({ rule: 'M1', reason: expect.stringMatching(/not a linked worktree/) });
  });
});

describe('dind (A4/M4) through an injected docker runner', () => {
  const inspect = (o: Record<string, unknown>) => ({ Id: 'c' + String(o.Name), Image: 'sha256:used', State: { Status: 'exited' }, HostConfig: { RestartPolicy: { Name: 'no' } }, Mounts: [], Config: { Image: 'x' }, SizeRw: 0, ...o });
  function dockerWorld(w: World) {
    const containers = [
      inspect({ Name: '/running', State: { Status: 'running' }, Mounts: [{ Type: 'bind', Source: join(w.ws, 'mounted') }] }),
      inspect({ Name: '/pin-db', State: { Status: 'created' } }),
      inspect({ Name: '/with-data', Mounts: [{ Type: 'volume', Name: 'pgdata' }] }),
      inspect({ Name: '/always', HostConfig: { RestartPolicy: { Name: 'always' } } }),
      inspect({ Name: '/old-job' }),
    ];
    w.docker = (args) => {
      const out = (s: string) => ({ code: 0, stdout: s, stderr: '' });
      if (args[0] === 'version') return out('27.5.1\n');
      if (args[0] === 'ps') return out(containers.filter((c) => args.includes('-a') || (c.State as { Status: string }).Status === 'running').map((c) => JSON.stringify(c.Id)).join('\n'));
      if (args[0] === 'inspect') return out(JSON.stringify(containers.filter((c) => args.includes(String(c.Id)) || args.includes(String((c as { Name?: unknown }).Name).slice(1)))));
      if (args[0] === 'system') return out(JSON.stringify({ Volumes: [{ Name: 'docintel-audit-gocache', Size: '2GB' }, { Name: 'a'.repeat(64), Size: '10MB' }, { Name: 'pgdata-old', Size: '1.5GB' }] }));
      if (args[0] === 'volume' && args[1] === 'ls') return out(['docintel-audit-gocache', 'a'.repeat(64), 'pgdata-old'].map((n) => JSON.stringify(n)).join('\n'));
      if (args[0] === 'volume' && args[1] === 'inspect') return out(JSON.stringify(args.slice(2).map((n) => ({ Name: n, Labels: null }))));
      if (args[0] === 'images' && args.includes('dangling=true') && args.includes('{{json .ID}}')) return out(JSON.stringify('sha256:old'));
      if (args[0] === 'images' && args.includes('dangling=true')) return out([JSON.stringify({ ID: 'sha256:old', CreatedAt: '2026-01-01 10:00:00 +0000 UTC', Size: '300MB' }), JSON.stringify({ ID: 'sha256:used', CreatedAt: '2026-01-01 10:00:00 +0000 UTC', Size: '1GB' })].join('\n'));
      if (args[0] === 'images') return out('app:rollback-1\napp:latest\n');
      return out('');
    };
  }

  it('plans only the old build cache as AUTO, every volume as M4, and protects pinned/running/data containers', async () => {
    const w = world();
    dockerWorld(w);
    write(join(w.ws, 'mounted', 'node_modules', 'x.js')); age(w.ws, 40);
    const s = sweeper(w, { dind: true });
    await sweep(s, true);
    const m = manifestOf(s);
    expect(m.auto.map((i) => i.target).sort()).toEqual(['docker:builder']);
    const m4 = Object.fromEntries(m.items.filter((i) => i.rule === 'M4').map((i) => [i.target, i]));
    expect(Object.keys(m4).sort()).toEqual(['docker:container:old-job', 'docker:image:sha256:old', `docker:volume:${'a'.repeat(64)}`, 'docker:volume:docintel-audit-gocache', 'docker:volume:pgdata-old'].sort());
    expect(m4['docker:volume:docintel-audit-gocache'].reason).toMatch(/looks like a build cache \(gocache\)/);
    expect(m4['docker:volume:docintel-audit-gocache'].reason).not.toMatch(/hold data/);
    expect(m4['docker:volume:pgdata-old']).toMatchObject({ mayHoldData: true, bytes: 1_500_000_000 });
    expect(m.protected.map((p) => p.target)).toEqual(expect.arrayContaining(['docker:containers:running', 'docker:containers:pin', 'docker:containers:mounts', 'docker:containers:restart-policy', 'docker:images:rollback']));
    // A running container's bind source is in use: nothing under it is offered.
    expect(m.items.some((i) => i.target.startsWith(join(w.ws, 'mounted')))).toBe(false);
    // A dry run sent docker nothing that writes.
    expect(w.dockerCalls.every((a) => readOnlyCommand('docker', a))).toBe(true);
  });

  it('an AUTO run only prunes old build cache: no volume goes without approval', async () => {
    const w = world();
    dockerWorld(w);
    const s = sweeper(w, { dind: true });
    await sweep(s, false);
    const writes = w.dockerCalls.filter((a) => !readOnlyCommand('docker', a));
    expect(writes).toEqual([['builder', 'prune', '-f', '--filter', 'until=168h']]);
  });

  it('an approved docker item runs the command rebuilt from its target, not the one stored in the manifest', async () => {
    const w = world();
    dockerWorld(w);
    const s = sweeper(w, { dind: true });
    await sweep(s, true);
    const m = manifestOf(s);
    const item = m.items.find((i) => i.target === 'docker:container:old-job')!;
    item.command = ['docker', 'volume', 'rm', 'pgdata']; // tampered on disk
    m.digest = manifestDigest(m.items);
    writeFileSync(join(w.state, 'storage-sweeper', 'manifests', `${m.id}.json`), JSON.stringify(m));
    w.dockerCalls.length = 0;
    await s.executeApproved(m.id, m.digest, [item.id]).done;
    expect(w.dockerCalls.filter((a) => !readOnlyCommand('docker', a))).toEqual([['rm', 'c/old-job']]);
  });
});

describe('approval: a passkey, bound to the exact items', () => {
  const req = { headers: { host: 'localhost:4999', origin: 'http://localhost:4999' }, secure: false } as never;
  const rp = { rpID: 'localhost', origin: 'http://localhost:4999' };

  async function setup() {
    const w = world();
    const a = worktree(w, 'a'), b = worktree(w, 'b');
    for (const d of [a, b]) write(join(d, 'src', 'index.js'), 'dirty');
    age(w.ws, 40);
    // The owner's passkey predates the sweeper: it is the seed approver.
    const owner = addPasskey(w.state, 'owner phone', undefined, undefined, Date.parse('2026-07-07T04:05:55Z'));
    const webauthn = new WebAuthnService(w.state);
    const approvers = new StorageApprovers(w.state);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    const item = (d: string) => m.items.find((i) => i.target === join(d, 'node_modules'))!;
    const ctl = new StorageController(s, approvers, webauthn);
    const sign = async (pk: TestPasskey, body: { manifestId: string; digest: string; itemIds: string[] }) => {
      const o = await ctl.approveOptions(req, body) as { flowId: string; options: { challenge: string } };
      return { ...body, flowId: o.flowId, response: assertion(pk, { ...rp, challenge: o.options.challenge }) as never };
    };
    const finish = async () => { for (let i = 0; i < 200 && (s.status().running as unknown); i++) await new Promise((r) => setTimeout(r, 25)); };
    return { w, a, b, m, item, ctl, s, owner, webauthn, approvers, sign, finish };
  }

  it('deletes only the approved items, after a re-check', async () => {
    const t = await setup();
    const body = { manifestId: t.m.id, digest: t.m.digest, itemIds: [t.item(t.a).id] };
    const out = await t.ctl.approve(req, await t.sign(t.owner, body));
    await t.finish();
    expect(existsSync(join(t.a, 'node_modules'))).toBe(false);
    expect(existsSync(join(t.b, 'node_modules'))).toBe(true);
    expect(existsSync(join(t.a, 'src', 'index.js'))).toBe(true);
    const r = t.s.runs()[0];
    expect(r).toMatchObject({ runId: out.runId, trigger: 'approval', mode: 'approved', deleted: 1 });
    expect(t.s.manifest(t.m.id)!.executed).toEqual({ [t.item(t.a).id]: out.runId });
  });

  it('skips an item whose conditions changed since the manifest', async () => {
    const t = await setup();
    write(join(t.b, 'src', 'fresh.js'), 'touched today');
    const body = { manifestId: t.m.id, digest: t.m.digest, itemIds: [t.item(t.b).id] };
    const out = await t.ctl.approve(req, await t.sign(t.owner, body));
    await t.finish();
    expect(existsSync(join(t.b, 'node_modules'))).toBe(true);
    expect(t.s.receipts(out.runId)!.receipts[0]).toMatchObject({ result: 'skipped' });
    expect(t.s.receipts(out.runId)!.receipts[0].reason).toContain('conditions changed');
  });

  it('refuses a wrong digest, an agent caller, and anything without the owner\'s fresh passkey', async () => {
    const t = await setup();
    const body = { manifestId: t.m.id, digest: t.m.digest, itemIds: [t.item(t.a).id] };
    await expect(t.ctl.approveOptions(req, { ...body, digest: 'f'.repeat(64) })).rejects.toThrow(/digest/);
    // The MCP bridge's identity, in the body or the header.
    await expect(t.ctl.approveOptions(req, { ...body, from: 'session-1' } as never)).rejects.toThrow(/not for an agent/);
    await expect(t.ctl.approve(req, { ...(await t.sign(t.owner, body)), self: { projectId: 'p', sessionId: 's' } } as never)).rejects.toThrow(/not for an agent/);
    expect(() => refuseAgentCaller({ headers: { 'x-x056-caller': 'p/s' } }, {})).toThrow();
    // No assertion at all.
    await expect(t.ctl.approve(req, body as never)).rejects.toThrow(/flowId and response required/);
    // A passkey registered later (as any session could, with the token) is not an approver.
    const intruder = addPasskey(t.w.state, 'session passkey');
    const ctl2 = new StorageController(t.s, t.approvers, new WebAuthnService(t.w.state));
    const o = await ctl2.approveOptions(req, body) as { flowId: string; options: { challenge: string; allowCredentials: { id: string }[] } };
    expect(o.options.allowCredentials.map((c) => c.id)).toEqual([t.owner.credentialId]);
    await expect(ctl2.approve(req, { ...body, flowId: o.flowId, response: assertion(intruder, { ...rp, challenge: o.options.challenge }) as never })).rejects.toThrow(/passkey approval failed/);
    // Signed for one item set, used for another: the purpose does not match.
    const signedA = await t.sign(t.owner, body);
    await expect(t.ctl.approve(req, { ...signedA, itemIds: [t.item(t.a).id, t.item(t.b).id] })).rejects.toThrow(/passkey approval failed/);
    // Without user verification.
    const o2 = await t.ctl.approveOptions(req, body) as { flowId: string; options: { challenge: string } };
    await expect(t.ctl.approve(req, { ...body, flowId: o2.flowId, response: assertion(t.owner, { ...rp, challenge: o2.options.challenge, uv: false }) as never })).rejects.toThrow(/passkey approval failed/);
    // A login ceremony's challenge is not an approval.
    const login = await t.webauthn.authenticationOptions(rp.rpID, rp.origin);
    await expect(t.ctl.approve(req, { ...body, flowId: login.flowId, response: assertion(t.owner, { ...rp, challenge: login.options.challenge }) as never })).rejects.toThrow(/passkey approval failed/);
    // Single use: a replayed approval fails.
    const ok = await t.sign(t.owner, body);
    await t.ctl.approve(req, ok);
    await t.finish();
    await expect(t.ctl.approve(req, ok)).rejects.toThrow();
    expect(existsSync(join(t.b, 'node_modules'))).toBe(true);
  });

  it('a new passkey becomes an approver only with an existing approver\'s assertion', async () => {
    const t = await setup();
    const second = addPasskey(t.w.state, 'laptop');
    const webauthn = new WebAuthnService(t.w.state);
    const ctl = new StorageController(t.s, t.approvers, webauthn);
    const o = await ctl.approverOptions(req, { credentialId: second.credentialId }) as { flowId: string; options: { challenge: string } };
    await expect(ctl.addApprover(req, { credentialId: second.credentialId, flowId: o.flowId, response: assertion(second, { ...rp, challenge: o.options.challenge }) as never })).rejects.toThrow();
    const o2 = await ctl.approverOptions(req, { credentialId: second.credentialId }) as { flowId: string; options: { challenge: string } };
    await ctl.addApprover(req, { credentialId: second.credentialId, flowId: o2.flowId, response: assertion(t.owner, { ...rp, challenge: o2.options.challenge }) as never });
    const key = webauthn.keys().find((k) => k.id === second.credentialId)!.key;
    expect(t.approvers.has(second.credentialId, key)).toBe(true);
    expect(t.approvers.allowed(webauthn.keys()).map((a) => a.id).sort()).toEqual([t.owner.credentialId, second.credentialId].sort());
  });

  it('expires a manifest after 7 days', async () => {
    const t = await setup();
    const later = new StorageSweeper({ stateDir: t.w.state, now: () => Date.now() + 8 * DAY, log: () => {} });
    expect(() => later.approval(t.m.id, t.m.digest, [t.item(t.a).id])).toThrow(/expired/);
    expect(approvalPurpose(t.m.id, t.m.digest, ['b', 'a'])).toBe(approvalPurpose(t.m.id, t.m.digest, ['a', 'b']));
    expect(manifestDigest(t.m.items)).toBe(t.m.digest);
  });
});

describe('schedule and helpers', () => {
  it('runs once a day at 04:00 Asia/Jakarta, catching up for two hours', async () => {
    const w = world();
    let now = Date.parse('2026-10-27T20:30:00Z'); // 03:30 WIB
    const s = sweeper(w, { schedule: true, now: () => now });
    s.tick();
    expect(s.runs()).toHaveLength(0);
    now = Date.parse('2026-10-27T21:10:00Z'); // 04:10 WIB
    s.tick();
    for (let i = 0; i < 200 && s.status().running; i++) await new Promise((r) => setTimeout(r, 25));
    expect(s.runs()).toHaveLength(1);
    expect(s.runs()[0]).toMatchObject({ trigger: 'scheduled', mode: 'auto' });
    now += 30 * 60_000;
    s.tick();
    expect(s.status().running).toBeNull();
    expect(s.runs()).toHaveLength(1);
  });

  it('protects the UAT checkout and the dev instance\'s shared tree by default', () => {
    const w = world();
    const uat = join(w.state, 'chats', 'c06d266a-1234', 'work', 'uat', 'qol-chatbot', 'worktree');
    mkdirSync(uat, { recursive: true }); mkdirSync(join(w.ws, 'poc-ahu-ai'));
    const s = new StorageSweeper({ stateDir: w.state, workspaceRoot: w.ws, log: () => {} });
    const prot = s.protectedPaths().filter((g) => g.category === 'configured').map((g) => g.path).sort();
    expect(prot).toEqual([join(w.ws, 'poc-ahu-ai'), uat].sort());
    expect(DEFAULT_PROTECTED_PATHS).toHaveLength(3);
  });

  it('protects ahu-codebase (bind-mounted into the dev instance): an idle finished worktree there is neither AUTO nor offered', async () => {
    const w = world();
    const wt = join(w.ws, 'ahu-codebase', 'ahu-apostille', 'ap-fe');
    mkdirSync(join(wt, '..'), { recursive: true });
    git(w.app, 'worktree', 'add', '-q', '-b', 'apfe', wt);
    git(w.app, 'update-ref', 'refs/remotes/origin/apfe', 'apfe');
    write(join(wt, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1');
    write(join(wt, '.next', 'cache', 'c.bin'));
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    const m = manifestOf(s);
    const under = (t: string) => t.startsWith(join(w.ws, 'ahu-codebase'));
    expect(m.auto.some((i) => under(i.target))).toBe(false);
    expect(m.items.some((i) => under(i.target))).toBe(false);
    expect(existsSync(join(wt, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    expect(existsSync(join(wt, '.next', 'cache', 'c.bin'))).toBe(true);
    expect(m.protected.find((p) => p.target === join(w.ws, 'ahu-codebase'))).toMatchObject({ category: 'configured', reason: expect.stringMatching(/ahu-codebase/) });
  });

  it('read-only commands only, in a dry run', () => {
    expect(readOnlyCommand('git', ['-c', 'core.fsmonitor=false', '-C', '/x', 'status', '--porcelain'])).toBe(true);
    expect(readOnlyCommand('git', ['-c', 'core.fsmonitor=false', '--git-dir=/x', 'worktree', 'remove', '/y'])).toBe(false);
    expect(readOnlyCommand('git', ['-C', '/x', 'worktree', 'prune'])).toBe(false);
    expect(readOnlyCommand('git', ['-C', '/x', 'gc'])).toBe(false);
    expect(readOnlyCommand('nice', ['-n', '10', 'ionice', '-c', '3', 'du', '-sb', '/x'])).toBe(true);
    expect(readOnlyCommand('docker', ['volume', 'rm', 'x'])).toBe(false);
    expect(readOnlyCommand('docker', ['system', 'df', '-v'])).toBe(true);
    expect(readOnlyCommand('go', ['clean', '-cache'])).toBe(false);
    expect(readOnlyCommand('find', ['/x', '-name', '.git', '-print', '-quit'])).toBe(true);
    for (const bad of ['-delete', '-exec', '-execdir', '-ok', '-fprint', '-fls']) expect(readOnlyCommand('nice', ['-n', '10', 'find', '/x', bad, 'rm'])).toBe(false);
    expect(parseSize('1.5GB')).toBe(1_500_000_000);
    expect(parseSize('512kB')).toBe(512_000);
    expect(dockerTime('2026-01-01 10:00:00 +0700 WIB')).toBe(Date.parse('2026-01-01T03:00:00Z'));
  });

  it('a dry run refuses a write command even if a rule asks for one', async () => {
    const w = world();
    const calls: string[][] = [];
    const s = sweeper(w, { containerCaches: true, home: join(w.base, 'home'), tmpDir: join(w.base, 'tmp'), run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: '', stderr: '' }; } });
    mkdirSync(join(w.base, 'home', '.cache', 'go-build'), { recursive: true });
    mkdirSync(join(w.base, 'tmp'), { recursive: true });
    await sweep(s, true);
    expect(calls.every(([c, ...a]) => readOnlyCommand(c, a))).toBe(true);
    const m: Manifest = manifestOf(s);
    expect(m.auto.find((i) => i.command?.[0] === 'go')).toBeTruthy();
  });
});

describe('nested checkouts and fail-closed', () => {
  /** A linked worktree inside `parent`, finished (remote ref), with node_modules. */
  function inner(w: World, parent: string): string {
    const branch = parent.slice(w.ws.length + 1).replace(/\//g, '-') + '-inner', dir = join(parent, 'inner');
    git(w.app, 'worktree', 'add', '-q', '-b', branch, dir);
    write(join(dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports=1');
    git(w.app, 'update-ref', `refs/remotes/origin/${branch}`, branch);
    return dir;
  }

  it('a finished checkout nested inside a missing-gitdir worktree or a detached-unreachable one is protected too', async () => {
    const w = world();
    const orphan = worktree(w, 'orphan'), det = worktree(w, 'det', { detach: true });
    write(join(det, 'src', 'only-here.js')); git(det, 'add', '-A'); git(det, 'commit', '-q', '-m', 'unreachable');
    const in1 = inner(w, orphan), in2 = inner(w, det);
    rmSync(join(w.app, '.git', 'worktrees', 'orphan'), { recursive: true });
    const control = inner(w, worktree(w, 'plain'));
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(existsSync(join(control, 'node_modules'))).toBe(false); // the same setup, not nested in a protected tree: A1
    for (const d of [in1, in2]) expect(existsSync(join(d, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    const m = manifestOf(s);
    expect(m.items.some((i) => i.target.startsWith(in1 + '/') || i.target.startsWith(in2 + '/') || i.target === in1 || i.target === in2)).toBe(false);
    expect(m.protected.find((p) => p.target === join(in1, 'node_modules'))?.reason).toMatch(/git metadata is missing/);
    expect(m.protected.find((p) => p.target === join(in2, 'node_modules'))?.reason).toMatch(/detached HEAD no ref contains/);
  });

  it('M3 and M2 are refused when another repository sits inside (git worktree remove / rm would take it)', async () => {
    const w = world();
    const host = worktree(w, 'host');
    git(w.app, 'update-ref', 'refs/remotes/origin/host', 'host');
    const clone = join(host, 'dist', 'clone');
    mkdirSync(clone, { recursive: true }); git(clone, 'init', '-q'); write(join(clone, 'work.txt'), 'unpushed'); git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'mine');
    const plain = worktree(w, 'plain2');
    git(w.app, 'update-ref', 'refs/remotes/origin/plain2', 'plain2');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    expect(m.items.some((i) => i.target === host || i.target === join(host, 'dist'))).toBe(false);
    expect(m.notes.find((n) => n.target === host)?.reason).toMatch(/another repository inside it/);
    expect(m.protected.find((p) => p.target === join(host, 'dist'))?.category).toBe('nested-repo');
    expect(m.items.find((i) => i.target === plain)).toMatchObject({ rule: 'M3', executable: true });
  });

  it('without a readable accounts.json nothing runs (the transcripts could not be located)', async () => {
    const w = world();
    const done = worktree(w, 'done');
    age(w.ws, 40);
    rmSync(join(w.state, 'accounts.json'));
    const s = sweeper(w);
    const rec = await sweep(s, false);
    expect(rec.aborted).toMatch(/accounts/);
    expect(rec.deleted).toBe(0);
    expect(existsSync(join(done, 'node_modules', 'left-pad'))).toBe(true);
  });

  it('logs storage_sweep (and a 1 GiB manifest) to events.jsonl and the emitter', async () => {
    const w = world();
    worktree(w, 'done');
    age(w.ws, 40);
    const seen: string[] = [];
    const s = sweeper(w, { emit: (k) => seen.push(k) });
    const rec = await sweep(s, true);
    const ev = readFileSync(join(w.state, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(ev.find((e) => e.type === 'storage_sweep')).toMatchObject({ runId: rec.runId, mode: 'dry-run', reclaimedBytes: 0 });
    expect(seen).toContain('storage_sweep');
    expect(seen).not.toContain('storage_manifest'); // a few KB is not worth a notice
  });
});

describe('approval gate: what a session with the token can and cannot do', () => {
  const req = { headers: { host: 'localhost:4999', origin: 'http://localhost:4999' }, secure: false } as never;
  const rp = { rpID: 'localhost', origin: 'http://localhost:4999' };
  async function setup(ownerCreatedAt: number) {
    const w = world();
    const a = worktree(w, 'a');
    write(join(a, 'src', 'index.js'), 'dirty');
    age(w.ws, 40);
    const owner = addPasskey(w.state, 'owner phone', undefined, undefined, ownerCreatedAt);
    const webauthn = new WebAuthnService(w.state);
    const approvers = new StorageApprovers(w.state);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    const body = { manifestId: m.id, digest: m.digest, itemIds: [m.items.find((i) => i.target === join(a, 'node_modules'))!.id] };
    return { w, a, s, owner, webauthn, approvers, body, ctl: new StorageController(s, approvers, webauthn) };
  }
  const register = async (webauthn: WebAuthnService, pk: ReturnType<typeof softwarePasskey>) => {
    const o = await webauthn.registrationOptions(rp.rpID, rp.origin);
    return webauthn.verifyRegistration(o.flowId, registration(pk, { ...rp, challenge: o.options.challenge }) as never, 'session key');
  };

  it('removing the owner passkey and registering a key under its id leaves no approver: refused at both steps', async () => {
    const t = await setup(Date.parse('2026-07-07T04:05:55Z'));
    expect(t.approvers.allowed(t.webauthn.keys()).map((k) => k.id)).toEqual([t.owner.credentialId]);
    const evil = softwarePasskey(t.owner.credentialId);
    // Registering over an existing id is refused outright.
    expect(await register(t.webauthn, evil)).toBe(false);
    // A session can remove the passkey and then register its own key under the id...
    t.webauthn.remove(t.owner.credentialId);
    expect(await register(t.webauthn, evil)).toBe(true);
    expect(await register(t.webauthn, softwarePasskey())).toBe(true);
    // ...but the pinned fingerprint no longer matches, and a new key is not pinned.
    expect(t.approvers.allowed(t.webauthn.keys())).toEqual([]);
    await expect(t.ctl.approveOptions(req, t.body)).rejects.toThrow(/no passkey may approve/);
    await expect(t.ctl.approve(req, { ...t.body, flowId: 'x', response: assertion(evil, { ...rp, challenge: 'x' }) as never })).rejects.toThrow(/no passkey may approve/);
    await expect(t.ctl.approverOptions(req, { credentialId: t.owner.credentialId })).rejects.toThrow(/no passkey may approve/);
    expect(existsSync(join(t.a, 'node_modules', 'left-pad'))).toBe(true);
  });

  it('a passkey registered after the sweeper existed is never a seed: with no approver, everything is refused', async () => {
    const t = await setup(Date.now());
    expect(t.approvers.allowed(t.webauthn.keys())).toEqual([]);
    expect(t.ctl.status()).toMatchObject({ approvers: 0 });
    await expect(t.ctl.approveOptions(req, t.body)).rejects.toThrow(/no passkey may approve/);
    await expect(t.ctl.approve(req, { ...t.body, flowId: 'x', response: assertion(t.owner, { ...rp, challenge: 'x' }) as never })).rejects.toThrow(/no passkey may approve/);
    expect(existsSync(join(t.a, 'node_modules', 'left-pad'))).toBe(true);
  });

  it('an approval challenge expires after 5 minutes', async () => {
    const t = await setup(Date.parse('2026-07-07T04:05:55Z'));
    const o = await t.ctl.approveOptions(req, t.body) as { flowId: string; options: { challenge: string } };
    const signed = { ...t.body, flowId: o.flowId, response: assertion(t.owner, { ...rp, challenge: o.options.challenge }) as never };
    const real = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(real + 6 * 60_000);
    try { await expect(t.ctl.approve(req, signed)).rejects.toThrow(/passkey approval failed/); } finally { spy.mockRestore(); }
    expect(existsSync(join(t.a, 'node_modules', 'left-pad'))).toBe(true);
  });
});

describe('review fixes (2026-10-27)', () => {
  /** Commit an extended .gitignore on main (and its remote ref) before any worktree is made. */
  function ignoreMore(w: World, lines: string): void {
    write(join(w.app, '.gitignore'), readFileSync(join(w.app, '.gitignore'), 'utf8') + lines);
    git(w.app, 'add', '-A'); git(w.app, 'commit', '-q', '-m', 'ignore more');
    git(w.app, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  }
  /** Give `p` an mtime of `days` ago (a file written after age()). */
  const old = (p: string, days = 40) => { const t = new Date(Date.now() - days * DAY); utimesSync(p, t, t); };
  const m3 = (s: StorageSweeper) => manifestOf(s).items.filter((i) => i.rule === 'M3').map((i) => i.target);
  const noteFor = (s: StorageSweeper, t: string) => manifestOf(s).notes.find((n) => n.target === t)?.reason ?? '';

  // ---- 1. M3 ----
  it('1: M3 is refused for ignored data, skip-worktree / assume-unchanged edits, per-worktree refs and an unreachable reflog; A1 still takes only node_modules', async () => {
    const w = world();
    ignoreMore(w, '.env\nlocal/\n__pycache__/\n*.pyc\n');
    const control = worktree(w, 'control'), env = worktree(w, 'env'), notes = worktree(w, 'notes'), skip = worktree(w, 'skip'), assume = worktree(w, 'assume'), wref = worktree(w, 'wref'), reflog = worktree(w, 'reflog');
    write(join(control, 'pkg', '__pycache__', 'm.pyc')); write(join(control, 'x.pyc'));          // regenerable: still offered
    write(join(env, '.env'), 'SECRET=1');
    write(join(notes, 'local', 'notes.md'), 'my notes');
    git(skip, 'update-index', '--skip-worktree', 'src/index.js'); write(join(skip, 'src', 'index.js'), 'skip edit');
    git(assume, 'update-index', '--assume-unchanged', 'src/index.js'); write(join(assume, 'src', 'index.js'), 'assume edit');
    git(wref, 'update-ref', 'refs/worktree/keep', 'HEAD');
    write(join(reflog, 'src', 'gone.js'), 'only in the reflog'); git(reflog, 'add', '-A'); git(reflog, 'commit', '-q', '-m', 'lost'); git(reflog, 'reset', '-q', '--hard', 'HEAD~1');
    for (const d of [control, env, notes, skip, assume, wref, reflog]) expect(git(d, 'status', '--porcelain')).toBe('');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(m3(s)).toEqual([control]);
    expect(noteFor(s, env)).toMatch(/ignored \.env is not a regenerable/);
    expect(noteFor(s, notes)).toMatch(/ignored local\/ is not a regenerable/);
    expect(noteFor(s, skip)).toMatch(/skip-worktree file \(src\/index\.js\)/);
    expect(noteFor(s, assume)).toMatch(/assume-unchanged file \(src\/index\.js\)/);
    expect(noteFor(s, wref)).toMatch(/per-worktree ref refs\/worktree\/keep/);
    expect(noteFor(s, reflog)).toMatch(/reflog holds commit .* no branch, tag or remote contains/);
    // A1 removes exactly the node_modules dir: ignored files elsewhere stay.
    expect(existsSync(join(env, 'node_modules'))).toBe(false);
    expect(readFileSync(join(env, '.env'), 'utf8')).toBe('SECRET=1');
    expect(readFileSync(join(notes, 'local', 'notes.md'), 'utf8')).toBe('my notes');
    expect(readFileSync(join(skip, 'src', 'index.js'), 'utf8')).toBe('skip edit');
  });

  it('1: the approval re-plan refuses M3 when an ignored file appeared after the manifest', async () => {
    const w = world();
    ignoreMore(w, '.env\n');
    const wt = worktree(w, 'later');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    const item = m.items.find((i) => i.rule === 'M3' && i.target === wt)!;
    expect(item).toBeTruthy();
    write(join(wt, '.env'), 'SECRET=1'); old(join(wt, '.env'));
    const rec = await s.executeApproved(m.id, m.digest, [item.id]).done;
    expect(s.receipts(rec.runId)!.receipts[0]).toMatchObject({ result: 'skipped' });
    expect(s.receipts(rec.runId)!.receipts[0].reason).toMatch(/\.env/);
    expect(readFileSync(join(wt, '.env'), 'utf8')).toBe('SECRET=1');
    expect(regenerablePath('a/node_modules/x')).toBe(true);
    expect(regenerablePath('sub/z.pyc')).toBe(true);
    expect(regenerablePath('.env')).toBe(false);
    expect(regenerablePath('my_dist/x')).toBe(false);
  });

  // ---- 2. live-use sources fail closed ----
  it('2: dind on and its running containers cannot be listed: the run aborts, nothing is deleted', async () => {
    const w = world();
    const done = worktree(w, 'done');
    age(w.ws, 40);
    w.docker = (args) => (args[0] === 'ps' ? { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' } : undefined);
    const logs: string[] = [];
    const s = sweeper(w, { dind: true, log: (m) => logs.push(m) });
    const rec = await sweep(s, false);
    expect(rec.aborted).toMatch(/bind mounts of running dind containers.*Cannot connect/);
    expect(rec.deleted).toBe(0);
    expect(existsSync(join(done, 'node_modules', 'left-pad'))).toBe(true);
    expect(logs.some((l) => l.includes('Cannot connect'))).toBe(true);
  });

  it('2: an unreadable process table or mount table aborts the run', async () => {
    const w = world();
    const done = worktree(w, 'done');
    age(w.ws, 40);
    for (const o of [{ processes: () => { throw new Error('EACCES /proc'); } }, { mounts: () => { throw new Error('EACCES mountinfo'); } }] as Partial<StorageSweeperOptions>[]) {
      const rec = await sweep(sweeper(w, o), false);
      expect(rec.aborted).toMatch(/EACCES/);
      expect(rec.deleted).toBe(0);
    }
    expect(existsSync(join(done, 'node_modules', 'left-pad'))).toBe(true);
    expect(() => listProcesses(join(w.base, 'no-proc'))).toThrow(/cannot read/);
    mkdirSync(join(w.base, 'empty-proc'));
    expect(() => listProcesses(join(w.base, 'empty-proc'))).toThrow(/no processes/);
    expect(() => listMounts(join(w.base, 'no-mountinfo'))).toThrow(/cannot read/);
  });

  it('2: the process table failing between plan and delete skips the item and the run is still recorded', async () => {
    const w = world();
    const a = worktree(w, 'a');
    age(w.ws, 40);
    let calls = 0;
    const s = sweeper(w, { processes: () => { if (++calls > 1) throw new Error('EACCES /proc'); return []; } });
    const realNow = Date.now;
    let shift = 0; Date.now = () => realNow() + shift;
    try {
      const run = s.sweep({ trigger: 'manual', dryRun: false });
      shift = 10_000;
      const rec = await run.done;
      expect(s.receipts(rec.runId)!.receipts.find((r) => r.target === join(a, 'node_modules'))).toMatchObject({ result: 'skipped', reason: expect.stringMatching(/cannot list processes/) });
    } finally { Date.now = realNow; }
    expect(existsSync(join(a, 'node_modules'))).toBe(true);
  });

  // ---- 3. the dev instance ----
  it('3: the daily schedule is opt-in (X056_SWEEP=on) and compose passes both vars to the gateway', () => {
    expect(sweepScheduleEnabled({})).toBe(false);
    expect(sweepScheduleEnabled({ X056_SWEEP: '' })).toBe(false);
    expect(sweepScheduleEnabled({ X056_SWEEP: 'off' })).toBe(false);
    expect(sweepScheduleEnabled({ X056_SWEEP: 'on' })).toBe(true);
    const compose = readFileSync(join(__dirname, '..', 'compose.yaml'), 'utf8');
    const x056 = compose.slice(compose.indexOf('\n  x056:'), compose.indexOf('\n  dind:'));
    const env = x056.slice(x056.indexOf('    environment:'), x056.indexOf('    volumes:'));
    expect(env).toContain('X056_SWEEP: ${X056_SWEEP:-}');
    expect(env).toContain('X056_SWEEP_AT: ${X056_SWEEP_AT:-}');
  });

  it('3: on a poc-ahu-ai workspace root only a dry run is allowed: no schedule, no manual delete, no approval', async () => {
    const w = world();
    const dev = join(w.ws, 'poc-ahu-ai');
    const done = join(dev, 'done');
    git(w.app, 'worktree', 'add', '-q', '-b', 'devdone', done);
    git(w.app, 'update-ref', 'refs/remotes/origin/devdone', 'devdone');
    write(join(done, 'node_modules', 'left-pad', 'index.js'));
    age(w.ws, 40);
    // Reached through a symlink too: the realpath is what counts.
    symlinkSync(dev, join(w.base, 'devroot'));
    for (const root of [dev, join(w.base, 'devroot')]) {
      expect(devTreeRoot(root)).toBeTruthy();
      let now = Date.parse('2026-10-27T21:10:00Z'); // 04:10 WIB
      const s = sweeper(w, { workspaceRoot: root, schedule: true, now: () => now });
      const before = s.runs().length;
      expect(() => s.sweep({ trigger: 'manual', dryRun: false })).toThrow(/poc-ahu-ai/);
      s.tick();
      expect(s.status().running).toBeNull();
      s.start(); s.stop();
      expect(s.runs()).toHaveLength(before);
      const rec = await sweep(s, true);
      expect(rec.mode).toBe('dry-run');
      const m = manifestOf(s);
      expect(m.auto.some((i) => i.target === join(done, 'node_modules'))).toBe(true);
      const m1 = m.items[0];
      if (m1) expect(() => s.executeApproved(m.id, m.digest, [m1.id])).toThrow(/poc-ahu-ai/);
      now += DAY;
    }
    expect(devTreeRoot(w.ws)).toBeNull();
    expect(existsSync(join(done, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
  });

  it('3: approval is refused on a poc-ahu-ai root even for a manifest made elsewhere', async () => {
    const w = world();
    const a = worktree(w, 'a'); write(join(a, 'src', 'index.js'), 'dirty');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, true);
    const m = manifestOf(s);
    const item = m.items.find((i) => i.target === join(a, 'node_modules'))!;
    mkdirSync(join(w.base, 'poc-ahu-ai'));
    const dev = sweeper(w, { workspaceRoot: join(w.base, 'poc-ahu-ai') });
    expect(() => dev.executeApproved(m.id, m.digest, [item.id])).toThrow(/poc-ahu-ai/);
    expect(existsSync(join(a, 'node_modules', 'left-pad'))).toBe(true);
  });

  // ---- 4 and 5. dind containers and volumes ----
  function dind(w: World, containers: Record<string, unknown>[], volumes: string[], volumeLabels: Record<string, Record<string, string>> = {}) {
    const c = (o: Record<string, unknown>): Record<string, unknown> => ({ Id: 'c' + String(o.Name).slice(1), Image: 'sha256:x', State: { Status: 'exited' }, HostConfig: { RestartPolicy: { Name: 'no' } }, Mounts: [], Config: { Image: 'x' }, ...o });
    const all = containers.map(c);
    const sized = { current: new Map<string, number>(), all };
    w.docker = (args) => {
      const out = (x: string) => ({ code: 0, stdout: x, stderr: '' });
      if (args[0] === 'version') return out('27.5.1\n');
      if (args[0] === 'ps') return out(all.filter((x) => args.includes('-a') || (x.State as { Status: string }).Status === 'running').map((x) => JSON.stringify(x.Id)).join('\n'));
      if (args[0] === 'inspect') {
        const hit = all.filter((x) => args.includes(String(x.Id)) || args.includes(String(x.Name).slice(1)));
        // Like docker: SizeRw only with --size.
        return out(JSON.stringify(hit.map((x) => { const { SizeRw, ...rest } = x as Record<string, unknown>; const n = sized.current.get(String(x.Id)) ?? SizeRw; return args.includes('--size') && n !== undefined ? { ...rest, SizeRw: n } : rest; })));
      }
      if (args[0] === 'system') return out(JSON.stringify({ Volumes: volumes.map((n) => ({ Name: n, Size: '100MB' })) }));
      if (args[0] === 'volume' && args[1] === 'ls') return out(volumes.map((n) => JSON.stringify(n)).join('\n'));
      if (args[0] === 'volume' && args[1] === 'inspect') return out(JSON.stringify(args.slice(2).filter((n) => volumes.includes(n)).map((n) => ({ Name: n, Labels: volumeLabels[n] ?? null }))));
      if (args[0] === 'images') return out('');
      return out('');
    };
    return sized;
  }

  it('4: a stopped container is sized with --size; a writable layer over 50 MB, an unknown size or a before/rollback/backup name is protected', async () => {
    const w = world();
    const sized = dind(w, [
      { Name: '/exciting_pike', SizeRw: 2_629_646_956 },
      { Name: '/db-before-migration', SizeRw: 0 },
      { Name: '/app_rollback_1', SizeRw: 0 },
      { Name: '/nightly-backup', SizeRw: 0 },
      { Name: '/no-size-reported' },
      { Name: '/old-job', SizeRw: 4096 },
    ], []);
    const s = sweeper(w, { dind: true });
    await sweep(s, true);
    const m = manifestOf(s);
    expect(m.items.filter((i) => i.target.startsWith('docker:container:')).map((i) => i.target)).toEqual(['docker:container:old-job']);
    const prot = Object.fromEntries(m.protected.filter((p) => p.target.startsWith('docker:container:')).map((p) => [p.target.slice(17), p]));
    expect(prot['exciting_pike']).toMatchObject({ bytes: 2_629_646_956, reason: expect.stringMatching(/writable layer holds 2\.4 GB/) });
    for (const n of ['db-before-migration', 'app_rollback_1', 'nightly-backup']) expect(prot[n]?.reason).toMatch(/before\/rollback\/backup/);
    expect(prot['no-size-reported']?.reason).toMatch(/size unknown/);
    expect(w.dockerCalls.some((a) => a[0] === 'inspect' && a.includes('--size'))).toBe(true);
    // Grown past 50 MB after the manifest: the approval re-check refuses it.
    const item = m.items.find((i) => i.target === 'docker:container:old-job')!;
    sized.current.set('cold-job', 60 * 1024 ** 2);
    w.dockerCalls.length = 0;
    const rec = await s.executeApproved(m.id, m.digest, [item.id]).done;
    expect(s.receipts(rec.runId)!.receipts[0]).toMatchObject({ result: 'skipped', reason: expect.stringMatching(/writable layer holds/) });
    expect(w.dockerCalls.filter((a) => !readOnlyCommand('docker', a))).toEqual([]);
  });

  it('5: no volume is AUTO; a cache-looking name is only a hint, anchored at the end of the name', async () => {
    const w = world();
    dind(w, [], ['docintel-audit-gocache', 'obs-gomod2', 'ergomodel_pg', 'verdaccio-npm-cache-storage', 'b'.repeat(64)]);
    const s = sweeper(w, { dind: true });
    await sweep(s, false);
    expect(w.dockerCalls.filter((a) => !readOnlyCommand('docker', a))).toEqual([['builder', 'prune', '-f', '--filter', 'until=168h']]);
    const m = manifestOf(s);
    const vol = Object.fromEntries(m.items.filter((i) => i.target.startsWith('docker:volume:')).map((i) => [i.target.slice(14), i]));
    expect(Object.values(vol).every((i) => i.rule === 'M4' && i.class === 'manifest')).toBe(true);
    expect(Object.keys(vol)).toHaveLength(5);
    expect(vol['docintel-audit-gocache'].evidence.looksLikeCache).toBe('gocache');
    expect(vol['obs-gomod2'].evidence.looksLikeCache).toBe('gomod');
    for (const n of ['ergomodel_pg', 'verdaccio-npm-cache-storage']) expect(vol[n].evidence.looksLikeCache).toBeUndefined();
    expect(vol['verdaccio-npm-cache-storage']).toMatchObject({ mayHoldData: true, reason: 'unused named volume: may hold data' });
    expect(vol['ergomodel_pg']).toMatchObject({ mayHoldData: true, dataVolume: true, reason: expect.stringMatching(/looks like a data volume \(pg\)/) });
    expect(CACHE_VOLUME_HINT.test('ergomodel_pg')).toBe(false);
    expect(CACHE_VOLUME_HINT.test('verdaccio-npm-cache-storage')).toBe(false);
  });

  it('5b: a volume of a compose project with a running container is protected, at plan time and at approval', async () => {
    const w = world();
    const P = 'com.docker.compose.project';
    const fx = dind(w, [
      { Name: '/ahu-ai-sso-demo-native-auth-1', State: { Status: 'running' }, Config: { Image: 'x', Labels: { [P]: 'ahu-ai-sso-demo' } } },
      { Name: '/other-web-1', State: { Status: 'exited' }, Config: { Image: 'x', Labels: { [P]: 'other' } }, SizeRw: 0 },
    ], ['ahu-ai-sso-demo_gocache', 'other_gocache', 'loose_gocache'], {
      'ahu-ai-sso-demo_gocache': { [P]: 'ahu-ai-sso-demo', 'com.docker.compose.volume': 'gocache' },
      'other_gocache': { [P]: 'other', 'com.docker.compose.volume': 'gocache' },
    });
    const s = sweeper(w, { dind: true });
    await sweep(s, true);
    const m = manifestOf(s);
    const vols = m.items.filter((i) => i.target.startsWith('docker:volume:')).map((i) => i.target.slice(14)).sort();
    expect(vols).toEqual(['loose_gocache', 'other_gocache']);
    expect(m.protected.find((p) => p.target === 'docker:volume:ahu-ai-sso-demo_gocache')?.reason).toMatch(/compose project ahu-ai-sso-demo has a running container/);
    // The stack comes up after the manifest: the approval re-check refuses it.
    const item = m.items.find((i) => i.target === 'docker:volume:other_gocache')!;
    (fx.all.find((c) => c.Name === '/other-web-1')!.State as { Status: string }).Status = 'running';
    w.dockerCalls.length = 0;
    const rec = await s.executeApproved(m.id, m.digest, [item.id]).done;
    expect(s.receipts(rec.runId)!.receipts[0]).toMatchObject({ result: 'skipped', reason: expect.stringMatching(/compose project other has a running container/) });
    expect(w.dockerCalls.filter((a) => !readOnlyCommand('docker', a))).toEqual([]);
  });

  it('5c: a data-looking volume is flagged dataVolume (never AUTO); cache names keep their hint and win', async () => {
    const w = world();
    const names = ['ahu-ai-sso-demo_pgdata', 'app_db', 'app-db-1', 'svc_pg', 'store_minio', 'files_s3', 'web_uploads', 'kc_config', 'x_audit', 'mongo-data', 'proj_staff',
      'docintel-audit-gocache', 'obs-gomod2', 'api_gomodcache', 'build-cache', 'misc'];
    dind(w, [], names, { 'proj_staff': { 'com.docker.compose.project': 'proj', 'com.docker.compose.volume': 'staff' } });
    const s = sweeper(w, { dind: true });
    await sweep(s, false);
    expect(w.dockerCalls.filter((a) => !readOnlyCommand('docker', a))).toEqual([['builder', 'prune', '-f', '--filter', 'until=168h']]);
    const m = manifestOf(s);
    expect(m.auto.some((i) => i.target.startsWith('docker:volume:'))).toBe(false);
    const vol = Object.fromEntries(m.items.filter((i) => i.target.startsWith('docker:volume:')).map((i) => [i.target.slice(14), i]));
    expect(Object.keys(vol)).toHaveLength(names.length);
    for (const n of names.slice(0, 11)) expect(vol[n], n).toMatchObject({ class: 'manifest', mayHoldData: true, dataVolume: true, reason: expect.stringMatching(/data volume/) });
    for (const n of names.slice(11)) expect(vol[n].dataVolume, n).toBeUndefined();
    expect(vol['api_gomodcache'].evidence.looksLikeCache).toBe('gomodcache');
    expect(vol['build-cache'].evidence.looksLikeCache).toBe('cache');
  });

  // ---- 6. projects ----
  it('6: the project list failing aborts the run (no workspace path would be checked for busy)', async () => {
    const w = world();
    const done = worktree(w, 'done');
    age(w.ws, 40);
    const rec = await sweep(sweeper(w, { projects: () => { throw new Error('registry locked'); } }), false);
    expect(rec.aborted).toMatch(/projects.*registry locked/);
    expect(existsSync(join(done, 'node_modules', 'left-pad'))).toBe(true);
  });

  // ---- 7. node_modules that git cannot vouch for ----
  it('7: a repository inside node_modules, a patches/ dir or patch-package makes A1 a manifest item', async () => {
    const w = world();
    const repo = worktree(w, 'repo'), patches = worktree(w, 'patches'), pp = worktree(w, 'pp'), control = worktree(w, 'control');
    const inner = join(repo, 'node_modules', '@scope', 'linked');
    mkdirSync(inner, { recursive: true }); git(inner, 'init', '-q'); write(join(inner, 'edit.js'), 'unpushed');
    mkdirSync(join(patches, 'patches'));
    git(w.app, 'update-ref', 'refs/remotes/origin/patches', 'patches');
    write(join(patches, 'patches', 'left-pad+1.0.0.patch'), 'diff'); git(patches, 'add', '-A'); git(patches, 'commit', '-q', '-m', 'patch'); git(w.app, 'update-ref', 'refs/remotes/origin/patches', 'patches');
    write(join(pp, 'package.json'), '{"scripts":{"postinstall":"patch-package"}}'); git(pp, 'add', '-A'); git(pp, 'commit', '-q', '-m', 'pp'); git(w.app, 'update-ref', 'refs/remotes/origin/pp', 'pp');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, false);
    expect(existsSync(join(control, 'node_modules'))).toBe(false);
    for (const d of [repo, patches, pp]) expect(existsSync(join(d, 'node_modules', 'left-pad', 'index.js'))).toBe(true);
    const m = manifestOf(s);
    const reason = (d: string) => m.items.find((i) => i.target === join(d, 'node_modules'))?.rule + ' ' + m.items.find((i) => i.target === join(d, 'node_modules'))?.reason;
    expect(reason(repo)).toMatch(/^M1 .*git repository inside node_modules \(.*@scope\/linked\)/);
    expect(reason(patches)).toMatch(/^M1 .*patches exists/);
    expect(reason(pp)).toMatch(/^M1 .*uses patch-package/);
    expect(readFileSync(join(inner, 'edit.js'), 'utf8')).toBe('unpushed');
  });

  it('7: M3 looks inside node_modules for a repository too', async () => {
    const w = world();
    const wt = worktree(w, 'nmrepo');
    const inner = join(wt, 'node_modules', 'forked');
    mkdirSync(inner, { recursive: true }); git(inner, 'init', '-q');
    age(w.ws, 40);
    const s = sweeper(w);
    await sweep(s, true);
    expect(m3(s)).not.toContain(wt);
    expect(noteFor(s, wt)).toMatch(/another repository inside it \(.*node_modules\/forked\)/);
  });

  // ---- 8. low ----
  it('8: git ls-files failing protects every candidate', async () => {
    const w = world();
    const done = worktree(w, 'done');
    age(w.ws, 40);
    const base = defaultRunner();
    const s = sweeper(w, { run: (cmd, args, o) => (cmd === 'git' && args.includes('ls-files') && args.includes('--') ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: index file corrupt' }) : base(cmd, args, o)) });
    await sweep(s, false);
    expect(existsSync(join(done, 'node_modules', 'left-pad'))).toBe(true);
    const m = manifestOf(s);
    expect(m.items.some((i) => i.target.startsWith(done + '/'))).toBe(false);
    expect(m.protected.find((p) => p.target === join(done, 'node_modules'))?.reason).toMatch(/ls-files failed: fatal: index file corrupt/);
  });

  it('8: config.json protectedPaths adds to the defaults; it never replaces them', () => {
    const w = world();
    mkdirSync(join(w.ws, 'poc-ahu-ai')); mkdirSync(join(w.ws, 'extra')); mkdirSync(join(w.ws, 'opt'));
    mkdirSync(join(w.state, 'storage-sweeper'), { recursive: true });
    writeFileSync(join(w.state, 'storage-sweeper', 'config.json'), JSON.stringify({ protectedPaths: ['{workspaceRoot}/extra'] }));
    const s = new StorageSweeper({ stateDir: w.state, workspaceRoot: w.ws, protectedPaths: ['{workspaceRoot}/opt'], log: () => {} });
    expect(s.protectedPaths().filter((g) => g.category === 'configured').map((g) => g.path).sort()).toEqual([join(w.ws, 'extra'), join(w.ws, 'opt'), join(w.ws, 'poc-ahu-ai')].sort());
  });

  it('8: a pnpm store passes the same gates as a path: in use or protected = not pruned', async () => {
    const w = world();
    const home = join(w.base, 'home'), tmp = join(w.base, 'tmp'), bin = join(w.base, 'bin');
    mkdirSync(tmp, { recursive: true }); mkdirSync(bin);
    writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'pnpm'), 0o755);
    const stateStore = join(w.state, '.pnpm-store'), homeStore = join(home, '.local', 'share', 'pnpm', 'store');
    write(join(stateStore, 'v3', 'f'), 'pkg'); write(join(homeStore, 'v3', 'f'), 'pkg');
    const commands: string[][] = [];
    const base = defaultRunner();
    const run = (cmd: string, args: string[], o?: Parameters<typeof base>[2]) => {
      if (['pnpm', 'go', 'npm'].includes(cmd)) { commands.push([cmd, ...args]); return Promise.resolve({ code: 0, stdout: '', stderr: '' }); }
      return base(cmd, args, o);
    };
    const path = process.env.PATH, gocache = process.env.GOCACHE;
    process.env.PATH = `${bin}:${path}`; delete process.env.GOCACHE;
    try {
      // Both stores are offered and pruned when nothing holds them.
      let s = sweeper(w, { containerCaches: true, home, tmpDir: tmp, run });
      await sweep(s, false);
      expect(commands.filter((c) => c[0] === 'pnpm').map((c) => c.at(-1)).sort()).toEqual([homeStore, stateStore].sort());
      // A process with its cwd in one store, and a protectedPaths entry on the other.
      commands.length = 0;
      w.procs = [{ pid: 99, comm: 'node', paths: [join(stateStore, 'v3')] }];
      s = sweeper(w, { containerCaches: true, home, tmpDir: tmp, run, protectedPaths: [homeStore] });
      await sweep(s, false);
      expect(commands.filter((c) => c[0] === 'pnpm')).toEqual([]);
      const p = manifestOf(s).protected;
      expect(p.find((x) => x.target === stateStore)?.reason).toMatch(/pid 99/);
      expect(p.find((x) => x.target === homeStore)?.reason).toMatch(/protected/);
    } finally { process.env.PATH = path; if (gocache !== undefined) process.env.GOCACHE = gocache; }
  });
});

describe('reclaimedBytes counts each filesystem once (2026-10-28)', () => {
  // The production numbers: one disk seen as the ext4 workspace bind (64512)
  // and the overlay root (5242955), same totals, same free space.
  const disk = { bsize: 4096, blocks: 257232685, files: 65404928 };
  it('folds two device ids of one filesystem into one entry', () => {
    const free = freeByFilesystem([
      { dev: '64512', ...disk, bavail: 14347802 },
      { dev: '64512', ...disk, bavail: 14347802 },
      { dev: '5242955', ...disk, bavail: 14347801 },
    ]);
    expect(free).toEqual({ '64512': 14347802 * 4096 });
  });
  it('keeps two different filesystems apart', () => {
    const free = freeByFilesystem([
      { dev: '64512', ...disk, bavail: 10 },
      { dev: '2049', bsize: 4096, blocks: 1000, files: 100, bavail: 7 },
    ]);
    expect(free).toEqual({ '64512': 10 * 4096, '2049': 7 * 4096 });
  });
  it('a real run: reclaimed equals the df delta of the one filesystem', async () => {
    const w = world();
    worktree(w, 'done');
    age(w.ws, 40);
    const rec = await sweep(sweeper(w), false);
    const keys = Object.keys(rec.df.before);
    expect(keys).toEqual(Object.keys(rec.df.after));
    const delta = keys.reduce((n, k) => n + (rec.df.after[k] - rec.df.before[k]), 0);
    expect(rec.reclaimedBytes).toBe(Math.max(0, delta));
  });
});
