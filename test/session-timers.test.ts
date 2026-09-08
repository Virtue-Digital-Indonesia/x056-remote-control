import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionTimerReader } from '../server/session-timers.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'session-timers-')); dirs.push(dir);
  const file = join(dir, 'session.jsonl'); writeFileSync(file, '');
  return { file, reader: new SessionTimerReader(), add: (...rows: unknown[]) => appendFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n') };
}
const call = (name = 'CronCreate', id = 'create', input: object = { cron: '0 12 8 9 *', prompt: 'Cutover at 19:00 WIB', recurring: false }) => ({ type: 'assistant', timestamp: '2026-09-08T09:33:35.586Z', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id = 'create', is_error = false, content: unknown = 'Scheduled one-shot task 578ed466 (0 12 8 9 *). Session-only (not written to disk, dies when Claude exits).') => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] } });

describe('provider session timer discovery', () => {
  it('finds the reported CronCreate format without claiming the timer is still scheduled', async () => {
    const f = fixture(); f.add(call(), result());
    const found = await f.reader.read(f.file);
    expect(found.jobs).toEqual([{ id: '578ed466', schedule: '0 12 8 9 *', prompt: 'Cutover at 19:00 WIB', recurring: false, createdAt: '2026-09-08T09:33:35.586Z', status: 'unverified', source: 'claude-session' }]);
    expect(await f.reader.read(f.file)).toEqual(found);
  });
  it('ignores plans, unconfirmed calls and failed creation', async () => {
    const f = fixture(); f.add({ type: 'assistant', message: { content: [{ type: 'text', text: 'Scheduled one-shot task 578ed466' }] } }, call());
    expect((await f.reader.read(f.file)).jobs).toEqual([]);
    f.add(result('create', true));
    expect((await f.reader.read(f.file)).jobs).toEqual([]);
  });
  it('recognizes recurring results without deriving an unproven next-run time', async () => {
    const f = fixture(); f.add(call('CronCreate', 'repeat', { cron: '*/5 * * * *', prompt: 'Check progress', recurring: true }), result('repeat', false, 'Scheduled recurring task repeat123 (*/5 * * * *).'));
    expect((await f.reader.read(f.file)).jobs[0]).toMatchObject({ id: 'repeat123', recurring: true, status: 'unverified' });
  });
  it('only removes a timer after a successful delete result', async () => {
    const f = fixture(); f.add(call(), result(), call('CronDelete', 'del', { id: '578ed466' }), result('del', true));
    expect((await f.reader.read(f.file)).jobs).toHaveLength(1);
    f.add(call('CronDelete', 'del2', { id: '578ed466' }));
    expect((await f.reader.read(f.file)).jobs).toHaveLength(1);
    f.add(result('del2', false, 'Deleted task 578ed466'));
    expect((await f.reader.read(f.file)).jobs).toEqual([]);
  });
  it('handles result blocks, repeated calls, and partial appends', async () => {
    const f = fixture(); f.add(call(), call());
    const row = JSON.stringify(result('create', false, [{ type: 'text', text: 'Scheduled one-shot task 578ed466 (0 12 8 9 *).' }]));
    appendFileSync(f.file, row.slice(0, 30));
    expect((await f.reader.read(f.file)).jobs).toEqual([]);
    appendFileSync(f.file, row.slice(30) + '\n');
    expect((await f.reader.read(f.file)).jobs).toHaveLength(1);
  });
  it('bounds oversized records and continues scanning after them', async () => {
    const f = fixture(); appendFileSync(f.file, 'x'.repeat(3 * 1024 * 1024) + '\nmalformed\n'); f.add(call(), result());
    const found = await f.reader.read(f.file);
    expect(found.jobs).toHaveLength(1); expect(found.incomplete).toBe(true);
  });
  it('resets cached state after truncation and ignores subagent events', async () => {
    const f = fixture(); f.add(call(), result()); await f.reader.read(f.file);
    writeFileSync(f.file, '');
    expect((await f.reader.read(f.file)).jobs).toEqual([]);
    f.add({ ...call(), parent_tool_use_id: 'parent' }, result());
    expect((await f.reader.read(f.file)).jobs).toEqual([]);
  });
});
