import { describe, expect, it } from 'vitest';
import { withMessageSender, readMessageSender } from '../src/message-sender.js';
import { withMemoryContext, stripMemoryContext } from '../src/memory-context.js';
import { withAskInstructions, stripAskInstructions } from '../src/question.js';

const sender = { kind: 'conversation' as const, projectId: 'p', sessionId: 's', conversationTitle: 'Review <UI>', projectName: 'Client project', messageId: 'msg-1' };
describe('message sender envelope', () => {
  it('retains source alongside ASK and memory without changing visible message text', () => {
    const prompt = withMessageSender(withMemoryContext(withAskInstructions('Ready to review'), 'Context'), sender);
    const parsed = readMessageSender(prompt);
    expect(parsed.sender).toEqual(sender);
    expect(stripAskInstructions(stripMemoryContext(parsed.text))).toBe('Ready to review');
  });
  it('leaves human messages and slash commands untouched', () => {
    expect(withMessageSender('hello')).toBe('hello');
    expect(withMessageSender('/model gpt-6-astra', sender)).toBe('/model gpt-6-astra');
    expect(readMessageSender('hello')).toEqual({ text: 'hello' });
  });
  it('preserves malformed or oversized envelopes instead of deleting message text', () => {
    for (const raw of ['no json', '{"kind":"human"}', '{"kind":"mcp","projectName":42}', 'x'.repeat(9000)]) {
      const text = 'hello\n\n[x056 message sender v1] ' + raw;
      expect(readMessageSender(text)).toEqual({ text });
    }
  });
});
