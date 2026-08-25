import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bring a newly-onboarded Claude account up to the same baseline as the ones
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
 * a new member gets. Where accounts disagree, the union wins — a capability
 * present on any account is intended, and the alternative (intersection) would
 * quietly erode the baseline every time one account lagged.
 */

export const PROVISIONER = Symbol('x056-provisioner');

export interface ProvisionAccount { name: string; configDir: string }

export interface ProvisionPlan {
  marketplaces: string[];
  plugins: string[];
  skills: string[];
  flags: string[];
}

export interface ProvisionResult extends ProvisionPlan {
  account: string;
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

function listDirs(path: string): string[] {
  try { return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}

export class AccountProvisioner {
  constructor(
    private readonly claudeAccounts: () => ProvisionAccount[],
    private readonly plugins: {
      addMarketplace(source: string): Promise<unknown>;
      install(plugin: string): Promise<unknown>;
      setEnabled(plugin: string, enabled: boolean): Promise<unknown>;
    },
    /** Optional so tests and older callers need not wire the CLI. */
    private readonly designConsent?: {
      grant(account: ProvisionAccount): Promise<{ ok: boolean; message: string }>;
    },
  ) {}

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
   * Apply the fleet baseline to one account. Never throws: a half-provisioned
   * account is worse than a failed login, but a failed login because a
   * marketplace was briefly unreachable is worse still.
   */
  async provision(target: ProvisionAccount): Promise<ProvisionResult> {
    const p = this.plan(target.configDir);
    const errors: string[] = [];
    const done: ProvisionPlan = { marketplaces: [], plugins: [], skills: [], flags: [] };

    // Plugins go through the CLI, which writes whichever dirs the manager knows
    // about — by now the new account is registered, so it is included.
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

    // Skills and flags are plain files; copy from the first account that has one.
    for (const skill of p.skills) {
      const src = this.firstWith(join('skills', skill), target.configDir);
      const dest = join(target.configDir, 'skills', skill);
      if (!src || existsSync(dest)) continue;
      try { mkdirSync(join(target.configDir, 'skills'), { recursive: true }); cpSync(src, dest, { recursive: true }); done.skills.push(skill); }
      catch (err) { errors.push(`skill ${skill}: ${(err as Error).message}`); }
    }
    for (const flag of p.flags) {
      const dest = join(target.configDir, flag);
      if (existsSync(dest)) continue;
      try { writeFileSync(dest, ''); done.flags.push(flag); }
      catch (err) { errors.push(`flag ${flag}: ${(err as Error).message}`); }
    }

    // Design agent access last: it reaches the network, and a failure here says
    // nothing about the plugins and skills already in place.
    let designConsent: string | undefined;
    if (this.designConsent) {
      try {
        const res = await this.designConsent.grant(target);
        designConsent = res.message;
        if (!res.ok) errors.push(`design consent: ${res.message}`);
      } catch (err) { errors.push(`design consent: ${(err as Error).message}`); }
    }

    return { account: target.name, ...done, designConsent, errors };
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

  private firstWith(relPath: string, exclude: string): string | null {
    for (const acct of this.claudeAccounts()) {
      if (acct.configDir === exclude) continue;
      const candidate = join(acct.configDir, relPath);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}
