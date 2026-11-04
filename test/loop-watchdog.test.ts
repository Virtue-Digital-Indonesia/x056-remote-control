import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import {
  LoopWatchdog, RateLimitedSink, RotatingLog, installLoopWatchdog, readSlowRecords,
  sanitizePath, watchdogEnabled, watchdogOptionsFromEnv,
} from '../server/loop-watchdog.js';

/** A ServerResponse stand-in: events, headers, status. */
function fakeRes(contentType?: string): ServerResponse & { finishNow: () => void; abortNow: () => void } {
  const ee = new EventEmitter() as unknown as ServerResponse & { finishNow: () => void; abortNow: () => void };
  const r = ee as unknown as Record<string, unknown>;
  r.statusCode = 200;
  r.headersSent = false;
  r.writableFinished = false;
  r.getHeader = (n: string) => (n.toLowerCase() === 'content-type' ? contentType : undefined);
  ee.finishNow = () => { r.headersSent = true; r.writableFinished = true; ee.emit('finish'); ee.emit('close'); };
  ee.abortNow = () => { ee.emit('close'); };
  return ee;
}

const dirs: string[] = [];
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 'x056-wd-')); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function readLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('sanitizePath', () => {
  it('keeps parameter names and drops every value', () => {
    const out = sanitizePath('/api/events?token=SECRET-abc123&limit=5&x');
    expect(out).toBe('/api/events?token&limit&x');
    expect(out).not.toContain('SECRET');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('=');
  });
  it('handles no query, empty names, duplicates, fragments and control chars', () => {
    expect(sanitizePath('/healthz')).toBe('/healthz');
    expect(sanitizePath('/a?')).toBe('/a');
    expect(sanitizePath('/a?=v&&b=1&b=2')).toBe('/a?b');
    expect(sanitizePath('/a?t=1#frag=SECRET')).toBe('/a?t');
    expect(sanitizePath('/a\n{"kind":"forged"}?q=1')).toBe('/a{"kind":"forged"}?q');
    expect(sanitizePath(undefined)).toBe('');
  });
  it('caps the path and the number and length of names', () => {
    const long = sanitizePath('/' + 'x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(202);
    const many = sanitizePath('/a?' + Array.from({ length: 15 }, (_, i) => `p${i}=v${i}`).join('&'));
    expect(many).toBe('/a?p0&p1&p2&p3&p4&p5&p6&p7&p8&p9&…+5');
    expect(many).not.toContain('v1');
    expect(sanitizePath('/a?' + 'n'.repeat(100) + '=1').length).toBeLessThan(60);
  });
});

describe('env switches', () => {
  it('X056_WATCHDOG=off disables; default on', () => {
    expect(watchdogEnabled({})).toBe(true);
    expect(watchdogEnabled({ X056_WATCHDOG: 'off' })).toBe(false);
    expect(watchdogEnabled({ X056_WATCHDOG: ' OFF ' })).toBe(false);
    const uses: unknown[] = [];
    expect(installLoopWatchdog({ use: (f) => uses.push(f) }, tmp(), { X056_WATCHDOG: 'off' })).toBeNull();
    expect(uses).toHaveLength(0);
  });
  it('thresholds come from env, 0 allowed, junk falls back', () => {
    expect(watchdogOptionsFromEnv('/s', {})).toMatchObject({ slowRequestMs: 500, loopLagMs: 1000 });
    expect(watchdogOptionsFromEnv('/s', { X056_SLOW_REQUEST_MS: '0', X056_LOOP_LAG_MS: '250' })).toMatchObject({ slowRequestMs: 0, loopLagMs: 250 });
    expect(watchdogOptionsFromEnv('/s', { X056_SLOW_REQUEST_MS: 'abc', X056_LOOP_LAG_MS: '-1' })).toMatchObject({ slowRequestMs: 500, loopLagMs: 1000 });
  });
});

describe('RateLimitedSink', () => {
  it('passes 20 per second and coalesces the rest into one counter line', () => {
    let t = 10_000;
    const lines: string[] = [];
    const sink = new RateLimitedSink((l) => lines.push(l), 20, () => t);
    for (let i = 0; i < 50; i++) sink.push({ i });
    expect(lines).toHaveLength(20);
    expect(sink.pendingDropped).toBe(30);
    t += 1000;
    sink.push({ i: 'next' });
    expect(lines).toHaveLength(22);
    expect(JSON.parse(lines[20])).toMatchObject({ kind: 'suppressed', count: 30 });
    expect(JSON.parse(lines[21])).toEqual({ i: 'next' });
    sink.flush();
    expect(lines).toHaveLength(22); // nothing pending
  });
  it('never throws when the writer does', () => {
    const sink = new RateLimitedSink(() => { throw new Error('disk full'); });
    expect(() => sink.push({ a: 1 })).not.toThrow();
  });
});

describe('RotatingLog', () => {
  it('rotates to .1 at the cap and keeps one old file', () => {
    const file = join(tmp(), 'diagnostics', 'slow.jsonl');
    const log = new RotatingLog(file, 100);
    const line = 'x'.repeat(39); // 40 bytes with the newline
    log.append(line); log.append(line);
    expect(statSync(file).size).toBe(80);
    expect(existsSync(file + '.1')).toBe(false);
    log.append(line); // 120 > 100: rotate first
    expect(statSync(file + '.1').size).toBe(80);
    expect(statSync(file).size).toBe(40);
    log.append(line); log.append(line); // 120 again: the old .1 is replaced
    expect(statSync(file + '.1').size).toBe(80);
    expect(statSync(file).size).toBe(40);
  });
  it('picks up an existing file size after a restart', () => {
    const d = tmp();
    const file = join(d, 'slow.jsonl');
    writeFileSync(file, 'y'.repeat(90) + '\n');
    new RotatingLog(file, 100).append('z'.repeat(9)); // 91 + 10 > 100
    expect(readFileSync(file, 'utf8')).toBe('zzzzzzzzz\n');
    expect(statSync(file + '.1').size).toBe(91);
  });
});

describe('LoopWatchdog records', () => {
  it('logs a slow request without headers or query values; skips fast ones and SSE', () => {
    const d = tmp();
    let t = 1000;
    const err: string[] = [];
    const wd = new LoopWatchdog({ stateDir: d, slowRequestMs: 500, now: () => t, stderr: (l) => err.push(l) });
    const fast = fakeRes();
    wd.track({ method: 'GET', url: '/api/fast' }, fast);
    t += 10; fast.finishNow();
    const slow = fakeRes();
    wd.track({ method: 'POST', originalUrl: '/api/send?token=TOPSECRET&x=1' }, slow);
    t += 700; slow.finishNow();
    const sse = fakeRes('text/event-stream');
    wd.track({ method: 'GET', url: '/api/events?token=TOPSECRET' }, sse);
    t += 60_000; sse.abortNow();
    const recs = readLines(wd.file);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ kind: 'slow_request', method: 'POST', path: '/api/send?token&x', status: 200, ms: 700, aborted: false });
    expect(readFileSync(wd.file, 'utf8')).not.toContain('TOPSECRET');
    expect(err).toHaveLength(1);
    expect(wd.inflightCount).toBe(0);
  });
  it('marks a request the client gave up on as aborted, once', () => {
    const d = tmp();
    let t = 0;
    const wd = new LoopWatchdog({ stateDir: d, slowRequestMs: 100, now: () => t, stderr: null });
    const res = fakeRes();
    wd.track({ method: 'GET', url: '/api/slow' }, res);
    t += 300; res.abortNow(); res.emit('close');
    const recs = readLines(wd.file);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ aborted: true, status: null, ms: 300 });
  });
  it('a lag record names in-flight requests (oldest first, max 10) and recently finished ones', () => {
    const d = tmp();
    let t = 0;
    const wd = new LoopWatchdog({ stateDir: d, slowRequestMs: 10_000, loopLagMs: 1000, now: () => t, stderr: null });
    const live: ReturnType<typeof fakeRes>[] = [];
    for (let i = 0; i < 12; i++) { const r = fakeRes(); live.push(r); wd.track({ method: 'GET', url: `/api/r${i}?token=S` }, r); t += 1; }
    wd.track({ method: 'GET', url: '/api/events' }, fakeRes('text/event-stream'));
    expect(wd.observeLag(500, 100, t)).toBeNull();
    const rec = wd.observeLag(1500, 900, t + 100, [{ method: 'POST', path: '/api/culprit', ms: 1400, startedAt: 0, endedAt: t + 50, status: 200, aborted: false }])!;
    expect(rec).toMatchObject({ kind: 'loop_lag', maxMs: 1500, p99Ms: 900, activeCount: 12 });
    const active = rec.activeRequests as { path: string; ageMs: number }[];
    expect(active).toHaveLength(10);
    expect(active[0]).toEqual({ method: 'GET', path: '/api/r0?token', ageMs: 112 });
    expect(active.some((a) => a.path === '/api/events')).toBe(false);
    expect(rec.recentlyFinished).toEqual([{ method: 'POST', path: '/api/culprit', ms: 1400, status: 200, aborted: false, endedAgoMs: 50 }]);
    // An in-flight request remembers the stall it lived through.
    t += 2000; live[0].finishNow();
    const all = readLines(wd.file);
    expect(all.filter((r) => r.kind === 'loop_lag')).toHaveLength(1);
    expect(JSON.stringify(all)).not.toContain('token=');
  });
});

describe('LoopWatchdog against a real stall', () => {
  function busyWait(ms: number): void { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
  async function untilLag(file: string, windows: number, intervalMs: number): Promise<Record<string, unknown> | undefined> {
    for (let i = 0; i < windows * 4; i++) {
      await new Promise((r) => setTimeout(r, intervalMs / 2));
      const hit = readLines(file).find((r) => r.kind === 'loop_lag');
      if (hit) return hit;
    }
    return undefined;
  }

  it('names a request still in flight when the loop blocks', async () => {
    const d = tmp();
    const wd = new LoopWatchdog({ stateDir: d, slowRequestMs: 60_000, loopLagMs: 300, intervalMs: 200, stderr: null }).start();
    try {
      const res = fakeRes();
      wd.track({ method: 'POST', url: '/api/heavy?token=NOPE' }, res);
      busyWait(700);
      const rec = await untilLag(wd.file, 3, 200);
      expect(rec).toBeDefined();
      expect(rec!.maxMs as number).toBeGreaterThanOrEqual(300);
      expect(rec!.activeRequests).toEqual([expect.objectContaining({ method: 'POST', path: '/api/heavy?token' })]);
      res.finishNow();
    } finally { wd.stop(); }
  });

  it('still names a synchronous culprit that answered before the tick ran', async () => {
    const d = tmp();
    const wd = new LoopWatchdog({ stateDir: d, slowRequestMs: 60_000, loopLagMs: 300, intervalMs: 200, stderr: null }).start();
    try {
      const res = fakeRes();
      wd.track({ method: 'GET', url: '/api/sync-heavy' }, res);
      busyWait(700);
      res.finishNow(); // finished inside the same blocked stretch
      expect(wd.inflightCount).toBe(0);
      const rec = await untilLag(wd.file, 3, 200);
      expect(rec).toBeDefined();
      expect(rec!.activeRequests).toEqual([]);
      expect(rec!.recentlyFinished).toEqual([expect.objectContaining({ method: 'GET', path: '/api/sync-heavy' })]);
    } finally { wd.stop(); }
  });
});

describe('readSlowRecords', () => {
  it('returns the last N records from the tail, skipping a partial first line', () => {
    const d = tmp();
    mkdirSync(join(d, 'diagnostics'));
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, pad: 'p'.repeat(20) }));
    writeFileSync(join(d, 'diagnostics', 'slow.jsonl'), lines.join('\n') + '\n');
    expect(readSlowRecords(d, 3).map((r) => r.i)).toEqual([47, 48, 49]);
    const tail = readSlowRecords(d, 1000, 200);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail[tail.length - 1].i).toBe(49);
    expect(readSlowRecords(tmp(), 10)).toEqual([]);
  });
});
