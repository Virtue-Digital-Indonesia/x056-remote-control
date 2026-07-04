import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowUsage {
  utilization: number;
  resetsAt: string;
}

export interface Usage {
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
}

export class TokenExpiredError extends Error {
  constructor() {
    super('OAuth access token expired (401 from usage endpoint)');
  }
}

interface UsageBody {
  five_hour: { utilization: number; resets_at: string };
  seven_day: { utilization: number; resets_at: string };
}

export async function fetchUsage(configDir: string, fetchFn: typeof fetch = fetch): Promise<Usage> {
  let creds: { claudeAiOauth?: { accessToken?: string } };
  try {
    creds = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: string };
    };
  } catch {
    // Never leak file contents or parse-error snippets (they may contain the token itself).
    throw new Error(`credentials unreadable in ${configDir}`);
  }
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) throw new Error(`no OAuth token in ${configDir}/.credentials.json`);

  const res = await fetchFn('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 401) throw new TokenExpiredError();
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  const body = (await res.json()) as UsageBody;
  return {
    fiveHour: { utilization: body.five_hour.utilization, resetsAt: body.five_hour.resets_at },
    sevenDay: { utilization: body.seven_day.utilization, resetsAt: body.seven_day.resets_at },
  };
}
