import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayDb, transaction } from './gateway-db.js';
import type { TokenUsage } from './transcript-stats.js';

const counters = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const claudePath = new RegExp(`/projects/[^/]+/(${uuid})(?:/subagents/(agent-[a-zA-Z0-9_-]+))?\\.jsonl$`);

/** Logical identity, independent of account aliases. Never infer a Codex parent. */
export function archivedIdentity(path: string): { identity: string; parentId: string; agent: boolean } | null {
  const match = claudePath.exec(path);
  return match ? { identity: `claude:${match[1]}:${match[2] || 'parent'}`, parentId: match[1], agent: !!match[2] } : null;
}

export interface ArchivedUsage {
  identity: string;
  parentId: string;
  agent: boolean;
  provider: 'claude';
  transcriptPath: string;
  source: string;
  asOf: string | null;
  schemaVersion: 4;
  size: number;
  scanned: number;
  usage: TokenUsage;
}

/** Accept only complete, reconciled v4 scans. Copy counters, never task payloads. */
export function archiveRecord(path: string, raw: unknown, version: number, source: string, asOf: string | null): ArchivedUsage | null {
  const identity = archivedIdentity(path);
  if (!identity || version !== 4 || !object(raw) || raw.partial !== false || !count(raw.size) || raw.scanned !== raw.size || (asOf !== null && !Number.isFinite(Date.parse(asOf)))) return null;
  const u = raw.usage;
  if (!object(u) || !object(u.byModel) || !count(u.messages) || !counters.every(k => count(u[k]))) return null;
  const byModel: TokenUsage['byModel'] = Object.create(null);
  for (const [model, values] of Object.entries(u.byModel)) {
    if (!object(values) || !counters.every(k => count(values[k]))) return null;
    byModel[model] = { input: values.input as number, output: values.output as number, cacheRead: values.cacheRead as number, cacheWrite: values.cacheWrite as number };
  }
  if (!counters.every(k => Object.values(byModel).reduce((sum, m) => sum + m[k], 0) === u[k])) return null;
  return { ...identity, provider: 'claude', transcriptPath: path, source, asOf, schemaVersion: 4, size: raw.size, scanned: raw.scanned as number,
    usage: { input: u.input as number, output: u.output as number, cacheRead: u.cacheRead as number, cacheWrite: u.cacheWrite as number, messages: u.messages, byModel } };
}

/** Prove a cumulative extension even when an older cache has no scan date. */
function extendsScan(a: ArchivedUsage, b: ArchivedUsage): boolean {
  if (a.size < b.size || a.usage.messages < b.usage.messages) return false;
  if (!Object.entries(b.usage.byModel).every(([model, values]) => counters.every(k => (a.usage.byModel[model]?.[k] || 0) >= values[k]))) return false;
  return a.size > b.size || a.usage.messages > b.usage.messages || counters.some(k => a.usage[k] > b.usage[k]);
}

/** One evidence record per logical transcript. Dated observations are ordered
 * by scan/snapshot time. Undated evidence wins only when an extension is proven. */
export class ArchivedUsageLedger {
  constructor(private readonly stateDir: string) {
    try { this.importLegacy(); } catch { /* An unavailable archive cannot disable live usage scans. */ }
  }

  private put(record: ArchivedUsage): void {
    const db = gatewayDb(this.stateDir);
    const old = db.prepare('SELECT data FROM archived_usage WHERE identity=?').get(record.identity);
    if (old) {
      const previous = JSON.parse(String(old.data)) as ArchivedUsage;
      let order: number;
      if ((!record.asOf || !previous.asOf) && extendsScan(record, previous)) order = 1;
      else if ((!record.asOf || !previous.asOf) && extendsScan(previous, record)) order = -1;
      else order = (record.asOf ? Date.parse(record.asOf) : 0) - (previous.asOf ? Date.parse(previous.asOf) : 0) || record.size - previous.size || record.source.localeCompare(previous.source);
      if (order <= 0) return;
    }
    db.prepare('INSERT INTO archived_usage(identity,parent_id,data) VALUES(?,?,?) ON CONFLICT(identity) DO UPDATE SET data=excluded.data,parent_id=excluded.parent_id')
      .run(record.identity, record.parentId, JSON.stringify(record));
  }

  preserve(path: string, raw: unknown, version: number, source: string, asOf: string | null): void {
    const record = archiveRecord(path, raw, version, source, asOf);
    if (record) this.put(record);
  }

  forParent(parentId: string): ArchivedUsage[] {
    try {
      return gatewayDb(this.stateDir).prepare('SELECT data FROM archived_usage WHERE parent_id=? ORDER BY identity').all(parentId)
        .map(row => JSON.parse(String(row.data)) as ArchivedUsage);
    } catch { return []; }
  }

  private importLegacy(): void {
    // Opening the DB first also completes an outstanding legacy cache migration.
    const db = gatewayDb(this.stateDir);
    for (const name of readdirSync(this.stateDir).filter(n => /^transcript-stats\.json\.migrated-/.test(n)).sort()) {
      const source = join(this.stateDir, name);
      let stat: ReturnType<typeof statSync>;
      try { stat = statSync(source); } catch { continue; }
      const imported = db.prepare('SELECT size,mtime FROM archived_usage_imports WHERE source=?').get(source);
      if (imported && Number(imported.size) === stat.size && Number(imported.mtime) === stat.mtimeMs) continue;
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(source, 'utf8')); } catch { continue; }
      if (!object(raw) || raw.v !== 4 || !object(raw.entries)) continue;
      // The file mtime is when its contents were last written, before migration.
      const asOf = stat.mtime.toISOString();
      transaction(db, () => {
        for (const [path, entry] of Object.entries(raw.entries as Record<string, unknown>)) this.preserve(path, entry, 4, source, asOf);
        db.prepare('INSERT INTO archived_usage_imports(source,size,mtime) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET size=excluded.size,mtime=excluded.mtime')
          .run(source, stat.size, stat.mtimeMs);
      });
    }
  }
}
