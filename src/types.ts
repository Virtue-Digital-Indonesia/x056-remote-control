export type RawEvent = Record<string, unknown>;

export interface Verdict {
  kind: 'limited' | 'transient' | 'warning' | 'ok' | 'irrelevant' | 'auth_required';
  // An ABSOLUTE reset time (unix seconds) when the provider reports one directly
  // (Anthropic's rate_limit_event does). Prefer this when present.
  resetsAt?: number;
  // A RELATIVE reset ("clears in N seconds") for providers that report that way
  // (Codex's rate_limits). runSession converts it to absolute using its own
  // clock, so the math stays deterministic and consistent with usability checks.
  resetsInSeconds?: number;
  source: string;
}
