import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const short = (v: string) => v.slice(0, 7);
export function sourceFingerprint(base = root) {
  const h = createHash('sha256');
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      if (['public', 'node_modules', '.git'].includes(name)) continue;
      const file = join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (/\.(ts|mjs|json)$/.test(name)) {
        h.update(file.slice(base.length));
        h.update(readFileSync(file));
      }
    }
  }
  for (const dir of ['src', 'server', 'scripts'])
    try {
      walk(join(base, dir));
    } catch {}
  return h.digest('hex');
}
export class VersionInfo {
  readonly backend: { revision: string; source: string; builtAt: string | null; startedAt: string };
  private last = '';
  private checkedAt = 0;
  private cached?: { revision: string; fingerprint: string; dirty: boolean };
  constructor(
    private publicDir: string,
    base = root,
  ) {
    let manifest: { revision?: string; source?: string; builtAt?: string } = {};
    try {
      manifest = JSON.parse(readFileSync(join(base, 'build-info.json'), 'utf8'));
    } catch {}
    let revision = manifest.revision;
    try {
      if (!revision || revision === 'unknown')
        revision = execFileSync('git', ['-C', base, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {}
    const source = manifest.source || sourceFingerprint(base);
    this.backend = {
      revision: revision && revision !== 'unknown' ? short(revision) : 'build-' + short(source),
      source,
      builtAt: manifest.builtAt || null,
      startedAt: new Date().toISOString(),
    };
  }
  current() {
    const names = ['panel.html', 'control-room.js', 'control-room.css'];
    const stamp = names
      .map((n) => {
        try {
          const s = statSync(join(this.publicDir, n));
          return s.mtimeMs + ':' + s.size;
        } catch {
          return '';
        }
      })
      .join('|');
    // UI publication commits can happen after the files are copied, without
    // changing their mtimes. Refresh Git metadata as well as file fingerprints.
    if (stamp !== this.last || !this.cached || Date.now() - this.checkedAt >= 30000) {
      const h = createHash('sha256');
      for (const n of names)
        try {
          h.update(n);
          h.update(readFileSync(join(this.publicDir, n)));
        } catch {}
      let revision = '';
      let dirty = false;
      try {
        revision = execFileSync('git', ['-C', this.publicDir, 'log', '-1', '--format=%h', '--', ...names], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        dirty = !!execFileSync('git', ['-C', this.publicDir, 'status', '--porcelain', '--', ...names], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {}
      const fingerprint = h.digest('hex');
      this.cached = { revision: revision || 'ui-' + short(fingerprint), fingerprint, dirty };
      this.last = stamp;
      this.checkedAt = Date.now();
    }
    return { backend: this.backend, ui: this.cached };
  }
  html(raw: string) {
    const info = this.current(),
      serialized = JSON.stringify(info).replace(/</g, '\\u003c'),
      revision = info.ui.fingerprint;
    return raw
      .replace('</head>', '<script>window.X056_RELEASE=' + serialized + ';</script></head>')
      .replace(/(\/control-room\.(?:js|css))(?:\?[^"']*)?(?=["'])/g, '$1?v=' + revision);
  }
}
