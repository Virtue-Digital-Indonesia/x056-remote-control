import { describe, expect, it } from 'vitest';
import { classifyEvent } from '../src/detector.js';

const rateLimitAllowed = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1783170000, rateLimitType: 'five_hour',
    overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false,
  },
};

const syntheticLimitEntry = {
  parentUuid: 'bdceb5bc', type: 'assistant',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 8:20pm (Asia/Jakarta)" }] },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
};

// Captured verbatim from a real `claude -p` run under a config dir with no valid
// OAuth session: the CLI never touches the network — it emits this synthetic
// assistant turn, then a result event carrying the same text with is_error: true.
const notLoggedInEntry = {
  type: 'assistant',
  message: {
    model: '<synthetic>', role: 'assistant',
    content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
  },
  error: 'authentication_failed',
};

describe('classifyEvent', () => {
  it('passes through an allowed rate_limit_event as ok', () => {
    expect(classifyEvent(rateLimitAllowed)).toEqual({ kind: 'ok', source: 'rate_limit_event' });
  });

  it('flags rejected rate_limit_event as limited with resetsAt', () => {
    const e = { ...rateLimitAllowed, rate_limit_info: { ...rateLimitAllowed.rate_limit_info, status: 'rejected' } };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', resetsAt: 1783170000, source: 'rate_limit_event' });
  });

  it('flags allowed_warning as warning', () => {
    const e = { ...rateLimitAllowed, rate_limit_info: { ...rateLimitAllowed.rate_limit_info, status: 'allowed_warning' } };
    expect(classifyEvent(e)).toEqual({ kind: 'warning', resetsAt: 1783170000, source: 'rate_limit_event' });
  });

  it('treats api_retry with rate_limit as transient — a retried 429 is a burst, not quota exhaustion', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' };
    expect(classifyEvent(e)).toEqual({ kind: 'transient', source: 'api_retry' });
  });

  it('treats api_retry for overloaded as transient (F8)', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' };
    expect(classifyEvent(e)).toEqual({ kind: 'transient', source: 'api_retry' });
  });

  it('treats a non-quota api_retry with a 429 status as transient, not limited (D6, Finding 2)', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'some_other_error' };
    expect(classifyEvent(e)).toEqual({ kind: 'transient', source: 'api_retry' });
  });

  it('flags result with api_error_status 429 as limited', () => {
    const e = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429 };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', source: 'result' });
  });

  it('flags the synthetic transcript limit entry as limited', () => {
    expect(classifyEvent(syntheticLimitEntry)).toEqual({ kind: 'limited', source: 'synthetic_message' });
  });

  it('flags the "Not logged in" synthetic entry as auth_required (real CLI capture)', () => {
    expect(classifyEvent(notLoggedInEntry)).toEqual({ kind: 'auth_required', source: 'synthetic_message' });
  });

  it('ignores ordinary events', () => {
    expect(classifyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }).kind).toBe('irrelevant');
    expect(classifyEvent({ type: 'result', subtype: 'success', is_error: false, api_error_status: null }).kind).toBe('irrelevant');
  });
});

describe('transient API 5xx (server overloaded)', () => {
  // Real capture: the CLI records "API Error: 529 Overloaded. This is a
  // server-side issue…" as a synthetic assistant message and exits 1. It is NOT
  // a quota limit — switching accounts hits the same servers.
  it('classifies the synthetic 529 assistant message as transient, not limited', () => {
    const v = classifyEvent({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.' }] },
    } as never);
    expect(v).toEqual({ kind: 'transient', source: 'api_overloaded' });
  });

  it('classifies a result event with a 5xx api_error_status as transient', () => {
    expect(classifyEvent({ type: 'result', api_error_status: 529 } as never)).toEqual({ kind: 'transient', source: 'api_overloaded' });
    expect(classifyEvent({ type: 'result', api_error_status: 503 } as never)).toEqual({ kind: 'transient', source: 'api_overloaded' });
  });

  it('still treats a 429 as a real limit (not swallowed by the 5xx rule)', () => {
    expect(classifyEvent({ type: 'result', api_error_status: 429 } as never)).toEqual({ kind: 'limited', source: 'result' });
  });

  it('ignores an ordinary assistant message that merely mentions overload', () => {
    const v = classifyEvent({
      type: 'assistant',
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: 'the server was overloaded earlier, retrying the deploy' }] },
    } as never);
    expect(v.kind).toBe('irrelevant');
  });
});
