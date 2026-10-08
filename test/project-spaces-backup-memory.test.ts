import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { backupProjectSpaces, restoreProjectSpaces } from '../server/project-spaces-recovery.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'backup-memory-')); roots.push(root);
  const source = join(root, 'state'), output = join(root, 'snapshot'); mkdirSync(source);
  return { root, source, output };
}
it('backs up a wide workspace under a small heap and restores all files, large bytes and dangling links', async () => {
  const { root, source, output } = fixture();
  // Long workspace paths amplify retained inventory strings without requiring
  // a giant fixture or reading any real gateway state.
  const workspace = join('chats', ...Array.from({ length: 6 }, (_, i) => `${i}-` + 'x'.repeat(178)));
  mkdirSync(join(source, workspace), { recursive: true });
  const count = 20_000;
  for (let i = 0; i < count; i++) writeFileSync(join(source, workspace, `file-${i}`), '');
  const large = join(source, 'artifacts', 'large.bin'); mkdirSync(join(source, 'artifacts'));
  const fd = openSync(large, 'w'); ftruncateSync(fd, 64 * 1024 * 1024); closeSync(fd);
  symlinkSync('missing-target', join(source, workspace, 'dangling'));
  const child = spawnSync(process.execPath, ['--max-old-space-size=64', '--import', 'tsx', resolve('scripts/project-spaces-recovery.ts'), 'backup', source, output, '--offline'], { encoding: 'utf8', timeout: 120_000 });
  expect(child.status, child.stderr || String(child.error)).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({ saved: count + 2, databases: [] });
  expect(existsSync(join(output, '.snapshot-inventory.sqlite'))).toBe(false);
  const manifest = JSON.parse(readFileSync(join(output, 'project-spaces-snapshot.json'), 'utf8'));
  expect(manifest.files).toHaveLength(count + 2);
  const expected = createHash('sha256');
  for (let i = 0; i < 64; i++) expected.update(Buffer.alloc(1024 * 1024));
  expect(manifest.files.find((file: { path: string }) => file.path === 'artifacts/large.bin')).toMatchObject({ bytes: 64 * 1024 * 1024, hash: expected.digest('hex') });
  const restored = join(root, 'restored'); restoreProjectSpaces(output, restored);
  expect(readlinkSync(join(restored, workspace, 'dangling'))).toBe('missing-target');
  expect(readFileSync(join(restored, workspace, 'file-19999'), 'utf8')).toBe('');
}, 120_000);
it('still rejects a source write during the SQLite copy and removes the partial snapshot', async () => {
  const { source, output } = fixture();
  writeFileSync(join(source, 'projects.json'), '{}');
  const db = new DatabaseSync(join(source, 'gateway.sqlite'));
  db.exec('CREATE TABLE payload (bytes BLOB); INSERT INTO payload VALUES (zeroblob(8388608));'); db.close();
  // backup() yields to SQLite's async backup while all inventory work is sync.
  const timer = setTimeout(() => writeFileSync(join(source, 'projects.json'), '{"changed":true}'), 0);
  try { await expect(backupProjectSpaces(source, output, true, { summaryOnly: true })).rejects.toThrow('State changed'); }
  finally { clearTimeout(timer); }
  expect(existsSync(output)).toBe(false);
});
it('rejects copied bytes that differ even when the source remains unchanged', () => {
  const { source, output } = fixture(); writeFileSync(join(source, 'projects.json'), '{}');
  // Inject a bad copy only in this subprocess, leaving normal filesystem calls
  // and every other test untouched.
  const script = `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    const copy = fs.copyFileSync;
    fs.copyFileSync = (source, output) => { copy(source, output); fs.writeFileSync(output, 'damaged'); };
    syncBuiltinESMExports();
    const { backupProjectSpaces } = await import(${JSON.stringify(resolve('server/project-spaces-recovery.ts'))});
    try { await backupProjectSpaces(${JSON.stringify(source)}, ${JSON.stringify(output)}, true, { summaryOnly: true }); process.exitCode = 2; }
    catch (error) { if (!error.message.includes('Copied file differs')) throw error; }
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30_000 });
  expect(child.status, child.stderr || String(child.error)).toBe(0);
  expect(existsSync(output)).toBe(false);
  expect(readFileSync(join(source, 'projects.json'), 'utf8')).toBe('{}');
});
