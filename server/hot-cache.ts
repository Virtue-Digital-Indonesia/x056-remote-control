/**
 * A tiny result cache for expensive GET handlers that several panel tabs,
 * phones and agents poll at once. Identical requests inside the TTL share one
 * computation: a fresh value is returned as is, an async computation still in
 * flight is shared (every caller gets the same promise), and errors are never
 * kept, so the next caller computes again.
 *
 * Values are SHARED between callers: a handler that hands one out must not
 * mutate it afterwards, and neither may whoever receives it.
 */
interface Slot {
  value: unknown;
  /** When the value became available (resolution time for a promise). */
  at: number;
  ttl: number;
  pending: boolean;
}

export type Ttl<T> = number | ((value: Awaited<T>) => number);

const isPromise = (v: unknown): v is Promise<unknown> =>
  !!v && typeof (v as { then?: unknown }).then === 'function';

export class HotCache {
  private readonly slots = new Map<string, Slot>();
  constructor(readonly max = 500, private readonly clock: () => number = Date.now) {}

  get size(): number { return this.slots.size; }

  /** `compute()` once per `key` per `ttlMs`. `ttlMs` may depend on the value
   *  (e.g. short while a result is still partial). */
  shared<T>(key: string, ttlMs: Ttl<T>, compute: () => T): T {
    const now = this.clock();
    const slot = this.slots.get(key);
    if (slot && (slot.pending || now - slot.at < slot.ttl)) return slot.value as T;
    if (slot) this.slots.delete(key);
    const value = compute(); // a synchronous throw propagates and stores nothing
    const ttlOf = (v: unknown) => (typeof ttlMs === 'function' ? ttlMs(v as Awaited<T>) : ttlMs);
    if (isPromise(value)) {
      const pending: Slot = { value, at: now, ttl: 0, pending: true };
      this.put(key, pending, now);
      value.then(
        (v) => {
          if (this.slots.get(key) !== pending) return;
          pending.pending = false;
          pending.at = this.clock();
          pending.ttl = ttlOf(v);
          if (pending.ttl <= 0) this.slots.delete(key);
        },
        () => { if (this.slots.get(key) === pending) this.slots.delete(key); },
      );
      return value;
    }
    const ttl = ttlOf(value);
    if (ttl > 0) this.put(key, { value, at: now, ttl, pending: false }, now);
    return value;
  }

  /** Drop every entry whose key starts with `prefix` ('' = all). */
  invalidate(prefix = ''): void {
    for (const key of [...this.slots.keys()]) if (key.startsWith(prefix)) this.slots.delete(key);
  }

  private put(key: string, slot: Slot, now: number): void {
    this.slots.delete(key);
    this.slots.set(key, slot);
    if (this.slots.size <= this.max) return;
    // Expired entries go first, then the oldest inserted.
    for (const [k, s] of this.slots) {
      if (!s.pending && now - s.at >= s.ttl) this.slots.delete(k);
    }
    for (const k of this.slots.keys()) {
      if (this.slots.size <= this.max) break;
      if (k !== key) this.slots.delete(k);
    }
  }
}

/** The gateway's shared instance. */
export const hotCache = new HotCache();
