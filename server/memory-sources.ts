import { readMessageSender } from '../src/message-sender.js';
import { createHash } from 'node:crypto';
import { stripMemoryContext } from '../src/memory-context.js';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { stripAsk, stripAskInstructions } from '../src/question.js';
import { projectDirName } from './memories.js';
import { ArtifactStore } from './workspace-store.js';
import type { SessionManager } from './manager.js';
import type { MemoryStore } from './memory-store.js';

export function cleanMemorySource(raw: string) {
  return stripAskInstructions(stripAsk(stripMemoryContext(readMessageSender(raw).text)))
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[private key removed]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})\b/g,
      '[credential removed]',
    )
    .trim();
}
export class MemorySources {
  constructor(
    private manager: SessionManager,
    private store: MemoryStore,
    private stateDir: string,
  ) {}
  ingestProject(
    pid: string,
    options: { conversations?: boolean; legacy?: boolean; artifacts?: boolean; sessionId?: string } = {},
  ) {
    const project = this.manager.listProjects().projects.find((p) => p.id === pid);
    if (!project) throw new Error('Project not found');
    const result = {
      created: 0,
      unchanged: 0,
      updated: 0,
      proposed: 0,
      scanned: 0,
      errors: [] as string[],
      truncated: false,
    };
    const ingest = (input: Parameters<MemoryStore['ingest']>[0], propose = false) => {
      try {
        const r = this.store.ingest(input);
        result.scanned++;
        if (r.created) result.created++;
        else if (r.changed) result.updated++;
        else result.unchanged++;
        if (propose && !r.source.excluded) {
          const p = this.store.proposeSource(r.source.id, {}, 'legacy import');
          if (!p.existed) result.proposed++;
        }
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    };
    if (options.conversations !== false) {
      const conversations = (project.conversations || []).filter(
        (c) => !options.sessionId || c.sessionId === options.sessionId,
      );
      if (conversations.length > 100) result.truncated = true;
      for (const c of conversations.slice(0, 100)) {
        try {
          const ctx = this.manager.historyContext(pid, c.sessionId),
            page = ctx.adapter.readHistoryPage?.(ctx.configDirs, ctx.providerSessionId, 150),
            rows = page?.rows || ctx.adapter.readHistory?.(ctx.configDirs, ctx.providerSessionId, 150) || [];
          if (page && !page.done) result.truncated = true;
          for (const [index, row] of rows.entries()) {
            if (!['user', 'assistant'].includes(row.role)) continue;
            const content = cleanMemorySource(row.text).slice(0, 100000);
            if (!content) continue;
            const at = Date.parse(row.ts || '') || Date.now();
            ingest({
              key:
                'conversation:' +
                pid +
                ':' +
                c.sessionId +
                ':' +
                row.role +
                ':' +
                (row.ts || createHash('sha256').update(content).digest('hex')),
              kind: 'conversation',
              projectId: pid,
              sessionId: c.sessionId,
              provider: ctx.adapter.id,
              title: (c.title + ' · ' + row.role).slice(0, 300),
              content,
              at,
              ref: 'conversation:' + c.sessionId,
            });
          }
        } catch (e) {
          result.errors.push(c.title + ': ' + (e as Error).message);
        }
      }
    }
    if (options.legacy !== false) {
      const seen = new Set<string>();
      for (const a of AccountRegistry.load(join(this.stateDir, 'accounts.json')).list()) {
        const dir = join(a.configDir, 'projects', projectDirName(project.cwd), 'memory');
        let root: string;
        try {
          root = realpathSync(dir);
        } catch {
          continue;
        }
        let names: string[];
        try {
          names = readdirSync(root).filter((x) => x.endsWith('.md') && x !== 'MEMORY.md');
        } catch {
          continue;
        }
        if (names.length > 500) result.truncated = true;
        for (const name of names.slice(0, 500)) {
          try {
            const path = realpathSync(join(root, name));
            if (!path.startsWith(root + sep) || seen.has(path)) continue;
            seen.add(path);
            const stat = statSync(path);
            if (!stat.isFile() || stat.size > 200000) continue;
            const content = cleanMemorySource(readFileSync(path, 'utf8'));
            if (!content) continue;
            ingest(
              {
                key: 'legacy:' + pid + ':' + path,
                kind: 'legacy',
                projectId: pid,
                provider: a.provider,
                title: name.replace(/\.md$/, '').slice(0, 300),
                content,
                at: stat.mtimeMs,
                ref: path,
              },
              true,
            );
          } catch (e) {
            result.errors.push(name + ': ' + (e as Error).message);
          }
        }
      }
    }
    if (options.artifacts !== false) {
      const library = new ArtifactStore(this.stateDir, () => [project.cwd]);
      for (const a of library
        .list()
        .filter((x) => x.projectId === pid && (!options.sessionId || x.sessionId === options.sessionId))
        .slice(0, 500)) {
        let content = [a.title, a.summary, a.url].filter(Boolean).join('\n');
        const file = library.fileFor(a.id);
        if (file && /\.(md|txt|csv|json)$/i.test(file.path)) {
          try {
            if (statSync(file.path).size <= 100000) content += '\n' + readFileSync(file.path, 'utf8');
          } catch {}
        }
        ingest({
          key: 'artifact:' + a.id,
          kind: 'artifact',
          projectId: pid,
          sessionId: a.sessionId,
          title: a.title,
          content: cleanMemorySource(content).slice(0, 100000),
          at: Date.parse(a.at),
          ref: a.url || file?.path || 'artifact:' + a.id,
        });
      }
    }
    return result;
  }
}
