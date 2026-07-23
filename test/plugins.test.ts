import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PluginManager } from '../server/plugins.js';

const STUB = new URL('./bin/stub-plugin-claude', import.meta.url).pathname;

/** Two Claude config dirs + one Codex dir (which must be ignored). */
function scenario(): { root: string; dirs: { name: string; configDir: string }[]; logFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'x056-plug-'));
  const a = join(root, 'cfg-a'); const b = join(root, 'cfg-b');
  mkdirSync(a, { recursive: true }); mkdirSync(b, { recursive: true });
  return { root, dirs: [{ name: 'a', configDir: a }, { name: 'b', configDir: b }], logFile: join(root, 'log.jsonl') };
}

function mgr(dirs: { name: string; configDir: string }[], logFile?: string): PluginManager {
  if (logFile) process.env.STUB_LOG = logFile; else delete process.env.STUB_LOG;
  return new PluginManager({ claudePath: STUB, claudeDirs: () => dirs, timeoutMs: 10_000 });
}

afterEach(() => { delete process.env.STUB_LOG; });

describe('PluginManager', () => {
  it('replicates install across EVERY claude config dir, each with its own CLAUDE_CONFIG_DIR', async () => {
    const s = scenario();
    const res = await mgr(s.dirs, s.logFile).install('claude-security@claude-plugins-official');
    expect(res.ok).toBe(true);
    expect(res.perDir.map((p) => p.account).sort()).toEqual(['a', 'b']);
    // the stub logged one invocation per dir with the install argv + that dir's env
    const calls = readFileSync(s.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const installs = calls.filter((c) => c.argv[0] === 'plugin' && c.argv[1] === 'install');
    expect(installs.length).toBe(2);
    expect(installs.every((c) => c.argv[2] === 'claude-security@claude-plugins-official')).toBe(true);
    expect(installs.map((c) => c.cfg).sort()).toEqual(s.dirs.map((d) => d.configDir).sort());
  });

  it('maps enable/disable to the right subcommand', async () => {
    const s = scenario();
    await mgr(s.dirs, s.logFile).setEnabled('p@m', false);
    await mgr(s.dirs, s.logFile).setEnabled('p@m', true);
    const calls = readFileSync(s.logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls.filter((c) => c.argv[1] === 'disable' && c.argv[2] === 'p@m').length).toBe(2);
    expect(calls.filter((c) => c.argv[1] === 'enable' && c.argv[2] === 'p@m').length).toBe(2);
  });

  it('reports a PARTIAL failure (one dir down) as not ok, naming the bad account', async () => {
    const s = scenario();
    writeFileSync(join(s.dirs[1].configDir, 'FAIL'), '1'); // dir b will exit non-zero
    const res = await mgr(s.dirs).install('x@m');
    expect(res.ok).toBe(false);
    const bad = res.perDir.find((p) => !p.ok);
    expect(bad?.account).toBe('b');
    expect(res.perDir.find((p) => p.account === 'a')?.ok).toBe(true);
  });

  it('aggregates list across dirs: synced only when installed AND enabled in ALL of them', async () => {
    const s = scenario();
    // p1: installed+enabled in both -> synced. p2: enabled only in a -> drift.
    writeFileSync(join(s.dirs[0].configDir, 'plugins.json'), JSON.stringify([
      { id: 'p1@m', version: '1.0.0', scope: 'user', enabled: true },
      { id: 'p2@m', version: '1.0.0', scope: 'user', enabled: true },
    ]));
    writeFileSync(join(s.dirs[1].configDir, 'plugins.json'), JSON.stringify([
      { id: 'p1@m', version: '1.0.0', scope: 'user', enabled: true },
      { id: 'p2@m', version: '1.0.0', scope: 'user', enabled: false },
    ]));
    const { plugins, dirs } = await mgr(s.dirs).list();
    expect(dirs).toBe(2);
    const p1 = plugins.find((p) => p.id === 'p1@m')!;
    const p2 = plugins.find((p) => p.id === 'p2@m')!;
    expect({ enabled: p1.enabled, synced: p1.synced, installedCount: p1.installedCount, enabledCount: p1.enabledCount })
      .toEqual({ enabled: true, synced: true, installedCount: 2, enabledCount: 2 });
    // p2 is enabled in only one dir → not "enabled" (pool-wide), not synced
    expect({ enabled: p2.enabled, synced: p2.synced, enabledCount: p2.enabledCount })
      .toEqual({ enabled: false, synced: false, enabledCount: 1 });
    expect(p2.name).toBe('p2'); expect(p2.marketplace).toBe('m');
  });

  it('flags a plugin present in only SOME dirs as not synced (would vanish on failover)', async () => {
    const s = scenario();
    writeFileSync(join(s.dirs[0].configDir, 'plugins.json'), JSON.stringify([{ id: 'only-a@m', enabled: true }]));
    // dir b has no plugins.json → []
    const { plugins } = await mgr(s.dirs).list();
    const p = plugins.find((x) => x.id === 'only-a@m')!;
    expect(p.installedCount).toBe(1);
    expect(p.totalDirs).toBe(2);
    expect(p.synced).toBe(false);
  });

  it('returns ok:false with no dirs when there are no Claude accounts (never silently "succeeds")', async () => {
    const res = await mgr([]).install('x@m');
    expect(res).toEqual({ ok: false, perDir: [] });
  });

  it('treats "already enabled" as a no-op success, not a failure (the reported bug)', async () => {
    const s = scenario();
    // every dir already has it enabled → CLI exits 1 with "already enabled"
    for (const d of s.dirs) writeFileSync(join(d.configDir, 'ALREADY'), '1');
    const res = await mgr(s.dirs).setEnabled('frontend-design@claude-plugins-official', true);
    expect(res.ok).toBe(true);
    expect(res.perDir.every((p) => p.ok && p.noop)).toBe(true);
    expect(res.perDir[0].message).toBe('already up to date');
  });

  it('treats "already disabled" and "not installed" as no-op successes too', async () => {
    const s = scenario();
    for (const d of s.dirs) writeFileSync(join(d.configDir, 'ALREADY'), '1');
    expect((await mgr(s.dirs).setEnabled('p@m', false)).ok).toBe(true); // already disabled
    expect((await mgr(s.dirs).uninstall('p@m')).ok).toBe(true); // not found in installed
  });

  it('still reports a GENUINE failure (not an "already" no-op) as failed', async () => {
    const s = scenario();
    writeFileSync(join(s.dirs[0].configDir, 'FAIL'), '1'); // hard error, no "already" text
    const res = await mgr(s.dirs).setEnabled('p@m', true);
    expect(res.ok).toBe(false);
    expect(res.perDir.find((p) => p.account === 'a')?.ok).toBe(false);
    expect(res.perDir.find((p) => p.account === 'a')?.noop).toBe(false);
  });

  it('claudeDirsFromRegistry reads accounts.json and keeps only Claude accounts', () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-reg-'));
    const file = join(root, 'accounts.json');
    writeFileSync(file, JSON.stringify({
      activeByProvider: { claude: 'a', codex: 'd' },
      accounts: [
        { name: 'a', configDir: '/x/a', provider: 'claude', state: { kind: 'ok' } },
        { name: 'd', configDir: '/x/d', provider: 'codex', state: { kind: 'unknown' } },
      ],
    }));
    const dirs = PluginManager.claudeDirsFromRegistry(file)();
    expect(dirs).toEqual([{ name: 'a', configDir: '/x/a' }]);
  });
});
