import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { SessionManager } from './manager.js';
import { STATE_DIR } from './api.controller.js';
import {
  MemoryConflict,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryStatus,
  type MemorySettings,
  type ContextPreferences,
} from './memory-store.js';
import { MemorySources, cleanMemorySource } from './memory-sources.js';

@Controller('api/memory')
export class MemoryController {
  constructor(
    @Inject(SessionManager) private manager: SessionManager,
    @Inject(STATE_DIR) private state: string,
  ) {}
  private store() {
    return this.manager.memory();
  }
  private call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof MemoryConflict) throw new ConflictException(e.message);
      throw new BadRequestException((e as Error).message);
    }
  }
  private validateProject(pid?: string, sid?: string) {
    if (pid && !this.manager.listProjects().projects.some((p) => p.id === pid))
      throw new Error('Project not found');
    if (sid && (!pid || !this.manager.listConversations(pid).some((c) => c.sessionId === sid)))
      throw new Error('Conversation not found');
  }
  private validateEntry(e: Partial<MemoryEntry>) {
    this.validateProject(e.projectId, e.sessionId);
    for (const pid of e.sharedProjectIds || []) this.validateProject(pid);
    for (const s of e.sources || []) {
      if (s.id && !this.store().source(s.id)) throw new Error('Source not found');
    }
  }
  @Get('stats') stats() {
    return this.store().stats();
  }
  @Get('search') search(@Query() q: MemoryQuery & { callerProjectId?: string; callerSessionId?: string }) {
    return this.call(() => {
      if (q.callerProjectId && q.callerSessionId) {
        this.validateProject(q.callerProjectId, q.callerSessionId);
        q.provider = this.manager.historyContext(q.callerProjectId, q.callerSessionId).adapter.id;
      }
      return this.store().search(q);
    });
  }
  @Get('entry') entry(
    @Query('id') id: string,
    @Query('projectId') pid?: string,
    @Query('sessionId') sid?: string,
    @Query('provider') provider?: 'claude' | 'codex',
    @Query('callerProjectId') callerPid?: string,
    @Query('callerSessionId') callerSid?: string,
  ) {
    return this.call(() => {
      const entry = this.store().get(id);
      if (!entry) throw new Error('Memory not found');
      if (callerPid && callerSid) {
        this.validateProject(callerPid, callerSid);
        const caller = this.manager.historyContext(callerPid, callerSid).adapter.id;
        if (!entry.providers.includes(caller)) throw new Error('Memory is not enabled for this provider');
      }
      if (
        provider &&
        !this.store().visible(entry, { projectId: pid, sessionId: sid, provider, access: 'context' })
      )
        throw new Error('Memory is outside this conversation’s context scope');
      return {
        entry,
        revisions: this.store().revisions(id),
        related: this.store().related(id),
        sources: entry.sources.map((ref) => ({
          ...ref,
          current: ref.id ? this.store().source(ref.id) : undefined,
          original: ref.id && ref.hash ? this.store().sourceVersion(ref.id, ref.hash) : undefined,
        })),
      };
    });
  }
  @Post('entry') @HttpCode(200) save(
    @Body() body: { entry: Partial<MemoryEntry>; id?: string; revision?: number },
  ) {
    return this.call(() => {
      if (!body?.entry) throw new Error('Memory required');
      const merged = { ...(body.id ? this.store().get(body.id) : {}), ...body.entry };
      this.validateEntry(merged);
      return body.id
        ? this.store().update(body.id, body.revision!, body.entry)
        : this.store().create(body.entry, 'operator');
    });
  }
  @Post('propose') @HttpCode(200) propose(
    @Body() body: { entry: Partial<MemoryEntry>; id?: string; revision?: number },
  ) {
    return this.call(() => {
      if (!body?.entry) throw new Error('Memory required');
      this.validateEntry({ ...(body.id ? this.store().get(body.id) : {}), ...body.entry });
      const entry = { ...body.entry, status: 'proposed' as const };
      return body.id
        ? this.store().update(body.id, body.revision!, entry, 'agent proposal')
        : this.store().create(entry, 'agent proposal');
    });
  }
  @Post('bulk') @HttpCode(200) bulk(
    @Body() body: { items: { id: string; revision: number }[]; status: MemoryStatus },
  ) {
    return this.call(() => this.store().bulk(body.items, body.status));
  }
  @Post('restore-revision') @HttpCode(200) restore(
    @Body() body: { id: string; revision: number; restoreRevision: number },
  ) {
    return this.call(() => {
      const version = this.store()
        .revisions(body.id)
        .find((e) => e.revision === body.restoreRevision);
      if (!version) throw new Error('Revision not found');
      return this.store().update(
        body.id,
        body.revision,
        { ...version, status: 'proposed' },
        'restored revision',
      );
    });
  }
  @Get('sources') sources(@Query() q: MemoryQuery & { excluded?: string }) {
    return this.call(() => this.store().sources(q, q.excluded === 'true'));
  }
  @Get('source') source(@Query('id') id: string, @Query('hash') hash?: string) {
    return this.call(() => {
      const source = hash ? this.store().sourceVersion(id, hash) : this.store().source(id);
      if (!source) throw new Error('Source not found');
      return source;
    });
  }
  @Post('source/exclude') @HttpCode(200) exclude(@Body() b: { id: string; excluded: boolean }) {
    return this.call(() => {
      if (typeof b.excluded !== 'boolean') throw new Error('Invalid exclusion');
      return this.store().excludeSource(b.id, b.excluded);
    });
  }
  @Post('source/promote') @HttpCode(200) promote(@Body() b: { id: string; entry?: Partial<MemoryEntry> }) {
    return this.call(() => {
      if (b.entry) this.validateEntry(b.entry);
      return this.store().proposeSource(b.id, b.entry);
    });
  }
  @Post('document') @HttpCode(200) document(
    @Body() b: { projectId: string; title: string; content: string; reference?: string },
  ) {
    return this.call(() => {
      this.validateProject(b.projectId);
      return this.store().ingest({
        key: 'document:' + b.projectId + ':' + (b.reference || b.title),
        kind: 'document',
        projectId: b.projectId,
        title: b.title,
        content: cleanMemorySource(b.content),
        ref: b.reference,
        at: Date.now(),
      });
    });
  }
  @Post('ingest') @HttpCode(200) ingest(
    @Body()
    b: {
      projectId?: string;
      sessionId?: string;
      conversations?: boolean;
      legacy?: boolean;
      artifacts?: boolean;
    },
  ) {
    return this.call(() => {
      this.validateProject(b.projectId, b.sessionId);
      const service = new MemorySources(this.manager, this.store(), this.state),
        projects = b.projectId ? [b.projectId] : this.manager.listProjects().projects.map((p) => p.id);
      if (projects.length > 100) throw new Error('Import up to 100 projects at a time');
      return projects.map((projectId) => ({ projectId, ...service.ingestProject(projectId, b) }));
    });
  }
  @Get('context') context(
    @Query('projectId') pid: string,
    @Query('sessionId') sid: string,
    @Query('query') query?: string,
    @Query('provider') targetProvider?: 'claude' | 'codex',
  ) {
    return this.call(() => {
      this.validateProject(pid, sid);
      if (!pid) throw new Error('Choose a project');
      const provider = targetProvider || this.manager.historyContext(pid, sid || '').adapter.id;
      if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider');
      return {
        ...this.store().context(pid, sid || '', provider, query || ''),
        provider,
        preferences: this.store().preferences(pid, sid || ''),
        history: this.store().contextHistory(pid, sid),
      };
    });
  }
  @Post('context/preferences') @HttpCode(200) contextPreferences(
    @Body() b: { projectId: string; sessionId: string; preferences: ContextPreferences },
  ) {
    return this.call(() => {
      if (!b.projectId || !b.sessionId) throw new Error('Choose a conversation');
      this.validateProject(b.projectId, b.sessionId);
      return this.store().setPreferences(b.projectId, b.sessionId, b.preferences);
    });
  }
  @Get('activity') activity(@Query('projectId') pid?: string, @Query('sessionId') sid?: string) {
    return this.store().contextHistory(pid, sid);
  }
  @Get('settings') settings() {
    return this.store().settings();
  }
  @Post('settings') @HttpCode(200) setSettings(@Body() b: Partial<MemorySettings>) {
    return this.call(() => this.store().setSettings(b));
  }
  @Post('link') @HttpCode(200) link(@Body() b: { from: string; to: string; kind: string }) {
    return this.call(() => this.store().link(b.from, b.to, b.kind));
  }
  @Post('unlink') @HttpCode(200) unlink(@Body() b: { id: string }) {
    return this.call(() => {
      this.store().unlink(b.id);
      return { ok: true };
    });
  }
  @Post('merge') @HttpCode(200) merge(
    @Body() b: { id: string; revision: number; others: { id: string; revision: number }[]; content: string },
  ) {
    return this.call(() => this.store().merge(b.id, b.revision, b.others, b.content));
  }
  @Get('export') export() {
    return this.store().export();
  }
  @Post('import') @HttpCode(200) import(
    @Body()
    b: {
      format: string;
      version: number;
      entries: MemoryEntry[];
      sources?: unknown[];
      links?: unknown[];
    },
  ) {
    return this.call(() => {
      if (
        b.format !== 'x056-memory' ||
        b.version !== 1 ||
        !Array.isArray(b.entries) ||
        b.entries.length > 10000
      )
        throw new Error('Choose an x056 memory export with at most 10,000 entries');
      for (const entry of b.entries) this.validateEntry({ ...entry, sources: [] });
      return this.store().importPackage(b);
    });
  }
}
