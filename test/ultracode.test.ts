import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';

/**
 * `ultracode` is a REAL `claude --effort` level, even though `--help` lists only
 * low|medium|high|xhigh|max. Verified against the CLI (2.1.220): an unknown
 * value warns and falls back to the default —
 *
 *   $ claude --effort banana …
 *   Warning: Unknown --effort value 'banana' — ignoring it and using the
 *   default effort. Valid values: low, medium, high, xhigh, max.
 *
 * — while `ultracode` passes silently, exactly like `max`. So it must reach the
 * CLI verbatim: translating it to `max` would silently downgrade the turn, and
 * that is the failure this file exists to prevent.
 *
 * Codex has no such level (its own extra is `ultra`), so the two must not cross.
 */

/**
 * The provider guard lives inside launch(), so drive a real start() with the
 * supported runSessionFn seam and capture what the turn was actually given.
 */
function effortUsedFor(provider: 'claude' | 'codex', effort: string): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'x056-uc-'));
  const stateDir = join(dir, 'state');
  const cwd = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({
    current: 'p1',
    projects: [{ id: 'p1', name: 'P', cwd, provider, conversations: [], lastSessionId: null }],
  }));
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg-a') }]);

  let seen: string | undefined;
  let called = false;
  const runSessionFn = (async (opts: { effort?: string }) => {
    called = true;
    seen = opts.effort;
    return { status: 'completed' as const, sessionId: 's1' };
  }) as never;

  const m = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
  m.start('hello', undefined, { effort }, 'p1');
  if (!called) throw new Error('runSessionFn was never called — the harness, not the guard, is wrong');
  return seen;
}

describe('ultracode effort', () => {
  it('is offered in the panel alongside the documented levels', async () => {
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('server/public/panel.html', 'utf8');
    expect(html).toContain('<option value="ultracode">Ultracode</option>');
    // and ordered last, above max
    expect(html).toContain("'max', 'ultra', 'ultracode'");
  });

  it('reaches the CLI verbatim rather than being downgraded to max', () => {
    expect(effortUsedFor('claude', 'ultracode')).toBe('ultracode');
  });

  it('is dropped for codex, whose extra level is "ultra" instead', () => {
    expect(effortUsedFor('codex', 'ultracode')).toBeUndefined();
  });

  it('still drops codex-only "ultra" on a claude conversation', () => {
    expect(effortUsedFor('claude', 'ultra')).toBeUndefined();
  });

  it('leaves the documented levels alone for both providers', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(effortUsedFor('claude', e)).toBe(e);
      expect(effortUsedFor('codex', e)).toBe(e);
    }
  });
});
