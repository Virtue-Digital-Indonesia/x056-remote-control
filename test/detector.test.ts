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

  it('flags api_retry with rate_limit as limited (kill-on-first-signal, D3)', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', source: 'api_retry' });
  });

  it('treats api_retry for overloaded as transient (F8)', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' };
    expect(classifyEvent(e)).toEqual({ kind: 'transient', source: 'api_retry' });
  });

  it('flags result with api_error_status 429 as limited', () => {
    const e = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429 };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', source: 'result' });
  });

  it('flags the synthetic transcript limit entry as limited', () => {
    expect(classifyEvent(syntheticLimitEntry)).toEqual({ kind: 'limited', source: 'synthetic_message' });
  });

  it('ignores ordinary events', () => {
    expect(classifyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }).kind).toBe('irrelevant');
    expect(classifyEvent({ type: 'result', subtype: 'success', is_error: false, api_error_status: null }).kind).toBe('irrelevant');
  });
});
