import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join, basename, resolve } from 'node:path';
import { SessionManager } from './manager.js';
import { STATE_DIR } from './api.controller.js';
import { ArtifactStore, artifactFailureReason, readState, writeState } from './workspace-store.js';
interface PendingImage {
  firstSeen: number;
  attempts: number;
  lastAttempt: number;
}
/** Bounds for retrying a referenced image whose file does not exist yet. */
export const IMAGE_RETRY = { attempts: 5, spacingMs: 1_000, windowMs: 10 * 60_000, rejectedMs: 30 * 60_000 };
@Controller('api/workspace')
export class WorkspaceController {
  private artifacts: ArtifactStore;
  private metaFile: string;
  private unsubscribe: () => void;
  /** Image paths a tool call named, waiting for the file to exist. */
  private imageReferences = new Map<string, Map<string, PendingImage>>();
  /** Paths add() refused for a reason that will not change soon (location,
   *  name, type, size), keyed `projectId::sessionId\0path` -> refused at. A
   *  screenshot loop names the same refused file again and again; 4 Nov 2026
   *  a worker set named 142 such files. Each re-mention would cost an add(). */
  private rejectedImages = new Map<string, number>();
  private plannerTimer: ReturnType<typeof setInterval>;
  constructor(
    @Inject(SessionManager) private manager: SessionManager,
    @Inject(STATE_DIR) state: string,
  ) {
    this.artifacts = new ArtifactStore(state, () =>
      this.manager.listProjects().projects.flatMap((p) => p.cwd ? [p.cwd] : []),
    );
    this.metaFile = join(state, 'conversation-metadata.json');
    this.plannerTimer = setInterval(() => this.manager.tickQueuePlanner(), 1000);
    this.plannerTimer.unref();
    this.unsubscribe = this.manager.subscribe((e) => {
      const pid = String(e.data.projectId || ''),
        sid = String(e.data.sessionId || ''),
        key = pid + '::' + sid;
      if (pid && sid && e.kind === 'artifact_reference' && Array.isArray(e.data.paths)) {
        const paths = this.imageReferences.get(key) || new Map<string, PendingImage>();
        for (const path of e.data.paths)
          if (typeof path === 'string' && !paths.has(path) && paths.size < 100 && !this.recentlyRejected(key, path))
            paths.set(path, { firstSeen: Date.now(), attempts: 0, lastAttempt: 0 });
        if (paths.size) this.imageReferences.set(key, paths);
      }
      if (
        pid &&
        sid &&
        (e.kind === 'session_done' ||
          e.kind === 'session_error' ||
          (e.kind === 'activity' && e.data.status !== 'start'))
      ) {
        const final = e.kind !== 'activity';
        const paths = this.imageReferences.get(key);
        if (paths?.size) this.captureImages(pid, sid, paths, final);
        if (final || !paths?.size) this.imageReferences.delete(key);
      }

      if (
        e.kind === 'assistant_text' &&
        e.data.projectId &&
        e.data.sessionId &&
        typeof e.data.text === 'string'
      ) {
        const cwd = /\]\((?:<?\.\.?\/|<?[^/:#\s]+\/)/.test(e.data.text)
          ? this.manager.listProjects().projects.find((p) => p.id === pid)?.cwd
          : undefined;
        this.artifacts.collect(pid, sid, e.data.text, cwd);
      }
    });
  }
  /** Try each queued image once. Added -> done. Not there yet (ENOENT, the
   *  usual case: the tool_use names the screenshot before the command writes
   *  it) -> retry with a doubling gap from IMAGE_RETRY.spacingMs (events in
   *  between are skipped, not counted: they come in bursts), at most
   *  IMAGE_RETRY.attempts times or IMAGE_RETRY.windowMs after first seen.
   *  Anything else (location, name, type, size, permissions) can never
   *  succeed: drop it now. Every
   *  activity event lands here, subagents' included, so a path that is never
   *  dropped is re-checked on every tool completion until the turn ends.
   *  `final` (the turn ended) ignores the spacing; the caller then clears. */
  private captureImages(pid: string, sid: string, paths: Map<string, PendingImage>, final: boolean) {
    const now = Date.now();
    for (const [path, p] of [...paths]) {
      if (!final && p.attempts > 0 && now - p.lastAttempt < IMAGE_RETRY.spacingMs * 2 ** (p.attempts - 1)) continue;
      p.attempts++;
      p.lastAttempt = now;
      try {
        this.artifacts.add({
          projectId: pid,
          sessionId: sid,
          title: basename(path),
          kind: 'image',
          path,
          source: 'response',
        });
        paths.delete(path);
      } catch (error) {
        const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
        if (!missing) this.rememberRejected(pid + '::' + sid, path, now);
        if (!missing || p.attempts >= IMAGE_RETRY.attempts || now - p.firstSeen >= IMAGE_RETRY.windowMs)
          paths.delete(path);
      }
    }
  }
  private recentlyRejected(key: string, path: string): boolean {
    const at = this.rejectedImages.get(key + '\0' + path);
    if (at === undefined) return false;
    if (Date.now() - at < IMAGE_RETRY.rejectedMs) return true;
    this.rejectedImages.delete(key + '\0' + path);
    return false;
  }
  private rememberRejected(key: string, path: string, now: number) {
    if (this.rejectedImages.size >= 5000) this.rejectedImages.clear();
    this.rejectedImages.set(key + '\0' + path, now);
  }
  onModuleDestroy() {
    clearInterval(this.plannerTimer);
    this.unsubscribe();
  }
  private validate(pid: string, sid: string) {
    if (!this.manager.listConversations(pid).some((c) => c.sessionId === sid))
      throw new BadRequestException('Conversation not found');
  }
  @Get('metadata') metadata() {
    return readState<Record<string, { archived?: boolean; tags?: string[] }>>(this.metaFile, {});
  }
  @Post('metadata') update(
    @Body()
    body: {
      items: {
        projectId: string;
        sessionId: string;
        archived?: boolean;
        tags?: string[];
      }[];
    },
  ) {
    if (!Array.isArray(body.items) || body.items.length > 500)
      throw new BadRequestException('Select up to 500 conversations');
    for (const x of body.items) {
      this.validate(x.projectId, x.sessionId);
      if (
        x.tags &&
        (!Array.isArray(x.tags) || x.tags.some((t) => typeof t !== 'string' || t.length > 40))
      )
        throw new BadRequestException('Tags must be short text');
    }
    const all = this.metadata();
    for (const x of body.items) {
      const key = x.projectId + '::' + x.sessionId;
      all[key] = {
        ...all[key],
        ...(typeof x.archived === 'boolean' ? { archived: x.archived } : {}),
        ...(x.tags ? { tags: [...new Set(x.tags)].slice(0, 20) } : {}),
      };
    }
    writeState(this.metaFile, all);
    return all;
  }
  @Get('artifacts') list(@Query('projectId') pid?: string, @Query('sessionId') sid?: string) {
    return this.artifacts
      .list()
      .filter((x) => (!pid || x.projectId === pid) && (!sid || x.sessionId === sid));
  }
  @Post('artifacts') add(
    @Body()
    body: {
      projectId: string;
      sessionId: string;
      title?: string;
      path?: string;
      url?: string;
      summary?: string;
      status?: string;
    },
  ) {
    this.validate(body.projectId, body.sessionId);
    try {
      return this.artifacts.add({
        projectId: body.projectId,
        sessionId: body.sessionId,
        title: (
          body.title ||
          body.path?.split('/').pop() ||
          (body.summary ? 'Test result' : 'Preview')
        ).slice(0, 180),
        source: 'manual',
        kind: body.path ? 'file' : body.summary ? 'test' : 'preview',
        path: body.path,
        url: body.url,
        summary: body.summary?.slice(0, 2000),
        status: body.status,
      });
    } catch (e) {
      throw new BadRequestException(artifactFailureReason(e));
    }
  }
  @Post('artifact-reference') reference(
    @Body()
    body: { projectId: string; sessionId: string; title?: string; target?: string },
  ) {
    this.validate(body.projectId, body.sessionId);
    if (typeof body.target !== 'string' || !body.target.trim() || body.target.length > 4096)
      throw new BadRequestException('Invalid file reference');
    const project = this.manager.listProjects().projects.find((p) => p.id === body.projectId);
    if (!project) throw new BadRequestException('Project not found');
    let target = body.target.trim().replace(/^<|>$/g, '').replace(/^sandbox:/, '');
    try {
      target = decodeURIComponent(target);
    } catch {}
    target = target.replace(/:\d+(?::\d+)?$/, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(target))
      throw new BadRequestException('Only local project file references are supported');
    try {
      return this.artifacts.add({
        projectId: body.projectId,
        sessionId: body.sessionId,
        title: (body.title?.trim() || basename(target) || 'Referenced file').slice(0, 180),
        kind: 'file',
        path: target.startsWith('/') ? target : resolve(this.manager.executionProject(project.id).cwd, target),
        source: 'manual',
      });
    } catch (error) {
      throw new BadRequestException(artifactFailureReason(error));
    }
  }
  @Post('artifacts/scan') scan(@Body() body: { projectId: string; sessionId: string }) {
    return this.scanReport(body).items;
  }
  @Post('artifacts/scan-report') scanReport(@Body() body: { projectId: string; sessionId: string }) {
    this.validate(body.projectId, body.sessionId);
    const { adapter, providerSessionId, configDirs } = this.manager.historyContext(
      body.projectId,
      body.sessionId,
    );
    const cwd = this.manager.listProjects().projects.find((p) => p.id === body.projectId)?.cwd;
    const warnings = new Map<string, string>();
    let before: number | undefined,
      done = false,
      scanned = 0;
    for (let n = 0; n < 10 && !done; n++) {
      const page = adapter.readHistoryPage
        ? adapter.readHistoryPage(configDirs, providerSessionId, 150, before)
        : {
            rows: adapter.readHistory?.(configDirs, providerSessionId, 150) || [],
            cursor: 0,
            done: true,
          };
      for (const row of page.rows) {
        scanned++;
        if (row.role === 'assistant') {
          for (const item of this.artifacts.collect(body.projectId, body.sessionId, row.text, cwd)
            .skipped)
            warnings.set(item.target, item.reason);
        }
        for (const path of row.artifacts || [])
          try {
            this.artifacts.add({
              projectId: body.projectId,
              sessionId: body.sessionId,
              title: basename(path),
              kind: 'image',
              path,
              source: 'response',
            });
          } catch (error) {
            warnings.set(path, artifactFailureReason(error));
          }
      }
      done = page.done || page.cursor === before || page.cursor <= 0;
      before = page.cursor;
    }
    return {
      items: this.list(body.projectId, body.sessionId),
      warnings: [...warnings].map(([path, reason]) => ({ path, reason })),
      scanned,
      truncated: !done,
    };
  }
  /** Read retained bytes only; never fetch preview URLs or arbitrary paths. */
  @Get('artifact-content') content(@Query('id') id: string) {
    const artifact = this.artifacts.list().find(item => item.id === id);
    if (!artifact) throw new BadRequestException('Artifact not found');
    const found = this.artifacts.fileFor(id);
    if (!found) return { artifact, truncated: false, note: artifact.file ? 'Retained file is unavailable.' : 'This artifact has no file content.' };
    const mime = artifact.mime || '';
    const image = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime);
    const text = mime.startsWith('text/') || mime === 'application/json';
    if (!image && !text) return { artifact, truncated: false, note: 'Download this file using /api/workspace/artifact-file?id=' + encodeURIComponent(id) };
    const fd = openSync(found.path, 'r');
    try {
      const size = fstatSync(fd).size, max = image ? 2 * 1024 * 1024 : 64 * 1024;
      if (image && size > max) return { artifact, truncated: true, note: 'Image exceeds the 2 MB inline limit; use the artifact download endpoint.' };
      const bytes = Buffer.alloc(Math.min(size, max));
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      return { artifact, truncated: size > max, ...(image ? { image: { data: bytes.subarray(0, count).toString('base64'), mimeType: mime } } : { text: bytes.subarray(0, count).toString('utf8') }) };
    } finally { closeSync(fd); }
  }

  @Get('artifact-file') file(@Query('id') id: string, @Res() res: Response) {
    const found = this.artifacts.fileFor(id);
    if (!found) {
      res.status(404).send('File not found');
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.attachment(found.item.original?.split('/').pop() || found.item.title.replace(/[\r\n]/g, ''));
    res.type(found.item.mime || 'application/octet-stream');
    res.sendFile(found.path);
  }
  @Post('artifacts/remove') remove(@Body() body: { id: string }) {
    this.artifacts.remove(body.id);
    return { ok: true };
  }
}
