import { mkdtempSync } from 'node:fs';
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
