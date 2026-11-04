import { describe, expect, it } from 'vitest';
import { HotCache } from '../server/hot-cache.js';

describe('HotCache.shared', () => {
  it('returns a fresh value within the TTL and recomputes after it', () => {
    let now = 0, calls = 0;
    const c = new HotCache(10, () => now);
    const compute = () => ({ n: ++calls });
    expect(c.shared('k', 1000, compute)).toEqual({ n: 1 });
    now = 999;
    expect(c.shared('k', 1000, compute)).toEqual({ n: 1 });
    now = 1000;
    expect(c.shared('k', 1000, compute)).toEqual({ n: 2 });
    expect(c.shared('other', 1000, compute)).toEqual({ n: 3 });
  });

  it('shares one in-flight async computation between concurrent callers', async () => {
    let calls = 0, release!: (v: number) => void;
    const c = new HotCache();
    const compute = () => { calls++; return new Promise<number>(r => { release = r; }); };
    const all = Array.from({ length: 8 }, () => c.shared('k', 1000, compute));
    expect(calls).toBe(1);
    expect(new Set(all).size).toBe(1);
    release(42);
    expect(await Promise.all(all)).toEqual(Array(8).fill(42));
    expect(await c.shared('k', 1000, compute)).toBe(42);
    expect(calls).toBe(1);
  });

  it('times an async value from when it resolved', async () => {
    let now = 0, calls = 0, release!: (v: number) => void;
    const c = new HotCache(10, () => now);
    const p = c.shared('k', 100, () => { calls++; return new Promise<number>(r => { release = r; }); });
    now = 5000; release(1); await p;
    now = 5050;
    await c.shared('k', 100, async () => { calls++; return 2; });
    expect(calls).toBe(1);
  });

  it('never keeps an error, sync or async', async () => {
    const c = new HotCache();
    let calls = 0;
    expect(() => c.shared('s', 1000, () => { calls++; throw new Error('boom'); })).toThrow('boom');
    expect(c.shared('s', 1000, () => { calls++; return 'ok'; })).toBe('ok');
    const failing = c.shared('a', 1000, async () => { calls++; throw new Error('later'); });
    await expect(failing).rejects.toThrow('later');
    expect(await c.shared('a', 1000, async () => { calls++; return 'ok'; })).toBe('ok');
    expect(calls).toBe(4);
  });

  it('lets the TTL depend on the value', () => {
    let now = 0, calls = 0;
    const c = new HotCache(10, () => now);
    const ttl = (v: { partial: boolean }) => (v.partial ? 10 : 1000);
    c.shared('k', ttl, () => ({ partial: ++calls < 2 }));
    now = 20;
    expect(c.shared('k', ttl, () => ({ partial: ++calls < 2 }))).toEqual({ partial: false });
    now = 500;
    c.shared('k', ttl, () => ({ partial: ++calls < 2 }));
    expect(calls).toBe(2);
    // A zero TTL keeps nothing.
    c.shared('z', () => 0, () => ++calls);
    c.shared('z', () => 0, () => ++calls);
    expect(calls).toBe(4);
  });

  it('is bounded, expired entries first, then the oldest', () => {
    let now = 0;
    const c = new HotCache(3, () => now);
    c.shared('short', 10, () => 0);
    c.shared('a', 1000, () => 1);
    c.shared('b', 1000, () => 2);
    now = 50;
    c.shared('c', 1000, () => 3);
    expect(c.size).toBe(3);
    let calls = 0;
    expect(c.shared('a', 1000, () => ++calls)).toBe(1); // kept: 'short' went
    c.shared('d', 1000, () => 4);
    expect(c.size).toBe(3);
    expect(c.shared('a', 1000, () => 99)).toBe(99); // now the oldest, evicted
  });

  it('invalidates by prefix', () => {
    const c = new HotCache();
    let calls = 0;
    c.shared('projects\0x', 1000, () => ++calls);
    c.shared('reply\0x', 1000, () => ++calls);
    c.invalidate('projects');
    expect(c.shared('projects\0x', 1000, () => ++calls)).toBe(3);
    expect(c.shared('reply\0x', 1000, () => ++calls)).toBe(2);
  });
});
