import type { Usage } from './quota.js';

/**
 * Codex usage without a probe.
 *
 * Reading a ChatGPT account's limits means spawning `codex app-server`
 * (`account/rateLimits/read`), and that fork blocks the gateway's main thread
 * for 8-35 ms on top of the 1-2 s round trip. A persistent app-server that is
 * already running a conversation pushes the same snapshot on its own as
 * `account/rateLimits/updated`; the persistent Codex transport hands each one
 * here, keyed by the process's CODEX_HOME, and GET /api/accounts folds the
 * newest into its quota cache instead of probing.
 *
 * The notification's payload is taken to be `{rateLimits: <snapshot>}`, the
 * same snapshot `account/rateLimits/read` answers with (the v2 schema names
 * one type for both); a bare snapshot is accepted too. Not yet checked
 * against a live notification. A snapshot for a model-scoped bucket
 * (`limitId` other than the account's own `codex`) is ignored, so it can never
 * overwrite the account's main windows.
 */

const asObj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

function windowLabel(mins: unknown): string {
  const m = typeof mins === 'number' ? mins : 0;
  if (m === 300) return '5-hour';
  if (m === 10080) return '7-day';
  if (m > 0 && m % 1440 === 0) return `${m / 1440}-day`;
  if (m > 0) return `${Math.round(m / 60)}-hour`;
  return 'usage';
}

/** `{rateLimits:{primary, secondary, credits, ...}}` (or the bare snapshot) ->
 *  Usage. null when there is no usable window. Shared with the probe. */
export function codexUsageFromRateLimits(payload: unknown): Usage | null {
  const p = asObj(payload);
  const rl = 'rateLimits' in p ? asObj(p.rateLimits) : p;
  const windows: NonNullable<Usage['windows']> = [];
  for (const key of ['primary', 'secondary']) {
    const w = asObj(rl[key]);
    if (typeof w.usedPercent !== 'number') continue;
    windows.push({
      label: windowLabel(w.windowDurationMins),
      utilization: w.usedPercent / 100,
      resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : undefined,
    });
  }
  if (!windows.length) return null;
  // `credits` sits beside the windows: {hasCredits, unlimited, balance}. With
  // credits the backend keeps serving after the window is used up, so the
  // gateway must know whether that is on offer before it calls the account
  // exhausted. `spendControlReached` means an admin cap stops it regardless.
  const c = asObj(rl.credits);
  const credits = 'hasCredits' in c
    ? { available: c.hasCredits === true && rl.spendControlReached !== true, unlimited: c.unlimited === true, balance: typeof c.balance === 'number' ? c.balance : null }
    : undefined;
  const limitReachedType = typeof rl.rateLimitReachedType === 'string' ? rl.rateLimitReachedType : null;
  return { windows, ...(credits ? { credits } : {}), limitReachedType };
}

interface LiveReading { at: number; usage: Usage }
const readings = new Map<string, LiveReading>();
const lastOutput = new Map<string, number>();

/** Any line from a live app-server of this home: the process is alive. */
export function noteCodexOutput(configDir: string | undefined, now = Date.now()): void {
  if (configDir) lastOutput.set(configDir, now);
}

/** An `account/rateLimits/updated` payload from a live app-server. */
export function noteCodexRateLimits(configDir: string | undefined, payload: unknown, now = Date.now()): void {
  if (!configDir) return;
  const p = asObj(payload);
  const rl = 'rateLimits' in p ? asObj(p.rateLimits) : p;
  if (typeof rl.limitId === 'string' && rl.limitId && rl.limitId !== 'codex') return;
  const usage = codexUsageFromRateLimits(payload);
  if (!usage) return;
  // An update that says nothing about credits keeps what the last reading
  // knew: dropping it would flip creditsCover() and with it the routing.
  const prev = readings.get(configDir)?.usage;
  if (!usage.credits && prev?.credits) usage.credits = prev.credits;
  readings.set(configDir, { at: now, usage });
  lastOutput.set(configDir, now);
}

/** The newest pushed reading for this home, if any. */
export function liveCodexUsage(configDir: string): LiveReading | undefined {
  return readings.get(configDir);
}

/** Has an app-server of this home written anything within `windowMs`? */
export function codexProcessLive(configDir: string, now = Date.now(), windowMs = 5 * 60_000): boolean {
  const at = lastOutput.get(configDir);
  return at !== undefined && now - at < windowMs;
}

/** Tests only. */
export function clearCodexLiveUsage(): void { readings.clear(); lastOutput.clear(); }
