import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../scripts/deployer.sh', import.meta.url), 'utf8');
// Evaluate only the gate with stubbed token/curl functions. Never run Docker,
// touch a deploy request, or contact the real gateway from a test.
const busy = source.slice(source.indexOf('busy() {'), source.indexOf('\n# Echo a one-line'));
function gate(snapshot: string, opts: { token?: string; failure?: boolean; idleOnly?: boolean } = {}) {
  const code = `token() { printf '%s' "$FIXTURE_TOKEN"; }
  curl() { [ "$FIXTURE_FAILURE" != 1 ] || return 1; printf '%s' "$FIXTURE_SNAPSHOT"; }
  ${busy}
  if busy; then printf busy; else printf idle; fi`;
  return execFileSync('bash', ['-c', code], { encoding: 'utf8', env: {
    ...process.env, IDLE_ONLY: opts.idleOnly === false ? '0' : '1', PORT: '0',
    FIXTURE_TOKEN: opts.token ?? 'fixture', FIXTURE_FAILURE: opts.failure ? '1' : '0', FIXTURE_SNAPSHOT: snapshot,
  } });
}
describe('idle-only release gate', () => {
  // The swap gate as the script runs it: re-check every POLL_EVERY seconds for
  // up to POLL_WINDOW inside one tick (sleep 0 here, so the test is instant).
  const waitLoop = (setup: string, env = 'X056_DEPLOY_POLL_EVERY=0 X056_DEPLOY_POLL_WINDOW=3') => {
    const decision = source.slice(source.indexOf('  # 2+3.'), source.indexOf('  if ! release_unchanged; then'));
    const dir = mkdtempSync(join(tmpdir(), 'x056-deploy-gate-'));
    try {
      writeFileSync(join(dir, 'requested'), '');
      return execFileSync('bash', ['-c', `export ${env}; IDLE_ONLY=1; age=86400; DIR=${dir}; FLAG=${dir}/requested; FORCE=${dir}/force
        n=0; live_workflows() { :; }; ${setup}
        ${decision}
        echo WOULD_SWAP`], { encoding: 'utf8' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  };
  it('never reaches the swap while activity is present, however long it waits', () => {
    const output = waitLoop('busy() { return 0; }');
    expect(output).toContain('release stays pending (checked every 0s for 3s');
    expect(output).not.toContain('WOULD_SWAP');
  });
  it('swaps as soon as a later poll finds the gateway idle', () => {
    const output = waitLoop('busy() { n=$((n+1)); [ "$n" -lt 3 ]; }');
    expect(output).toContain('gateway idle after 2s of polling');
    expect(output).toContain('WOULD_SWAP');
  });
  it('honours a force created while it waits, within one poll', () => {
    const output = waitLoop('busy() { n=$((n+1)); [ "$n" -ge 2 ] && touch "$FORCE"; return 0; }');
    expect(output).toContain('.deploy/force present');
    expect(output).toContain('WOULD_SWAP');
  });
  it('stops waiting when the request is withdrawn', () => {
    const output = waitLoop('busy() { rm -f "$FLAG"; return 0; }');
    expect(output).toContain('request withdrawn while waiting');
    expect(output).not.toContain('WOULD_SWAP');
  });
  it('a live workflow keeps it pending too', () => {
    const output = waitLoop('busy() { return 1; }; live_workflows() { echo "1 run"; }');
    expect(output).toContain('workflow runs still live: 1 run');
    expect(output).not.toContain('WOULD_SWAP');
  });
  it('allows a confirmed idle gateway', () => {
    expect(gate(JSON.stringify({ running: false, runningProjects: [], backgroundProjects: [] }))).toBe('idle');
  });
  it.each([
    { running: true, runningProjects: ['fixture'], backgroundProjects: [] },
    { running: false, runningProjects: [], backgroundProjects: ['fixture'] },
    { running: false }, {}, null,
  ])('keeps activity or incomplete information pending: %j', snapshot => {
    expect(gate(JSON.stringify(snapshot))).toBe('busy');
  });
  it('fails closed on missing credentials, unreadable responses and request failures', () => {
    expect(gate('{}', { token: '' })).toBe('busy');
    expect(gate('not JSON')).toBe('busy');
    expect(gate('{}', { failure: true })).toBe('busy');
  });
  it('retains the default gate for other releases', () => {
    expect(gate('{"running":true}', { idleOnly: false })).toBe('busy');
    expect(gate('{"running":false}', { idleOnly: false })).toBe('idle');
  });
});

describe('offline Project release snapshot', () => {
  const functions = source.slice(source.indexOf('PREVIOUS_CONTAINER=""'), source.indexOf('\n{\n  echo "=== tick'));
  function snapshot(options: { enabled?: boolean; idle?: boolean; busy?: boolean; fail?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-backup-'));
    mkdirSync(join(dir, '.deploy', 'backups'), { recursive: true });
    if (options.enabled !== false) writeFileSync(join(dir, '.deploy', 'backup-project-spaces'), '');
    try {
      const output = execFileSync('bash', ['-c', `
        docker() {
          printf 'DOCKER %s\\n' "$*" >> "$DIR/actions"
          case "$*" in
            *' ps -q x056') printf previous-container ;;
            *' config --format json') printf '%s' '{"name":"fixture","services":{"x056":{}}}' ;;
            'inspect '*) printf previous-image ;;
            'run '*) [ "$FAIL_BACKUP" != 1 ] ;;
          esac
        }
        git() { printf release-revision; }
        live_workflows() { :; }
        busy() { [ "$IS_BUSY" = 1 ]; }
        ${functions}
        if backup_project_spaces; then
          echo READY_TO_SWAP
          PREVIOUS_CONTAINER=""
        else
          echo NOT_SWAPPING
        fi
      `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, DIR: dir, IDLE_ONLY: options.idle === false ? '0' : '1',
        IS_BUSY: options.busy ? '1' : '0', FAIL_BACKUP: options.fail ? '1' : '0',
      } });
      let actions = '';
      try { actions = readFileSync(join(dir, 'actions'), 'utf8'); } catch { /* No Docker for a normal request. */ }
      return { output, actions };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  it('leaves normal releases unchanged and requires idle-only for an offline backup', () => {
    const normal = snapshot({ enabled: false });
    expect(normal.output).toContain('READY_TO_SWAP'); expect(normal.actions).toBe('');
    expect(snapshot({ idle: false }).output).toContain('NOT_SWAPPING');
  });
  it('rechecks activity before stopping any writers', () => {
    const busy = snapshot({ busy: true });
    expect(busy.output).toContain('activity changed before backup');
    expect(busy.output).not.toContain('READY_TO_SWAP');
    expect(busy.actions).not.toContain('DOCKER stop');
  });
  it('requires a completed offline snapshot before proceeding', () => {
    const success = snapshot();
    expect(success.output).toContain('offline Project snapshot saved:');
    expect(success.actions).toContain('DOCKER stop --time 30 previous-container');
    expect(success.actions).toContain('--entrypoint node fixture-x056 --import tsx scripts/project-spaces-recovery.ts backup /app/state /release-backup/state --offline');
    expect(success.actions).not.toContain('DOCKER start');
    const failed = snapshot({ fail: true });
    expect(failed.output).toContain('NOT_SWAPPING');
    expect(failed.actions).toContain('DOCKER start previous-container');
  });
});
