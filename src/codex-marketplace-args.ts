import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Codex app-server upgrades every configured Git marketplace on startup. This
 * gateway starts short-lived app-servers for quota and capability checks, then
 * kills them while that background clone may still be running. Codex 0.156.1
 * leaves those interrupted clones under .staging, with unbounded disk growth.
 *
 * The account already has Codex's installed marketplace snapshot. Point only
 * app-server processes at that snapshot as a local source. Plugin management
 * commands still use the account's Git source for explicit upgrades.
 */
export function codexAppServerArgs(configDir: string): string[] {
  let config: string;
  try { config = readFileSync(join(configDir, 'config.toml'), 'utf8'); }
  catch { return ['app-server']; }

  const gitMarketplaces = new Set<string>();
  let section: string | undefined;
  for (const line of config.split(/\r?\n/)) {
    const heading = /^\s*\[marketplaces\.([A-Za-z0-9_-]+)\]\s*(?:#.*)?$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    if (/^\s*\[/.test(line)) { section = undefined; continue; }
    if (section && /^\s*source_type\s*=\s*["']git["']\s*(?:#.*)?$/.test(line)) gitMarketplaces.add(section);
  }

  const args = ['app-server'];
  for (const name of gitMarketplaces) {
    const root = join(configDir, '.tmp', 'marketplaces', name);
    if (!existsSync(join(root, '.claude-plugin', 'marketplace.json')) &&
        !existsSync(join(root, '.agents', 'plugins', 'marketplace.json'))) continue;
    args.push(
      '-c', `marketplaces.${name}.source_type="local"`,
      '-c', `marketplaces.${name}.source=${JSON.stringify(root)}`,
    );
  }
  return args;
}
