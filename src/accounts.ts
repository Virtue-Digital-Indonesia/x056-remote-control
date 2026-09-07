import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderId } from './provider.js';

export type AccountState =
  | { kind: 'unknown' }
  | { kind: 'ok' }
  // `estimated: true` means `until` is our own retry-cooldown guess (no reset
  // time was available from the provider), NOT a real reported reset time — the
  // UI must not present it as a factual countdown.
  | { kind: 'limited'; until: number; estimated?: boolean }
  // The CLI reported "Not logged in" for this account (expired/revoked OAuth
  // session) — unlike 'limited', there's no reset time; it stays unusable until
  // a human re-authenticates it (see markOk, called once that succeeds).
  | { kind: 'unauthenticated' };

export interface Account {
  name: string;
  /** Human-readable nickname. The routing key and transcript attribution stay stable. */
  label?: string;
  configDir: string;
  /** Which agent CLI this account authenticates against. Failover only ever
   *  happens WITHIN a provider — a Claude transcript can't resume on GPT — so
   *  the account pool is effectively partitioned by this field. */
  provider: ProviderId;
  state: AccountState;
  /** Exclude from future attempts without changing authentication or live turns. */
  paused?: boolean;
}

export const ROUTING_STRATEGIES = ['sticky', 'priority', 'round-robin', 'least-busy', 'wait'] as const;
export type RoutingStrategy = typeof ROUTING_STRATEGIES[number];
export interface RoutingPolicy { strategy: RoutingStrategy; order: string[] }

interface RegistryFile {
  // One "next up" pointer PER provider — a Claude session and a Codex session
  // each have their own active account. (Legacy files carry a single `active`
  // string instead; load() migrates it into activeByProvider['claude'].)
  activeByProvider: Partial<Record<ProviderId, string>>;
  accounts: Account[];
  autoSwitch?: Partial<Record<ProviderId, boolean>>;
  routing?: Partial<Record<ProviderId, RoutingPolicy>>;
  lastRouted?: Partial<Record<ProviderId, string>>;
  manualNext?: Partial<Record<ProviderId, string>>;
  active?: string; // legacy single-provider pointer; read on load, never written
}

interface AccountSpec {
  name: string;
  configDir: string;
  provider?: ProviderId;
}

export class AccountRegistry {
  private constructor(
    private readonly file: string,
    private data: RegistryFile,
  ) {}

  static init(file: string, specs: AccountSpec[]): AccountRegistry {
    const accounts: Account[] = specs.map((s) => ({
      name: s.name,
      configDir: s.configDir,
      provider: s.provider ?? 'claude',
      state: { kind: 'unknown' },
    }));
    const activeByProvider: Partial<Record<ProviderId, string>> = {};
    for (const a of accounts) if (!activeByProvider[a.provider]) activeByProvider[a.provider] = a.name;
    const reg = new AccountRegistry(file, { activeByProvider, accounts });
    reg.save();
    return reg;
  }

  static load(file: string): AccountRegistry {
    if (!existsSync(file)) {
      throw new Error(`${file} not found — run the setup wizard (scripts/setup.sh) first.`);
    }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as RegistryFile;
    // Backward compat: older files predate multi-provider — every account is a
    // Claude account, and the pointer is a single `active` string. Fill both in.
    for (const a of raw.accounts) if (!a.provider) a.provider = 'claude';
    if (!raw.activeByProvider) {
      raw.activeByProvider = {};
      if (raw.active) {
        const acct = raw.accounts.find((a) => a.name === raw.active);
        if (acct) raw.activeByProvider[acct.provider] = acct.name;
      }
    }
    // Ensure every provider that has accounts has a pointer (first one wins).
    for (const a of raw.accounts) if (!raw.activeByProvider[a.provider]) raw.activeByProvider[a.provider] = a.name;
    return new AccountRegistry(file, raw);
  }

  private find(name: string): Account {
    const acct = this.data.accounts.find((a) => a.name === name);
    if (!acct) throw new Error(`unknown account: ${name}`);
    return acct;
  }

  private ofProvider(provider: ProviderId): Account[] {
    return this.data.accounts.filter((a) => a.provider === provider);
  }

  list(): Account[] {
    return this.data.accounts.map((a) => structuredClone(a));
  }

  get(name: string): Account {
    return structuredClone(this.find(name));
  }

  has(name: string): boolean {
    return this.data.accounts.some((a) => a.name === name);
  }

  /** The "next up" account name for a provider, falling back to that provider's
   *  first account when no pointer is set yet. */
  activeName(provider: ProviderId = 'claude'): string {
    const ptr = this.data.activeByProvider[provider];
    if (ptr && this.data.accounts.some((a) => a.name === ptr && a.provider === provider)) return ptr;
    const first = this.ofProvider(provider)[0];
    if (!first) throw new Error(`no ${provider} account configured`);
    return first.name;
  }

  /** Append a freshly-onboarded account (state unknown until first used). */
  add(name: string, configDir: string, provider: ProviderId = 'claude'): Account {
    if (this.has(name)) throw new Error(`account already exists: ${name}`);
    const acct: Account = { name, configDir, provider, state: { kind: 'unknown' } };
    this.data.accounts.push(acct);
    if (!this.data.activeByProvider[provider]) this.data.activeByProvider[provider] = name;
    this.save();
    return structuredClone(acct);
  }

  /** Forget an account. Refuses to remove the last one overall; if it was the
   *  active account for its provider, that provider's pointer moves to the first
   *  remaining account of the same provider. */
  remove(name: string): Account {
    const idx = this.data.accounts.findIndex((a) => a.name === name);
    if (idx < 0) throw new Error(`unknown account: ${name}`);
    if (this.data.accounts.length <= 1) throw new Error('cannot remove the last account');
    const [removed] = this.data.accounts.splice(idx, 1);
    if (this.data.activeByProvider[removed.provider] === name) {
      const next = this.ofProvider(removed.provider)[0];
      if (next) this.data.activeByProvider[removed.provider] = next.name;
      else delete this.data.activeByProvider[removed.provider];
    }
    this.save();
    return structuredClone(removed);
  }

  private usable(a: Account, now: number): boolean {
    if (a.paused || a.state.kind === 'unauthenticated') return false;
    return a.state.kind !== 'limited' || a.state.until <= now;
  }

  /** Which account the next turn WOULD run on for a provider, without mutating
   *  the pointer — for showing "this prompt will use X" in the UI. Returns null
   *  when every account of that provider is currently limited/unauthenticated. */
  routingPolicy(provider: ProviderId): RoutingPolicy {
    const saved = this.data.routing?.[provider];
    const names = this.ofProvider(provider).map(a => a.name);
    const order = [...new Set([...(saved?.order || []), ...names])].filter(n => names.includes(n));
    return { strategy: saved?.strategy || 'sticky', order };
  }

  setRouting(provider: ProviderId, strategy: RoutingStrategy, order: string[]): void {
    const names = this.ofProvider(provider).map(a => a.name);
    if (!ROUTING_STRATEGIES.includes(strategy)) throw new Error('Unknown routing strategy');
    if (order.length !== names.length || new Set(order).size !== names.length || order.some(n => !names.includes(n))) {
      throw new Error('Priority order must include every account for this provider exactly once');
    }
    (this.data.routing ??= {})[provider] = { strategy, order: [...order] };
    (this.data.autoSwitch ??= {})[provider] = strategy !== 'wait';
    this.save();
  }

  peekActive(now: number, provider: ProviderId = 'claude', busy: Record<string, number> = {}): Account | null {
    const policy = this.routingPolicy(provider);
    const pool = policy.order.map(n => this.find(n));
    if (!pool.length) return null;
    const manual = pool.find(a => a.name === this.data.manualNext?.[provider]);
    if (manual && this.usable(manual, now)) return structuredClone(manual);
    const preferred = pool.find(a => a.name === this.data.activeByProvider[provider]) || pool[0];
    if (!this.automaticSwitching(provider)) return this.usable(preferred, now) ? structuredClone(preferred) : null;
    let usable = pool.filter(a => this.usable(a, now));
    if (policy.strategy === 'least-busy') usable.sort((a,b) => (busy[a.name] || 0) - (busy[b.name] || 0));
    else if (policy.strategy === 'round-robin') {
      const index = pool.findIndex(a => a.name === this.data.lastRouted?.[provider]);
      const rotated = [...pool.slice(index + 1), ...pool.slice(0, index + 1)];
      usable = rotated.filter(a => this.usable(a, now));
    } else if (policy.strategy === 'sticky' && this.usable(preferred, now)) return structuredClone(preferred);
    return usable[0] ? structuredClone(usable[0]) : null;
  }

  pickActive(now: number, provider: ProviderId = 'claude', busy: Record<string, number> = {}): Account | null {
    const selected = this.peekActive(now, provider, busy);
    if (selected) {
      this.data.activeByProvider[provider] = selected.name;
      (this.data.lastRouted ??= {})[provider] = selected.name;
      if (this.data.manualNext) delete this.data.manualNext[provider];
      this.save();
    }
    return selected;
  }

  automaticSwitching(provider: ProviderId): boolean {
    return this.routingPolicy(provider).strategy !== 'wait' && this.data.autoSwitch?.[provider] !== false;
  }

  setAutomaticSwitching(provider: ProviderId, enabled: boolean): void {
    (this.data.autoSwitch ??= {})[provider] = enabled;
    this.save();
  }

  setPaused(name: string, paused: boolean): void {
    const acct = this.find(name);
    acct.paused = paused;
    if (paused && this.data.activeByProvider[acct.provider] === name) {
      const next = this.ofProvider(acct.provider).find(a => this.usable(a, Math.floor(Date.now() / 1000)));
      if (next) this.data.activeByProvider[acct.provider] = next.name;
    }
    this.save();
  }

  setLabel(name: string, label: string): void {
    const clean = label.trim();
    if (clean.length > 80 || /[\u0000-\u001f\u007f]/.test(clean)) throw new Error('Account name must be at most 80 characters without control characters');
    const account = this.find(name);
    if (clean) account.label = clean;
    else delete account.label;
    this.save();
  }

  setActive(name: string): void {
    const acct = this.find(name);
    if (acct.paused) throw new Error('resume this account before selecting it');
    this.data.activeByProvider[acct.provider] = name;
    (this.data.manualNext ??= {})[acct.provider] = name;
    this.save();
  }

  markLimited(name: string, until: number, estimated?: boolean): void {
    this.find(name).state = estimated ? { kind: 'limited', until, estimated: true } : { kind: 'limited', until };
    this.save();
  }

  markOk(name: string): void {
    this.find(name).state = { kind: 'ok' };
    this.save();
  }

  markUnauthenticated(name: string): void {
    this.find(name).state = { kind: 'unauthenticated' };
    this.save();
  }

  /** The soonest reset time among limited accounts — scoped to one provider when
   *  given (a parked session only cares about its own provider's resets), or all
   *  accounts otherwise. Falls back to `now` (not Infinity) when nothing carries
   *  a real reset time (e.g. all unauthenticated). */
  earliestReset(provider?: ProviderId): number {
    const pool = provider ? this.ofProvider(provider) : this.data.accounts;
    const untils = pool
      .map((a) => a.state)
      .filter((s): s is { kind: 'limited'; until: number } => s.kind === 'limited')
      .map((s) => s.until);
    if (untils.length === 0) return Math.floor(Date.now() / 1000);
    return Math.min(...untils);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    // Persist only the current-shape fields (drop any legacy `active`).
    const out: RegistryFile = { activeByProvider: this.data.activeByProvider, accounts: this.data.accounts, autoSwitch: this.data.autoSwitch, routing: this.data.routing, lastRouted: this.data.lastRouted, manualNext: this.data.manualNext };
    writeFileSync(tmp, JSON.stringify(out, null, 2));
    renameSync(tmp, this.file);
  }
}
