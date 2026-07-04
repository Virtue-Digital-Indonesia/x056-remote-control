import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const TIMEOUT = 30_000;

function run(args: string[], cwd: string) {
  return spawnSync('npx', ['tsx', CLI, ...args], { cwd, encoding: 'utf8', timeout: TIMEOUT });
}

describe('cli (child process)', () => {
  it('init writes state/accounts.json with accounts a and b using the expected configDirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-cli-init-'));
    const res = run(['init'], dir);
    expect(res.status).toBe(0);

    const accounts = JSON.parse(readFileSync(join(dir, 'state', 'accounts.json'), 'utf8')) as {
      active: string;
      accounts: { name: string; configDir: string }[];
    };
    expect(accounts.accounts.map((a) => a.name)).toEqual(['a', 'b']);
    expect(accounts.accounts.find((a) => a.name === 'a')?.configDir).toBe(join(homedir(), '.claude-x056-a'));
    expect(accounts.accounts.find((a) => a.name === 'b')?.configDir).toBe(join(homedir(), '.claude-x056-b'));
  }, TIMEOUT);

  it('continue with no previous session exits 2 with a graceful message (Finding 1)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-cli-continue-'));
    const init = run(['init'], dir);
    expect(init.status).toBe(0);

    const res = run(['continue', 'x'], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('no previous session');
  }, TIMEOUT);

  it('run parks without ever spawning a turn when both accounts are limited, preserving lastSessionId (Finding 3)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-cli-park-'));
    const init = run(['init'], dir);
    expect(init.status).toBe(0);

    const stateDir = join(dir, 'state');
    const farFuture = Math.floor(Date.now() / 1000) + 10_000_000;
    writeFileSync(
      join(stateDir, 'accounts.json'),
      JSON.stringify({
        active: 'a',
        accounts: [
          { name: 'a', configDir: join(dir, 'cfg-a'), state: { kind: 'limited', until: farFuture } },
          { name: 'b', configDir: join(dir, 'cfg-b'), state: { kind: 'limited', until: farFuture } },
        ],
      }),
    );
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ lastSessionId: 'original-sid' }));

    const res = run(['run', 'task'], dir);
    expect(res.status).toBe(3);

    const state = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as { lastSessionId?: string };
    expect(state.lastSessionId).toBe('original-sid');
  }, TIMEOUT);
});
