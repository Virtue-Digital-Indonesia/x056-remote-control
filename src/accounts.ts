import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AccountState =
  | { kind: 'unknown' }
  | { kind: 'ok' }
  // `estimated: true` means `until` is our own retry-cooldown guess (no reset
  // time was available from Anthropic), NOT a real reported reset time — the UI
  // must not present it as a factual countdown.
  | { kind: 'limited'; until: number; estimated?: boolean };

export interface Account {
  name: string;
  configDir: string;
  state: AccountState;
}

interface RegistryFile {
  active: string;
  accounts: Account[];
}

export class AccountRegistry {
  private constructor(
    private readonly file: string,
    private data: RegistryFile,
  ) {}

  static init(file: string, specs: { name: string; configDir: string }[]): AccountRegistry {
    const data: RegistryFile = {
      active: specs[0].name,
      accounts: specs.map((s) => ({ ...s, state: { kind: 'unknown' } })),
    };
    const reg = new AccountRegistry(file, data);
    reg.save();
    return reg;
  }

  static load(file: string): AccountRegistry {
    if (!existsSync(file)) {
      throw new Error(`${file} not found — run the setup wizard (scripts/setup.sh) first.`);
    }
    return new AccountRegistry(file, JSON.parse(readFileSync(file, 'utf8')) as RegistryFile);
  }

  private find(name: string): Account {
    const acct = this.data.accounts.find((a) => a.name === name);
    if (!acct) throw new Error(`unknown account: ${name}`);
    return acct;
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

  activeName(): string {
    return this.data.active;
  }

  /** Append a freshly-onboarded account (state unknown until first used). */
  add(name: string, configDir: string): Account {
    if (this.has(name)) throw new Error(`account already exists: ${name}`);
    const acct: Account = { name, configDir, state: { kind: 'unknown' } };
    this.data.accounts.push(acct);
    this.save();
    return structuredClone(acct);
  }

  /** Forget an account. Refuses to remove the last one; if it was the active
   *  account, the active pointer moves to the first remaining account. */
  remove(name: string): Account {
    const idx = this.data.accounts.findIndex((a) => a.name === name);
    if (idx < 0) throw new Error(`unknown account: ${name}`);
    if (this.data.accounts.length <= 1) throw new Error('cannot remove the last account');
    const [removed] = this.data.accounts.splice(idx, 1);
    if (this.data.active === name) this.data.active = this.data.accounts[0].name;
    this.save();
    return structuredClone(removed);
  }

  private usable(a: Account, now: number): boolean {
    return a.state.kind !== 'limited' || a.state.until <= now;
  }

  /** Which account the next turn WOULD run on, without mutating the active
   *  pointer — for showing "this prompt will use X" in the UI. Returns null when
   *  every account is currently limited. */
  peekActive(now: number): Account | null {
    const preferred = this.find(this.data.active);
    if (this.usable(preferred, now)) return structuredClone(preferred);
    const other = this.data.accounts.find((a) => a.name !== preferred.name && this.usable(a, now));
    return other ? structuredClone(other) : null;
  }

  pickActive(now: number): Account | null {
    const preferred = this.find(this.data.active);
    if (this.usable(preferred, now)) return structuredClone(preferred);
    const other = this.data.accounts.find((a) => a.name !== preferred.name && this.usable(a, now));
    if (other) {
      this.data.active = other.name;
      this.save();
      return structuredClone(other);
    }
    return null;
  }

  setActive(name: string): void {
    this.find(name);
    this.data.active = name;
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

  earliestReset(): number {
    const untils = this.data.accounts
      .map((a) => a.state)
      .filter((s): s is { kind: 'limited'; until: number } => s.kind === 'limited')
      .map((s) => s.until);
    return Math.min(...untils);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
