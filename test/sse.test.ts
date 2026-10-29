import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SseWriter, sseFrame } from '../server/sse.js';
import type { GatewayEvent } from '../server/manager.js';

class FakeRes extends EventEmitter {
  written: string[] = [];
  accept = true;
  destroyed = false;
  write(chunk: string): boolean { this.written.push(chunk); return this.accept; }
  destroy(): void { this.destroyed = true; }
}

const ev = (seq: number, data: Record<string, unknown> = {}): GatewayEvent => ({ seq, ts: '2026-10-29T00:00:00.000Z', kind: 'activity', data });

describe('sseFrame', () => {
  it('is the same frame the route used to build, serialized once per event', () => {
    const e = ev(7, { text: 'hi' });
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      const frames = [sseFrame(e), sseFrame(e), sseFrame(e)];
      expect(spy).toHaveBeenCalledTimes(1);
      expect(new Set(frames).size).toBe(1);
    } finally { spy.mockRestore(); }
    expect(sseFrame(e)).toBe(`id: 7\nevent: activity\ndata: ${JSON.stringify(e)}\n\n`);
    // Nothing is stored on the event itself, so the payload is unchanged.
    expect(Object.keys(e)).toEqual(['seq', 'ts', 'kind', 'data']);
  });
});

describe('SseWriter', () => {
  it('writes straight through while the client keeps up', () => {
    const res = new FakeRes(), w = new SseWriter(res);
    w.send('a'); w.ping(); w.send('b');
    expect(res.written).toEqual(['a', ': ping\n\n', 'b']);
  });

  it('stops writing after write() returns false and resumes in order on drain', () => {
    const res = new FakeRes(), w = new SseWriter(res);
    res.accept = false;
    w.send('a');
    w.send('b'); w.ping(); w.send('c');
    expect(res.written).toEqual(['a']);
    res.accept = true;
    res.emit('drain');
    expect(res.written).toEqual(['a', 'b', 'c']);
    expect(w.pendingBytes).toBe(0);
    w.send('d');
    expect(res.written).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pauses again when a flush fills the socket', () => {
    const res = new FakeRes(), w = new SseWriter(res);
    res.accept = false; w.send('a'); w.send('b'); w.send('c');
    res.emit('drain'); // still not accepting: writes b, stops
    expect(res.written).toEqual(['a', 'b']);
    res.accept = true; res.emit('drain');
    expect(res.written).toEqual(['a', 'b', 'c']);
  });

  it('drops a client holding more than the byte cap of live events', () => {
    const res = new FakeRes(), onDrop = vi.fn();
    const w = new SseWriter(res, { maxPendingBytes: 10, onDrop });
    res.accept = false;
    w.send('first');
    w.send('12345'); w.send('67890');
    expect(res.destroyed).toBe(false);
    w.send('x');
    expect(res.destroyed).toBe(true);
    expect(onDrop).toHaveBeenCalledWith('pending');
    w.send('after'); res.emit('drain');
    expect(res.written).toEqual(['first']);
  });

  it('drops a client that stays undrained past the stall limit, checked by the ping', () => {
    let now = 1000;
    const res = new FakeRes(), onDrop = vi.fn();
    const w = new SseWriter(res, { maxStallMs: 30_000, now: () => now, onDrop });
    res.accept = false; w.send('a');
    now += 29_000; w.ping();
    expect(res.destroyed).toBe(false);
    now += 2_000; w.ping();
    expect(res.destroyed).toBe(true);
    expect(onDrop).toHaveBeenCalledWith('stalled');
  });

  it('a drain resets the stall clock', () => {
    let now = 0;
    const res = new FakeRes(), w = new SseWriter(res, { maxStallMs: 30_000, now: () => now });
    res.accept = false; w.send('a'); w.send('b');
    now = 25_000; res.emit('drain'); // writes b, still full: stall restarts here
    now = 50_000; w.ping();
    expect(res.destroyed).toBe(false);
  });

  it('never counts the replay toward the byte cap', () => {
    const res = new FakeRes(), w = new SseWriter(res, { maxPendingBytes: 4 });
    res.accept = false;
    w.replaying = true;
    for (let i = 0; i < 100; i++) w.send('replayed-frame');
    w.replaying = false;
    expect(res.destroyed).toBe(false);
    expect(w.pendingBytes).toBe(0);
    res.accept = true; res.emit('drain');
    expect(res.written).toHaveLength(100);
  });
});
