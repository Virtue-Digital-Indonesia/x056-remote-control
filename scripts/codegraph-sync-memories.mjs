#!/usr/bin/env node
/**
 * Mirror the per-project auto-memory files into the codegraph service's wiki, so
 * a session can search EVERY project's memories, not just the one it is in.
 *
 * The auto-memory system only injects the current project's MEMORY.md. That is
 * the right default (context is finite), but it means obscura's 100+ hard-won
 * notes are invisible from any other project. This makes them searchable.
 *
 * Deliberately NOT the LLM ingest path (/wiki/ingest): memories are already
 * structured markdown with frontmatter, so they are written straight to pages
 * via /wiki/page/write. No LLM, no API key, nothing leaves the machine.
 *
 * Idempotent — page/write upserts by ref, so re-running syncs edits and adds new
 * files. Deletions are reported, not applied (see --prune).
 *
 * Usage:
 *   node scripts/codegraph-sync-memories.mjs [--dry-run] [--prune]
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.KNOWLEDGE_API_URL || 'http://dind:8421';
const TOKEN = process.env.KNOWLEDGE_API_TOKEN || readTokenFile();
const SERVICE_ID = process.env.KNOWLEDGE_SERVICE_ID || 'x056';
const TEAM_ID = process.env.KNOWLEDGE_TEAM_ID || 'x056';
const WIKI_ID = process.env.KNOWLEDGE_WIKI_ID || readFileMaybe('/app/state/tools/wikiid-memories.txt');
// Accounts share one memory tree (b/c are mirrors of a); read one to avoid
// writing every page N times.
const SOURCE_ACCOUNT = process.env.X056_MEMORY_ACCOUNT || 'a';
const PROJECTS_DIR = `/app/state/accounts/${SOURCE_ACCOUNT}/projects`;

const dryRun = process.argv.includes('--dry-run');
const prune = process.argv.includes('--prune');

function readFileMaybe(p) { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } }
function readTokenFile() { return readFileMaybe('/app/state/tools/codegraph-token.txt'); }

async function api(path, body) {
  const res = await fetch(`${API}/v3${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tdai-service-id': SERVICE_ID,
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify({ team_id: TEAM_ID, ...body }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || (json && json.code !== 0)) {
    throw new Error(`${path} → ${res.status} ${json?.message ?? ''}`);
  }
  return json?.data;
}

/** Project dir name → the readable project name (…-obscura → obscura). */
function projectName(dirName) {
  const base = dirName.replace(/^-home-efran-remote-development-?/, '');
  return base || 'root';
}

function collect() {
  const pages = [];
  let dirs;
  try { dirs = readdirSync(PROJECTS_DIR); } catch { return pages; }
  for (const d of dirs) {
    const memDir = join(PROJECTS_DIR, d, 'memory');
    let files;
    try {
      if (!statSync(memDir).isDirectory()) continue;
      files = readdirSync(memDir).filter((f) => f.endsWith('.md'));
    } catch { continue; }
    const proj = projectName(d);
    for (const f of files) {
      const content = readFileSync(join(memDir, f), 'utf8');
      if (!content.trim()) continue;
      // Prefix each page with its origin so a search hit says which project it
      // came from even when only the body is shown.
      pages.push({
        ref: `${proj}/${f}`,
        content: `> memory of project **${proj}** (${f})\n\n${content}`,
      });
    }
  }
  return pages.sort((a, b) => a.ref.localeCompare(b.ref));
}

const pages = collect();
const byProject = pages.reduce((m, p) => {
  const k = p.ref.split('/')[0];
  m[k] = (m[k] || 0) + 1;
  return m;
}, {});

console.log(`found ${pages.length} memory files across ${Object.keys(byProject).length} projects`);
for (const [proj, n] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${proj}`);
}

if (!WIKI_ID) {
  console.error('\nno wiki id — set KNOWLEDGE_WIKI_ID or write /app/state/tools/wikiid-memories.txt');
  process.exit(1);
}
if (dryRun) { console.log('\n--dry-run: nothing written'); process.exit(0); }

// Report what exists remotely but no longer exists locally. Not deleted unless
// --prune: a memory file vanishing is more often a moved checkout than an
// intentional deletion, and silently dropping recall is the worse failure.
let existing = [];
try {
  const ls = await api('/wiki/page/ls', { wiki_id: WIKI_ID });
  existing = (Array.isArray(ls) ? ls : ls?.items ?? []).map((x) => (typeof x === 'string' ? x : x.ref)).filter(Boolean);
} catch { /* first run: no pages yet */ }

const local = new Set(pages.map((p) => p.ref));
const stale = existing.filter((ref) => !local.has(ref));

// The API caps a write at 20 pages ("pages exceeds max 20"), so chunk under it.
const CHUNK = 20;
let written = 0;
for (let i = 0; i < pages.length; i += CHUNK) {
  const batch = pages.slice(i, i + CHUNK);
  await api('/wiki/page/write', { wiki_id: WIKI_ID, pages: batch });
  written += batch.length;
  process.stdout.write(`\rwrote ${written}/${pages.length}`);
}
console.log(`\nsynced ${written} pages into ${WIKI_ID}`);

if (stale.length) {
  console.log(`\n${stale.length} page(s) exist remotely with no local file:`);
  for (const ref of stale.slice(0, 20)) console.log(`  ${ref}`);
  if (prune) {
    await api('/wiki/page/rm', { wiki_id: WIKI_ID, refs: stale });
    console.log(`pruned ${stale.length}`);
  } else {
    console.log('re-run with --prune to remove them');
  }
}
