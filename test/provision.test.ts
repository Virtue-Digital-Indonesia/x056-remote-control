import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountProvisioner, type ProvisionAccount } from '../server/provision.js';

/** Records what the plugin CLI was asked to do, without running it. */
function fakePlugins() {
  const calls: string[] = [];
  return {
    calls,
    addMarketplace: async (s: string) => { calls.push(`marketplace:${s}`); },
    install: async (p: string) => { calls.push(`install:${p}`); },
    setEnabled: async (p: string, on: boolean) => { calls.push(`enable:${p}:${on}`); },
  };
}

function fleet(): { root: string; accounts: ProvisionAccount[] } {
  const root = mkdtempSync(join(tmpdir(), 'x056-prov-'));
  const accounts = ['a', 'b', 'c'].map((n) => ({ name: n, configDir: join(root, n) }));
  for (const a of accounts) mkdirSync(a.configDir, { recursive: true });
  return { root, accounts };
}

const setEnabled = (dir: string, ids: Record<string, boolean>) =>
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ enabledPlugins: ids }));
const addSkill = (dir: string, name: string) => {
  mkdirSync(join(dir, 'skills', name), { recursive: true });
  writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `# ${name}\n`);
};
const addMarketplace = (dir: string, name: string) => mkdirSync(join(dir, 'plugins', 'marketplaces', name), { recursive: true });

describe('AccountProvisioner.plan — derived from the fleet, not configured', () => {
  it('unions what the existing accounts have, so a lagging account cannot erode the baseline', () => {
    const { accounts } = fleet();
    setEnabled(accounts[0].configDir, { 'p1@m': true, 'p2@m': true });
    setEnabled(accounts[1].configDir, { 'p1@m': true });            // b lags
    addSkill(accounts[0].configDir, 'design');
    addSkill(accounts[1].configDir, 'brand');
    addMarketplace(accounts[0].configDir, 'm');

    const p = new AccountProvisioner(() => accounts, fakePlugins()).plan();
    expect(p.plugins).toEqual(['p1@m', 'p2@m']);
    expect(p.skills).toEqual(['brand', 'design']);
    expect(p.marketplaces).toEqual(['m']);
  });

  it('ignores a plugin that is present but explicitly disabled', () => {
    const { accounts } = fleet();
    setEnabled(accounts[0].configDir, { 'on@m': true, 'off@m': false });
    const p = new AccountProvisioner(() => accounts, fakePlugins()).plan();
    expect(p.plugins).toEqual(['on@m']);
  });

  it('excludes the target, so a new empty account does not plan against itself', () => {
    const { accounts } = fleet();
    setEnabled(accounts[0].configDir, { 'p1@m': true });
    const prov = new AccountProvisioner(() => accounts, fakePlugins());
    expect(prov.plan(accounts[2].configDir).plugins).toEqual(['p1@m']);
  });
});

describe('AccountProvisioner.provision — what a NEW account gets', () => {
  it('installs and enables every plugin the fleet has, and copies missing skills', async () => {
    const { accounts } = fleet();
    setEnabled(accounts[0].configDir, { 'p1@m': true });
    addMarketplace(accounts[0].configDir, 'm');
    addSkill(accounts[0].configDir, 'design');
    const plugins = fakePlugins();

    const res = await new AccountProvisioner(() => accounts, plugins).provision(accounts[2]);

    expect(plugins.calls).toEqual(['marketplace:m', 'install:p1@m', 'enable:p1@m:true']);
    expect(res.skills).toEqual(['design']);
    expect(existsSync(join(accounts[2].configDir, 'skills', 'design', 'SKILL.md'))).toBe(true);
  });

  it('carries opt-in flag files across, which is what makes always-on survive failover', async () => {
    const { accounts } = fleet();
    writeFileSync(join(accounts[0].configDir, '.i-have-adhd-always'), '');
    const res = await new AccountProvisioner(() => accounts, fakePlugins()).provision(accounts[2]);
    expect(res.flags).toEqual(['.i-have-adhd-always']);
    expect(existsSync(join(accounts[2].configDir, '.i-have-adhd-always'))).toBe(true);
  });

  it('never overwrites a skill the account already has', async () => {
    const { accounts } = fleet();
    addSkill(accounts[0].configDir, 'design');
    addSkill(accounts[2].configDir, 'design');
    writeFileSync(join(accounts[2].configDir, 'skills', 'design', 'SKILL.md'), 'LOCAL EDIT\n');
    await new AccountProvisioner(() => accounts, fakePlugins()).provision(accounts[2]);
    const body = readFileSync(join(accounts[2].configDir, 'skills', 'design', 'SKILL.md'), 'utf8');
    expect(body).toBe('LOCAL EDIT\n');
  });

  it('reports a failure without throwing — onboarding must not fail because provisioning did', async () => {
    const { accounts } = fleet();
    setEnabled(accounts[0].configDir, { 'p1@m': true });
    const plugins = { ...fakePlugins(), install: async () => { throw new Error('registry down'); } };
    const res = await new AccountProvisioner(() => accounts, plugins).provision(accounts[2]);
    expect(res.plugins).toEqual([]);
    expect(res.errors[0]).toMatch(/registry down/);
  });
});

describe('opt-in flags span every account', () => {
  it('sets the flag on all accounts, because the hook resolves it per CLAUDE_CONFIG_DIR', () => {
    const { accounts } = fleet();
    const prov = new AccountProvisioner(() => accounts, fakePlugins());
    expect(prov.flagState('.i-have-adhd-always').on).toBe(false);

    const res = prov.setFlag('.i-have-adhd-always', true);
    expect(res.changed).toEqual(['a', 'b', 'c']);
    for (const a of accounts) expect(existsSync(join(a.configDir, '.i-have-adhd-always'))).toBe(true);
    expect(prov.flagState('.i-have-adhd-always').on).toBe(true);
  });

  it('reports partial state as off, since that is the "randomly broken" case', () => {
    const { accounts } = fleet();
    writeFileSync(join(accounts[0].configDir, '.i-have-adhd-always'), '');
    const state = new AccountProvisioner(() => accounts, fakePlugins()).flagState('.i-have-adhd-always');
    expect(state.on).toBe(false);
    expect(state.accounts).toEqual(['a']);
    expect(state.missing).toEqual(['b', 'c']);
  });

  it('clears the flag everywhere', () => {
    const { accounts } = fleet();
    const prov = new AccountProvisioner(() => accounts, fakePlugins());
    prov.setFlag('.i-have-adhd-always', true);
    prov.setFlag('.i-have-adhd-always', false);
    for (const a of accounts) expect(existsSync(join(a.configDir, '.i-have-adhd-always'))).toBe(false);
  });

  it('refuses an arbitrary filename rather than writing anywhere it is told', () => {
    const { accounts } = fleet();
    const prov = new AccountProvisioner(() => accounts, fakePlugins());
    expect(() => prov.setFlag('../../etc/passwd', true)).toThrow(/unknown flag/);
    expect(() => prov.setFlag('.ssh/authorized_keys', true)).toThrow(/unknown flag/);
  });
});
