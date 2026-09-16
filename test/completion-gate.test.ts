import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompletionGate } from '../server/completion-gate.js';

afterEach(() => vi.useRealTimers());
describe('conversation completion notification gate', () => {
  it('waits for parent and descendants to stop, then emits once after stable idle', () => {
    vi.useFakeTimers(); let busy = true; const send = vi.fn();
    const gate = new CompletionGate(() => busy, send);
    gate.queue('s', { sessionId: 's', completionPending: true });
    vi.advanceTimersByTime(10000); expect(send).not.toHaveBeenCalled();
    busy = false; vi.advanceTimersByTime(1500); expect(send).not.toHaveBeenCalled();
    busy = true; vi.advanceTimersByTime(1000); expect(send).not.toHaveBeenCalled();
    busy = false; vi.advanceTimersByTime(3000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ sessionId: 's', completionPending: false });
    vi.advanceTimersByTime(10000); expect(send).toHaveBeenCalledTimes(1); gate.close();
  });
  it('resets quiet time when a child wakes the parent before the next tick', () => {
    vi.useFakeTimers(); const send = vi.fn(); const gate = new CompletionGate(() => false, send);
    gate.queue('s', {}); vi.advanceTimersByTime(1500); gate.touch('s');
    vi.advanceTimersByTime(1500); expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); expect(send).toHaveBeenCalledTimes(1); gate.close();
  });
  it('cancels old completion on a new user turn, error, question or shutdown', () => {
    vi.useFakeTimers(); const send = vi.fn(); const gate = new CompletionGate(() => false, send);
    gate.queue('s', {}); gate.cancel('s'); vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
    gate.queue('s', {}); gate.close(); vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
  });
});
