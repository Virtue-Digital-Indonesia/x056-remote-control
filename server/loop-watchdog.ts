// Loop watchdog: the next time the gateway's main thread saturates, it says
// which request was running. Two records, both cheap and both safe (no
// inspector, no profiler):
//
//   - a slow request: wall time from arrival to 'finish' (or 'close', when the
//     client gave up first: aborted) at or over X056_SLOW_REQUEST_MS (500);
//   - a loop stall: the event loop's max delay in a 1 s window at or over
//     X056_LOOP_LAG_MS (1000), naming the requests in flight AND the ones that
//     finished during that window. The second list matters: a handler that
//     blocks synchronously and then answers emits 'finish' before the late
//     tick runs, so it is no longer in flight when the stall is noticed.
//
// Records go to <stateDir>/diagnostics/slow.jsonl (rotated to slow.jsonl.1 at
// ~5 MB, one old file kept) and to stderr as `[slow] {...}` for docker logs.
// At most 20 lines per second; the rest are counted and coalesced into one
// `suppressed` line. Nothing here may throw into the request path.
//
// Never recorded: headers (Authorization, cookies) and query VALUES. A token
// can arrive as ?token=, so a path keeps only its query parameter names.
//
// X056_WATCHDOG=off turns all of it off. GET /api/diagnostics/slow?limit=N
// (behind the ordinary auth guard) returns the last records.

import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Get, Inject, Query } from '@nestjs/common';

export const DIAGNOSTICS_STATE_DIR = Symbol('x056-diagnostics-state-dir');

const MAX_PATH = 200;
const MAX_QUERY_NAMES = 10;
const MAX_QUERY_NAME = 40;

export interface WatchdogEnv { [k: string]: string | undefined }

export function watchdogEnabled(env: WatchdogEnv = process.env): boolean {
  return (env.X056_WATCHDOG ?? '').trim().toLowerCase() !== 'off';
}

function envMs(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Strip control characters so a crafted URL cannot forge log lines. */
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * The request path with query parameter NAMES only, never their values:
 * `/api/x?token=abc&limit=5` -> `/api/x?token&limit`. Capped in length and in
 * the number of names (both are attacker-controlled).
 */
export function sanitizePath(url: string | undefined): string {
  const raw = clean(String(url ?? ''));
  const q = raw.indexOf('?');
  const hash = raw.indexOf('#');
  const pathEnd = q >= 0 ? q : hash >= 0 ? hash : raw.length;
  let path = raw.slice(0, pathEnd);
  if (path.length > MAX_PATH) path = path.slice(0, MAX_PATH) + '…';
  if (q < 0) return path;
  const query = raw.slice(q + 1, hash > q ? hash : raw.length);
  const names: string[] = [];
  let extra = 0;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    let name = eq >= 0 ? part.slice(0, eq) : part;
    if (!name) continue;
    if (name.length > MAX_QUERY_NAME) name = name.slice(0, MAX_QUERY_NAME) + '…';
    if (names.includes(name)) continue;
    if (names.length >= MAX_QUERY_NAMES) { extra++; continue; }
    names.push(name);
  }
  if (!names.length) return path;
  return path + '?' + names.join('&') + (extra ? `&…+${extra}` : '');
}

/**
 * Append-only JSONL file with a size cap: over `maxBytes` it is renamed to
 * `<file>.1` (replacing the previous one) and a fresh file begins. The size is
 * tracked in memory after one stat. Never throws.
 */
export class RotatingLog {
  private size = -1;
  constructor(readonly file: string, private readonly maxBytes = 5 * 1024 * 1024) {}

  append(line: string): void {
    try {
      const text = line.endsWith('\n') ? line : line + '\n';
      const bytes = Buffer.byteLength(text);
      if (this.size < 0) {
        mkdirSync(join(this.file, '..'), { recursive: true });
        try { this.size = statSync(this.file).size; } catch { this.size = 0; }
      }
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        try { renameSync(this.file, this.file + '.1'); } catch { /* keep appending */ }
        this.size = 0;
      }
      appendFileSync(this.file, text);
      this.size += bytes;
    } catch {
      this.size = -1; // re-stat next time
    }
  }
}

/**
 * At most `perSecond` lines per one-second window; the rest are counted and
 * reported as ONE `{kind: 'suppressed', count}` line, written by `flush()` (on
 * the next write in a new window, or from the watchdog's tick).
 */
export class RateLimitedSink {
  private windowStart = 0;
  private written = 0;
  private dropped = 0;
  constructor(
    private readonly write: (line: string) => void,
    private readonly perSecond = 20,
    private readonly now: () => number = Date.now,
  ) {}

  push(record: Record<string, unknown>): boolean {
    const t = this.now();
    if (t - this.windowStart >= 1000) { this.flush(t); this.windowStart = t; this.written = 0; }
    if (this.written >= this.perSecond) { this.dropped++; return false; }
    this.written++;
    this.safeWrite(JSON.stringify(record));
    return true;
  }

  /** Emit the coalesced counter line if anything was dropped. */
  flush(t = this.now()): void {
    if (!this.dropped) return;
    const count = this.dropped;
    this.dropped = 0;
    this.safeWrite(JSON.stringify({ ts: new Date(t).toISOString(), kind: 'suppressed', count }));
  }

  get pendingDropped(): number { return this.dropped; }

  private safeWrite(line: string): void { try { this.write(line); } catch { /* never into the request path */ } }
}

interface Inflight {
  method: string;
  path: string;
  start: number;
  res: ServerResponse;
  maxLagMs: number;
  done: boolean;
}

interface Finished { method: string; path: string; ms: number; startedAt: number; endedAt: number; status: number | null; aborted: boolean }

export interface LoopWatchdogOptions {
  stateDir: string;
  slowRequestMs?: number;
  loopLagMs?: number;
  intervalMs?: number;
  /** Histogram resolution, ms. */
  resolutionMs?: number;
  maxBytes?: number;
  perSecond?: number;
  /** stderr by default; tests pass their own or null. */
  stderr?: ((line: string) => void) | null;
  now?: () => number;
}

export function watchdogOptionsFromEnv(stateDir: string, env: WatchdogEnv = process.env): LoopWatchdogOptions {
  return {
    stateDir,
    slowRequestMs: envMs(env.X056_SLOW_REQUEST_MS, 500),
    loopLagMs: envMs(env.X056_LOOP_LAG_MS, 1000),
  };
}

function isStream(res: ServerResponse): boolean {
  try {
    const ct = res.getHeader('content-type');
    return typeof ct === 'string' && ct.includes('event-stream');
  } catch { return false; }
}

export class LoopWatchdog {
  readonly file: string;
  private readonly slowMs: number;
  private readonly lagMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sink: RateLimitedSink;
  private readonly inflight = new Map<number, Inflight>();
  private finished: Finished[] = [];
  private seq = 0;
  private hist: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private readonly resolutionMs: number;

  constructor(opts: LoopWatchdogOptions) {
    this.file = join(opts.stateDir, 'diagnostics', 'slow.jsonl');
    this.slowMs = opts.slowRequestMs ?? 500;
    this.lagMs = opts.loopLagMs ?? 1000;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.resolutionMs = opts.resolutionMs ?? 20;
    this.now = opts.now ?? Date.now;
    const log = new RotatingLog(this.file, opts.maxBytes);
    const stderr = opts.stderr === undefined ? (l: string) => { process.stderr.write('[slow] ' + l + '\n'); } : opts.stderr;
    this.sink = new RateLimitedSink((line) => {
      log.append(line);
      if (stderr) { try { stderr(line); } catch { /* ignore */ } }
    }, opts.perSecond ?? 20, this.now);
  }

  start(): this {
    if (this.timer) return this;
    try {
      this.hist = monitorEventLoopDelay({ resolution: this.resolutionMs });
      this.hist.enable();
    } catch { this.hist = null; }
    this.lastTick = this.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
    return this;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try { this.hist?.disable(); } catch { /* ignore */ }
    this.hist = null;
    this.sink.flush();
  }

  /** Express/connect middleware. Must stay first so arrival time is real. */
  readonly middleware = (req: IncomingMessage & { originalUrl?: string }, res: ServerResponse, next: () => void): void => {
    try { this.track(req, res); } catch { /* never block a request on diagnostics */ }
    next();
  };

  /** Begin tracking one request; returns its id (tests drive this directly). */
  track(req: { method?: string; url?: string; originalUrl?: string }, res: ServerResponse): number {
    const id = ++this.seq;
    const entry: Inflight = {
      method: String(req.method ?? '?').slice(0, 10),
      path: sanitizePath(req.originalUrl ?? req.url),
      start: this.now(),
      res,
      maxLagMs: 0,
      done: false,
    };
    this.inflight.set(id, entry);
    const end = (aborted: boolean) => {
      if (entry.done) return;
      entry.done = true;
      this.inflight.delete(id);
      try { this.complete(entry, aborted); } catch { /* ignore */ }
    };
    res.once('finish', () => end(false));
    res.once('close', () => end(!res.writableFinished));
    return id;
  }

  private complete(entry: Inflight, aborted: boolean): void {
    if (isStream(entry.res)) return; // SSE lives for minutes by design
    const endedAt = this.now();
    const ms = endedAt - entry.start;
    const status = entry.res.headersSent ? entry.res.statusCode : null;
    this.finished.push({ method: entry.method, path: entry.path, ms, startedAt: entry.start, endedAt, status, aborted });
    if (this.finished.length > 200) this.finished.splice(0, this.finished.length - 200);
    if (ms < this.slowMs) return;
    const rec: Record<string, unknown> = {
      ts: new Date(endedAt).toISOString(), kind: 'slow_request',
      method: entry.method, path: entry.path, status, ms, aborted,
    };
    if (entry.maxLagMs) rec.maxLoopLagMs = entry.maxLagMs;
    this.sink.push(rec);
  }

  /** One window: read the histogram (and the tick's own drift), reset it. */
  tick(): void {
    try {
      const t = this.now();
      const drift = Math.max(0, t - this.lastTick - this.intervalMs);
      const windowStart = this.lastTick;
      this.lastTick = t;
      let maxMs = drift;
      let p99Ms = 0;
      if (this.hist) {
        maxMs = Math.max(maxMs, this.hist.max / 1e6);
        p99Ms = this.hist.percentile(99) / 1e6;
        this.hist.reset();
      }
      // Requests that finished since the last tick were alive in this window.
      const recent = this.finished.filter((f) => f.endedAt >= windowStart);
      this.finished = [];
      this.observeLag(Math.round(maxMs), Math.round(p99Ms), t, recent);
      this.sink.flush(t);
    } catch { /* ignore */ }
  }

  /** Separated from tick() so the record can be tested without a real stall. */
  observeLag(maxMs: number, p99Ms: number, t = this.now(), recent: Finished[] = []): Record<string, unknown> | null {
    if (maxMs < this.lagMs) return null;
    const active: { method: string; path: string; ageMs: number }[] = [];
    for (const e of this.inflight.values()) {
      if (isStream(e.res)) continue;
      e.maxLagMs = Math.max(e.maxLagMs, maxMs);
      active.push({ method: e.method, path: e.path, ageMs: t - e.start });
    }
    active.sort((a, b) => b.ageMs - a.ageMs);
    const finished = recent
      .slice()
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10)
      .map((f) => ({ method: f.method, path: f.path, ms: f.ms, status: f.status, aborted: f.aborted, endedAgoMs: t - f.endedAt }));
    const rec: Record<string, unknown> = {
      ts: new Date(t).toISOString(), kind: 'loop_lag', maxMs, p99Ms,
      activeCount: active.length,
      activeRequests: active.slice(0, 10),
      recentlyFinished: finished,
    };
    this.sink.push(rec);
    return rec;
  }

  get inflightCount(): number { return this.inflight.size; }
}

/** Install on an Express app (first, before body parsers). Returns null when off. */
export function installLoopWatchdog(
  express: { use: (fn: LoopWatchdog['middleware']) => unknown },
  stateDir: string,
  env: WatchdogEnv = process.env,
): LoopWatchdog | null {
  if (!watchdogEnabled(env)) return null;
  try {
    const wd = new LoopWatchdog(watchdogOptionsFromEnv(stateDir, env)).start();
    express.use(wd.middleware);
    return wd;
  } catch (e) {
    console.warn('[watchdog] not started:', (e as Error).message);
    return null;
  }
}

/** The last `limit` records, read from the file's tail only (256 KB). */
export function readSlowRecords(stateDir: string, limit = 200, tailBytes = 256 * 1024): Record<string, unknown>[] {
  const file = join(stateDir, 'diagnostics', 'slow.jsonl');
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - tailBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    const out: Record<string, unknown>[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const l = lines[i].trim();
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out.reverse();
  } catch { return []; } finally { try { closeSync(fd); } catch { /* ignore */ } }
}

@Controller('api/diagnostics')
export class DiagnosticsController {
  constructor(@Inject(DIAGNOSTICS_STATE_DIR) private readonly stateDir: string) {}

  @Get('slow')
  slow(@Query('limit') limit?: string): { enabled: boolean; records: Record<string, unknown>[] } {
    const n = Number(limit);
    const cap = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 1000) : 200;
    return { enabled: watchdogEnabled(), records: readSlowRecords(this.stateDir, cap) };
  }
}
