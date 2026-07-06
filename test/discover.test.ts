import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listInteractiveSessions, adoptFromInteractive } from '../server/discover.js';

function munge(cwd: string): string { return cwd.replace(/[/.]/g, '-'); }

describe('discover', () => {
  it('lists interactive sessions for a cwd with first message + count, newest first', () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-int-'));
    const cwd = '/home/efran/remote-development/obscura';
    const dir = join(root, munge(cwd)); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: 'first real message' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n'));
    // a command-wrapper user line should be skipped for the preview
    writeFileSync(join(dir, 's2.jsonl'), [
      JSON.stringify({ type: 'user', message: { content: '<command-name>/model</command-name>' } }),
      JSON.stringify({ type: 'user', message: { content: 'the actual ask' } }),
    ].join('\n'));
    const list = listInteractiveSessions(root, cwd);
    const ids = list.map((s) => s.id).sort();
    expect(ids).toEqual(['s1', 's2']);
    expect(list.find((s) => s.id === 's1')?.firstMessage).toBe('first real message');
    expect(list.find((s) => s.id === 's2')?.firstMessage).toBe('the actual ask');
  });

  it('returns empty for a cwd with no interactive history', () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-int-'));
    expect(listInteractiveSessions(root, '/nope')).toEqual([]);
  });

  it('adopts a transcript into the failover tree at the munged path', () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-int-'));
    const failover = mkdtempSync(join(tmpdir(), 'x056-fo-'));
    const cwd = '/home/efran/remote-development/poc-kyb';
    const dir = join(root, munge(cwd)); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'abc.jsonl'), '{"type":"user","message":{"content":"x"}}\n');
    adoptFromInteractive(root, failover, cwd, 'abc');
    expect(existsSync(join(failover, munge(cwd), 'abc.jsonl'))).toBe(true);
    expect(() => adoptFromInteractive(root, failover, cwd, 'missing')).toThrow(/not found/);
  });
});
