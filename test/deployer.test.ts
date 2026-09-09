import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  it('never reaches the swap after the normal timeout while activity is present', () => {
    const decision = source.slice(source.indexOf('  # 2.'), source.indexOf('  if ! release_unchanged; then'));
    const output = execFileSync('bash', ['-c', `IDLE_ONLY=1; age=86400; MAX_DEFER=180; FORCE=/dev/null
      live_workflows() { :; }; busy() { return 0; }
      ${decision}
      echo WOULD_SWAP`], { encoding: 'utf8' });
    expect(output).toContain('idle-only release stays pending');
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
