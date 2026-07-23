import { execFile } from 'node:child_process';
import { AccountRegistry } from '../src/accounts.js';

/** One installed plugin, aggregated across every Claude config dir in the
 *  failover pool. The RC runs a session under whichever account is active, so a
 *  plugin is only reliably usable when it's installed AND enabled in ALL of
 *  them — hence the per-dir counts and the `synced` flag (the panel warns when
 *  a plugin would vanish on failover because some account lacks it). */
export interface PluginInfo {
  id: string; // "name@marketplace"
  name: string;
  marketplace: string;
  version?: string;
  scope?: string;
  /** Enabled in every config dir (the only state that survives failover). */
  enabled: boolean;
  installedCount: number;
  enabledCount: number;
  totalDirs: number;
  /** Installed AND enabled across all dirs — safe under failover. */
  synced: boolean;
}

export interface MarketplaceInfo {
  name: string;
  source?: string;
  repo?: string;
}

/** The result of a mutating op that ran against each config dir. `ok` is true
 *  only when every dir succeeded — a partial success still leaves the pool out
 *  of sync, which the caller surfaces rather than hiding. */
export interface OpResult {
  ok: boolean;
  perDir: { account: string; ok: boolean; message: string }[];
}

interface RawPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
}

export interface PluginManagerOptions {
  /** Path to the `claude` binary (defaults to `claude` on PATH). */
  claudePath?: string;
  /** Enumerates the Claude accounts to replicate across. Re-read on each call
   *  so adding/removing an account is reflected without restarting. */
  claudeDirs: () => { name: string; configDir: string }[];
  /** Per-CLI-invocation timeout. Marketplace add clones a repo, so allow room. */
  timeoutMs?: number;
}

/** Manages Claude Code plugins across the RC's Claude failover accounts by
 *  driving the `claude plugin` CLI once per config dir (with CLAUDE_CONFIG_DIR
 *  set). Every mutation is replicated to all dirs so plugins survive failover;
 *  reads aggregate all dirs so drift is visible. */
export class PluginManager {
  private readonly bin: string;
  private readonly timeoutMs: number;
  constructor(private readonly opts: PluginManagerOptions) {
    this.bin = opts.claudePath ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  /** Build the enumerator from the on-disk accounts registry (the same source
   *  the accounts API reads), filtered to Claude — Codex has no Claude plugins. */
  static claudeDirsFromRegistry(accountsFile: string): () => { name: string; configDir: string }[] {
    return () => {
      try {
        return AccountRegistry.load(accountsFile)
          .list()
          .filter((a) => a.provider === 'claude')
          .map((a) => ({ name: a.name, configDir: a.configDir }));
      } catch {
        return [];
      }
    };
  }

  private run(configDir: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        this.bin,
        ['plugin', ...args],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir }, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  }

  /** Strip the CLI's decorative prefixes/checkmarks to a single human line for
   *  the panel — prefer the last non-empty stderr/stdout line (where the CLI
   *  prints its ✔/✘ summary). */
  private static oneLine(stdout: string, stderr: string): string {
    const text = (stderr.trim() || stdout.trim());
    const lines = text.split('\n').map((l) => l.replace(/\r/g, '').trim()).filter(Boolean);
    const summary = lines.reverse().find((l) => /✔|✘|error|success|fail/i.test(l)) ?? lines[0] ?? '';
    return summary.replace(/^[✔✘•\-\s]+/, '').slice(0, 240) || (stdout || stderr ? 'done' : 'no output');
  }

  private async eachDir(args: string[]): Promise<OpResult> {
    const dirs = this.opts.claudeDirs();
    if (dirs.length === 0) return { ok: false, perDir: [] };
    const perDir = await Promise.all(
      dirs.map(async (d) => {
        const r = await this.run(d.configDir, args);
        return { account: d.name, ok: r.ok, message: PluginManager.oneLine(r.stdout, r.stderr) };
      }),
    );
    return { ok: perDir.every((p) => p.ok), perDir };
  }

  /** Installed plugins + configured marketplaces, aggregated across every dir. */
  async list(): Promise<{ plugins: PluginInfo[]; marketplaces: MarketplaceInfo[]; dirs: number }> {
    const dirs = this.opts.claudeDirs();
    const total = dirs.length;
    // installed plugins per dir
    const perDirPlugins = await Promise.all(
      dirs.map(async (d) => {
        const r = await this.run(d.configDir, ['list', '--json']);
        try {
          const arr = JSON.parse(r.stdout) as RawPlugin[];
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [] as RawPlugin[];
        }
      }),
    );
    const byId = new Map<string, PluginInfo>();
    for (const list of perDirPlugins) {
      for (const p of list) {
        const [name, marketplace = ''] = p.id.split('@');
        const cur = byId.get(p.id) ?? {
          id: p.id, name, marketplace, version: p.version, scope: p.scope,
          enabled: false, installedCount: 0, enabledCount: 0, totalDirs: total, synced: false,
        };
        cur.installedCount += 1;
        if (p.enabled) cur.enabledCount += 1;
        if (!cur.version && p.version) cur.version = p.version;
        byId.set(p.id, cur);
      }
    }
    const plugins = [...byId.values()].map((p) => ({
      ...p,
      enabled: total > 0 && p.enabledCount === total,
      synced: total > 0 && p.installedCount === total && p.enabledCount === total,
    })).sort((a, b) => a.id.localeCompare(b.id));

    // marketplaces from the first dir (kept in sync by replicated mutations)
    let marketplaces: MarketplaceInfo[] = [];
    if (dirs[0]) {
      const r = await this.run(dirs[0].configDir, ['marketplace', 'list', '--json']);
      try {
        const arr = JSON.parse(r.stdout) as MarketplaceInfo[];
        if (Array.isArray(arr)) marketplaces = arr;
      } catch { /* leave empty */ }
    }
    return { plugins, marketplaces, dirs: total };
  }

  addMarketplace(source: string): Promise<OpResult> { return this.eachDir(['marketplace', 'add', source]); }
  removeMarketplace(name: string): Promise<OpResult> { return this.eachDir(['marketplace', 'remove', name]); }
  install(plugin: string): Promise<OpResult> { return this.eachDir(['install', plugin]); }
  uninstall(plugin: string): Promise<OpResult> { return this.eachDir(['uninstall', plugin]); }
  setEnabled(plugin: string, enabled: boolean): Promise<OpResult> {
    return this.eachDir([enabled ? 'enable' : 'disable', plugin]);
  }
}
