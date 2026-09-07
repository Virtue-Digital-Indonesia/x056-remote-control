import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { shareCodexSessions, sharedCodexSessionsDir } from '../server/codex-sessions.js';
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
