import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { codexAppServerArgs } from '../src/codex-marketplace-args.js';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it('uses an installed snapshot for app-server, leaving Git config intact for explicit upgrades', () => {
  const home = mkdtempSync(join(tmpdir(), 'x056-codex-marketplace-')); homes.push(home);
  const root = join(home, '.tmp', 'marketplaces', 'claude-plugins-official');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), '{}');
  writeFileSync(join(home, 'config.toml'), [
    '[marketplaces.claude-plugins-official]',
    'source_type = "git"',
    'source = "https://github.com/anthropics/claude-plugins-official.git"',
    '[marketplaces.missing]',
    'source_type = "git"',
    '[marketplaces.local]',
    'source_type = "local"',
  ].join('\n'));
  expect(codexAppServerArgs(home)).toEqual([
    'app-server', '-c', 'marketplaces.claude-plugins-official.source_type="local"',
    '-c', `marketplaces.claude-plugins-official.source=${JSON.stringify(root)}`,
  ]);
});

it('starts normally without a configured snapshot', () => {
  const home = mkdtempSync(join(tmpdir(), 'x056-codex-marketplace-')); homes.push(home);
  expect(codexAppServerArgs(home)).toEqual(['app-server']);
});
