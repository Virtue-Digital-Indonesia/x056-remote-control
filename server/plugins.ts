import { execFile } from 'node:child_process';
import { AccountRegistry } from '../src/accounts.js';
import type { ProviderId } from '../src/provider.js';

/** One plugin as the panel sees it, aggregated across a provider's accounts. */
export interface PluginInfo {
  id: string; // "name@marketplace"
  name: string;
  marketplace: string;
  version?: string;
  scope?: string;
  /** Enabled on EVERY account of the provider. */
  enabled: boolean;
  installedCount: number;
  enabledCount: number;
  totalDirs: number;
  /** Installed and enabled on every account — no drift. */
  synced: boolean;
}

export interface MarketplaceInfo {
  name: string;
  source?: string;
  repo?: string;
  installLocation?: string;
}

export interface OpResult {
  ok: boolean;
  /** One entry per account the mutation ran on. */
  perDir: { account: string; ok: boolean; message: string; noop?: boolean }[];
}

interface RawPlugin {
  id: string;
  version?: string;
  scope?: string;
  enabled?: boolean;
}

export interface PluginManagerOptions {
  strictReads?: boolean;
  /** Path to the `claude` binary (defaults to `claude` on PATH). */
  claudePath?: string;
  /** Path to the `codex` binary (defaults to `codex` on PATH). */
  codexPath?: string;
  /** Enumerates the accounts of a provider to replicate across. Re-read on
   *  each call so adding/removing an account is reflected without restarting. */
  dirs?: (provider: ProviderId) => { name: string; configDir: string }[];
  /** Back-compat: Claude-only enumerator. Prefer `dirs`. */
  claudeDirs?: () => { name: string; configDir: string }[];
  /** Per-CLI-invocation timeout. Marketplace add clones a repo, so allow room. */
  timeoutMs?: number;
}

/**
 * Manages plugins across the RC's failover accounts, per provider, by driving
 * each CLI's `plugin` subcommand once per config dir. Every mutation is
 * replicated to all of a provider's dirs so plugins survive failover; reads
 * aggregate all dirs so drift is visible.
 *
 * Codex speaks the SAME plugin and marketplace format as Claude -- verified
 * live on codex-cli 0.153.4: `codex plugin marketplace add
 * anthropics/claude-plugins-official` clones the real Claude marketplace and
 * `codex plugin add code-review@claude-plugins-official` installs from it. So
 * one plugin id means the same thing on both providers. What differs is only
 * the verb (`add`/`remove` for `install`/`uninstall`), the env var
 * (CODEX_HOME), the `list --json` envelope, and that Codex has no
 * enable/disable at all.
 */
export class PluginManager {
  private readonly timeoutMs: number;
  constructor(private readonly opts: PluginManagerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  /** Enumerator over the on-disk accounts registry, by provider. */
  static dirsFromRegistry(accountsFile: string): (provider: ProviderId) => { name: string; configDir: string }[] {
    return (provider) => {
      try {
        return AccountRegistry.load(accountsFile)
          .list()
          .filter((a) => a.provider === provider)
          .map((a) => ({ name: a.name, configDir: a.configDir }));
      } catch {
        return [];
      }
    };
  }

  /** Back-compat for callers that only know Claude. */
  static claudeDirsFromRegistry(accountsFile: string): () => { name: string; configDir: string }[] {
    const f = PluginManager.dirsFromRegistry(accountsFile);
    return () => f('claude');
  }

  private dirsFor(provider: ProviderId): { name: string; configDir: string }[] {
    if (this.opts.dirs) return this.opts.dirs(provider);
    return provider === 'claude' ? (this.opts.claudeDirs?.() ?? []) : [];
  }

  /** Scope onboarding writes to one account, leaving active peers untouched. */
  forAccounts(accounts: { name: string; configDir: string }[], provider: ProviderId): PluginManager {
    return new PluginManager({ ...this.opts, strictReads: true, dirs: (p) => p === provider ? accounts : [] });
  }

  private bin(provider: ProviderId): string {
    return provider === 'codex' ? (this.opts.codexPath ?? 'codex') : (this.opts.claudePath ?? 'claude');
  }

  private run(provider: ProviderId, configDir: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const env = provider === 'codex'
      ? { ...process.env, CODEX_HOME: configDir }
      : { ...process.env, CLAUDE_CONFIG_DIR: configDir };
    return new Promise((resolve) => {
      execFile(
        this.bin(provider),
        ['plugin', ...args],
        { env, timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' });
        },
      );
    });
  }

  private static oneLine(stdout: string, stderr: string): string {
    const text = (stderr.trim() || stdout.trim());
    const lines = text.split('\n').map((l) => l.replace(/\r/g, '').trim())
      .filter((l) => l && !/^WARNING: proceeding/.test(l)); // codex's benign PATH-alias notice
    const summary = lines.reverse().find((l) => /✔|✘|error|success|fail|added|removed|installed/i.test(l)) ?? lines[0] ?? '';
    return summary.replace(/^[✔✘•\-\s]+/, '').slice(0, 240) || (stdout || stderr ? 'done' : 'no output');
  }

  private async eachDir(provider: ProviderId, args: string[], okAnyway?: RegExp): Promise<OpResult> {
    const dirs = this.dirsFor(provider);
    if (dirs.length === 0) return { ok: false, perDir: [] };
    const perDir = await Promise.all(
      dirs.map(async (d) => {
        const r = await this.run(provider, d.configDir, args);
        const combined = r.stdout + '\n' + r.stderr;
        const noop = !r.ok && !!okAnyway && okAnyway.test(combined);
        return {
          account: d.name,
          ok: r.ok || noop,
          noop,
          message: noop ? 'already up to date' : PluginManager.oneLine(r.stdout, r.stderr),
        };
      }),
    );
    return { ok: perDir.every((p) => p.ok), perDir };
  }

  /** Normalise one CLI's `plugin list --json` into RawPlugin[]. */
  private static parseList(provider: ProviderId, stdout: string): RawPlugin[] {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { return []; }
    if (provider === 'claude') return Array.isArray(parsed) ? (parsed as RawPlugin[]) : [];
    // Codex: {installed:[{pluginId, name, marketplaceName, version, installed, enabled, ...}]}
    const inst = (parsed as { installed?: unknown }).installed;
    if (!Array.isArray(inst)) return [];
    return inst
      .map((p) => p as Record<string, unknown>)
      .filter((p) => typeof p.pluginId === 'string' && p.installed !== false)
      .map((p) => ({
        id: p.pluginId as string,
        version: typeof p.version === 'string' ? p.version : undefined,
        // Codex has no enable/disable; an installed plugin is an enabled one.
        enabled: p.enabled !== false,
      }));
  }

  private static parseMarketplaces(provider: ProviderId, stdout: string): MarketplaceInfo[] {
    let parsed: unknown;
    try { parsed = JSON.parse(stdout); } catch { return []; }
    if (provider === 'claude') return Array.isArray(parsed) ? (parsed as MarketplaceInfo[]) : [];
    const arr = (parsed as { marketplaces?: unknown }).marketplaces;
    if (!Array.isArray(arr)) return [];
    return arr.map((m) => m as Record<string, unknown>).filter((m) => typeof m.name === 'string').map((m) => {
      const src = (m.marketplaceSource ?? {}) as Record<string, unknown>;
      return {
        name: m.name as string,
        source: typeof src.sourceType === 'string' ? src.sourceType : undefined,
        repo: typeof src.source === 'string' ? src.source.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '') : undefined,
        installLocation: typeof m.root === 'string' ? m.root : undefined,
      };
    });
  }

  async list(provider: ProviderId = 'claude'): Promise<{ plugins: PluginInfo[]; marketplaces: MarketplaceInfo[]; dirs: number; provider: ProviderId; canToggle: boolean }> {
    const dirs = this.dirsFor(provider);
    const total = dirs.length;
    const perDirPlugins = await Promise.all(
      dirs.map(async (d) => {
        const r = await this.run(provider, d.configDir, ['list', '--json']);
        if (this.opts.strictReads) {
          if (!r.ok) throw new Error('Plugin inventory unavailable');
          const parsed = JSON.parse(r.stdout);
          if (!(provider === 'claude' ? Array.isArray(parsed) : Array.isArray(parsed?.installed))) throw new Error('Invalid plugin inventory');
        }
        return PluginManager.parseList(provider, r.stdout);
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
      const r = await this.run(provider, dirs[0].configDir, ['marketplace', 'list', '--json']);
      if (this.opts.strictReads && !r.ok) throw new Error('Marketplace inventory unavailable');
      marketplaces = PluginManager.parseMarketplaces(provider, r.stdout);
    }
    return { plugins, marketplaces, dirs: total, provider, canToggle: provider === 'claude' };
  }

  addMarketplace(source: string, provider: ProviderId = 'claude'): Promise<OpResult> {
    return this.eachDir(provider, ['marketplace', 'add', source], /already/i);
  }
  removeMarketplace(name: string, provider: ProviderId = 'claude'): Promise<OpResult> {
    return this.eachDir(provider, ['marketplace', 'remove', name], /not found|no such|unknown|not configured/i);
  }
  install(plugin: string, provider: ProviderId = 'claude'): Promise<OpResult> {
    return this.eachDir(provider, [provider === 'codex' ? 'add' : 'install', plugin], /already (installed|enabled|added)/i);
  }
  uninstall(plugin: string, provider: ProviderId = 'claude'): Promise<OpResult> {
    return this.eachDir(provider, [provider === 'codex' ? 'remove' : 'uninstall', plugin], /not found|not installed|no such/i);
  }
  setEnabled(plugin: string, enabled: boolean, provider: ProviderId = 'claude'): Promise<OpResult> {
    if (provider === 'codex') {
      // No such verb: `codex plugin` has add/list/marketplace/remove only.
      return Promise.resolve({ ok: false, perDir: this.dirsFor(provider).map((d) => ({ account: d.name, ok: false, message: 'Codex plugins have no enable/disable; remove it instead' })) });
    }
    return enabled
      ? this.eachDir(provider, ['enable', plugin], /already enabled/i)
      : this.eachDir(provider, ['disable', plugin], /already disabled/i);
  }
}
