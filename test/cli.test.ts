import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('switch with a stale pidfile (dead process) exits 2, reports it, and removes the pidfile (Finding 5)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-cli-switch-'));
    const init = run(['init'], dir);
    expect(init.status).toBe(0);

    // Spawn a process and wait for it to exit synchronously, so its pid is guaranteed dead
    // by the time we write it to the pidfile — more deterministic than guessing an
    // unlikely-live pid.
    const dead = spawnSync('node', ['-e', ''], { encoding: 'utf8' });
    const deadPid = dead.pid;
    expect(deadPid).toBeGreaterThan(0);

    const pidfile = join(dir, 'state', 'x056.pid');
    writeFileSync(pidfile, String(deadPid));

    const res = run(['switch'], dir);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('stale pidfile');
    expect(existsSync(pidfile)).toBe(false);
  }, TIMEOUT);
});

describe('x056 adopt', () => {
  it('copies the transcript from the interactive profile and updates state', () => {
    const home = mkdtempSync(join(tmpdir(), 'x056-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'x056-proj-'));
    const munged = proj.replace(/[/.]/g, '-');
    mkdirSync(join(home, '.claude', 'projects', munged), { recursive: true });
    writeFileSync(join(home, '.claude', 'projects', munged, 'sess-42.jsonl'), '{"type":"user"}\n');
    const env = { ...process.env, HOME: home };
    const init = spawnSync('npx', ['tsx', CLI, 'init'], { cwd: proj, encoding: 'utf8', timeout: TIMEOUT, env });
    expect(init.status).toBe(0);
    const adopt = spawnSync('npx', ['tsx', CLI, 'adopt', 'sess-42'], { cwd: proj, encoding: 'utf8', timeout: TIMEOUT, env });
    expect(adopt.status).toBe(0);
    expect(existsSync(join(home, '.claude-x056-a', 'projects', munged, 'sess-42.jsonl'))).toBe(true);
    const st = JSON.parse(readFileSync(join(proj, 'state', 'state.json'), 'utf8'));
    expect(st.lastSessionId).toBe('sess-42');
  });

  it('fails with exit 2 when the source transcript does not exist', () => {
    const home = mkdtempSync(join(tmpdir(), 'x056-home-'));
    const proj = mkdtempSync(join(tmpdir(), 'x056-proj-'));
    const env = { ...process.env, HOME: home };
    spawnSync('npx', ['tsx', CLI, 'init'], { cwd: proj, encoding: 'utf8', timeout: TIMEOUT, env });
    const adopt = spawnSync('npx', ['tsx', CLI, 'adopt', 'nope'], { cwd: proj, encoding: 'utf8', timeout: TIMEOUT, env });
    expect(adopt.status).toBe(2);
    expect(adopt.stderr).toContain('no transcript');
  });
});
