import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The SSE `accounts` event fires on every turn start and end, in every tab.
// The panel collapses those into one poll per 3 s, only while visible, and
// without refetching the model catalog. This runs the panel's own code.
const html = readFileSync(join(__dirname, '..', 'server', 'public', 'panel.html'), 'utf8');
const start = html.indexOf('  var accountsSoonTimer = null;');
const end = html.indexOf('\n  }\n', html.indexOf('function pollAccountsSoon()')) + 4;

function load(hidden: { value: boolean }) {
  const polls: unknown[] = [];
  const missed: Record<string, () => void> = {};
  const whenVisible = (name: string, fn: () => void) => () => { if (hidden.value) { missed[name] = fn; return; } fn(); };
  const pollAccounts = (opts?: unknown) => { polls.push(opts); };
  const soon = new Function('whenVisible', 'pollAccounts', html.slice(start, end) + '\nreturn pollAccountsSoon;')(whenVisible, pollAccounts) as () => void;
  return { soon, polls, missed };
}

describe('panel: event-driven account polls', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('collapses a burst into one poll without the model catalog', () => {
    expect(start).toBeGreaterThan(0);
    vi.useFakeTimers();
    const { soon, polls } = load({ value: false });
    for (let i = 0; i < 10; i++) soon();
    expect(polls).toHaveLength(0);
    vi.advanceTimersByTime(3000);
    expect(polls).toEqual([{ models: false }]);
    soon(); vi.advanceTimersByTime(3000);
    expect(polls).toHaveLength(2);
  });

  it('a hidden tab polls only once it is shown again', () => {
    vi.useFakeTimers();
    const hidden = { value: true };
    const { soon, polls, missed } = load(hidden);
    soon(); vi.advanceTimersByTime(3000);
    expect(polls).toHaveLength(0);
    expect(Object.keys(missed)).toEqual(['accounts-event']);
    missed['accounts-event']();
    expect(polls).toEqual([{ models: false }]);
  });
});
