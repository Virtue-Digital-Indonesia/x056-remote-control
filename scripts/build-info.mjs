import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.cwd(),
  hash = createHash('sha256');
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (['public', 'node_modules', '.git'].includes(name)) continue;
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (/\.(ts|mjs|json)$/.test(name)) {
      hash.update(file.slice(root.length));
      hash.update(readFileSync(file));
    }
  }
}
for (const dir of ['src', 'server', 'scripts']) walk(join(root, dir));
writeFileSync(
  'build-info.json',
  JSON.stringify({
    revision: process.env.X056_BUILD_REVISION || 'unknown',
    source: hash.digest('hex'),
    builtAt: new Date().toISOString(),
  }),
);
