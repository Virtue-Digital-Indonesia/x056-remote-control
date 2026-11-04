import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { getAdapter } from '../src/adapters/registry.js';
import { TokenExpiredError } from '../src/quota.js';
import { clearFileMemo, parseFileByStat } from '../src/file-memo.js';
import { clearCodexLiveUsage, noteCodexRateLimits } from '../src/codex-live-usage.js';
import { CodexTransport } from '../src/persistent-codex.js';
import { DeliveryStore } from '../server/workspace-store.js';
import { ApiController, QUOTA_AUTH_BACKOFF_MS, isUsageAuthError } from '../server/api.controller.js';
import { hotCache } from '../server/hot-cache.js';

// GET /api/accounts used to await a usage refresh per account (HTTPS for
// Claude, a spawned `codex app-server` for Codex) on every other poll, with no
// sharing between concurrent calls. These pin the off-path behaviour.

function controller(stateDir: string): ApiController {
  return new ApiController(
    { deliveries: () => new DeliveryStore(stateDir), accountLoads: () => ({}), subscribe: () => () => {} } as never,
    stateDir,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  );
}

const claude = getAdapter('claude');
const codex = getAdapter('codex');
const flush = () => new Promise<void>((r) => setTimeout(r, 20));

function signedIn(dir: string, name: string): string {
  const cfg = join(dir, name); mkdirSync(cfg, { recursive: true });
  writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x', refreshToken: 'y' } }));
  writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { displayName: name, emailAddress: `${name}@example.test` } }));
  return cfg;
}

describe('GET /api/accounts — usage off the request path', () => {
  let claudeSpy: ReturnType<typeof vi.spyOn>;
  let codexSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    hotCache.invalidate('accounts');
    clearCodexLiveUsage();
    // Both providers stubbed: a stale Codex row must never spawn a real codex.
    codexSpy = vi.spyOn(codex, 'fetchUsage' as never).mockImplementation((() => new Promise(() => {})) as never);
  });
  afterEach(() => { vi.restoreAllMocks(); hotCache.invalidate('accounts'); clearCodexLiveUsage(); });

  it('two concurrent calls start at most one refresh per account and neither awaits it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-offpath-'));
    AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'a', configDir: signedIn(dir, 'a') }, { name: 'b', configDir: signedIn(dir, 'b') }]);
    writeFileSync(join(dir, 'quota-cache.json'), JSON.stringify({ a: { at: Date.now() - 10 * 60_000, quota: { fiveHour: { utilization: 10 } } } }));
    claudeSpy = vi.spyOn(claude, 'fetchUsage' as never).mockImplementation((() => new Promise(() => {})) as never); // never resolves
    const c = controller(dir);
    const first = await c.accounts() as { name: string; quotaStale?: boolean; quotaAt?: number; quota: unknown }[];
    hotCache.invalidate('accounts'); // past the 2 s share: exercise the per-account in-flight map
    const second = await c.accounts() as typeof first;
    await flush();
    expect(claudeSpy).toHaveBeenCalledTimes(2); // one per account, not one per call
    expect(first.find((r) => r.name === 'a')).toMatchObject({ quotaStale: true, quota: { fiveHour: { utilization: 10 } } });
    expect(second.find((r) => r.name === 'b')?.quota).toBeNull();
  });

  it('a finished refresh is served on the next call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-offpath-'));
    AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'a', configDir: signedIn(dir, 'a') }]);
    claudeSpy = vi.spyOn(claude, 'fetchUsage' as never).mockResolvedValue({ fiveHour: { utilization: 42 } } as never);
    const c = controller(dir);
    expect(((await c.accounts()) as { quota: unknown }[])[0].quota).toBeNull();
    await flush();
    const row = ((await c.accounts()) as { quota: unknown; quotaStale?: boolean; quotaAt?: number }[])[0];
    expect(row.quota).toEqual({ fiveHour: { utilization: 42 } });
    expect(row.quotaStale).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'quota-cache.json'), 'utf8')).a.quota).toEqual({ fiveHour: { utilization: 42 } });
  });

  it('a signed-out account never calls fetchUsage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-offpath-'));
    const cfg = signedIn(dir, 'a');
    writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '' } }));
    AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'a', configDir: cfg }]);
    claudeSpy = vi.spyOn(claude, 'fetchUsage' as never).mockResolvedValue({} as never);
    const rows = await controller(dir).accounts() as { state: { kind: string } }[];
    await flush();
    expect(rows[0].state.kind).toBe('unauthenticated');
    expect(claudeSpy).not.toHaveBeenCalled();
  });

  it('an auth error backs off 20 minutes, and a re-login ends it early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-offpath-'));
    const cfg = signedIn(dir, 'a');
    AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'a', configDir: cfg }]);
    claudeSpy = vi.spyOn(claude, 'fetchUsage' as never).mockRejectedValue(new TokenExpiredError() as never);
    const c = controller(dir);
    const t0 = Date.now();
    await c.accounts();
    await flush();
    hotCache.invalidate('accounts');
    const row = ((await c.accounts()) as { quotaError?: string; quotaRetryAt?: number }[])[0];
    expect(row.quotaError).toMatch(/expired/);
    expect(row.quotaRetryAt! - t0).toBeGreaterThanOrEqual(QUOTA_AUTH_BACKOFF_MS - 1000);
    expect(row.quotaRetryAt! - t0).toBeLessThan(QUOTA_AUTH_BACKOFF_MS + 5000);
    // 19 minutes later: still backed off.
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0 + 19 * 60_000);
    hotCache.invalidate('accounts');
    await c.accounts(); await flush();
    expect(claudeSpy).toHaveBeenCalledTimes(1);
    // A re-login rewrites the credentials: the backoff ends.
    writeFileSync(join(cfg, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'new-token-longer', refreshToken: 'y' } }));
    hotCache.invalidate('accounts');
    await c.accounts(); await flush();
    expect(claudeSpy).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it('classifies auth errors, but not a probe timeout', () => {
    expect(isUsageAuthError(new TokenExpiredError())).toBe(true);
    expect(isUsageAuthError(new Error('401 Unauthorized'))).toBe(true);
    expect(isUsageAuthError(new Error('no OAuth token in /x/.credentials.json'))).toBe(true);
    expect(isUsageAuthError(new Error('codex app-server timed out (please login again)'))).toBe(false);
    expect(isUsageAuthError(new Error('usage endpoint returned 500'))).toBe(false);
  });

  it('quota-cache.json is read at most once per request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-offpath-'));
    const names = ['a', 'b', 'c', 'd'];
    AccountRegistry.init(join(dir, 'accounts.json'), names.map((n) => ({ name: n, configDir: signedIn(dir, n) })));
    writeFileSync(join(dir, 'quota-cache.json'), JSON.stringify(Object.fromEntries(names.map((n) => [n, { at: Date.now(), quota: { fiveHour: { utilization: 5 } } }]))));
    claudeSpy = vi.spyOn(claude, 'fetchUsage' as never).mockResolvedValue({} as never);
    const reads = vi.spyOn(AccountRegistry.prototype, 'readQuotaReadings');
    await controller(dir).accounts();
    expect(reads.mock.calls.length).toBeLessThanOrEqual(1);
    // And explain() alone reads it once, not once per candidate.
    reads.mockClear();
    AccountRegistry.load(join(dir, 'accounts.json')).explain(Math.floor(Date.now() / 1000), 'claude');
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('a Codex reading pushed by a live app-server is used, so no probe is spawned', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-offpath-'));
    const cfg = join(dir, 'codex-a'); mkdirSync(cfg);
    writeFileSync(join(cfg, 'auth.json'), JSON.stringify({ tokens: { access_token: 'x', refresh_token: 'y' } }));
    AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'a', configDir: signedIn(dir, 'claude-a') }]);
    const reg = AccountRegistry.load(join(dir, 'accounts.json'));
    reg.add('g', cfg, 'codex');
    claudeSpy = vi.spyOn(claude, 'fetchUsage' as never).mockResolvedValue({} as never);
    // Through the real transport: the notification as the app-server sends it.
    const transport = new CodexTransport();
    const st = { ext: {} } as never;
    transport.open(st, { configDir: cfg, cwd: dir, sessionId: 's', mode: 'new' } as never, () => {});
    transport.ingest(st, JSON.stringify({ jsonrpc: '2.0', method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: null } } }));
    const rows = await controller(dir).accounts() as { name: string; quota: { windows?: { utilization: number }[] } | null }[];
    await flush();
    expect(rows.find((r) => r.name === 'g')?.quota?.windows?.[0].utilization).toBeCloseTo(0.37);
    expect(codexSpy).not.toHaveBeenCalled();
    // A model-scoped bucket never overwrites the account's own windows.
    noteCodexRateLimits(cfg, { rateLimits: { limitId: 'some-model', primary: { usedPercent: 99, windowDurationMins: 300 } } });
    hotCache.invalidate('accounts');
    const again = await controller(dir).accounts() as typeof rows;
    expect(again.find((r) => r.name === 'g')?.quota?.windows?.[0].utilization).toBeCloseTo(0.37);
  });
});

describe('parseFileByStat', () => {
  beforeEach(() => clearFileMemo());
  it('does not re-parse an unchanged file, and does once it changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-memo-'));
    const file = join(dir, '.claude.json');
    writeFileSync(file, JSON.stringify({ v: 1 }));
    const parse = vi.fn((t: string) => JSON.parse(t));
    expect(parseFileByStat(file, parse)).toEqual({ v: 1 });
    expect(parseFileByStat(file, parse)).toEqual({ v: 1 });
    expect(parse).toHaveBeenCalledTimes(1);
    writeFileSync(file, JSON.stringify({ v: 22 }));
    const later = statSync(file).mtimeMs / 1000 + 5;
    utimesSync(file, later, later);
    expect(parseFileByStat(file, parse)).toEqual({ v: 22 });
    expect(parse).toHaveBeenCalledTimes(2);
  });

  it('readIdentity is served from the memo while the file is unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-memo-'));
    const cfg = signedIn(dir, 'a');
    const file = join(cfg, '.claude.json');
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(claude.readIdentity(cfg).email).toBe('a@example.test');
    // Same inode, size and mtime, different bytes: proves the second read is the memo.
    writeFileSync(file, readFileSync(file, 'utf8').replace('a@example.test', 'z@example.test'));
    utimesSync(file, 1_700_000_000, 1_700_000_000);
    expect(claude.readIdentity(cfg).email).toBe('a@example.test');
  });
});
