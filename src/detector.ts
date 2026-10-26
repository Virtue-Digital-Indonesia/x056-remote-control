import type { LimitKind, RawEvent, Verdict } from './types.js';

export type { LimitKind } from './types.js';

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
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

/** Which window a limit text names (contract R1). */
export function limitKindOfText(text: string): LimitKind {
  if (/weekly/i.test(text)) return 'weekly';
  if (/session|5-hour|five-hour/i.test(text)) return 'session';
  if (/(opus|sonnet|fable|haiku)[^·]*limit/i.test(text)) return 'model';
  return 'unknown';
}

/** The API's `rateLimitType` (five_hour, seven_day, seven_day_opus, ...). */
export function limitKindOfType(type: unknown): LimitKind | undefined {
  if (typeof type !== 'string' || !type) return undefined;
  if (/opus|sonnet|fable|haiku/i.test(type)) return 'model';
  if (/five_hour|session/i.test(type)) return 'session';
  if (/seven_day|week/i.test(type)) return 'weekly';
  return 'unknown';
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zoneFormat(zone: string): Intl.DateTimeFormat | undefined {
  let f = fmtCache.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch { return undefined; }
    fmtCache.set(zone, f);
  }
  return f;
}
/** Wall-clock fields of an instant in a zone. */
function wallParts(sec: number, f: Intl.DateTimeFormat): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(sec * 1000))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
/** Epoch seconds of a wall time in a zone. Day/month overflow normalises like
 *  Date.UTC; the second pass settles a guess that crossed a DST change. */
function zonedEpoch(y: number, mo: number, d: number, h: number, mi: number, f: Intl.DateTimeFormat): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi) / 1000;
  const offsetAt = (t: number) => { const w = wallParts(t, f); return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s) / 1000 - t; };
  let t = guess - offsetAt(guess);
  t = guess - offsetAt(t);
  return Math.floor(t);
}

const TIME = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m?\.?\b`;
const TIME24 = String.raw`(\d{1,2}):(\d{2})\b`;
const UNIT_SECS: Record<string, number> = { d: 86400, h: 3600, m: 60, s: 1 };

function clockOf(m: RegExpMatchArray | null, i: number): { h: number; mi: number } | null {
  if (!m) return null;
  let h = Number(m[i]);
  const mi = m[i + 1] ? Number(m[i + 1]) : 0;
  const ap = m[i + 2]?.toLowerCase();
  if (ap) { if (h < 1 || h > 12) return null; h = (h % 12) + (ap === 'p' ? 12 : 0); }
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/**
 * The reset time a usage-limit text names, in epoch seconds, plus which window
 * it is (contract R1). `at` is the epoch seconds of the MESSAGE, and every
 * roll-forward is relative to it, never to now: a reset that is already past by
 * the time a caller acts means "act at once", not "tomorrow". The zone is the
 * trailing `(IANA zone)`, UTC by default or when unknown. Null when no reset
 * can be read.
 */
export function parseLimitReset(text: string, at: number): { until: number; kind: LimitKind } | null {
  if (typeof text !== 'string' || !Number.isFinite(at)) return null;
  const kind = limitKindOfText(text);
  // "resets …" is the CLI's wording; "try again at/in …" is Codex's.
  const head = /\b(?:resets?|try again)\b\s*(?:at\s+|on\s+)?/i.exec(text);
  if (!head) return null;
  let rest = text.slice(head.index + head[0].length).split(/\s·\s|\n/)[0].trim();
  let zone = 'UTC';
  const z = /\(\s*([A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*)\s*\)/.exec(rest);
  if (z) { zone = z[1]; rest = rest.slice(0, z.index).trim(); }
  const f = zoneFormat(zone) ?? zoneFormat('UTC')!;
  const until = (v: number) => ({ until: v, kind });

  const rel = /^in\s+(.+)/i.exec(rest);
  if (rel) {
    let secs = 0, hit = false;
    for (const m of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)\b/gi)) {
      secs += Number(m[1]) * UNIT_SECS[m[2][0].toLowerCase()];
      hit = true;
    }
    return hit ? until(Math.floor(at + secs)) : null;
  }

  const iso = /^(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)(Z|[+-]\d{2}:?\d{2})?/i.exec(rest);
  if (iso) {
    const off = iso[2]?.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const ms = Date.parse(iso[1].replace(' ', 'T') + (iso[1].length > 10 ? '' : 'T00:00') + (off ?? 'Z'));
    return Number.isFinite(ms) ? until(Math.floor(ms / 1000)) : null;
  }

  const dated = new RegExp(String.raw`^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b,?\s*(?:(\d{4})\b,?\s*)?(?:at\s+)?(.*)$`, 'i').exec(rest);
  const mo = dated ? MONTHS.indexOf(dated[1].slice(0, 3).toLowerCase()) + 1 : 0;
  if (dated && mo > 0) {
    const day = Number(dated[2]);
    const t = dated[4].trim();
    const clock = t ? clockOf(new RegExp('^' + TIME, 'i').exec(t), 1) ?? clockOf(new RegExp('^' + TIME24).exec(t), 1) : { h: 0, mi: 0 };
    if (!clock || day < 1 || day > 31) return null;
    if (dated[3]) return until(zonedEpoch(Number(dated[3]), mo, day, clock.h, clock.mi, f));
    // No year: the first occurrence at or after a day before the message.
    const floor = at - 86400;
    const y = wallParts(floor, f).y;
    const v = zonedEpoch(y, mo, day, clock.h, clock.mi, f);
    return until(v >= floor ? v : zonedEpoch(y + 1, mo, day, clock.h, clock.mi, f));
  }

  const clock = clockOf(new RegExp('^' + TIME, 'i').exec(rest), 1) ?? clockOf(new RegExp('^' + TIME24).exec(rest), 1);
  if (!clock) return null;
  // No date: the first occurrence of that wall time at or after a minute
  // before the message, read in the zone's own calendar.
  const floor = at - 60;
  const w = wallParts(floor, f);
  const v = zonedEpoch(w.y, w.mo, w.d, clock.h, clock.mi, f);
  return until(v >= floor ? v : zonedEpoch(w.y, w.mo, w.d + 1, clock.h, clock.mi, f));
}

interface ErrorQuota { resetsAt?: unknown; rateLimitType?: unknown }

/** A limit verdict filled in from the event: a structured reset (the transcript
 *  entry's apiErrorParams / quotaLimits) and the reset its text names, keeping
 *  the LATER of the two (the same guess as failover's, see there), and the kind. */
function limitVerdict(e: RawEvent, source: string, text: string): Verdict {
  const params = e.apiErrorParams as { rate_limit_info?: ErrorQuota } | undefined;
  const q = [params?.rate_limit_info, e.quotaLimits as ErrorQuota | undefined];
  const structured = q.map((x) => x?.resetsAt).find((x): x is number => typeof x === 'number' && x > 0);
  const typeKind = q.map((x) => limitKindOfType(x?.rateLimitType)).find((k) => k && k !== 'unknown');
  const ts = typeof e.timestamp === 'string' ? Date.parse(e.timestamp) : NaN;
  const at = Number.isFinite(ts) ? Math.floor(ts / 1000) : Math.floor(Date.now() / 1000);
  const parsed = text ? parseLimitReset(text, at) : null;
  const resetsAt = structured != null && parsed ? Math.max(structured, parsed.until) : structured ?? parsed?.until;
  const textKind = text ? limitKindOfText(text) : undefined;
  const limitKind = typeKind ?? (textKind && textKind !== 'unknown' ? textKind : undefined) ?? (text || structured != null ? 'unknown' : undefined);
  return { kind: 'limited', ...(resetsAt != null ? { resetsAt: Math.floor(resetsAt) } : {}), ...(limitKind ? { limitKind } : {}), source };
}

export function classifyEvent(e: RawEvent): Verdict {
  if (e.type === 'rate_limit_event') {
    const info = (e.rate_limit_info ?? {}) as RateLimitInfo;
    if (info.status === 'rejected') {
      const limitKind = limitKindOfType(info.rateLimitType);
      return { kind: 'limited', resetsAt: info.resetsAt, ...(limitKind ? { limitKind } : {}), source: 'rate_limit_event' };
    }
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
  if (e.type === 'result' && e.api_error_status === 429) return limitVerdict(e, 'result', typeof e.result === 'string' ? e.result : '');
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
  if (e.error === 'rate_limit') return limitVerdict(e, 'synthetic_message', assistantErrorText(e));
  // The CLI's own synthetic response when the account's stored OAuth session is
  // missing/expired/revoked: an assistant message with this exact `error` field
  // and no real model involved (message.model: '<synthetic>'), text "Not logged
  // in · Please run /login". No reset time applies — a human has to re-auth.
  if (e.error === 'authentication_failed') return { kind: 'auth_required', source: 'synthetic_message' };
  return { kind: 'irrelevant', source: 'none' };
}
