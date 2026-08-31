import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Token totals and Task outcomes, read straight out of a transcript.
 *
 * Both answers live in the same file, so they are gathered in ONE pass:
 *
 *  - every assistant entry carries `message.usage` and `message.model`, so the
 *    tokens a conversation (or a subagent) actually spent are recorded, not
 *    estimated;
 *  - a `tool_use` for Task and its later `tool_result` bracket a subagent, which
 *    is the only DEFINITIVE "did it come back" signal — the alternative, guessing
 *    from file mtime, calls a subagent that is thinking hard "finished".
 *
 * Scanning is INCREMENTAL and cached. These transcripts reach 627MB here, so
 * re-reading one per request is not an option: the cache keeps a byte offset and
 * the running totals, and a later call only reads what was appended since.
 */

export const TRANSCRIPT_STATS = Symbol('x056-transcript-stats');

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Per model, so a session that switched models can still be priced. */
  byModel: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  /** Assistant responses counted — the denominator for "per message" figures. */
  messages: number;
}

export interface TaskOutcome {
  toolUseId: string;
  description: string;
  /** True once the parent recorded a tool_result for it. */
  done: boolean;
  /** What it handed back, truncated. Absent while it is still running. */
  result?: string;
  isError?: boolean;
  startedAt?: string;
  endedAt?: string;
}

export interface TranscriptStats {
  usage: TokenUsage;
  tasks: Record<string, TaskOutcome>;
  /** True while bytes remain unread — the totals are still climbing. */
  partial: boolean;
  /** Bytes accounted for so far, from the start of the file. */
  scanned: number;
  size: number;
}

interface CacheEntry extends TranscriptStats { offset: number }

/**
 * List API prices per MILLION tokens, for orientation only.
 *
 * These accounts are Claude Max — a flat subscription — so a dollar figure here
 * is what the same work would have cost on the API, not what was billed. An
 * unknown model is priced at null rather than guessed, so a new model shows its
 * tokens and no invented number.
 */
const PRICES: Record<string, { in: number; out: number }> = {
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 0.8, out: 4 },
};

function priceFor(model: string): { in: number; out: number } | null {
  const m = model.toLowerCase();
  for (const key of Object.keys(PRICES)) if (m.includes(key)) return PRICES[key];
  return null;
}

/**
 * Estimated API cost, plus the models it could NOT price.
 *
 * Returning a single nullable number was worse in both directions: one unknown
 * model blanked the whole figure, and Claude Code's `<synthetic>` pseudo-model
 * (which carries no tokens at all) counted as unknown. Naming the gap lets the
 * UI show "≈$4.20 excl. fable-5" instead of nothing.
 */
export function estimateCost(u: TokenUsage): { usd: number; unpriced: string[] } {
  let usd = 0;
  const unpriced: string[] = [];
  for (const [model, t] of Object.entries(u.byModel)) {
    if (!(t.input + t.output + t.cacheRead + t.cacheWrite)) continue; // e.g. <synthetic>
    const p = priceFor(model);
    if (!p) { unpriced.push(model); continue; }
    // Cache reads bill at a tenth of input; 5-minute cache writes at 1.25x.
    usd += (t.input * p.in + t.cacheRead * p.in * 0.1 + t.cacheWrite * p.in * 1.25 + t.output * p.out) / 1e6;
  }
  return { usd, unpriced };
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: {}, messages: 0 });

/**
 * Bytes read per call. The totals are for the WHOLE file — a capped scan that
 * silently ignored the first 600MB of a 627MB transcript answered a different
 * question than the one being asked — but reading 627MB takes 10.3s at 61MB/s,
 * which cannot happen inside one request. So a big file is read across several
 * calls: each does a bounded amount of work, reports itself as `partial`, and
 * resumes where it stopped. Poll and the figure converges to the exact total.
 */
const SCAN_BUDGET = 24 * 1024 * 1024;

/**
 * Bumped when the meaning of a cached entry changes. v1 entries began mid-file
 * (the old 32MB tail cap), so their totals are not comparable with these and
 * are discarded rather than shown as if they were whole-file numbers.
 */
const CACHE_VERSION = 2;
const CHUNK = 4 * 1024 * 1024;
const MAX_RESULT_CHARS = 4000;
const MAX_TASKS = 400;
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export class TranscriptStatsReader {
  private cache = new Map<string, CacheEntry>();

  constructor(private readonly stateDir: string) { this.load(); }

  private get file(): string { return join(this.stateDir, 'transcript-stats.json'); }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { v?: number; entries?: Record<string, CacheEntry> };
      if (raw?.v !== CACHE_VERSION || !raw.entries) return; // older shape: rescan
      for (const [k, v] of Object.entries(raw.entries)) this.cache.set(k, v);
    } catch { /* first run */ }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, entries: Object.fromEntries(this.cache) }));
      renameSync(tmp, this.file);
    } catch { /* the cache is an optimisation; losing it only costs a rescan */ }
  }

  /**
   * Totals for one transcript, reading at most `budget` bytes this call.
   *
   * Always starts at byte 0 — the number is for the whole file. A large one
   * simply takes several calls to get there, and says so via `partial` until it
   * does.
   */
  statsFor(path: string, budget = SCAN_BUDGET): TranscriptStats {
    let size: number;
    try { size = fstatSyncSize(path); } catch { return { usage: emptyUsage(), tasks: {}, partial: false, scanned: 0, size: 0 }; }

    let entry = this.cache.get(path);
    // A smaller file than we last saw is a different file (rotated, or the
    // session was rewritten): the cached totals describe bytes that are gone.
    if (entry && entry.size > size) entry = undefined;

    if (!entry) entry = { usage: emptyUsage(), tasks: {}, partial: size > 0, scanned: 0, size: 0, offset: 0 };
    else if (entry.offset >= size) return strip(entry); // nothing new, and complete

    const end = this.scan(path, entry, size, budget);
    entry.offset = end;
    entry.size = size;
    entry.scanned = end;
    entry.partial = end < size;
    this.cache.set(path, entry);
    this.save();
    return strip(entry);
  }

  /**
   * What is already known about a transcript, WITHOUT scanning it.
   *
   * A cross-conversation total must not trigger a cold scan of every session:
   * 52 transcripts here come to 587MB even with the 32MB cap, which is ~10s of
   * synchronous work. This lets a caller take the free answers and budget the
   * rest.
   */
  cached(path: string): TranscriptStats | null {
    const e = this.cache.get(path);
    if (!e) return null;
    // Cached totals describe bytes that may since have been replaced.
    try { if (fstatSyncSize(path) < e.size) return null; } catch { return null; }
    return strip(e);
  }

  /** Read [entry.offset, size) in chunks, folding each complete line in. */
  private scan(path: string, entry: CacheEntry, size: number, budget: number): number {
    let fd: number | undefined;
    let pos = entry.offset;
    // Floor the budget rather than rounding it up to a whole CHUNK: a 4MB floor
    // made every small budget read the entire file. 64KB still guarantees
    // progress past any single line, so the offset can never stall.
    const stopAt = Math.min(size, pos + Math.max(budget, 64 * 1024));
    let carry = '';
    try {
      fd = openSync(path, 'r');
      const buf = Buffer.allocUnsafe(CHUNK);
      while (pos < stopAt) {
        const want = Math.min(CHUNK, stopAt - pos);
        const got = readSync(fd, buf, 0, want, pos);
        if (got <= 0) break;
        pos += got;
        const text = carry + buf.toString('utf8', 0, got);
        const lines = text.split('\n');
        carry = lines.pop() ?? ''; // last piece may be a partial line
        for (const line of lines) this.fold(entry, line);
      }
    } catch {
      return entry.offset; // leave the offset where it was; try again next call
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    }
    // Stop at the last COMPLETE line so the next scan resumes on a boundary.
    return pos - Buffer.byteLength(carry, 'utf8');
  }

  private fold(entry: CacheEntry, line: string): void {
    if (!line || line.charCodeAt(0) !== 0x7b) return; // not a JSON object
    // Most of a transcript by BYTE is tool_result bodies — whole files that were
    // read. JSON.parsing all of them is what made a full scan slow, and none of
    // them carry usage. Decide from the raw text whether the line can matter.
    const hasUsage = line.includes('"usage"');
    const hasTask = line.includes('"tool_use"') && (line.includes('"Task"') || line.includes('"Agent"'));
    let hasResult = false;
    if (!hasUsage && !hasTask && line.includes('"tool_result"')) {
      // Pull just the id out; only a result for a Task we are tracking is worth
      // parsing, and there are far fewer of those than there are tool results.
      const m = /"tool_use_id":"([^"]+)"/.exec(line);
      hasResult = !!(m && entry.tasks[m[1]]);
    }
    if (!hasUsage && !hasTask && !hasResult) return;
    let d: Record<string, unknown>;
    try { d = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    const msg = d.message as { usage?: Record<string, unknown>; model?: string; content?: unknown } | undefined;
    const ts = typeof d.timestamp === 'string' ? d.timestamp : undefined;

    if (d.type === 'assistant' && msg?.usage) {
      const u = msg.usage;
      const model = typeof msg.model === 'string' ? msg.model : 'unknown';
      const inp = num(u.input_tokens);
      const out = num(u.output_tokens);
      const cr = num(u.cache_read_input_tokens);
      const cw = num(u.cache_creation_input_tokens);
      entry.usage.input += inp;
      entry.usage.output += out;
      entry.usage.cacheRead += cr;
      entry.usage.cacheWrite += cw;
      entry.usage.messages += 1;
      const m = (entry.usage.byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      m.input += inp; m.output += out; m.cacheRead += cr; m.cacheWrite += cw;
    }

    const content = msg?.content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const b = raw as Record<string, unknown>;
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_use' && SUBAGENT_TOOLS.has(String(b.name))) {
        const id = String(b.id ?? '');
        if (!id) continue;
        const input = (b.input ?? {}) as Record<string, unknown>;
        entry.tasks[id] = {
          toolUseId: id,
          description: String(input.description ?? '').slice(0, 300),
          done: false,
          startedAt: ts,
        };
        // Bound the cache: a long session can spawn hundreds.
        const ids = Object.keys(entry.tasks);
        if (ids.length > MAX_TASKS) delete entry.tasks[ids[0]];
      } else if (b.type === 'tool_result') {
        const id = String(b.tool_use_id ?? '');
        const task = id && entry.tasks[id];
        if (!task) continue; // a result for some other tool — not ours to keep
        task.done = true;
        task.endedAt = ts;
        task.isError = b.is_error === true ? true : undefined;
        task.result = resultText(b.content).slice(0, MAX_RESULT_CHARS);
      }
    }
  }
}

function num(v: unknown): number { return typeof v === 'number' && isFinite(v) ? v : 0; }

function fstatSyncSize(path: string): number {
  const fd = openSync(path, 'r');
  try { return fstatSync(fd).size; } finally { closeSync(fd); }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

/** The cache carries an offset the callers have no use for. */
function strip(e: CacheEntry): TranscriptStats {
  return { usage: e.usage, tasks: e.tasks, partial: e.partial, scanned: e.scanned, size: e.size };
}
