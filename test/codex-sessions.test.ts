import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { codexHomeIndexed, prepareCodexHome, shareCodexSessions, sharedCodexSessionsDir } from '../server/codex-sessions.js';
import { CODEX_INDEXING_REASON, codexHomePreparing } from '../src/codex-home.js';
import { getAdapter } from '../src/adapters/registry.js';
import { createRequire } from 'node:module';
import { SessionManager } from '../server/manager.js';

function state(): string {
  const dir = mkdtempSync(join(tmpdir(), 'x056-cxs-'));
  mkdirSync(join(dir, 'state'), { recursive: true });
  return join(dir, 'state');
}

/** A rollout where codex writes one: sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl */
function rollout(configDir: string, thread: string, body = '{"type":"session_meta"}\n'): string {
  const day = join(configDir, 'sessions', '2026', '09', '07');
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-09-07T06-00-00-${thread}.jsonl`);
  writeFileSync(path, body);
  return path;
}

const isLinkTo = (path: string, target: string) => lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;

describe('shareCodexSessions', () => {
  it('links a fresh account\'s sessions/ to the shared store', () => {
    const st = state();
    const cfg = join(st, 'accounts', 'g');
    mkdirSync(cfg, { recursive: true });
    const r = shareCodexSessions(st, { name: 'g', configDir: cfg });
    expect(r).toMatchObject({ linked: true, moved: 0, skipped: 0 });
    expect(isLinkTo(join(cfg, 'sessions'), sharedCodexSessionsDir(st))).toBe(true);
  });

  // The accounts already running have their own rollouts; those must follow.
  it('moves an account\'s existing rollouts into the store, then links', () => {
    const st = state();
    const cfg = join(st, 'accounts', 'd');
    rollout(cfg, 'thr-1');
    rollout(cfg, 'thr-2');
    const r = shareCodexSessions(st, { name: 'd', configDir: cfg });
    expect(r).toMatchObject({ linked: true, moved: 2, skipped: 0 });
    expect(isLinkTo(join(cfg, 'sessions'), sharedCodexSessionsDir(st))).toBe(true);
    // ...and are reachable through the link exactly where codex will look.
    expect(existsSync(join(cfg, 'sessions', '2026', '09', '07', 'rollout-2026-09-07T06-00-00-thr-1.jsonl'))).toBe(true);
  });

  it('is what makes one account\'s thread visible to another', () => {
    const st = state();
    const g = join(st, 'accounts', 'g');
    const h = join(st, 'accounts', 'h');
    rollout(g, 'thr-g', 'from g\n');
    mkdirSync(h, { recursive: true });
    shareCodexSessions(st, { name: 'g', configDir: g });
    shareCodexSessions(st, { name: 'h', configDir: h });
    expect(readFileSync(join(h, 'sessions', '2026', '09', '07', 'rollout-2026-09-07T06-00-00-thr-g.jsonl'), 'utf8')).toBe('from g\n');
  });

  it('never overwrites a rollout the store already has', () => {
    const st = state();
    const a = join(st, 'accounts', 'a');
    const b = join(st, 'accounts', 'b');
    rollout(a, 'same', 'first\n');
    rollout(b, 'same', 'second\n');
    shareCodexSessions(st, { name: 'a', configDir: a });
    const r = shareCodexSessions(st, { name: 'b', configDir: b });
    expect(r).toMatchObject({ linked: true, moved: 0, skipped: 1 });
    expect(readFileSync(join(sharedCodexSessionsDir(st), '2026', '09', '07', 'rollout-2026-09-07T06-00-00-same.jsonl'), 'utf8')).toBe('first\n');
  });

  it('is idempotent: a second run on a linked account changes nothing', () => {
    const st = state();
    const cfg = join(st, 'accounts', 'g');
    mkdirSync(cfg, { recursive: true });
    shareCodexSessions(st, { name: 'g', configDir: cfg });
    expect(shareCodexSessions(st, { name: 'g', configDir: cfg })).toMatchObject({ linked: false, moved: 0 });
    expect(isLinkTo(join(cfg, 'sessions'), sharedCodexSessionsDir(st))).toBe(true);
  });
});

describe('SessionManager applies it at boot', () => {
  it('links every Codex account and leaves Claude accounts alone', () => {
    const st = state();
    const codex = join(st, 'accounts', 'g');
    const claude = join(st, 'accounts', 'a');
    rollout(codex, 'thr-boot');
    mkdirSync(join(claude, 'sessions'), { recursive: true }); // whatever a Claude dir might hold
    AccountRegistry.init(join(st, 'accounts.json'), [
      { name: 'a', configDir: claude },
      { name: 'g', configDir: codex, provider: 'codex' },
    ]);
    new SessionManager({ stateDir: st, workspaceRoot: mkdtempSync(join(tmpdir(), 'x056-ws-')) });
    expect(isLinkTo(join(codex, 'sessions'), sharedCodexSessionsDir(st))).toBe(true);
    expect(existsSync(join(sharedCodexSessionsDir(st), '2026', '09', '07', 'rollout-2026-09-07T06-00-00-thr-boot.jsonl'))).toBe(true);
    expect(lstatSync(join(claude, 'sessions')).isSymbolicLink()).toBe(false);
  });
});

describe('a Codex home\'s one-time index of the shared store', () => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  function home(status?: string, file = 'state_5.sqlite'): string {
    const dir = mkdtempSync(join(tmpdir(), 'x056-cxh-'));
    if (status !== undefined) {
      const db = new DatabaseSync(join(dir, file));
      db.exec('create table backfill_state (id integer primary key, status text not null, last_watermark text, last_success_at integer, updated_at integer not null)');
      db.prepare('insert into backfill_state values (1, ?, null, null, 0)').run(status);
      db.close();
    }
    return dir;
  }
  /** A stand-in `codex`: answers initialize after `delayMs` (never, if -1), exits on stdin EOF. */
  function fakeCodex(delayMs: number): string {
    const bin = join(mkdtempSync(join(tmpdir(), 'x056-cxbin-')), 'codex');
    writeFileSync(bin, `#!/usr/bin/env node
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => { const m = JSON.parse(l); if (m.method === 'initialize' && ${delayMs} >= 0) setTimeout(() => process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n'), ${delayMs}); });
rl.on('close', () => process.exit(0));
${delayMs < 0 ? 'setTimeout(() => process.exit(1), 150);' : ''}
`, { mode: 0o755 });
    return bin;
  }

  it('reads backfill_state: complete, unfinished, or unknown', () => {
    expect(codexHomeIndexed(home('complete'))).toBe(true);
    expect(codexHomeIndexed(home('running'))).toBe(false);
    expect(codexHomeIndexed(home())).toBeUndefined(); // never started
    // The newest schema file is the one the CLI uses.
    const both = home('complete', 'state_5.sqlite');
    const db = new DatabaseSync(join(both, 'state_6.sqlite'));
    db.exec("create table backfill_state (id integer primary key, status text not null); insert into backfill_state values (1, 'running')");
    db.close();
    expect(codexHomeIndexed(both)).toBe(false);
  });

  // The first app-server in a home answers nothing, initialize included, until
  // its index is done (224 s over 3.5 GB, measured 2026-09-30). Held open
  // until it answers, and kept out of routing meanwhile.
  it('holds one app-server open until initialize answers, keeping the account out of routing', async () => {
    const dir = home('running');
    const file = join(state(), 'accounts.json');
    const reg = AccountRegistry.init(file, [{ name: 'g', configDir: dir, provider: 'codex' }]);
    const done = prepareCodexHome(dir, fakeCodex(300));
    expect(codexHomePreparing(dir)).toBe(true);
    expect(getAdapter('codex').notReadyReason?.(dir)).toBe(CODEX_INDEXING_REASON);
    const g = reg.explain(Date.now(), 'codex').candidates.find((c) => c.name === 'g');
    expect(g?.eligible).toBe(false);
    expect(g?.reasons).toContain(CODEX_INDEXING_REASON);
    expect(await prepareCodexHome(dir, fakeCodex(0))).toBe(false); // one at a time
    expect(await done).toBe(true);
    expect(codexHomePreparing(dir)).toBe(false);
    expect(getAdapter('codex').notReadyReason?.(dir)).toBeUndefined();
  });

  it('reports a process that exits without answering, and frees the account', async () => {
    const dir = home('running');
    expect(await prepareCodexHome(dir, fakeCodex(-1))).toBe(false);
    expect(codexHomePreparing(dir)).toBe(false);
  });
});
