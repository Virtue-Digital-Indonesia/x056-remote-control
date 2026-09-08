import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import * as turns from '../src/turn.js';
import { generateTitle } from '../server/title-generator.js';
import { AccountRegistry } from '../src/accounts.js';
import { getAdapter } from '../src/adapters/registry.js';
import type { RawEvent } from '../src/types.js';
import type { ProviderId } from '../src/provider.js';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function setup(provider: ProviderId, events: RawEvent[]) {
  const dir = mkdtempSync(join(tmpdir(), 'title-generator-'));
  dirs.push(dir);
  const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'a', provider, configDir: join(dir, 'account') },
  ]);
  const killed = vi.fn();
  const spawn = vi
    .spyOn(turns, 'spawnJsonlTurn')
    .mockImplementation((_bin, _args, _cwd, _env, onEvent) => {
      let resolve!: (r: turns.TurnExit) => void;
      const done = new Promise<turns.TurnExit>((r) => {
        resolve = r;
      });
      queueMicrotask(() => {
        for (const event of events) onEvent(event);
        resolve({ code: 0, signal: null });
      });
      return {
        kill: () => {
          killed();
          resolve({ code: null, signal: 'SIGKILL' });
        },
        interrupt: () => {},
        done,
      };
    });
  return {
    registry,
    spawn,
    killed,
    input: {
      account: registry.get('a'),
      registry,
      provider,
      prompt: '{"messages":[{"role":"user","text":"Fix keyboard navigation"}]}',
      stateDir: dir,
      signal: new AbortController().signal,
    },
  };
}
it('runs a Claude naming request without working-chat tools, hooks, MCP or a persisted session', async () => {
  const f = setup('claude', [
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      structured_output: { title: 'Keyboard navigation improvements' },
    },
  ]);
  expect(await generateTitle(f.input)).toBe('Keyboard navigation improvements');
  const [bin, args, cwd, env] = f.spawn.mock.calls[0];
  expect(bin).toBe('claude');
  expect(args).toEqual(
    expect.arrayContaining([
      '--restricted',
      '--tools',
      '',
      '--strict-mcp-config',
      '--no-session-persistence',
      '--disable-slash-commands',
    ]),
  );
  expect(args).not.toContain('--resume');
  expect(args).not.toContain('--dangerously-skip-permissions');
  expect(cwd).toBe(join(f.input.stateDir, 'title-worker'));
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.input.account.configDir);
});
it('runs an isolated Codex request and extracts its final JSON answer', async () => {
  const f = setup('codex', [
    {
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"title":"Keyboard navigation improvements"}' },
    },
    { type: 'turn.completed', usage: { input_tokens: 90, output_tokens: 10 } },
  ]);
  expect(await generateTitle(f.input)).toBe('Keyboard navigation improvements');
  const [bin, args, , env] = f.spawn.mock.calls[0];
  expect(bin).toBe('codex');
  expect(args).toEqual(
    expect.arrayContaining([
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--disable',
      'shell_tool',
      'plugins',
      'apps',
      'multi_agent',
      '--output-schema',
    ]),
  );
  expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  expect(env.CODEX_HOME).toBe(f.input.account.configDir);
});
it('records a quota failure without benching unrelated accounts', async () => {
  const f = setup('claude', [{ type: 'limited' }]);
  vi.spyOn(getAdapter('claude'), 'classify').mockReturnValue({
    kind: 'limited',
    source: 'test',
    resetsInSeconds: 60,
  });
  await expect(generateTitle(f.input)).rejects.toThrow('usage limit');
  expect(f.registry.get('a').state.kind).toBe('limited');
  expect(f.killed).toHaveBeenCalled();
});
it('rejects tool activity and invalid final output instead of accepting it as a title', async () => {
  const f = setup('codex', [
    { type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'do not run' } },
    { type: 'turn.completed' },
  ]);
  await expect(generateTitle(f.input)).rejects.toThrow('use tools');
  expect(f.killed).toHaveBeenCalled();
});
