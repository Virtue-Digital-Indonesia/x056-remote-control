export type RawEvent = Record<string, unknown>;

/** Which usage window a limit is: the 5-hour session, the weekly cap, a
 *  per-model cap, or not said. */
export type LimitKind = 'session' | 'weekly' | 'model' | 'unknown';

export interface Verdict {
  kind: 'limited' | 'transient' | 'warning' | 'ok' | 'irrelevant' | 'auth_required' | 'cancelled';
  // An ABSOLUTE reset time (unix seconds) when the provider reports one directly
  // (Anthropic's rate_limit_event does). Prefer this when present.
  resetsAt?: number;
  // A RELATIVE reset ("clears in N seconds") for providers that report that way
  // (Codex's rate_limits). runSession converts it to absolute using its own
  // clock, so the math stays deterministic and consistent with usability checks.
  resetsInSeconds?: number;
  // Set on a `limited` verdict when the event says which window ran out
  // (rateLimitType, or the limit text).
  limitKind?: LimitKind;
  source: string;
}
