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
// Keep the order aligned with VersionInfo.current(): these are the image's
// fingerprinted assets, all of which VersionInfo.html() versions in the page.
const fingerprinted = ['panel.html', 'control-room.js', 'control-room.css', 'rc-chat.js', 'rc-chat.css', 'project-spaces.js', 'project-spaces.css', 'workspace.js', 'workspace.css'];
const fingerprint = createHash('sha256');
for (const name of fingerprinted) {
  fingerprint.update(name);
  fingerprint.update(readFileSync(resolve(assets, name)));
}
if (fingerprint.digest('hex') !== version.ui.fingerprint)
  throw new Error('Interface fingerprint mismatch');
const checks = {};
for (const name of [...fingerprinted, 'agent-tree.js']) {
  const path = name === 'panel.html' ? '/' : '/' + name;
  let served = await (await get(path)).text();
  if (name === 'panel.html')
    served = served
      .replace(/<script>window\.X056_RELEASE=[\s\S]*?;<\/script>/, '')
      .replace(/(\/(?:control-room|rc-chat|project-spaces|workspace)\.(?:js|css))\?v=([^"']+)(?=["'])/g, (_match, asset, value) => {
        if (value !== version.ui.fingerprint) throw new Error('Asset fingerprint mismatch: ' + asset);
        return asset;
      });
  checks[name] = digest(served) === digest(readFileSync(resolve(assets, name)));
  if (!checks[name]) throw new Error('Interface mismatch: ' + name);
}
console.log(
  JSON.stringify({ ok: true, backend: version.backend.revision, ui: version.ui.revision, checks }, null, 2),
);
