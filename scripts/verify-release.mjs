// Read-only release check. Run after an approved backend deployment and UI publication.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const [base, expected, assets = 'server/public'] = process.argv.slice(2);
if (!base || !expected)
  throw new Error('Usage: node scripts/verify-release.mjs <base URL> <backend commit> [asset directory]');
const get = async (path) => {
  const response = await fetch(new URL(path, base), {
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status);
  return response;
};
const version = await (await get('/api/version')).json();
if (version.backend.revision !== expected.slice(0, 7))
  throw new Error(
    'Backend mismatch: expected ' + expected.slice(0, 7) + ', running ' + version.backend.revision,
  );
if (!(await (await get('/healthz')).json()).ok) throw new Error('Backend health check failed');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checks = {};
for (const [name, path] of [
  ['panel.html', '/'],
  ['control-room.js', '/control-room.js'],
  ['control-room.css', '/control-room.css'],
]) {
  let served = await (await get(path)).text();
  if (name === 'panel.html')
    served = served
      .replace(/<script>window\.X056_RELEASE=[\s\S]*?;<\/script>/, '')
      .replace(/(\/control-room\.(?:js|css))\?v=[a-f0-9]+(?=["'])/g, '$1');
  checks[name] = digest(served) === digest(readFileSync(resolve(assets, name)));
  if (!checks[name]) throw new Error('Interface mismatch: ' + name);
}
console.log(
  JSON.stringify({ ok: true, backend: version.backend.revision, ui: version.ui.revision, checks }, null, 2),
);
