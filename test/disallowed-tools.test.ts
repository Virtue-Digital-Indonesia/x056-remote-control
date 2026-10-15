import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { runSession } from '../src/failover.js';
import { ClaudeTransport, hashText } from '../src/persistent-transport.js';
import { CodexTransport } from '../src/persistent-codex.js';
import { disallowedToolsArgs, startTurn } from '../src/turn.js';
import type { TurnHandle, TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

const STUB = new URL('./bin/stub-claude', import.meta.url).pathname;

function base(extra: Partial<TurnOptions> = {}): TurnOptions {
  return {
    configDir: '/tmp/cfg-a', cwd: '/tmp', sessionId: 'sid-1', conversationId: 'conv-1',
    mode: 'new', prompt: 'hello', model: 'opus', effort: 'high', onEvent: () => {}, ...extra,
  };
}

/** The element after `--disallowedTools`'s value must be a flag (or nothing), so the variadic option cannot swallow it. */
function expectNothingSwallowable(argv: string[]): void {
  const i = argv.indexOf('--disallowedTools');
  expect(i).toBeGreaterThan(-1);
  const next = argv[i + 2];
  expect(next === undefined || next.startsWith('--')).toBe(true);
}

describe('disallowedToolsArgs', () => {
  it('is one comma-joined value, trimmed and deduped', () => {
    expect(disallowedToolsArgs(['Bash', ' Edit ', 'Bash', ''])).toEqual(['--disallowedTools', 'Bash,Edit']);
  });
  it('is nothing for absent or empty', () => {
    expect(disallowedToolsArgs(undefined)).toEqual([]);
    expect(disallowedToolsArgs([])).toEqual([]);
    expect(disallowedToolsArgs(['  '])).toEqual([]);
  });
});

describe('one-shot Claude argv (startTurn)', () => {
  async function argvOf(extra: Partial<TurnOptions>): Promise<string[]> {
    const events: RawEvent[] = [];
    const h = startTurn({ ...base({ claudePath: STUB, cwd: process.cwd(), prompt: 'FAST go', ...extra }), onEvent: (e) => events.push(e) });
    await h.done;
    return (events[0] as { argv: string[] }).argv;
  }

  it('places --disallowedTools right before the session flag (new)', async () => {
    const argv = await argvOf({ disallowedTools: ['Bash', 'Edit'], subagents: '{"x":{}}' });
    expect(argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--model', 'opus', '--effort', 'high', '--agents', '{"x":{}}',
      '--disallowedTools', 'Bash,Edit', '--session-id', 'sid-1', '--', 'FAST go',
    ]);
    expectNothingSwallowable(argv);
  });

  it('and before --resume on a resume, with a non-dash prompt still after --', async () => {
    const argv = await argvOf({ mode: 'resume', disallowedTools: ['Bash'], prompt: 'FAST plain words' });
    expect(argv.slice(-6)).toEqual(['--disallowedTools', 'Bash', '--resume', 'sid-1', '--', 'FAST plain words']);
    expectNothingSwallowable(argv);
  });

  it('emits nothing when absent or empty', async () => {
    expect(await argvOf({})).not.toContain('--disallowedTools');
    expect(await argvOf({ disallowedTools: [] })).not.toContain('--disallowedTools');
  });
});

describe('persistent Claude transport', () => {
  const t = new ClaudeTransport();

  it('spawnSpec places --disallowedTools right before the session flag', () => {
    const argv = t.spawnSpec(base({ disallowedTools: ['Bash', 'Edit'], mcp: { configPath: '/m.json', command: 'node', args: [], env: {} } })).args;
    const i = argv.indexOf('--disallowedTools');
    expect(argv.slice(i)).toEqual(['--disallowedTools', 'Bash,Edit', '--session-id', 'sid-1']);
    expectNothingSwallowable(argv);
    const r = t.spawnSpec(base({ mode: 'resume', disallowedTools: ['Bash'] })).args;
    expect(r.slice(r.indexOf('--disallowedTools'))).toEqual(['--disallowedTools', 'Bash', '--resume', 'sid-1']);
  });

  it('spawnSpec emits nothing when absent or empty', () => {
    expect(t.spawnSpec(base()).args).not.toContain('--disallowedTools');
    expect(t.spawnSpec(base({ disallowedTools: [] })).args).not.toContain('--disallowedTools');
  });

  it('identity is byte-identical to the old key when absent or empty', () => {
    const o = base({ advisor: 'opus', subagents: 'S', appendSystemPrompt: 'NOTE', mcp: { configPath: '/m.json', command: 'node', args: [], env: {} } });
    // The pre-change formula, verbatim.
    const legacy = [o.configDir, o.conversationId, o.model, o.effort, o.advisor, hashText('S'), '/m.json', hashText('NOTE')].join('\0');
    expect(t.identity(o)).toBe(legacy);
    expect(t.identity(o).split('\0')).toHaveLength(8);
    expect(t.identity({ ...o, disallowedTools: [] })).toBe(t.identity(o));
    expect(t.identity({ ...o, disallowedTools: ['  '] })).toBe(t.identity(o));
  });

  it('identity differs when a deny list is set, and per list', () => {
    const o = base();
    const a = t.identity({ ...o, disallowedTools: ['Bash', 'Edit'] });
    const b = t.identity({ ...o, disallowedTools: ['Bash'] });
    expect(a).not.toBe(t.identity(o));
    expect(a).not.toBe(b);
    // Order and duplicates do not make a different process.
    expect(t.identity({ ...o, disallowedTools: ['Edit', 'Bash', 'Bash'] })).toBe(a);
  });
});

describe('Codex ignores disallowedTools', () => {
  it('no identity change', () => {
    const t = new CodexTransport();
    const o = base();
    expect(t.identity({ ...o, disallowedTools: ['Bash', 'Edit'] })).toBe(t.identity(o));
  });
});

describe('runSession passes disallowedTools through', () => {
  it('reaches the TurnOptions given to startTurnFn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-dt-'));
    const registry = AccountRegistry.init(join(dir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const log = new EventLog(join(dir, 'events.jsonl'));
    const seen: TurnOptions[] = [];
    const startTurnFn = (opts: TurnOptions): TurnHandle => {
      seen.push(opts);
      const done = (async () => {
        opts.onEvent({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'ok' });
        return { code: 0, signal: null };
      })();
      return { kill: () => {}, interrupt: () => {}, done };
    };
    const res = await runSession({
      registry, log, sessionId: 'sid-x', cwd: '/tmp', prompt: 'p', forceSwitchSignal: false, now: () => 100,
      disallowedTools: ['Bash', 'Edit'], startTurnFn,
    });
    expect(res.status).toBe('completed');
    expect(seen[0].disallowedTools).toEqual(['Bash', 'Edit']);
  });
});
