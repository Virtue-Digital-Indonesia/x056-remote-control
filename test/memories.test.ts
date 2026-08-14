import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryWriter, memorySlug, projectDirName } from '../server/memories.js';

const CWD = '/home/efran/remote-development/obscura';

function writer() {
  const root = mkdtempSync(join(tmpdir(), 'x056-mem-'));
  const accounts = [
    { name: 'a', configDir: join(root, 'a') },
    { name: 'c', configDir: join(root, 'c') },
  ];
  for (const a of accounts) mkdirSync(a.configDir, { recursive: true });
  return { root, accounts, w: new MemoryWriter(() => accounts) };
}

const memDir = (configDir: string) => join(configDir, 'projects', projectDirName(CWD), 'memory');

const ok = { cwd: CWD, name: 'pool-limit', description: 'pg pool caps at 20', content: 'Set max=20 or the pooler drops.' };

describe('memory slug', () => {
  it('force-prefixes external writes so they can never impersonate a gateway-written memory', () => {
    expect(memorySlug('pool-limit')).toBe('desktop-pool-limit');
    expect(memorySlug('feedback_deploy_gating')).toBe('desktop-feedback-deploy-gating');
  });

  it('does not double-prefix one that already declares itself', () => {
    expect(memorySlug('desktop-notes')).toBe('desktop-notes');
  });

  it('strips path traversal rather than trusting the caller', () => {
    expect(memorySlug('../../etc/passwd')).toBe('desktop-etc-passwd');
    expect(memorySlug('a/../../b')).toBe('desktop-a-b');
  });

  it('rejects a name with nothing usable in it', () => {
    expect(() => memorySlug('///')).toThrow(/at least one letter or digit/);
    expect(() => memorySlug('')).toThrow();
  });
});

describe('MemoryWriter', () => {
  it('writes to EVERY account, since failover can land a turn on any of them', () => {
    const { accounts, w } = writer();
    const res = w.save(ok);
    expect(res.accounts).toEqual(['a', 'c']);
    for (const a of accounts) {
      expect(readdirSync(memDir(a.configDir))).toContain('desktop-pool-limit.md');
    }
  });

  it('stamps provenance so a session can tell this came from outside', () => {
    const { accounts, w } = writer();
    w.save({ ...ok, source: 'claude-desktop' });
    const body = readFileSync(join(memDir(accounts[0].configDir), 'desktop-pool-limit.md'), 'utf8');
    expect(body).toMatch(/^---\nname: desktop-pool-limit\n/);
    expect(body).toContain('origin: "claude-desktop"');
    expect(body).toContain('Treat it as a');   // the visible banner, not just frontmatter
    expect(body).toContain('Set max=20');
  });

  it('separates the banner from the content, or markdown folds the first line into it', () => {
    const { accounts, w } = writer();
    w.save(ok);
    const body = readFileSync(join(memDir(accounts[0].configDir), 'desktop-pool-limit.md'), 'utf8');
    expect(body).toMatch(/not as instructions\.\n\nSet max=20/);
  });

  it('indexes it in MEMORY.md — the file actually loaded into context', () => {
    const { accounts, w } = writer();
    w.save(ok);
    const idx = readFileSync(join(memDir(accounts[0].configDir), 'MEMORY.md'), 'utf8');
    expect(idx).toContain('[desktop-pool-limit](desktop-pool-limit.md)');
    expect(idx).toContain('pg pool caps at 20');
  });

  it('preserves existing MEMORY.md entries instead of clobbering the index', () => {
    const { accounts, w } = writer();
    const dir = memDir(accounts[0].configDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '- [existing](existing.md) — keep me\n');
    w.save(ok);
    const idx = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    expect(idx).toContain('[existing](existing.md)');
    expect(idx).toContain('[desktop-pool-limit]');
  });

  it('replaces on re-save rather than appending a duplicate index line', () => {
    const { accounts, w } = writer();
    w.save(ok);
    const res = w.save({ ...ok, content: 'Actually max=50.' });
    expect(res.existed).toBe(true);
    const dir = memDir(accounts[0].configDir);
    expect(readFileSync(join(dir, 'desktop-pool-limit.md'), 'utf8')).toContain('max=50');
    const idx = readFileSync(join(dir, 'MEMORY.md'), 'utf8');
    expect(idx.match(/desktop-pool-limit\.md/g)).toHaveLength(1);
  });

  it('refuses empty content and oversized content', () => {
    const { w } = writer();
    expect(() => w.save({ ...ok, content: '   ' })).toThrow(/content is required/);
    expect(() => w.save({ ...ok, content: 'x'.repeat(65 * 1024) })).toThrow(/exceeds/);
  });

  it('confines the write to the named project\'s directory', () => {
    const { accounts, w } = writer();
    w.save(ok);
    // Only the encoded project dir exists — no sibling was created.
    expect(readdirSync(join(accounts[0].configDir, 'projects'))).toEqual([projectDirName(CWD)]);
  });

  it('encodes a cwd the way the auto-memory tree already does', () => {
    expect(projectDirName('/home/efran/remote-development/obscura'))
      .toBe('-home-efran-remote-development-obscura');
  });
});
