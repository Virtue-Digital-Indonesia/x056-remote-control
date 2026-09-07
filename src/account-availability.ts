import type { ProviderId } from './provider.js';

export interface QuotaReading { at: number; quota: unknown }

/** Only account-wide windows restrict the entire routing pool. Model-specific
 * Claude caps remain visible in the dashboard without blocking other models. */
export function quotaLimit(provider: ProviderId, reading: QuotaReading | undefined, now: number): { kind: 'limited'; until: number; estimated?: boolean } | null {
  if (!reading || !Number.isFinite(reading.at) || !reading.quota || typeof reading.quota !== 'object') return null;
  const q = reading.quota as Record<string, unknown>;
  const windows = provider === 'codex' ? (Array.isArray(q.windows) ? q.windows : []) : [q.fiveHour, q.sevenDay];
  const limits: { until: number; estimated?: boolean }[] = [];
  for (const value of windows) {
    if (!value || typeof value !== 'object') continue;
    const w = value as Record<string, unknown>;
    if (typeof w.utilization !== 'number' || !Number.isFinite(w.utilization) || w.utilization < (provider === 'codex' ? 1 : 100)) continue;
    const reset = typeof w.resetsAt === 'number' ? w.resetsAt : typeof w.resetsAt === 'string' ? Date.parse(w.resetsAt) / 1000 : NaN;
    // Without a reset, only a fresh reading blocks routing. Never turn a cached
    // reading into an indefinite lockout, or invent a provider reset time.
    const until = Number.isFinite(reset) ? reset : reading.at / 1000 + 300;
    if (until > now) limits.push({ until, ...(!Number.isFinite(reset) ? { estimated: true } : {}) });
  }
  limits.sort((a,b) => b.until-a.until);
  return limits.length ? { kind: 'limited', ...limits[0] } : null;
}
