import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

/** A transcript proves creation, not that a provider's in-memory timer still exists. */
export interface SessionTimer {
  id: string;
  schedule: string;
  prompt: string;
  recurring: boolean;
  createdAt?: string;
  status: 'unverified';
  source: 'claude-session';
}
interface Scan {
  inode: number; offset: number; tail: Buffer; skipping: boolean; skipped: number;
  pending: Map<string, { name: string; input: Record<string, unknown>; at?: string }>;
  jobs: Map<string, SessionTimer>;
}
const MAX_LINE = 2 * 1024 * 1024;

/** Incremental, read-only discovery. Never imports a timer into the scheduler. */
export class SessionTimerReader {
  private cache = new Map<string, Scan>();
  private reading = new Map<string, Promise<{ jobs: SessionTimer[]; incomplete: boolean }>>();

  read(file: string) {
    const pending = this.reading.get(file);
    if (pending) return pending;
    const result = this.scan(file).finally(() => this.reading.delete(file));
    this.reading.set(file, result);
    return result;
  }

  private async scan(file: string) {
    const info = await stat(file);
    let state = this.cache.get(file);
    if (!state || state.inode !== info.ino || info.size < state.offset) {
      state = { inode: info.ino, offset: 0, tail: Buffer.alloc(0), skipping: false, skipped: 0, pending: new Map(), jobs: new Map() };
      this.cache.set(file, state);
    }
    if (state.offset < info.size) {
      // Fixed end avoids chasing a growing transcript indefinitely.
      for await (const chunk of createReadStream(file, { start: state.offset, end: info.size - 1, highWaterMark: 64 * 1024 })) {
        const bytes = chunk as Buffer;
        state.offset += bytes.length;
        let start = 0;
        for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
          this.part(state, bytes.subarray(start, end), true);
          start = end + 1;
        }
        this.part(state, bytes.subarray(start), false);
      }
    }
    return { jobs: [...state.jobs.values()], incomplete: state.skipped > 0 };
  }

  private part(state: Scan, bytes: Buffer, end: boolean) {
    if (!state.skipping) {
      if (state.tail.length + bytes.length > MAX_LINE) {
        state.skipping = true;
        state.skipped++;
        state.tail = Buffer.alloc(0);
      } else state.tail = Buffer.concat([state.tail, bytes]);
    }
    if (!end) return;
    if (!state.skipping) this.line(state, state.tail.toString('utf8'));
    state.tail = Buffer.alloc(0);
    state.skipping = false;
  }

  private line(state: Scan, line: string) {
    if (!line.includes('CronCreate') && !line.includes('CronDelete') &&
        ![...state.pending.keys()].some(id => line.includes(id))) return;
    let row;
    try { row = JSON.parse(line); } catch { return; }
    if (row.parent_tool_use_id || row.isSidechain) return;
    const blocks = row.message?.content;
    if (!Array.isArray(blocks)) return;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (row.type === 'assistant' && block.type === 'tool_use' && ['CronCreate', 'CronDelete'].includes(block.name) && typeof block.id === 'string') {
        state.pending.set(block.id, { name: block.name, input: block.input || {}, at: typeof row.timestamp === 'string' ? row.timestamp : undefined });
      } else if (row.type === 'user' && block.type === 'tool_result') {
        const call = state.pending.get(block.tool_use_id);
        if (!call) continue;
        state.pending.delete(block.tool_use_id);
        if (block.is_error) continue;
        if (call.name === 'CronDelete') {
          if (typeof call.input.id === 'string') state.jobs.delete(call.input.id);
          continue;
        }
        const result = typeof block.content === 'string' ? block.content :
          Array.isArray(block.content) ? block.content.filter((b: {type: string}) => b.type === 'text').map((b: {text: string}) => b.text).join('\n') : '';
        const id = /Scheduled\s+(?:(?:one-shot|recurring)\s+)?task\s+([a-zA-Z0-9_-]+)/i.exec(result)?.[1];
        if (!id || typeof call.input.cron !== 'string' || typeof call.input.prompt !== 'string') continue;
        state.jobs.set(id, { id, schedule: call.input.cron, prompt: call.input.prompt, recurring: call.input.recurring !== false, createdAt: call.at, status: 'unverified', source: 'claude-session' });
      }
    }
  }
}
