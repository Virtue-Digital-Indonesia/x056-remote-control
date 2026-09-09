import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { imagePaths } from '../src/artifact-references.js';
import { basename, extname, join, resolve, sep, relative } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface Artifact {
  id: string;
  projectId: string;
  sessionId: string;
  title: string;
  kind: 'image' | 'file' | 'preview' | 'test';
  at: string;
  source: 'response' | 'manual';
  url?: string;
  file?: string;
  original?: string;
  mime?: string;
  size?: number;
  status?: string;
  summary?: string;
  removed?: boolean;
}
const TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function artifactFailureReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return 'The original file is no longer available.';
  if (code === 'EACCES' || code === 'EPERM') return 'The gateway cannot read this file.';
  return error instanceof Error ? error.message : 'The file could not be added.';
}
export function readState<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
export function writeState(file: string, value: unknown): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  renameSync(file + '.tmp', file);
}
export class ArtifactStore {
  private file: string;
  private worktrees = new Map<string, { at: number; paths: string[] }>();
  constructor(
    private state: string,
    private roots: () => string[],
  ) {
    this.file = join(state, 'artifacts.json');
  }
  private all(): Artifact[] {
    return readState<Artifact[]>(this.file, []);
  }
  list(): Artifact[] {
    return this.all().filter((x) => !x.removed);
  }
  private reuse(item: Artifact, source: Artifact['source'], all: Artifact[]): Artifact {
    if (item.removed && source === 'manual') {
      delete item.removed;
      item.at = new Date().toISOString();
      writeState(this.file, all);
    }
    return item;
  }
  add(input: Omit<Artifact, 'id' | 'at'> & { path?: string }): Artifact {
    const all = this.all(),
      item: Artifact = {
        ...input,
        id: randomUUID(),
        at: new Date().toISOString(),
      };
    delete (item as Artifact & { path?: string }).path;
    if (input.path) {
      let path: string;
      try {
        path = realpathSync(input.path);
      } catch (error) {
        // A temporary source may be gone after we preserved its bytes. Reuse
        // the retained artifact instead of claiming that its screenshot is lost.
        const retained = all.find(
          (x) =>
            x.projectId === input.projectId &&
            x.sessionId === input.sessionId &&
            x.original === resolve(input.path!) &&
            x.file,
        );
        if (retained) {
          try {
            if (statSync(join(this.state, 'artifacts', basename(retained.file!))).isFile())
              return this.reuse(retained, input.source, all);
          } catch {}
        }
        throw error;
      }
      const roots = [...this.roots(), join(this.state, 'uploads'), '/tmp'];
      const visiblePart = (part: string) =>
        !part.startsWith('.') || /^\.review(?:[-_].+)?$/i.test(part);
      const matches = (root: string) => {
        try {
          return path.startsWith(realpathSync(root) + sep);
        } catch {
          return false;
        }
      };
      const visible = (root: string) =>
        matches(root) &&
        !relative(realpathSync(root), path)
          .split(sep)
          .some((p) => !visiblePart(p));
      let allowedRoot = roots.find(visible);
      if (!allowedRoot)
        for (const root of this.roots()) {
          let cached = this.worktrees.get(root);
          if (!cached || Date.now() - cached.at > 30000) {
            let paths: string[] = [];
            try {
              paths = execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], {
                encoding: 'utf8',
                timeout: 2000,
                maxBuffer: 1024 * 1024,
                stdio: ['ignore', 'pipe', 'ignore'],
              })
                .split('\0')
                .filter((x) => x.startsWith('worktree '))
                .map((x) => x.slice(9));
            } catch {}
            cached = { at: Date.now(), paths };
            this.worktrees.set(root, cached);
          }
          allowedRoot = cached.paths.filter(visible).sort((a, b) => b.length - a.length)[0];
          if (allowedRoot) break;
        }
      if (
        !allowedRoot ||
        relative(realpathSync(allowedRoot), path)
          .split(sep)
          .some((p) => !visiblePart(p)) ||
        /(?:credential|secret|token|password|auth\.json)/i.test(basename(path))
      )
        throw new Error('This file cannot be added to the library.');
      const mime = TYPES[extname(path).toLowerCase()],
        info = statSync(path);
      if (!mime || !info.isFile() || info.size > 50 * 1024 * 1024)
        throw new Error('Use a supported document or image under 50 MB.');
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      const previous = all.find(
        (x) =>
          x.projectId === input.projectId &&
          x.sessionId === input.sessionId &&
          x.file?.startsWith(digest),
      );
      if (previous) return this.reuse(previous, input.source, all);
      item.file = digest + extname(path).toLowerCase();
      item.original = path;
      item.mime = mime;
      item.size = info.size;
      item.kind = mime.startsWith('image/') ? 'image' : 'file';
      mkdirSync(join(this.state, 'artifacts'), { recursive: true });
      copyFileSync(path, join(this.state, 'artifacts', item.file));
    } else if (input.kind === 'preview') {
      const url = new URL(input.url || '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Use an HTTP or HTTPS preview URL.');
      item.url = url.href;
      const previous = all.find(
        (x) => x.projectId === input.projectId && x.sessionId === input.sessionId && x.url === item.url,
      );
      if (previous) return this.reuse(previous, input.source, all);
    } else if (input.kind === 'test') {
      const previous = all.find(
        (x) =>
          x.projectId === input.projectId &&
          x.sessionId === input.sessionId &&
          x.kind === 'test' &&
          x.summary === input.summary,
      );
      if (previous) return this.reuse(previous, input.source, all);
    } else throw new Error('A file path, preview URL, or test result is required.');
    all.unshift(item);
    writeState(this.file, all);
    return item;
  }
  remove(id: string): void {
    const all = this.all(),
      item = all.find((x) => x.id === id);
    if (item) item.removed = true;
    writeState(this.file, all);
  }
  fileFor(id: string): { item: Artifact; path: string } | undefined {
    const item = this.list().find((x) => x.id === id);
    if (!item?.file) return;
    return { item, path: join(this.state, 'artifacts', basename(item.file)) };
  }
  collect(
    projectId: string,
    sessionId: string,
    text: string,
    cwd?: string,
  ): { skipped: { target: string; reason: string }[] } {
    const skipped: { target: string; reason: string }[] = [];
    for (const m of text.matchAll(/\[([^\]\n]+)\]\((<?[^)\n]+>?)\)/g)) {
      let target = m[2].replace(/^<|>$/g, '').replace(/^sandbox:/, '');
      if (cwd && !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(target) && TYPES[extname(target).toLowerCase()])
        target = resolve(cwd, target);
      if (target.startsWith('/'))
        try {
          target = decodeURIComponent(target);
        } catch {}
      if (
        !target.startsWith('/') &&
        !/preview|demo|draft|localhost|127\.0\.0\.1|\.think\.|\.rc\.|\.val\.id/i.test(
          m[1] + ' ' + target,
        )
      )
        continue;
      try {
        this.add({
          projectId,
          sessionId,
          title: m[1].slice(0, 180),
          kind: target.startsWith('/') ? 'file' : 'preview',
          ...(target.startsWith('/') ? { path: target.replace(/:\d+(?::\d+)?$/, '') } : { url: target }),
          source: 'response',
        });
      } catch (error) {
        if (/\.(png|jpe?g|webp|gif)$/i.test(target))
          skipped.push({ target, reason: artifactFailureReason(error) });
      }
    }
    for (const path of imagePaths(text)) {
      try {
        this.add({
          projectId,
          sessionId,
          title: basename(path),
          kind: 'image',
          path,
          source: 'response',
        });
      } catch (error) {
        if (!skipped.some((x) => x.target === path))
          skipped.push({ target: path, reason: artifactFailureReason(error) });
      }
    }
    const testLine = text
      .split('\n')
      .find(
        (line) =>
          /\b(?:tests?\s+(?:passed|failed)|\d+\s+(?:tests?\s+)?passed|test\s+results?:)/i.test(line) &&
          line.length < 500,
      );
    if (
      testLine &&
      !this.list().some(
        (x) => x.projectId === projectId && x.sessionId === sessionId && x.summary === testLine,
      )
    )
      this.add({
        projectId,
        sessionId,
        title: 'Reported test result',
        kind: 'test',
        summary: testLine,
        source: 'response',
        status: /\bfailed\b/i.test(testLine.replace(/\b0\s+(?:tests?\s+)?failed\b/gi, ''))
          ? 'failed'
          : /\bpassed\b/i.test(testLine)
            ? 'passed'
            : 'reported',
      });
    return { skipped };
  }
}
export interface DeliveryReceipt {
  requestId: string;
  hash: string;
  status: 'processing' | 'accepted' | 'queued' | 'failed' | 'uncertain' | 'cancelled';
  at: number;
  sessionId?: string;
  id?: string;
  queued?: boolean;
  steered?: boolean;
  error?: string;
}
export class DeliveryStore {
  private file: string;
  constructor(state: string) {
    this.file = join(state, 'message-receipts.json');
    const rows = this.all();
    for (const r of Object.values(rows)) if (r.status === 'processing') r.status = 'uncertain';
    writeState(this.file, rows);
  }
  all(): Record<string, DeliveryReceipt> {
    return readState(this.file, {});
  }
  get(id: string) {
    return this.all()[id];
  }
  accept(id: string, sessionId: string, status: 'accepted' | 'cancelled' | 'uncertain' = 'accepted') {
    const rows = this.all();
    if (rows[id]) {
      rows[id].status = status;
      rows[id].sessionId = sessionId;
      writeState(this.file, rows);
    }
  }
  run<T extends { requestId?: string }>(
    body: T,
    action: () => {
      sessionId?: string;
      id?: string;
      queued?: boolean;
      steered?: boolean;
    },
  ): DeliveryReceipt {
    const id = body.requestId || '';
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(id)) throw new Error('Invalid request ID');
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      rows = this.all(),
      previous = rows[id];
    if (previous && previous.hash !== hash)
      throw new Error('Request ID was already used for another message');
    if (previous && previous.status !== 'failed') return previous;
    rows[id] = { requestId: id, hash, status: 'processing', at: Date.now() };
    writeState(this.file, rows);
    let result: {
      sessionId?: string;
      id?: string;
      queued?: boolean;
      steered?: boolean;
    };
    try {
      result = action();
    } catch (e) {
      rows[id] = { ...rows[id], status: 'failed', error: (e as Error).message };
      writeState(this.file, rows);
      throw e;
    }
    rows[id] = {
      ...rows[id],
      ...result,
      status: result.queued ? 'queued' : 'accepted',
    };
    // A persistence error after dispatch leaves the durable processing marker;
    // it must never turn an already-started request into a retryable failure.
    writeState(this.file, rows);
    return rows[id];
  }
}
