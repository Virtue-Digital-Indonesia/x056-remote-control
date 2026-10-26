import { describe, expect, it } from 'vitest';
import { classifyCodexEvent } from '../src/adapters/codex.js';
import { classifyEvent, parseLimitReset } from '../src/detector.js';

const at = (iso: string) => Date.parse(iso) / 1000;
const MSG = Math.floor(at('2026-10-26T05:31:30.999Z'));
const until = (text: string, when = MSG) => parseLimitReset(text, when)?.until;

describe('parseLimitReset: formats', () => {
  it('a time with am/pm in an explicit UTC zone', () => {
    expect(until('resets 8:30am (UTC)')).toBe(at('2026-10-26T08:30:00Z'));
  });
  it('an hour in an IANA zone (Asia/Jakarta, UTC+7)', () => {
    expect(until('resets 3pm (Asia/Jakarta)')).toBe(at('2026-10-26T08:00:00Z'));
  });
  it('a 24-hour time with no zone is UTC', () => {
    expect(until('resets 15:10')).toBe(at('2026-10-26T15:10:00Z'));
  });
  it('a month and day with a time, in a zone', () => {
    expect(until('resets Oct 30, 9am (Asia/Jakarta)')).toBe(at('2026-10-30T02:00:00Z'));
  });
  it('a month and day "at" a time', () => {
    expect(until('resets Oct 30 at 9:30am')).toBe(at('2026-10-30T09:30:00Z'));
  });
  it('a full month name', () => {
    expect(until('resets October 30, 9am')).toBe(at('2026-10-30T09:00:00Z'));
  });
  it('relative hours, from the message time', () => {
    expect(until('resets in 3 hours')).toBe(MSG + 3 * 3600);
  });
  it('relative minutes', () => {
    expect(until('resets in 45 minutes')).toBe(MSG + 45 * 60);
  });
  it('relative compact h and m', () => {
    expect(until('resets in 2h 10m')).toBe(MSG + 2 * 3600 + 10 * 60);
  });
  it('ISO 8601, with Z or an offset', () => {
    expect(until('resets 2026-10-30T09:00:00Z')).toBe(at('2026-10-30T09:00:00Z'));
    expect(until('resets 2026-10-30T09:00:00+07:00')).toBe(at('2026-10-30T02:00:00Z'));
  });
  it('12am is midnight and 12pm is noon', () => {
    expect(until('resets 12am')).toBe(at('2026-10-27T00:00:00Z'));
    expect(until('resets 12pm')).toBe(at('2026-10-26T12:00:00Z'));
  });
  it("Codex's \"try again at\" wording", () => {
    expect(until("You've hit your usage limit. Try again at Oct 30th, 2026 9:00 AM.")).toBe(at('2026-10-30T09:00:00Z'));
    expect(until("You've hit your usage limit. Try again in 1 day 2 hours.")).toBe(MSG + 86400 + 7200);
  });
});

describe('parseLimitReset: resolution', () => {
  it('a year-less date rolls into the next year across a year end', () => {
    const dec31 = at('2026-12-31T10:00:00Z');
    expect(parseLimitReset("You've hit your weekly limit · resets Jan 2, 9am", dec31)).toEqual({ until: at('2027-01-02T09:00:00Z'), kind: 'weekly' });
  });
  it('a year-less date up to a day before the message stays in its year', () => {
    expect(until('resets Oct 25, 9am', at('2026-10-26T05:00:00Z'))).toBe(at('2026-10-25T09:00:00Z'));
  });
  it('a past reset stays in the past: it is resolved from the message, never from now', () => {
    // Message 05:31Z, read at 09:00Z: still 08:30Z the same day, already past,
    // so the caller acts at once. Rolling it to tomorrow is the bug.
    const r = parseLimitReset("You've hit your session limit · resets 8:30am (UTC)", MSG);
    expect(r).toEqual({ until: at('2026-10-26T08:30:00Z'), kind: 'session' });
    expect(r!.until).toBeLessThan(at('2026-10-26T09:00:00Z'));
  });
  it('a time earlier in the day than the message rolls to the next day', () => {
    expect(until('resets 5am (UTC)')).toBe(at('2026-10-27T05:00:00Z'));
  });
  it('a time-only reset in a negative-offset zone uses that zone\'s own calendar day', () => {
    // 05:31Z is 22:31 the evening before in Los Angeles (PDT, UTC-7).
    expect(until('resets 11pm (America/Los_Angeles)')).toBe(at('2026-10-26T06:00:00Z'));
    expect(until('resets 4pm (America/Los_Angeles)')).toBe(at('2026-10-26T23:00:00Z'));
  });
  it('an unknown zone falls back to UTC', () => {
    expect(until('resets 9am (Mars/Olympus_Mons)')).toBe(at('2026-10-26T09:00:00Z'));
  });
  it('anything unreadable is null', () => {
    expect(parseLimitReset("You've hit your session limit", MSG)).toBeNull();
    expect(parseLimitReset('resets soon', MSG)).toBeNull();
    expect(parseLimitReset('resets 25:00', MSG)).toBeNull();
    expect(parseLimitReset('resets Foo 30, 9am', MSG)).toBeNull();
    expect(parseLimitReset('', MSG)).toBeNull();
  });
});

describe('parseLimitReset: kinds', () => {
  const kind = (text: string) => parseLimitReset(text, MSG)?.kind;
  it('session', () => expect(kind("You've hit your session limit · resets 8:30am (UTC)")).toBe('session'));
  it('session, as the 5-hour window', () => expect(kind('5-hour limit reached · resets 3pm')).toBe('session'));
  it('weekly', () => expect(kind("You've hit your weekly limit · resets Oct 30, 9am (Asia/Jakarta)")).toBe('weekly'));
  it('model', () => expect(kind("You've hit your Opus limit · resets 3pm")).toBe('model'));
  it('unknown', () => expect(kind("You've hit your limit · resets 3pm")).toBe('unknown'));
});

describe('classifyEvent: the real synthetic limit entries', () => {
  // T2: e3c3f8d4 line 20050, trimmed to the fields the code reads.
  const T2 = {
    type: 'assistant', timestamp: '2026-10-26T05:31:30.999Z',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 8:30am (UTC)" }] },
    apiError: 'usage_limit_reached',
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1793003400, rateLimitType: 'five_hour' } },
    quotaLimits: { status: 'rejected', resetsAt: 1793003400, rateLimitType: 'five_hour' },
    error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
  };
  // T1: 92356202 line 20447, the main thread's own 429.
  const T1 = {
    ...T2, timestamp: '2026-10-26T13:18:44.023Z',
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 3:10pm (UTC)" }] },
    apiErrorParams: { rate_limit_info: { status: 'rejected', resetsAt: 1793027400, rateLimitType: 'five_hour' } },
    quotaLimits: { status: 'rejected', resetsAt: 1793027400, rateLimitType: 'five_hour' },
  };

  it('T2 is limited until 08:30Z, kind session', () => {
    expect(classifyEvent(T2)).toEqual({ kind: 'limited', resetsAt: at('2026-10-26T08:30:00Z'), limitKind: 'session', source: 'synthetic_message' });
  });
  it('T1 is limited until 15:10Z, kind session', () => {
    expect(classifyEvent(T1)).toEqual({ kind: 'limited', resetsAt: at('2026-10-26T15:10:00Z'), limitKind: 'session', source: 'synthetic_message' });
  });
  it('the text alone (no structured fields, as the stream may carry it) gives the same reset', () => {
    const { apiErrorParams: _p, quotaLimits: _q, ...bare } = T2;
    expect(classifyEvent(bare)).toEqual({ kind: 'limited', resetsAt: at('2026-10-26T08:30:00Z'), limitKind: 'session', source: 'synthetic_message' });
  });
  it('a structured reset earlier than the text one loses to it (the later-of-two guess)', () => {
    const weekly = { ...T2, message: { ...T2.message, content: [{ type: 'text', text: "You've hit your weekly limit · resets Oct 30, 9am (Asia/Jakarta)" }] } };
    expect(classifyEvent(weekly)).toMatchObject({ kind: 'limited', resetsAt: at('2026-10-30T02:00:00Z') });
  });
  it('a 429 result reads its reset from the result text', () => {
    const e = { type: 'result', is_error: true, api_error_status: 429, timestamp: '2026-10-26T05:31:31Z', result: "You've hit your weekly limit · resets Oct 30, 9am (Asia/Jakarta)" };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', resetsAt: at('2026-10-30T02:00:00Z'), limitKind: 'weekly', source: 'result' });
  });
});

describe('classifyCodexEvent: text reset only as a fallback', () => {
  const failed = (message: string, rate_limits?: Record<string, unknown>) => ({ type: 'turn.failed', error: { code: 'usage_limit_exceeded', message }, ...(rate_limits ? { rate_limits: { primary: rate_limits } } : {}) });
  it('keeps the structured resets_at', () => {
    expect(classifyCodexEvent(failed('Try again at Oct 30th, 2026 9:00 AM.', { resets_at: 1793003400 })).resetsAt).toBe(1793003400);
  });
  it('keeps the structured resets_in_seconds and adds no text reset', () => {
    const v = classifyCodexEvent(failed('Try again at Oct 30th, 2026 9:00 AM.', { resets_in_seconds: 600 }));
    expect(v).toMatchObject({ kind: 'limited', resetsInSeconds: 600 });
    expect(v.resetsAt).toBeUndefined();
  });
  it('reads the error text when nothing structured is there', () => {
    expect(classifyCodexEvent(failed("You've hit your usage limit. Try again at Oct 30th, 2026 9:00 AM.")).resetsAt).toBe(at('2026-10-30T09:00:00Z'));
  });
});
