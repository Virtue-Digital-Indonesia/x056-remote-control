import type { RawEvent, Verdict } from './types.js';

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
}

export function classifyEvent(e: RawEvent): Verdict {
  if (e.type === 'rate_limit_event') {
    const info = (e.rate_limit_info ?? {}) as RateLimitInfo;
    if (info.status === 'rejected') return { kind: 'limited', resetsAt: info.resetsAt, source: 'rate_limit_event' };
    if (info.status === 'allowed_warning') return { kind: 'warning', resetsAt: info.resetsAt, source: 'rate_limit_event' };
    return { kind: 'ok', source: 'rate_limit_event' };
  }
  if (e.type === 'system' && e.subtype === 'api_retry') {
    // D6: only a rate_limit error should bench the account for hours — a transient
    // non-quota 429 (or any other error) must not trigger the 5h cooldown.
    if (e.error === 'rate_limit') return { kind: 'limited', source: 'api_retry' };
    return { kind: 'transient', source: 'api_retry' };
  }
  if (e.type === 'result' && e.api_error_status === 429) return { kind: 'limited', source: 'result' };
  if (e.error === 'rate_limit') return { kind: 'limited', source: 'synthetic_message' };
  return { kind: 'irrelevant', source: 'none' };
}
