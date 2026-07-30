import type { RawEvent, Verdict } from './types.js';

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
}

/** "API Error: 529 Overloaded", "API Error: 503 …" — server-side, retryable. */
const OVERLOAD_RE = /API Error:\s*5\d\d\b|\boverloaded\b/i;

/** Text of a synthetic error message the CLI records in place of a reply. */
function assistantErrorText(e: RawEvent): string {
  const msg = e.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join(' ');
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
  // A 5xx from the API (529 Overloaded, 503, 500) is Anthropic being busy, NOT
  // this account being out of quota: switching accounts hits the same servers, so
  // the right move is to wait and retry the same one (runSession does that).
  if (typeof e.api_error_status === 'number' && e.api_error_status >= 500) {
    return { kind: 'transient', source: 'api_overloaded' };
  }
  // The CLI also reports it as a synthetic assistant message and then exits
  // non-zero — which is how it actually reached us in the wild ("API Error: 529
  // Overloaded. This is a server-side issue…"), with no result event to inspect.
  if (e.type === 'assistant' && e.isApiErrorMessage === true && OVERLOAD_RE.test(assistantErrorText(e))) {
    return { kind: 'transient', source: 'api_overloaded' };
  }
  if (e.error === 'rate_limit') return { kind: 'limited', source: 'synthetic_message' };
  // The CLI's own synthetic response when the account's stored OAuth session is
  // missing/expired/revoked: an assistant message with this exact `error` field
  // and no real model involved (message.model: '<synthetic>'), text "Not logged
  // in · Please run /login". No reset time applies — a human has to re-auth.
  if (e.error === 'authentication_failed') return { kind: 'auth_required', source: 'synthetic_message' };
  return { kind: 'irrelevant', source: 'none' };
}
