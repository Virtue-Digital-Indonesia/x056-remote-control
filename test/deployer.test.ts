import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
  function snapshot(options: { enabled?: boolean; idle?: boolean; busy?: boolean; fail?: boolean; timeout?: boolean; cleanupFailure?: boolean; signal?: boolean; scope?: string; swap?: 'success' | 'failure' } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-backup-'));
    mkdirSync(join(dir, '.deploy', 'backups'), { recursive: true });
    if (options.enabled !== false) writeFileSync(join(dir, '.deploy', 'backup-project-spaces'), '');
    if (options.scope !== undefined) writeFileSync(join(dir, '.deploy', 'backup-scope'), options.scope);
    writeFileSync(join(dir, '.deploy', 'requested'), 'original-request');
    try {
      const result = spawnSync('bash', ['-c', `
        FLAG="$DIR/.deploy/requested"; STATUS="$DIR/.deploy/status.json"; FORCE="$DIR/.deploy/force"
        timeout() {
          printf 'BOUND %s\\n' "$*" >> "$DIR/actions"
          shift 2; "$@"
        }
        docker() {
          printf 'DOCKER %s\\n' "$*" >> "$DIR/actions"
          case "$*" in
            *' ps -q x056') printf previous-container ;;
            *' config --format json') printf '%s' '{"name":"fixture","services":{"x056":{}}}' ;;
            'inspect '*) printf previous-image ;;
            'start -a '*)
              [ "$SIGNAL_BACKUP" != 1 ] || kill -TERM $$
              [ "$TIMEOUT_BACKUP" != 1 ] || return 124
              [ "$FAIL_BACKUP" != 1 ] ;;
            'rm -f '*) [ "$CLEANUP_FAILURE" != 1 ] ;;
            *' up -d '*) [ "$SWAP_RESULT" != failure ] ;;

          esac
        }
        git() { printf release-revision; }
        live_workflows() { :; }
        busy() { [ "$IS_BUSY" = 1 ]; }
        ${functions}
        if backup_project_spaces; then
          echo READY_TO_SWAP
          ${options.swap ? source.slice(source.indexOf('  swap_args=(up -d)'), source.indexOf('\n} >> "$LOG"')) : 'PREVIOUS_CONTAINER=""'}
        else
          echo NOT_SWAPPING
        fi
      `], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...process.env, DIR: dir, IDLE_ONLY: options.idle === false ? '0' : '1',
        IS_BUSY: options.busy ? '1' : '0', FAIL_BACKUP: options.fail ? '1' : '0',
        TIMEOUT_BACKUP: options.timeout ? '1' : '0', CLEANUP_FAILURE: options.cleanupFailure ? '1' : '0',
        SIGNAL_BACKUP: options.signal ? '1' : '0',
        SWAP_RESULT: options.swap ?? '',
      } });
      const output = result.stdout;
      let actions = '';
      try { actions = readFileSync(join(dir, 'actions'), 'utf8'); } catch { /* No Docker for a normal request. */ }
      let status = '';
      try { status = readFileSync(join(dir, '.deploy', 'status.json'), 'utf8'); } catch {}
      const requested = existsSync(join(dir, '.deploy', 'requested'));
      const archived = readdirSync(join(dir, '.deploy')).filter(name => name.startsWith('requested.paused-backup-failed-'));
      return { output, actions, status, requested, archived, exitCode: result.status, error: result.stderr,
        scopeMarker: existsSync(join(dir, '.deploy', 'backup-scope')),
        backupMarker: existsSync(join(dir, '.deploy', 'backup-project-spaces')) };
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
    expect(busy.requested).toBe(true);
    expect(busy.archived).toHaveLength(0);
  });
  it('defaults to full and propagates an explicitly selected application-state scope', () => {
    const full = snapshot();
    expect(full.actions).toContain('--offline --scope=full');
    expect(full.output).toContain('backup scope: full');
    expect(full.output).not.toContain('excluded from rollback snapshot');
    const selected = snapshot({ scope: 'application-state\n' });
    expect(selected.actions).toContain('--offline --scope=application-state');
    expect(selected.output).toContain('backup scope: application-state');
    expect(selected.output).toContain('chats/*/work subtrees (exactly chats/<one chat id>/work relative to the state root)');
    expect(snapshot({ scope: 'full' }).actions).toContain('--offline --scope=full');
  });
  it.each(['', 'unknown', 'application-state extra', ' full', 'full\napplication-state'])('rejects invalid scope %j before any Docker action', scope => {
    const invalid = snapshot({ scope });
    expect(invalid.exitCode).toBe(1);
    expect(invalid.error).toContain('invalid backup scope');
    expect(invalid.actions).toBe('');
    expect(invalid.requested).toBe(true);
    expect(invalid.scopeMarker).toBe(true);
    expect(source.indexOf('BACKUP_SCOPE=full')).toBeLessThan(source.indexOf('  # 1. Build ahead'));
  });
  it('retains the scope marker on failures and clears it only after a successful swap', () => {
    for (const options of [{ fail: true }, { timeout: true }, { busy: true }, { swap: 'failure' as const }]) {
      const failed = snapshot({ scope: 'application-state', ...options });
      expect(failed.scopeMarker).toBe(true);
      expect(failed.backupMarker).toBe(true);
    }
    const success = snapshot({ scope: 'application-state', swap: 'success' });
    expect(success.output).toContain('deploy OK');
    expect(success.scopeMarker).toBe(false);
    expect(success.backupMarker).toBe(false);
    expect(success.actions).not.toContain('DOCKER start previous-container');
  });
  it('the real timeout wrapper terminates a hung Docker client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-timeout-'));
    try {
      writeFileSync(join(dir, 'docker'), '#!/bin/sh\nsleep 30\n', { mode: 0o700 });
      const wrapper = source.slice(source.indexOf('bounded_docker()'), source.indexOf('\npause_backup_request()'));
      const result = spawnSync('bash', ['-c', `${wrapper}\nbounded_docker 1s start -a fixture`], {
        encoding: 'utf8', timeout: 8000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(124);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps writers stopped when helper removal fails', () => {
    const failed = snapshot({ fail: true, cleanupFailure: true });
    expect(failed.actions).not.toContain('DOCKER start previous-container');
    expect(JSON.parse(failed.status).status).toBe('backup_recovery_required');
    expect(failed.requested).toBe(false);
  });
  it('archives the request and removes the helper before writer recovery on TERM', () => {
    const failed = snapshot({ signal: true });
    expect(failed.actions.indexOf('DOCKER rm -f')).toBeLessThan(failed.actions.indexOf('DOCKER start previous-container'));
    expect(failed.requested).toBe(false);
    expect(JSON.parse(failed.status).status).toBe('backup_failed');
  });
  it('bounds helper execution and restores writers only after removing a timed-out helper', () => {
    const failed = snapshot({ timeout: true });
    expect(failed.actions).toMatch(/BOUND --kill-after=5s 120s docker start -a x056-release-backup-/);
    expect(failed.actions.indexOf('DOCKER rm -f')).toBeLessThan(failed.actions.indexOf('DOCKER start previous-container'));
    expect(failed.requested).toBe(false);
    expect(JSON.parse(failed.status).status).toBe('backup_failed');
  });
  it('requires a completed offline snapshot before proceeding', () => {
    const success = snapshot();
    expect(success.output).toContain('offline Project snapshot saved:');
    expect(success.actions).toContain('DOCKER stop --time 30 previous-container');
    expect(success.actions).toContain('--entrypoint node fixture-x056 --import tsx scripts/project-spaces-recovery.ts backup /app/state /release-backup/state --offline');
    expect(success.actions).not.toContain('DOCKER start previous-container');
    expect(success.requested).toBe(true);
    expect(success.archived).toHaveLength(0);
    const failed = snapshot({ fail: true });
    expect(failed.output).toContain('NOT_SWAPPING');
    expect(failed.actions).toContain('DOCKER start previous-container');
    expect(failed.actions.indexOf('DOCKER rm -f')).toBeLessThan(failed.actions.indexOf('DOCKER start previous-container'));
    expect(JSON.parse(failed.status).status).toBe('backup_failed');
    expect(failed.requested).toBe(false);
    expect(failed.archived).toHaveLength(1);
  });
});
