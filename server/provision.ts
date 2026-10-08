import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProviderId } from '../src/provider.js';
import type { PluginManager, OpResult } from './plugins.js';
import type { McpServerManager, McpServerInfo, McpServerSpec } from './mcp-servers.js';

/**
 * Bring a newly-onboarded account up to the same baseline as the ones
 * already running.
 *
 * PluginManager and McpServerManager replicate across every account that exists
 * AT THE TIME OF THE CALL — which silently leaves a hole: an account onboarded
 * later starts empty, so a plugin installed last week is missing on it and a
 * failover onto that account loses capability with no error anywhere. Same for
 * skills, and for opt-in flag files like `.i-have-adhd-always`, which the hook
 * resolves per-account through $CLAUDE_CONFIG_DIR.
 *
 * The baseline is DERIVED from the existing accounts rather than configured, so
 * there is no second source of truth to drift: whatever the fleet already has,
 * a new member of the same provider gets. Where accounts disagree, the union wins — a capability
 * present on any account is intended, and the alternative (intersection) would
 * quietly erode the baseline every time one account lagged.
 */

export const PROVISIONER = Symbol('x056-provisioner');

export interface ProvisionAccount { name: string; configDir: string; provider?: ProviderId }

export interface ProvisionPlan {
  marketplaces: string[];
  plugins: string[];
  skills: string[];
  flags: string[];
}

export interface ProvisionResult extends ProvisionPlan {
  account: string;
  mcpServers?: string[];
  provider?: ProviderId;
  needsAuthorization?: string[];
  /**
   * Whether Claude Design agent access was granted. Not derived from the fleet
   * like everything else: it is a server-side grant per claude.ai identity, so
   * there is no file to copy and no way to inherit one account's from another.
   */
  designConsent?: string;
  /** Non-fatal problems; provisioning never blocks onboarding. */
  errors: string[];
}

/** Opt-in dotfiles that live in a config dir and must follow the fleet. */
const SEED_FLAG_FILES = ['.i-have-adhd-always'];

function readJson(path: string): Record<string, unknown> | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch { return null; }
}

/** Directory entries, following symlinks: a shared skill is a link into
 *  state/skills, and Dirent.isDirectory() is false for a link. */
function listDirs(path: string): string[] {
  try {
    return readdirSync(path).filter((name) => {
      try { return statSync(join(path, name)).isDirectory(); } catch { return false; }
    });
  } catch { return []; }
}

export class AccountProvisioner {
  constructor(
    private readonly allAccounts: () => ProvisionAccount[],
    private readonly plugins: {
      addMarketplace(source: string): Promise<unknown>;
      install(plugin: string): Promise<unknown>;
      setEnabled(plugin: string, enabled: boolean): Promise<unknown>;
    },
    /** Optional so tests and older callers need not wire the CLI. */
    private readonly designConsent?: {
      grant(account: ProvisionAccount): Promise<{ ok: boolean; message: string }>;
    },
    private readonly capabilities?: { plugins: PluginManager; mcp: McpServerManager },
  ) {}

  private claudeAccounts(): ProvisionAccount[] { return this.allAccounts().filter(a => (a.provider ?? 'claude') === 'claude'); }

  /** What the fleet collectively has, ignoring `exclude` (the new account). */
  plan(exclude?: string): ProvisionPlan {
    const marketplaces = new Set<string>();
    const plugins = new Set<string>();
    const skills = new Set<string>();
    const flags = new Set<string>();

    for (const acct of this.claudeAccounts()) {
      if (exclude && acct.configDir === exclude) continue;
      for (const m of listDirs(join(acct.configDir, 'plugins', 'marketplaces'))) marketplaces.add(m);
      const settings = readJson(join(acct.configDir, 'settings.json'));
      const enabled = (settings?.enabledPlugins ?? {}) as Record<string, boolean>;
      for (const [id, on] of Object.entries(enabled)) if (on) plugins.add(id);
      for (const s of listDirs(join(acct.configDir, 'skills'))) skills.add(s);
      for (const f of SEED_FLAG_FILES) if (existsSync(join(acct.configDir, f))) flags.add(f);
    }
    return {
      marketplaces: [...marketplaces].sort(),
      plugins: [...plugins].sort(),
      skills: [...skills].sort(),
      flags: [...flags].sort(),
    };
  }

  /**
   * Apply the fleet baseline to one account. Setup failures are reported in
   * the result and never prevent account onboarding.
   */
  private readonly pending = new Map<string, Promise<ProvisionResult>>();

  provision(target: ProvisionAccount): Promise<ProvisionResult> {
    const existing = this.pending.get(target.configDir);
    if (existing) return existing;
    const task = this.apply(target).finally(() => this.pending.delete(target.configDir));
    this.pending.set(target.configDir, task);
    return task;
  }

  private async apply(target: ProvisionAccount): Promise<ProvisionResult> {
    const provider = target.provider ?? 'claude';
    const errors: string[] = [];
    const done: ProvisionPlan = { marketplaces: [], plugins: [], skills: [], flags: [] };
    const mcpServers: string[] = [], needsAuthorization: string[] = [];
    const result: ProvisionResult = { account: target.name, provider, ...done, mcpServers, needsAuthorization, errors };
    try {
      let peers: ProvisionAccount[] = [];
      try { peers = this.allAccounts().filter(a => a.configDir !== target.configDir && (a.provider ?? 'claude') === provider); }
      catch { errors.push('accounts: could not read registry'); }
      let p: ProvisionPlan = { marketplaces: [], plugins: [], skills: [], flags: [] };
      try {
        p = provider === 'claude' ? this.plan(target.configDir) : { ...p, skills: [...new Set(peers.flatMap(a => listDirs(join(a.configDir, 'skills')).filter(n => !n.startsWith('.'))))].sort() };
      } catch { errors.push('baseline: could not read plan'); }

      // Legacy callers can supply simple plugin operations. The runtime uses
      // capability managers below, scoped exclusively to the target account.
      if (!this.capabilities) {
        for (const m of p.marketplaces) {
          try { await this.plugins.addMarketplace(m); done.marketplaces.push(m); }
          catch (err) { errors.push(`marketplace ${m}: ${(err as Error).message}`); }
        }
        for (const id of p.plugins) {
          try {
            await this.plugins.install(id);
            await this.plugins.setEnabled(id, true);
            done.plugins.push(id);
          } catch (err) { errors.push(`plugin ${id}: ${(err as Error).message}`); }
        }

      }

      // Skills and flags are plain files; copy from the first account that has one.
      // A skill the fleet SHARES (a symlink into state/skills, so that an edit --
      // /pushback rewriting rules.json -- lands on every account at once) is
      // linked the same way, not copied: a copy would drift from the first edit.
      for (const skill of p.skills) {
        const src = peers.map(a => join(a.configDir, 'skills', skill)).find(path => existsSync(path));
        const dest = join(target.configDir, 'skills', skill);
        if (!src || existsSync(dest)) continue;
        try {
          mkdirSync(join(target.configDir, 'skills'), { recursive: true });
          if (lstatSync(src).isSymbolicLink()) symlinkSync(resolve(dirname(src), readlinkSync(src)), dest);
          else cpSync(src, dest, { recursive: true });
          done.skills.push(skill);
        } catch (err) { errors.push(`skill ${skill}: ${(err as Error).message}`); }
      }
      for (const flag of p.flags) {
        const dest = join(target.configDir, flag);
        if (existsSync(dest)) continue;
        try { writeFileSync(dest, ''); done.flags.push(flag); }
        catch (err) { errors.push(`flag ${flag}: ${(err as Error).message}`); }
      }

      if (this.capabilities) {
        const check = (result: OpResult) => {
          if (!result.ok) throw new Error(result.perDir.filter(r => !r.ok).map(r => r.message).join('; ') || 'Setup did not complete');
        };
        // Finish MCP before optional plugin installs or network consent. All
        // writes remain sequential because the CLIs share the target config.
        try {
          const targetMcp = this.capabilities.mcp.forAccounts([target], provider);
          const current = await targetMcp.list();
          const baseline = new Map<string, McpServerInfo>();
          const definition = (s: McpServerSpec) => ({ transport: s.transport, command: s.command ?? '', args: s.args ?? [], env: s.env ?? {}, url: s.url ?? '', headers: s.headers ?? {} });
          for (const peer of peers) {
            try {
              const inventory = await this.capabilities.mcp.forAccounts([peer], provider).list();
              for (const server of inventory.servers) {
                const prior = baseline.get(server.name);
                if (!prior) baseline.set(server.name, { ...server, differing: [...server.differing] });
                else if (server.differing.length || !isDeepStrictEqual(definition(prior), definition(server))) prior.differing.push(peer.name);
              }
            } catch { errors.push(`MCP: could not read account ${peer.name} inventory`); }
          }
          for (const server of baseline.values()) {
            if (current.servers.some(s => s.name === server.name)) continue;
            if (server.differing.length) { errors.push(`MCP ${server.name}: peers use different definitions; choose one in Connections`); continue; }
            try { check(await targetMcp.add(provider, server)); mcpServers.push(server.name); }
            catch { errors.push(`MCP ${server.name}: could not install configuration`); }
          }
        } catch { errors.push('MCP: could not read target account inventory'); }
        try {
          const targetPlugins = this.capabilities.plugins.forAccounts([target], provider);
          const current = await targetPlugins.list(provider);
          const installed = new Set(current.plugins.map(p => p.id));
          const baseline = new Set<string>();
          const marketplaces = new Map<string, string>();
          for (const peer of peers) {
            try {
              const inventory = await this.capabilities.plugins.forAccounts([peer], provider).list(provider);
              for (const plugin of inventory.plugins) if (plugin.enabledCount > 0) baseline.add(plugin.id);
              for (const m of inventory.marketplaces) if (m.repo || m.installLocation) marketplaces.set(m.name, m.repo || m.installLocation!);
            } catch { errors.push(`plugins: could not read account ${peer.name} inventory`); }
          }
          for (const [name, source] of marketplaces) {
            if (current.marketplaces.some(m => m.name === name)) continue;
            try { check(await targetPlugins.addMarketplace(source, provider)); done.marketplaces.push(name); }
            catch { errors.push(`marketplace ${name}: could not register source`); }
          }
          for (const id of baseline) {
            if (installed.has(id)) continue; // preserve explicit local enable/disable choices
            try {
              check(await targetPlugins.install(id, provider));
              if (provider === 'claude') check(await targetPlugins.setEnabled(id, true, provider));
              // Remote connector installation may only start authorization. Verify
              // the target's own inventory; never copy another account's OAuth.
              const verified = await targetPlugins.list(provider);
              if (!verified.plugins.some(p => p.id === id && p.enabledCount > 0)) {
                if (id.endsWith('@openai-curated-remote')) needsAuthorization.push(id);
                else errors.push(`plugin ${id}: installation not confirmed`);
              } else done.plugins.push(id);
            } catch {
              if (id.endsWith('@openai-curated-remote')) needsAuthorization.push(id);
              else errors.push(`plugin ${id}: installation failed; retry from Connections`);
            }
          }
        } catch { errors.push('plugins: could not read account inventories'); }
      }
      // Consent is optional and may wait on the network, so it runs last.
      if (provider === 'claude' && this.designConsent) {
        try {
          const res = await this.designConsent.grant(target);
          result.designConsent = res.message;
          if (!res.ok) errors.push(`design consent: ${res.message}`);
        } catch { errors.push('design consent: could not grant access'); }
      }
    } catch { errors.push('provisioning: unexpected setup failure'); }
    return result;
  }

  /** Set or clear an opt-in flag file on EVERY Claude account at once. */
  setFlag(flag: string, on: boolean): { changed: string[]; errors: string[] } {
    if (!SEED_FLAG_FILES.includes(flag)) throw new Error(`unknown flag: ${flag}`);
    const changed: string[] = [];
    const errors: string[] = [];
    for (const acct of this.claudeAccounts()) {
      const path = join(acct.configDir, flag);
      try {
        if (on) {
          if (!existsSync(path)) { writeFileSync(path, ''); changed.push(acct.name); }
        } else if (existsSync(path)) {
          unlinkSync(path);
          changed.push(acct.name);
        }
      } catch (err) { errors.push(`${acct.name}: ${(err as Error).message}`); }
    }
    return { changed, errors };
  }

  /** Whether every Claude account currently carries the flag. */
  flagState(flag: string): { on: boolean; accounts: string[]; missing: string[] } {
    const accounts: string[] = [];
    const missing: string[] = [];
    for (const acct of this.claudeAccounts()) {
      (existsSync(join(acct.configDir, flag)) ? accounts : missing).push(acct.name);
    }
    return { on: missing.length === 0 && accounts.length > 0, accounts, missing };
  }

}
