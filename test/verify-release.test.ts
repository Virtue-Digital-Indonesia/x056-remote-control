import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const names = ['panel.html', 'control-room.js', 'control-room.css', 'rc-chat.js', 'rc-chat.css', 'project-spaces.js', 'project-spaces.css', 'workspace.js', 'workspace.css'];
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(change: 'none' | 'tag' | 'body' | 'fingerprint') {
  const dir = mkdtempSync(join(tmpdir(), 'x056-verify-release-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = Object.fromEntries([...names, 'agent-tree.js'].map(n => [n, '// ' + n]));
  files['panel.html'] = '<head>' + names.slice(1).map(n => '<script src="/' + n + '"></script>').join('') + '</head>';
  const hash = createHash('sha256');
  for (const n of names) { hash.update(n); hash.update(files[n]); }
  const fingerprint = hash.digest('hex');
  for (const [n, text] of Object.entries(files)) writeFileSync(join(dir, n), text);
  const version = { backend: { revision: '0cd8621' }, ui: { revision: 'test', fingerprint: change === 'fingerprint' ? 'wrong' : fingerprint } };
  const server: Server = createServer((req, res) => {
    if (req.url === '/api/version') return void res.end(JSON.stringify(version));
    if (req.url === '/healthz') return void res.end('{"ok":true}');
    if (req.url === '/') return void res.end(files['panel.html']
      .replace('</head>', '<script>window.X056_RELEASE=' + JSON.stringify(version) + ';</script></head>')
      .replace(/\.(js|css)"/g, '.$1?v=' + (change === 'tag' ? 'wrong' : fingerprint) + '"'));
    const name = req.url?.slice(1) || '';
    if (!(name in files)) { res.statusCode = 404; return void res.end(); }
    res.end(files[name] + (change === 'body' && name === 'workspace.js' ? '\nchanged' : ''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  return () => exec(process.execPath, [resolve('scripts/verify-release.mjs'), 'http://127.0.0.1:' + address.port, '0cd8621d96f1173a3503e4bcb72ef939c26e2c5a', dir]);
}

describe('release verifier', () => {
  it('accepts the current panel renderer and checks workspace/chat/agent assets', async () => {
    const result = JSON.parse((await (await fixture('none'))()).stdout);
    expect(result.ok).toBe(true);
    expect(Object.keys(result.checks)).toEqual([...names, 'agent-tree.js']);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
  });
  it.each(['tag', 'body', 'fingerprint'] as const)('rejects changed %s evidence', async change => {
    await expect((await fixture(change))()).rejects.toThrow(/mismatch/);
  });
});
