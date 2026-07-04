import { describe, expect, it } from 'vitest';
import { startTurn } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

const STUB = new URL('./bin/stub-claude', import.meta.url).pathname;

function collect(): { events: RawEvent[]; onEvent: (e: RawEvent) => void } {
  const events: RawEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe('startTurn', () => {
  it('builds new-session args, passes CLAUDE_CONFIG_DIR, parses NDJSON, skips junk lines', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-1', mode: 'new', prompt: 'FAST task', onEvent,
    });
    const exit = await h.done;
    expect(exit.code).toBe(0);
    const init = events[0] as { argv: string[]; config_dir: string };
    expect(init.config_dir).toBe('/tmp/cfg-a');
    expect(init.argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--session-id', 'sid-1', 'FAST task',
    ]);
    expect(events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
  });

  it('builds resume args', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-b', cwd: process.cwd(),
      sessionId: 'sid-2', mode: 'resume', prompt: 'FAST continue', onEvent,
    });
    await h.done;
    const init = events[0] as { argv: string[] };
    expect(init.argv).toContain('--resume');
    expect(init.argv).toContain('sid-2');
    expect(init.argv).not.toContain('--session-id');
  });

  it('kill() terminates a hanging turn with SIGKILL', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-3', mode: 'new', prompt: 'slow task', onEvent,
    });
    // wait until the stub has emitted, then kill mid-"turn"
    await new Promise((r) => setTimeout(r, 300));
    h.kill();
    const exit = await h.done;
    expect(exit.signal).toBe('SIGKILL');
    expect(events.length).toBeGreaterThan(0);
  }, 10000);
});
