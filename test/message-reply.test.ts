import { describe, expect, it } from 'vitest';
import { findMessageReply } from '../server/message-reply.js';
import type { HistoryEntry } from '../src/provider.js';

const user = (messageId: string): HistoryEntry => ({ role: 'user', text: 'same prompt', sender: { kind: 'mcp', messageId } });
const reply = (text: string): HistoryEntry => ({ role: 'assistant', text });
describe('MCP exact-request reply tracking', () => {
  it('finds a reply in a full rolling page rather than comparing message counts', () => {
    const rows = [...Array.from({ length: 498 }, () => reply('old')), user('wanted'), reply('new')];
    expect(findMessageReply(() => ({ rows, cursor: 0, done: true }), 'wanted')).toMatchObject({ found: true, messages: [reply('new')], truncated: false });
  });
  it('finds the anchor on an older page and excludes later users’ replies', () => {
    const cursors: (number | undefined)[] = [];
    const out = findMessageReply(before => {
      cursors.push(before);
      return before === undefined
        ? { rows: [reply('answer'), user('other'), reply('unrelated')], cursor: 123, done: false }
        : { rows: [user('wanted')], cursor: 0, done: true };
    }, 'wanted');
    expect(cursors).toEqual([undefined, 123]);
    expect(out.messages).toEqual([reply('answer')]);
  });
  it('never treats another message’s answer as the requested reply', () => {
    expect(findMessageReply(() => ({ rows: [user('other'), reply('unrelated')], cursor: 0, done: true }), 'queued')).toEqual({ messageId: 'queued', found: false, messages: [], truncated: false });
  });
  it('distinguishes an unanswered anchor from a missing one', () => {
    expect(findMessageReply(() => ({ rows: [user('wanted'), user('other'), reply('unrelated')], cursor: 0, done: true }), 'wanted')).toMatchObject({ found: true, messages: [] });
  });
  it('bounds scans and exposes incomplete history, including stalled cursors', () => {
    let calls = 0;
    const out = findMessageReply(() => ({ rows: [], cursor: ++calls, done: false }), 'missing');
    expect(calls).toBe(10);
    expect(out).toMatchObject({ found: false, truncated: true });
    expect(findMessageReply(() => ({ rows: [], cursor: 2, done: false }), 'missing').truncated).toBe(true);
  });
  it('bounds reply output and does not swallow read failures', () => {
    const out = findMessageReply(() => ({ rows: [user('wanted'), reply('x'.repeat(110_000))], cursor: 0, done: true }), 'wanted');
    expect(out.messages[0].text).toHaveLength(100_000);
    expect(out.truncated).toBe(true);
    expect(() => findMessageReply(() => { throw new Error('cannot read'); }, 'wanted')).toThrow('cannot read');
  });
});
