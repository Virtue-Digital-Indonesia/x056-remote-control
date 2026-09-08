import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { VersionInfo } from '../server/version.js';

it('keeps the running backend stamp fixed while detecting a UI publication committed after file copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'x056-version-')),
    pub = join(root, 'public');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const commit = (message: string) => {
    git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-m', message);
    return git('rev-parse', '--short', 'HEAD');
  };
  try {
    mkdirSync(pub);
    for (const name of ['panel.html', 'control-room.js', 'control-room.css'])
      writeFileSync(join(pub, name), 'initial');
    writeFileSync(
      join(root, 'build-info.json'),
      JSON.stringify({
        revision: '1234567890abcdef',
        source: 'backend-a',
        builtAt: '2026-09-08T00:00:00Z',
      }),
    );
    git('init');
    const firstCommit = commit('Initial release');
    const version = new VersionInfo(pub, root),
      first = version.current();
    expect(first.ui.revision).toBe(firstCommit);
    writeFileSync(join(pub, 'panel.html'), '<head></head><script src="/control-room.js"></script>');
    const copied = version.current();
    expect(copied.ui.dirty).toBe(true);
    const uiCommit = commit('Publish copied UI');
    writeFileSync(
      join(root, 'build-info.json'),
      JSON.stringify({ revision: 'different', source: 'backend-b' }),
    );
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31000);
    const published = version.current();
    expect(published.ui).toEqual({
      revision: uiCommit,
      fingerprint: copied.ui.fingerprint,
      dirty: false,
    });
    expect(published.backend).toEqual(first.backend);
    expect(published.backend.revision).toBe('1234567');
    expect(version.html('<head></head><script src="/control-room.js"></script>')).toContain(
      '/control-room.js?v=' + published.ui.fingerprint,
    );
  } finally {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
