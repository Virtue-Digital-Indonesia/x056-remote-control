import { openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join, basename } from 'node:path';
import { SessionManager } from './manager.js';
import { STATE_DIR } from './api.controller.js';
import { ArtifactStore, artifactFailureReason, readState, writeState } from './workspace-store.js';
@Controller('api/workspace')
export class WorkspaceController {
  private artifacts: ArtifactStore;
  private metaFile: string;
  private unsubscribe: () => void;
  private imageReferences = new Map<string, Set<string>>();
  private plannerTimer: ReturnType<typeof setInterval>;
  constructor(
    @Inject(SessionManager) private manager: SessionManager,
    @Inject(STATE_DIR) state: string,
  ) {
    this.artifacts = new ArtifactStore(state, () =>
      this.manager.listProjects().projects.map((p) => p.cwd),
    );
    this.metaFile = join(state, 'conversation-metadata.json');
    this.plannerTimer = setInterval(() => this.manager.tickQueuePlanner(), 1000);
    this.plannerTimer.unref();
    this.unsubscribe = this.manager.subscribe((e) => {
      const pid = String(e.data.projectId || ''),
        sid = String(e.data.sessionId || ''),
        key = pid + '::' + sid;
      if (pid && sid && e.kind === 'artifact_reference' && Array.isArray(e.data.paths)) {
        const paths = this.imageReferences.get(key) || new Set<string>();
        for (const path of e.data.paths)
          if (typeof path === 'string' && paths.size < 100) paths.add(path);
        this.imageReferences.set(key, paths);
      }
      if (
        pid &&
        sid &&
        (e.kind === 'session_done' ||
          e.kind === 'session_error' ||
          (e.kind === 'activity' && e.data.status !== 'start'))
      ) {
        for (const path of this.imageReferences.get(key) || [])
          try {
            this.artifacts.add({
              projectId: pid,
              sessionId: sid,
              title: basename(path),
              kind: 'image',
              path,
              source: 'response',
            });
            this.imageReferences.get(key)?.delete(path);
          } catch {}
        if (e.kind !== 'activity') this.imageReferences.delete(key);
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
