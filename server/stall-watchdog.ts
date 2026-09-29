import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Leaves evidence when the gateway's event loop stalls.
 *
 * The panel intermittently waits 7-12 s on routes that answer in 5 ms when
 * idle, and by the time anyone looks the stall is over and nothing was
 * logged. A stalled loop cannot report on itself from JavaScript, but V8's
 * sampling profiler runs on its own thread and keeps recording the blocked
 * stack. So one runs continuously, in windows: at the end of each window the
 * loop-delay histogram says whether the loop blocked, and only then is that
 * window's profile kept (`state/stall-profiles/*.cpuprofile`, openable in
 * Chrome DevTools or Safari) and its hottest functions logged. A window that
 * saw no stall is discarded.
 *
 * The check runs on a timer, so a stall delays it until the stall ends -- the
 * window being inspected always contains the whole stall.
 *
 * Cost: the sampler at 2 ms, and one profile stop/start per window.
 * `X056_STALL_WATCHDOG=off` disables it.
 */

export interface StallSummary {
  at: string;
  maxDelayMs: number;
  file?: string;
  top: { fn: string; where: string; selfMs: number }[];
}

interface ProfileNode { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; }
interface CpuProfile { nodes: ProfileNode[]; samples?: number[]; timeDeltas?: number[] }

/** Self time per function, heaviest first. Idle and GC pseudo-frames are kept:
 *  a stall that is mostly `(garbage collector)` is itself the answer. */
export function topSelfTime(profile: CpuProfile, limit = 12): StallSummary['top'] {
  const byNode = new Map<number, ProfileNode>(profile.nodes.map((n) => [n.id, n]));
  const self = new Map<string, { fn: string; where: string; us: number }>();
  const samples = profile.samples ?? [], deltas = profile.timeDeltas ?? [];
  for (let i = 0; i < samples.length; i++) {
    const node = byNode.get(samples[i]);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const where = url ? `${url.replace(/^file:\/\/\/app\//, '')}:${lineNumber + 1}` : '';
    const key = `${functionName}@${where}`;
    const row = self.get(key) ?? { fn: functionName || '(anonymous)', where, us: 0 };
    row.us += deltas[i] ?? 0;
    self.set(key, row);
  }
  return [...self.values()]
    .filter((r) => r.fn !== '(idle)' && r.fn !== '(program)')
    .sort((a, b) => b.us - a.us)
    .slice(0, limit)
    .map((r) => ({ fn: r.fn, where: r.where, selfMs: Math.round(r.us / 1000) }));
}

export function startStallWatchdog(stateDir: string, opts: { windowMs?: number; thresholdMs?: number; keep?: number } = {}): () => void {
  if (process.env.X056_STALL_WATCHDOG === 'off') return () => {};
  const windowMs = opts.windowMs ?? 15_000, thresholdMs = opts.thresholdMs ?? 1_000, keep = opts.keep ?? 20;
  const dir = join(stateDir, 'stall-profiles');
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const session = new Session();
  session.connect();
  const post = <T>(method: string, params?: object) =>
    new Promise<T>((resolve, reject) => session.post(method, params ?? {}, (err, res) => (err ? reject(err) : resolve(res as T))));
  let stopped = false;
  const begin = () => post('Profiler.start').catch(() => {});
  void post('Profiler.enable').then(() => post('Profiler.setSamplingInterval', { interval: 2000 })).then(begin).catch(() => {});

  const tick = async () => {
    const maxDelayMs = Math.round(delay.max / 1e6);
    delay.reset();
    let profile: CpuProfile | undefined;
    try { profile = (await post<{ profile: CpuProfile }>('Profiler.stop')).profile; } catch { /* not started yet */ }
    if (!stopped) await begin();
    if (!profile || maxDelayMs < thresholdMs) return;
    const at = new Date().toISOString();
    const summary: StallSummary = { at, maxDelayMs, top: topSelfTime(profile) };
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `stall-${at.replace(/[:.]/g, '-')}-${maxDelayMs}ms.cpuprofile`);
      writeFileSync(file, JSON.stringify(profile));
      writeFileSync(file.replace(/\.cpuprofile$/, '.json'), JSON.stringify(summary, null, 2));
      summary.file = file;
      const old = readdirSync(dir).filter((f) => f.endsWith('.cpuprofile')).sort();
      for (const f of old.slice(0, Math.max(0, old.length - keep))) {
        try { unlinkSync(join(dir, f)); unlinkSync(join(dir, f.replace(/\.cpuprofile$/, '.json'))); } catch { /* already gone */ }
      }
    } catch { /* evidence is best effort; never take the gateway down over it */ }
    console.warn(`[stall] event loop blocked up to ${maxDelayMs} ms; hottest: ` +
      summary.top.slice(0, 5).map((t) => `${t.fn} ${t.where} ${t.selfMs}ms`).join(' | ') +
      (summary.file ? ` -- ${summary.file}` : ''));
  };
  const timer = setInterval(() => { void tick(); }, windowMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    delay.disable();
    void post('Profiler.stop').catch(() => {}).finally(() => session.disconnect());
  };
}
