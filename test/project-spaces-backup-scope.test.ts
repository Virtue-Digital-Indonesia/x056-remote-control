import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { backupProjectSpaces, restoreProjectSpaces } from '../server/project-spaces-recovery.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'backup-scope-')); roots.push(root);
  const state = join(root, 'state'); mkdirSync(state);
  const files = {
    'projects.json': '{"projects":[]}',
    'chats/chat-one/work/code.txt': 'original work bytes',
    'chats/chat-two/work/deep/file.txt': 'second workspace',
    'chats/chat-one/messages.json': '["retained history"]',
    'chats/chat-one/metadata/work/keep.txt': 'nested work directory',
    'chats/work/metadata.json': 'chat named work',
    'project-files/work/keep.txt': 'project files',
    'artifacts/work/blob': 'retained original',
    'memory-extractions/work/text': 'extracted text',
  };
  for (const [path, data] of Object.entries(files)) { mkdirSync(dirname(join(state, path)), { recursive: true }); writeFileSync(join(state, path), data); }
  return { root, state, files };
}
describe('explicit backup scope', () => {
  it('defaults to full scope including exact workspace bytes and restores legacy full manifests', async () => {
    const f = fixture(), snapshot = join(f.root, 'snapshot');
    const result = await backupProjectSpaces(f.state, snapshot, true);
    expect(result.scope).toBe('full'); expect(result.excludedPathPatterns).toEqual([]);
    for (const [path, bytes] of Object.entries(f.files)) expect(readFileSync(join(snapshot, path), 'utf8')).toBe(bytes);
    const legacy: any = { ...result }; delete legacy.scope; delete legacy.excludedPathPatterns;
    writeFileSync(join(snapshot, 'project-spaces-snapshot.json'), JSON.stringify(legacy));
    expect(restoreProjectSpaces(snapshot, join(f.root, 'restore')).scope).toBe('full');
  });
  it('excludes only direct Chat worktrees, retains metadata and all three complete WAL databases, and restores to a new destination', async () => {
    const f = fixture(), snapshot = join(f.root, 'snapshot');
    const dbs = ['chat-files.sqlite', 'memory.sqlite', 'gateway.sqlite'];
    const handles = dbs.map(name => {
      const db = new DatabaseSync(join(f.state, name));
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE records (value TEXT); INSERT INTO records VALUES ('committed WAL'); CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('retain complete DB'); PRAGMA user_version=4;");
      expect(existsSync(join(f.state, name + '-wal'))).toBe(true); return db;
    });
    try {
      const result = await backupProjectSpaces(f.state, snapshot, true, { scope: 'application-state', summaryOnly: true });
      expect(result).toMatchObject({ scope: 'application-state', excludedPathPatterns: ['chats/*/work'], databases: dbs });
      const manifest = JSON.parse(readFileSync(join(snapshot, 'project-spaces-snapshot.json'), 'utf8'));
      expect(manifest).toMatchObject({ schemaVersion: 2, scope: result.scope, excludedPathPatterns: result.excludedPathPatterns });
      for (const [path, bytes] of Object.entries(f.files)) {
        if (/^chats\/[^/]+\/work\//.test(path)) expect(existsSync(join(snapshot, path))).toBe(false);
        else expect(readFileSync(join(snapshot, path), 'utf8')).toBe(bytes);
      }
      writeFileSync(join(f.state, 'chats/chat-one/work/code.txt'), 'new work preserved');
      expect(() => restoreProjectSpaces(snapshot, f.state)).toThrow('preserve');
      const target = join(f.root, 'restored');
      expect(restoreProjectSpaces(snapshot, target)).toMatchObject({ scope: 'application-state', excludedPathPatterns: ['chats/*/work'] });
      expect(existsSync(join(target, 'chats/chat-one/work'))).toBe(false);
      expect(readFileSync(join(f.state, 'chats/chat-one/work/code.txt'), 'utf8')).toBe('new work preserved');
      for (const name of dbs) {
        const saved = new DatabaseSync(join(target, name), { readOnly: true });
        try {
          expect(saved.prepare('SELECT value FROM records').get()?.value).toBe('committed WAL');
          expect(saved.prepare('SELECT value FROM unrelated').get()?.value).toBe('retain complete DB');
          expect(saved.prepare('PRAGMA user_version').get()?.user_version).toBe(4);
          expect(saved.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        } finally { saved.close(); }
      }
    } finally { for (const db of handles) db.close(); }
  });
  it('validates explicit scope before creating backup output and rejects inconsistent restore scope', async () => {
    const f = fixture(), snapshot = join(f.root, 'snapshot');
    await expect(backupProjectSpaces(f.state, snapshot, true, { scope: 'metadata' as any })).rejects.toThrow('Invalid backup scope');
    expect(existsSync(snapshot)).toBe(false);
    await backupProjectSpaces(f.state, snapshot, true, { scope: 'application-state' });
    const path = join(snapshot, 'project-spaces-snapshot.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...manifest, schemaVersion: 1 }));
    expect(() => restoreProjectSpaces(snapshot, join(f.root, 'restore'))).toThrow('schema version 2');
    const missingScope = { ...manifest }; delete missingScope.scope;
    writeFileSync(path, JSON.stringify(missingScope));
    expect(() => restoreProjectSpaces(snapshot, join(f.root, 'restore'))).toThrow('declare application-state scope');
    delete manifest.excludedPathPatterns; writeFileSync(path, JSON.stringify(manifest));
    expect(() => restoreProjectSpaces(snapshot, join(f.root, 'restore'))).toThrow('declare exclusions');
    expect(existsSync(join(f.root, 'restore'))).toBe(false);
  });
  it('CLI rejects invalid scope and unknown options before backup and reports the selected scope', () => {
    const f = fixture();
    for (const flag of ['--scope=metadata', '--scope=', '--unknown']) {
      const output = join(f.root, 'invalid');
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/project-spaces-recovery.ts', 'backup', f.state, output, '--offline', flag], { encoding: 'utf8' });
      expect(child.status).not.toBe(0); expect(child.stderr).toContain('Invalid backup scope'); expect(existsSync(output)).toBe(false);
    }
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/project-spaces-recovery.ts', 'backup', f.state, join(f.root, 'valid'), '--offline', '--scope=application-state'], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({ scope: 'application-state', excludedPathPatterns: ['chats/*/work'] });
  });
});
