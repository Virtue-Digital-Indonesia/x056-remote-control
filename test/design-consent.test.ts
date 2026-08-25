import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesignConsentGranter, readConsentOutcome } from '../server/design-consent.js';
import { AccountProvisioner } from '../server/provision.js';

// Verbatim from a real `claude -p /design-consent` run on each kind of account.
const GRANTED = 'Design agent access granted for your Claude Design projects. Use /design revoke to undo.\nShell cwd was reset to /home/efran/remote-development/x056-remote-control\n';
const REFUSED = "Couldn't record Design agent access for your Claude Design projects — Request failed with status code 401. Try again, or check your claude.ai login with /login.\n";

describe('reading what the CLI said', () => {
  it('treats the granted line as success', () => {
    expect(readConsentOutcome(GRANTED)).toEqual({
      ok: true,
      message: 'Design agent access granted for your Claude Design projects. Use /design revoke to undo.',
    });
  });

  it('reports a refusal as failure and keeps the 401, which names the real fix', () => {
    const r = readConsentOutcome(REFUSED);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('401');
  });

  // `claude -p` exits 0 either way, so anything keyed on the exit code would
  // call a logged-out account healthy.
  it('does not mistake an empty run for success', () => {
    expect(readConsentOutcome('').ok).toBe(false);
    expect(readConsentOutcome('').message).toBe('no output from the CLI');
  });

  it('drops the trailing cwd notice the CLI appends', () => {
    expect(readConsentOutcome(GRANTED).message).not.toContain('Shell cwd');
  });
});

describe('DesignConsentGranter', () => {
  it('grants per account and keeps going after one fails', async () => {
    const seen: string[] = [];
    const g = new DesignConsentGranter({
      cwd: '/tmp',
      runFn: (dir) => { seen.push(dir); return Promise.resolve(dir.endsWith('bad') ? REFUSED : GRANTED); },
    });
    const out = await g.grantAll([
      { name: 'a', configDir: '/cfg/bad' },
      { name: 'b', configDir: '/cfg/good' },
    ]);
    expect(seen).toEqual(['/cfg/bad', '/cfg/good']); // the 401 did not abort the run
    expect(out.map((r) => [r.account, r.ok])).toEqual([['a', false], ['b', true]]);
  });
});

describe('onboarding a new account', () => {
  // The grant is server-side per claude.ai identity, so unlike plugins and
  // skills there is nothing to copy from an existing account — a new account
  // starts without it and every design tool call fails until it is made.
  it('grants design consent as part of provisioning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-prov-'));
    const granted: string[] = [];
    const p = new AccountProvisioner(
      () => [{ name: 'a', configDir: join(dir, 'a') }],
      { addMarketplace: async () => {}, install: async () => {}, setEnabled: async () => {} },
      { grant: async (acct) => { granted.push(acct.name); return { ok: true, message: 'granted' }; } },
    );
    const res = await p.provision({ name: 'new', configDir: join(dir, 'new') });
    expect(granted).toEqual(['new']);
    expect(res.designConsent).toBe('granted');
    expect(res.errors).toEqual([]);
  });

  it('records a failed grant as an error without failing onboarding', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-prov-'));
    const p = new AccountProvisioner(
      () => [],
      { addMarketplace: async () => {}, install: async () => {}, setEnabled: async () => {} },
      { grant: async () => ({ ok: false, message: '401' }) },
    );
    const res = await p.provision({ name: 'new', configDir: join(dir, 'new') });
    expect(res.account).toBe('new');
    expect(res.errors).toEqual(['design consent: 401']);
  });

  it('still provisions when no granter is wired', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-prov-'));
    const p = new AccountProvisioner(
      () => [],
      { addMarketplace: async () => {}, install: async () => {}, setEnabled: async () => {} },
    );
    const res = await p.provision({ name: 'new', configDir: join(dir, 'new') });
    expect(res.designConsent).toBeUndefined();
    expect(res.errors).toEqual([]);
  });
});
