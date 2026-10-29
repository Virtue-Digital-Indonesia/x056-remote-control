import type { GatewayEvent } from './manager.js';

/**
 * The SSE frame for an event, serialized once however many panels are open.
 * A WeakMap rather than a field on the event: the frame's `data:` is
 * JSON.stringify(event) itself, so a field would leak into every frame.
 */
const frames = new WeakMap<GatewayEvent, string>();
export function sseFrame(e: GatewayEvent): string {
  let frame = frames.get(e);
  if (frame === undefined) {
    frame = `id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
    frames.set(e, frame);
  }
  return frame;
}

/** The part of an http.ServerResponse the writer uses (a fake in tests). */
export interface SseSink {
  write(chunk: string): boolean;
  on(event: 'drain', fn: () => void): unknown;
  destroy(): unknown;
}

export interface SseWriterOptions {
  /** Bytes of live events held for a client that is not draining. */
  maxPendingBytes?: number;
  /** How long a client may stay undrained. */
  maxStallMs?: number;
  now?: () => number;
  /** Called once when the writer gives up on the client. */
  onDrop?: (reason: 'pending' | 'stalled') => void;
}

/**
 * One SSE client with backpressure. Once `write` returns false nothing more is
 * written until 'drain'; frames wait in order in a local queue. A client that
 * holds more than `maxPendingBytes` of live events, or stays undrained longer
 * than `maxStallMs`, is dropped: the panel reconnects with `since=<lastSeq>`
 * and catches up from the gateway's event buffer.
 *
 * The replay a new subscriber gets (written while `replaying` is set) never
 * counts toward the byte cap, so a fresh panel is not dropped on every connect
 * just because the buffer is large; only the stall rule applies to it.
 */
export class SseWriter {
  private queue: { frame: string; live: boolean }[] = [];
  private liveBytes = 0;
  private stalledSince: number | null = null;
  private closed = false;
  replaying = false;
  private readonly maxPendingBytes: number;
  private readonly maxStallMs: number;
  private readonly now: () => number;

  constructor(private readonly res: SseSink, private readonly opts: SseWriterOptions = {}) {
    this.maxPendingBytes = opts.maxPendingBytes ?? 2 * 1024 * 1024;
    this.maxStallMs = opts.maxStallMs ?? 30_000;
    this.now = opts.now ?? Date.now;
    res.on('drain', () => this.flush());
  }

  get dropped(): boolean { return this.closed; }
  get pendingBytes(): number { return this.liveBytes; }

  send(frame: string): void {
    if (this.closed) return;
    if (this.stalledSince === null && this.queue.length === 0) {
      if (!this.res.write(frame)) this.stalledSince = this.now();
      return;
    }
    const live = !this.replaying;
    this.queue.push({ frame, live });
    if (live) this.liveBytes += Buffer.byteLength(frame);
    this.check();
  }

  /** A keepalive comment; skipped while the client is not draining. */
  ping(): void {
    if (this.closed) return;
    if (this.stalledSince !== null || this.queue.length) { this.check(); return; }
    if (!this.res.write(': ping\n\n')) this.stalledSince = this.now();
  }

  /** Give up on the client if it is over either limit. */
  check(): void {
    if (this.closed) return;
    if (this.liveBytes > this.maxPendingBytes) this.drop('pending');
    else if (this.stalledSince !== null && this.now() - this.stalledSince > this.maxStallMs) this.drop('stalled');
  }

  close(): void { this.closed = true; this.queue = []; this.liveBytes = 0; }

  private flush(): void {
    if (this.closed) return;
    this.stalledSince = null;
    while (this.queue.length) {
      const item = this.queue.shift()!;
      if (item.live) this.liveBytes -= Buffer.byteLength(item.frame);
      if (!this.res.write(item.frame)) { this.stalledSince = this.now(); return; }
    }
  }

  private drop(reason: 'pending' | 'stalled'): void {
    this.close();
    try { this.res.destroy(); } catch { /* already gone */ }
    this.opts.onDrop?.(reason);
  }
}
