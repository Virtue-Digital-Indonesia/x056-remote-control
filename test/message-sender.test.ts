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
  it('keeps which ending a recap asked for, and refuses an unknown one', () => {
    const recap = { kind: 'recap' as const, recap: 'autopilot' as const, messageId: 'r1' };
    expect(readMessageSender(withMessageSender('Recap the run', recap))).toEqual({ text: 'Recap the run', sender: recap });
    const bad = 'hello\n\n[x056 message sender v1] ' + JSON.stringify({ kind: 'recap', recap: 'elsewhere' });
    expect(readMessageSender(bad)).toEqual({ text: bad });
  });
  it('preserves malformed or oversized envelopes instead of deleting message text', () => {
    for (const raw of ['no json', '{"kind":"human"}', '{"kind":"mcp","projectName":42}', 'x'.repeat(9000)]) {
      const text = 'hello\n\n[x056 message sender v1] ' + raw;
      expect(readMessageSender(text)).toEqual({ text });
    }
  });
});
