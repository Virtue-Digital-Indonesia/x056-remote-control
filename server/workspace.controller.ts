import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join } from 'node:path';
import { SessionManager } from './manager.js';
import { STATE_DIR } from './api.controller.js';
import { ArtifactStore, readState, writeState } from './workspace-store.js';
@Controller('api/workspace')
export class WorkspaceController {
  private artifacts: ArtifactStore;
  private metaFile: string;
  private unsubscribe: () => void;
  private plannerTimer: ReturnType<typeof setInterval>;
  constructor(
    @Inject(SessionManager) private manager: SessionManager,
    @Inject(STATE_DIR) state: string,
  ) {
    this.artifacts = new ArtifactStore(state, () => this.manager.listProjects().projects.map((p) => p.cwd));
    this.metaFile = join(state, 'conversation-metadata.json');
    this.plannerTimer = setInterval(() => this.manager.tickQueuePlanner(), 1000);
    this.plannerTimer.unref();
    this.unsubscribe = this.manager.subscribe((e) => {
      if (
        e.kind === 'assistant_text' &&
        e.data.projectId &&
        e.data.sessionId &&
        typeof e.data.text === 'string'
      )
        this.artifacts.collect(String(e.data.projectId), String(e.data.sessionId), e.data.text);
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
    @Body() body: { items: { projectId: string; sessionId: string; archived?: boolean; tags?: string[] }[] },
  ) {
    if (!Array.isArray(body.items) || body.items.length > 500)
      throw new BadRequestException('Select up to 500 conversations');
    for (const x of body.items) {
      this.validate(x.projectId, x.sessionId);
      if (x.tags && (!Array.isArray(x.tags) || x.tags.some((t) => typeof t !== 'string' || t.length > 40)))
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
      throw new BadRequestException((e as Error).message);
    }
  }
  @Post('artifacts/scan') scan(@Body() body: { projectId: string; sessionId: string }) {
    this.validate(body.projectId, body.sessionId);
    const { adapter, providerSessionId, configDirs } = this.manager.historyContext(
      body.projectId,
      body.sessionId,
    );
    const page = adapter.readHistoryPage
      ? adapter.readHistoryPage(configDirs, providerSessionId, 150)
      : { rows: adapter.readHistory?.(configDirs, providerSessionId, 150) || [] };
    for (const r of page.rows)
      if (r.role === 'assistant') this.artifacts.collect(body.projectId, body.sessionId, r.text);
    return this.list(body.projectId, body.sessionId);
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
