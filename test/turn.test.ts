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
      '--session-id', 'sid-1', '--', 'FAST task',
    ]);
    expect(events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
  });

  it('places the prompt after -- so a dash-leading prompt is not parsed as a flag', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-d', mode: 'resume', prompt: '- FAST bullet list item', onEvent,
    });
    await h.done;
    const init = events[0] as { argv: string[] };
    const dd = init.argv.indexOf('--');
    expect(dd).toBeGreaterThan(-1);
    // the prompt is the element immediately after '--', nothing between them
    expect(init.argv[dd + 1]).toBe('- FAST bullet list item');
    expect(init.argv[init.argv.length - 1]).toBe('- FAST bullet list item');
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

  it('resolves done with spawnError instead of crashing when the binary does not exist', async () => {
    const { onEvent } = collect();
    const h = startTurn({
      claudePath: '/nonexistent/x056-no-such-binary', configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-4', mode: 'new', prompt: 'anything', onEvent,
    });
    const exit = await h.done;
    expect(exit.spawnError).toMatch(/ENOENT/);
    expect(exit.code).toBeNull();
  });
});

describe('startTurn model/effort flags', () => {
  it('inserts --model and --effort before the session flag when provided', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-me', mode: 'new', prompt: 'FAST go', model: 'opus', effort: 'high', onEvent,
    });
    await h.done;
    const argv = (events[0] as { argv: string[] }).argv;
    expect(argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--model', 'opus', '--effort', 'high', '--session-id', 'sid-me', '--', 'FAST go',
    ]);
  });

  it('omits both flags when not provided', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({ claudePath: STUB, configDir: '/tmp/c', cwd: process.cwd(), sessionId: 's', mode: 'new', prompt: 'FAST', onEvent });
    await h.done;
    const argv = (events[0] as { argv: string[] }).argv;
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--effort');
  });
});

describe('startTurn appendSystemPrompt', () => {
  it('inserts --append-system-prompt before model/session flags when provided', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({ claudePath: STUB, configDir: '/tmp/c', cwd: process.cwd(), sessionId: 's', mode: 'new', prompt: 'FAST', appendSystemPrompt: 'NOTE-HERE', onEvent });
    await h.done;
    const argv = (events[0] as { argv: string[] }).argv;
    const i = argv.indexOf('--append-system-prompt');
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe('NOTE-HERE');
    expect(i).toBeLessThan(argv.indexOf('--session-id'));
  });
});
