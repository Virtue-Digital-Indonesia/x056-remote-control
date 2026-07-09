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
    // A 429 the CLI is retrying is transient, NOT quota exhaustion. Real quota
    // limits surface as a rate_limit_event with status 'rejected' (carrying
    // resetsAt) or a synthetic transcript entry — both handled below. Treating
    // every retried 429 as 'limited' benched accounts that still had quota when
    // a large-context turn tripped a short burst/RPM limit mid-compaction.
    return { kind: 'transient', source: 'api_retry' };
  }
  if (e.type === 'result' && e.api_error_status === 429) return { kind: 'limited', source: 'result' };
  if (e.error === 'rate_limit') return { kind: 'limited', source: 'synthetic_message' };
  // The CLI's own synthetic response when the account's stored OAuth session is
  // missing/expired/revoked: an assistant message with this exact `error` field
  // and no real model involved (message.model: '<synthetic>'), text "Not logged
  // in · Please run /login". No reset time applies — a human has to re-auth.
  if (e.error === 'authentication_failed') return { kind: 'auth_required', source: 'synthetic_message' };
  return { kind: 'irrelevant', source: 'none' };
}
