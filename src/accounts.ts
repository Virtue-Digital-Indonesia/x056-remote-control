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
  configDir: string;
  /** Which agent CLI this account authenticates against. Failover only ever
   *  happens WITHIN a provider — a Claude transcript can't resume on GPT — so
   *  the account pool is effectively partitioned by this field. */
  provider: ProviderId;
  state: AccountState;
}

interface RegistryFile {
  // One "next up" pointer PER provider — a Claude session and a Codex session
  // each have their own active account. (Legacy files carry a single `active`
  // string instead; load() migrates it into activeByProvider['claude'].)
  activeByProvider: Partial<Record<ProviderId, string>>;
  accounts: Account[];
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
    if (a.state.kind === 'unauthenticated') return false;
    return a.state.kind !== 'limited' || a.state.until <= now;
  }

  /** Which account the next turn WOULD run on for a provider, without mutating
   *  the pointer — for showing "this prompt will use X" in the UI. Returns null
   *  when every account of that provider is currently limited/unauthenticated. */
  peekActive(now: number, provider: ProviderId = 'claude'): Account | null {
    const pool = this.ofProvider(provider);
    if (pool.length === 0) return null;
    const preferred = pool.find((a) => a.name === this.data.activeByProvider[provider]) ?? pool[0];
    if (this.usable(preferred, now)) return structuredClone(preferred);
    const other = pool.find((a) => a.name !== preferred.name && this.usable(a, now));
    return other ? structuredClone(other) : null;
  }

  pickActive(now: number, provider: ProviderId = 'claude'): Account | null {
    const pool = this.ofProvider(provider);
    if (pool.length === 0) return null;
    const preferred = pool.find((a) => a.name === this.data.activeByProvider[provider]) ?? pool[0];
    if (this.usable(preferred, now)) return structuredClone(preferred);
    const other = pool.find((a) => a.name !== preferred.name && this.usable(a, now));
    if (other) {
      this.data.activeByProvider[provider] = other.name;
      this.save();
      return structuredClone(other);
    }
    return null;
  }

  setActive(name: string): void {
    const acct = this.find(name);
    this.data.activeByProvider[acct.provider] = name;
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
    const out: RegistryFile = { activeByProvider: this.data.activeByProvider, accounts: this.data.accounts };
    writeFileSync(tmp, JSON.stringify(out, null, 2));
    renameSync(tmp, this.file);
  }
}
