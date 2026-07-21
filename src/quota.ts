import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowUsage {
  utilization: number;
  resetsAt: string;
}

export interface Usage {
  fiveHour?: WindowUsage;
  sevenDay?: WindowUsage;
  /** Model-scoped weekly limits, distinct from the all-models 7-day window —
   *  e.g. a "Fable" cap that Max plans meter separately (the usage endpoint's
   *  `limits[]` entries of kind `weekly_scoped`, labelled by the scoped model's
   *  display name). One entry per scoped model; empty/absent when the plan has
   *  none. Rendered as extra gauges beside 5-hour/7-day. */
  weeklyScoped?: { label: string; utilization: number; resetsAt?: string }[];
  /** Provider-shaped usage windows, for providers whose plans don't have
   *  Claude's fixed 5-hour + 7-day pair (a Codex team plan has a single
   *  weekly window). When present the panel renders THESE gauges; fiveHour/
   *  sevenDay stay for Claude (and for old panels during a deploy overlap). */
  windows?: { label: string; utilization: number; resetsAt?: string }[];
}

export class TokenExpiredError extends Error {
  constructor() {
    super('OAuth access token expired (401 from usage endpoint)');
  }
}

export class UsageRateLimitedError extends Error {
  /** How long the caller must back off before touching the endpoint again. */
  readonly retryAfterMs: number;
  constructor(retryAfterSeconds: number) {
    super('usage endpoint rate-limited upstream');
    // Clamp: never below 1 min, never above 1 h, default 5 min when absent/garbled.
    const secs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds : 300;
    this.retryAfterMs = Math.min(Math.max(secs, 60), 3600) * 1000;
  }
}

interface UsageBody {
  five_hour: { utilization: number; resets_at: string };
  seven_day: { utilization: number; resets_at: string };
  /** Modern, structured limits list. Carries the same session/weekly-all data
   *  as the two fields above PLUS model-scoped weekly caps (the Fable window),
   *  which have no dedicated top-level field. Absent on older plan shapes. */
  limits?: {
    kind: string;
    percent: number;
    resets_at?: string;
    scope?: { model?: { id?: string | null; display_name?: string | null } | null } | null;
  }[];
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
  if (res.status === 429) throw new UsageRateLimitedError(Number(res.headers.get('retry-after')));
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  const body = (await res.json()) as UsageBody;
  // Model-scoped weekly caps (e.g. Fable) live only in the structured `limits[]`
  // — the top-level seven_day is the ALL-models window. Each scoped entry is
  // labelled by its model's display name; utilization is a 0–100 percent, the
  // same convention as five_hour/seven_day.
  const weeklyScoped = (body.limits ?? [])
    .filter((l) => l.kind === 'weekly_scoped' && l.scope?.model?.display_name)
    .map((l) => ({ label: l.scope!.model!.display_name as string, utilization: l.percent, resetsAt: l.resets_at }));
  return {
    fiveHour: { utilization: body.five_hour.utilization, resetsAt: body.five_hour.resets_at },
    sevenDay: { utilization: body.seven_day.utilization, resetsAt: body.seven_day.resets_at },
    ...(weeklyScoped.length ? { weeklyScoped } : {}),
  };
}
