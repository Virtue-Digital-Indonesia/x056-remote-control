import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { ApiController } from '../server/api.controller.js';

// accounts() is only exercised end-to-end via a running gateway elsewhere; this
// targets the specific bug directly. ApiController is a plain class (Nest DI is
// just constructor injection), so it's instantiable with minimal fakes for the
// three dependencies this endpoint never touches.
function controller(stateDir: string): ApiController {
  return new ApiController(
    {} as never, // SessionManager — unused by accounts()
    stateDir,
    {} as never, // PushService
    {} as never, // WebAuthnService
    {} as never, // SessionStore
    {} as never, // PluginManager
    {} as never, // McpServerManager
    {} as never, // CodegraphClient
    {} as never, // MemoryWriter
    {} as never, // AccountProvisioner
    {} as never, // CronScheduler
    {} as never, // DesignLoginManager
    {} as never, // DesignConsentGranter
  );
}

describe('GET /api/accounts — badge staleness', () => {
  it('reports an expired "limited" mark as ok (matches what pickActive would actually do)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-badge-'));
    const reg = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'a', configDir: join(dir, 'cfg-a') },
      { name: 'b', configDir: join(dir, 'cfg-b') },
    ]);
    const now = Math.floor(Date.now() / 1000);
    reg.markLimited('a', now - 3600); // expired an hour ago — pickActive would treat this as usable
    reg.markLimited('b', now + 3600); // genuinely still limited

    const result = (await controller(dir).accounts()) as { name: string; state: { kind: string; until?: number } }[];
    const a = result.find((r) => r.name === 'a')!;
    const b = result.find((r) => r.name === 'b')!;
    expect(a.state).toEqual({ kind: 'ok' }); // corrected — was stale 'limited'
    expect(b.state.kind).toBe('limited'); // genuinely still in the future — left as-is
    expect(b.state.until).toBe(now + 3600);
  });

  it('passes through the estimated flag so the panel knows not to show a fabricated reset time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-badge-'));
    const reg = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'a', configDir: join(dir, 'cfg-a') },
      { name: 'b', configDir: join(dir, 'cfg-b') },
    ]);
    const now = Math.floor(Date.now() / 1000);
    reg.markLimited('a', now + 3600); // real Anthropic-reported reset time
    reg.markLimited('b', now + 3600, true); // our own cooldown guess
    const result = (await controller(dir).accounts()) as { name: string; state: { estimated?: boolean } }[];
    expect(result.find((r) => r.name === 'a')!.state.estimated).toBeUndefined();
    expect(result.find((r) => r.name === 'b')!.state.estimated).toBe(true);
  });

  it('returns [] when accounts.json does not exist, without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-badge-'));
    expect(await controller(dir).accounts()).toEqual([]);
  });
});

describe('GET /api/accounts — a signed-out account', () => {
  // A revoked session leaves .credentials.json in place with the two secrets
  // blanked, so nothing in the registry changes and the account keeps whatever
  // badge it had — for one unused for days, a long-expired 'limited'. The panel
  // only offers "Log in again" on 'unauthenticated', so it never appears.
  function withCreds(dir: string, name: string, oauth: unknown): string {
    const cfg = join(dir, `cfg-${name}`);
    mkdirSync(cfg, { recursive: true });
    writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: oauth }));
    return cfg;
  }

  it('reports blank tokens as unauthenticated, overriding a stale limited mark', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-badge-'));
    const now = Math.floor(Date.now() / 1000);
    const reg = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'a', configDir: withCreds(dir, 'a', { accessToken: '', refreshToken: '', expiresAt: 0 }) },
      { name: 'b', configDir: withCreds(dir, 'b', { accessToken: 'live', refreshToken: 'r', expiresAt: now * 1000 }) },
    ]);
    reg.markLimited('a', now - 3600);
    reg.markLimited('b', now + 3600);

    const result = (await controller(dir).accounts()) as { name: string; state: { kind: string } }[];
    expect(result.find((r) => r.name === 'a')!.state.kind).toBe('unauthenticated');
    // A live account is untouched — the check must not swallow a real limit.
    expect(result.find((r) => r.name === 'b')!.state.kind).toBe('limited');
  });

  it('leaves the recorded state alone when the file says nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-badge-'));
    const now = Math.floor(Date.now() / 1000);
    const noFile = join(dir, 'cfg-none');
    mkdirSync(noFile, { recursive: true });
    const reg = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'a', configDir: noFile },
      { name: 'b', configDir: withCreds(dir, 'junk', undefined) },
    ]);
    reg.markLimited('a', now + 3600);
    reg.markLimited('b', now + 3600);
    const result = (await controller(dir).accounts()) as { name: string; state: { kind: string } }[];
    expect(result.map((r) => r.state.kind)).toEqual(['limited', 'limited']);
  });
});
