export type RawEvent = Record<string, unknown>;

export interface Verdict {
  kind: 'limited' | 'transient' | 'warning' | 'ok' | 'irrelevant' | 'auth_required';
  resetsAt?: number; // unix seconds when known
  source: string;
}
