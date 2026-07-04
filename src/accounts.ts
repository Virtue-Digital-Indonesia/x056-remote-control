import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AccountState = { kind: 'unknown' } | { kind: 'ok' } | { kind: 'limited'; until: number };

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
      throw new Error(`${file} not found — run the setup step (scripts/setup-accounts.sh) first.`);
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

  private usable(a: Account, now: number): boolean {
    return a.state.kind !== 'limited' || a.state.until <= now;
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

  markLimited(name: string, until: number): void {
    this.find(name).state = { kind: 'limited', until };
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
