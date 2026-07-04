import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenExpiredError, fetchUsage } from '../src/quota.js';

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
});
