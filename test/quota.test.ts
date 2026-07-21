import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenExpiredError, UsageRateLimitedError, fetchUsage } from '../src/quota.js';

function configDirWithToken(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'x056-cfg-'));
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return dir;
}

const usageBody = {
  five_hour: { utilization: 62.0, resets_at: '2026-07-04T12:59:59.677980+00:00' },
  seven_day: { utilization: 48.0, resets_at: '2026-07-07T21:00:00.678002+00:00' },
};

describe('fetchUsage', () => {
  it('calls the oauth usage endpoint with the bearer token and maps windows', async () => {
    const dir = configDirWithToken('tok-123');
    let seenUrl = '';
    let seenAuth = '';
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(usageBody), { status: 200 });
    }) as typeof fetch;

    const usage = await fetchUsage(dir, fakeFetch);
    expect(seenUrl).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(seenAuth).toBe('Bearer tok-123');
    expect(usage).toEqual({
      fiveHour: { utilization: 62.0, resetsAt: '2026-07-04T12:59:59.677980+00:00' },
      sevenDay: { utilization: 48.0, resetsAt: '2026-07-07T21:00:00.678002+00:00' },
    });
  });

  it('surfaces model-scoped weekly caps (Fable) from the limits[] array', async () => {
    const dir = configDirWithToken('tok');
    // The real endpoint shape (captured live): scoped weekly caps live ONLY in
    // limits[], labelled by scope.model.display_name; seven_day is all-models.
    const body = {
      five_hour: { utilization: 35, resets_at: '2026-07-21T08:40:00+00:00' },
      seven_day: { utilization: 11, resets_at: '2026-07-24T18:00:00+00:00' },
      limits: [
        { kind: 'session', percent: 35, resets_at: '2026-07-21T08:40:00+00:00', scope: null },
        { kind: 'weekly_all', percent: 11, resets_at: '2026-07-24T18:00:00+00:00', scope: null },
        { kind: 'weekly_scoped', percent: 9, resets_at: '2026-07-24T18:00:00+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
      ],
    };
    const fakeFetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const usage = await fetchUsage(dir, fakeFetch);
    expect(usage.weeklyScoped).toEqual([
      { label: 'Fable', utilization: 9, resetsAt: '2026-07-24T18:00:00+00:00' },
    ]);
    // The fixed windows are unchanged by the scoped parsing.
    expect(usage.fiveHour).toEqual({ utilization: 35, resetsAt: '2026-07-21T08:40:00+00:00' });
    expect(usage.sevenDay).toEqual({ utilization: 11, resetsAt: '2026-07-24T18:00:00+00:00' });
  });

  it('omits weeklyScoped entirely when the plan has no model-scoped caps', async () => {
    const dir = configDirWithToken('tok');
    // A limits[] with only session + weekly_all (no scoped model) → no field.
    const body = {
      five_hour: { utilization: 5, resets_at: 'a' },
      seven_day: { utilization: 2, resets_at: 'b' },
      limits: [{ kind: 'session', percent: 5, scope: null }, { kind: 'weekly_all', percent: 2, scope: null }],
    };
    const fakeFetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const usage = await fetchUsage(dir, fakeFetch);
    expect('weeklyScoped' in usage).toBe(false);
  });

  it('throws TokenExpiredError on 401', async () => {
    const dir = configDirWithToken('stale');
    const fakeFetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    await expect(fetchUsage(dir, fakeFetch)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('throws a plain error on other failures, without the token in the message', async () => {
    const dir = configDirWithToken('sekret');
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(fetchUsage(dir, fakeFetch)).rejects.toThrow(/500/);
    await expect(fetchUsage(dir, fakeFetch)).rejects.not.toThrow(/sekret/);
  });

  it('throws UsageRateLimitedError with clamped retryAfterMs from the retry-after header on 429', async () => {
    const dir = configDirWithToken('tok');
    const fakeFetch = (async () =>
      new Response('rate limited', { status: 429, headers: { 'retry-after': '3155' } })) as typeof fetch;
    const err = await fetchUsage(dir, fakeFetch).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageRateLimitedError);
    expect((err as UsageRateLimitedError).retryAfterMs).toBe(3155 * 1000);
  });

  it('defaults the backoff to 5 minutes when retry-after is missing or garbled', async () => {
    const dir = configDirWithToken('tok');
    const fakeFetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    const err = await fetchUsage(dir, fakeFetch).catch((e: unknown) => e);
    expect((err as UsageRateLimitedError).retryAfterMs).toBe(300_000);
  });

  it('wraps an unreadable credentials file (nonexistent config dir) in a generic error (Finding 7)', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'x056-cfg-'));
    const dir = join(parent, 'does-not-exist');
    await expect(fetchUsage(dir)).rejects.toThrow(/credentials unreadable/);
  });

  it('wraps malformed credentials JSON in a generic error, never leaking file contents (Finding 7)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-cfg-'));
    const fakeToken = 'sk-ant-definitely-a-fake-secret-token';
    writeFileSync(join(dir, '.credentials.json'), `{ this is not json, ${fakeToken}`);
    await expect(fetchUsage(dir)).rejects.toThrow(/credentials unreadable/);
    await expect(fetchUsage(dir)).rejects.not.toThrow(fakeToken);
  });
});
