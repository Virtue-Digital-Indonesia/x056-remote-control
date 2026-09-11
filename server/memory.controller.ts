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
    if(e.spaceId)this.manager.projectContext().validateMemoryOwner({kind:'space',id:e.spaceId});
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
        return this.store().searchContext({ ...q, projectId: q.callerProjectId, sessionId: q.callerSessionId,
          spaceId:undefined,requestId:this.manager.memoryRequestId(q.callerProjectId,q.callerSessionId),provider: this.manager.historyContext(q.callerProjectId, q.callerSessionId).adapter.id, access: 'context' });
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
      const pinned=callerPid&&callerSid?this.store().access.references(callerPid,callerSid,this.manager.memoryRequestId(callerPid,callerSid))?.selections.find(r=>r.kind==='entry'&&r.id===id):undefined;
      const entry = pinned?this.store().revisions(id).find(e=>String(e.revision)===pinned.version):this.store().get(id);
      if (!entry) throw new Error('Memory not found');
      const contextQuery = callerPid && callerSid ? { projectId: callerPid, sessionId: callerSid, requestId:this.manager.memoryRequestId(callerPid,callerSid),provider: this.manager.historyContext(callerPid, callerSid).adapter.id, access: 'context' as const } : undefined;
      if (callerPid && callerSid) {
        this.validateProject(callerPid, callerSid);
        const caller = this.manager.historyContext(callerPid, callerSid).adapter.id;
        const reason = this.store().contextProblem(entry, { projectId: callerPid, sessionId: callerSid, requestId:this.manager.memoryRequestId(callerPid,callerSid),provider: caller, access: 'context' });
        if (reason) throw new Error(reason);
      }
      if (
        provider &&
        !this.store().visible(entry, { projectId: pid, sessionId: sid, provider, access: 'context' })
      )
        throw new Error('Memory is outside this conversation’s context scope');
      if(contextQuery)this.store().access.recordRead({kind:'entry',id,version:String(entry.revision)},callerPid!,callerSid!,contextQuery.requestId);
      return {
        entry,
        revisions: this.store().revisions(id).filter(e => !contextQuery || !this.store().contextProblem(e, contextQuery)),
        related: this.store().related(id).filter(link => !contextQuery || (link.entry && !this.store().contextProblem(link.entry, contextQuery))),
        sources: entry.sources.map(ref => {
          const current=ref.id?this.store().source(ref.id):undefined, original=ref.id&&(ref.versionId||ref.hash)?this.store().sourceVersion(ref.id,ref.versionId||ref.hash!):undefined;
          const problem=contextQuery&&current?this.store().sourceContextProblem(current,contextQuery):undefined;
          return {...ref,...(problem?{unavailable:problem}:{current,original})};
        }),
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
    @Body() body: { entry: Partial<MemoryEntry>; id?: string; revision?: number;callerProjectId?:string;callerSessionId?:string },
  ) {
    return this.call(() => {
      if (!body?.entry) throw new Error('Memory required');
      this.validateEntry({ ...(body.id ? this.store().get(body.id) : {}), ...body.entry });
      const q=this.callerQuery(body);
      if(body.callerProjectId&&body.callerSessionId){
        if(body.id){const current=this.store().get(body.id);if(!current)throw new Error('Memory not found');const problem=this.store().contextProblem(current,q);if(problem)throw new Error(problem);}
        for(const ref of body.entry.sources||[]){if(!ref.id)continue;const source=this.store().source(ref.id);if(!source)throw new Error('Source unavailable');const reason=this.store().sourceContextProblem(source,q);if(reason)throw new Error(reason);const grant=this.store().access.eligible({kind:'source',id:ref.id},body.callerProjectId,body.callerSessionId);ref.grantId=grant?.id;ref.grantRevision=grant?.revision;ref.hash=source.hash;ref.versionId=source.versionId;ref.spaceId=source.spaceId;}
      }
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
  private callerQuery(q:MemoryQuery & {callerProjectId?:string;callerSessionId?:string}):MemoryQuery {
    if(q.callerProjectId&&q.callerSessionId){this.validateProject(q.callerProjectId,q.callerSessionId);return {...q,projectId:q.callerProjectId,sessionId:q.callerSessionId,spaceId:undefined,requestId:this.manager.memoryRequestId(q.callerProjectId,q.callerSessionId),provider:this.manager.historyContext(q.callerProjectId,q.callerSessionId).adapter.id,access:'context',eligibleOnly:true};}
    return q;
  }
  @Get('sources') sources(@Query() q: MemoryQuery & { excluded?: string;callerProjectId?:string;callerSessionId?:string }) {
    return this.call(() => this.store().sources(this.callerQuery(q), !q.callerProjectId&&q.excluded === 'true'));
  }
  @Get('source') source(@Query('id') id: string, @Query('hash') hash?: string,@Query('callerProjectId') callerProjectId?:string,@Query('callerSessionId') callerSessionId?:string) {
    return this.call(() => {
      const source = hash ? this.store().sourceVersion(id, hash) : this.store().source(id);
      if (!source) throw new Error('Source not found');
      if(callerProjectId&&callerSessionId){const reason=this.store().sourceContextProblem(source,this.callerQuery({callerProjectId,callerSessionId}));if(reason)throw new Error(reason);this.store().access.recordRead({kind:'source',id,version:source.versionId||source.hash},callerProjectId,callerSessionId,this.manager.memoryRequestId(callerProjectId,callerSessionId));}
      return source;
    });
  }
  @Get('grants') grants(@Query('kind') kind:'entry'|'source',@Query('id') id:string) {return this.call(()=>this.store().access.grants({kind,id}));}
  @Post('grants') @HttpCode(200) share(@Body() b:Parameters<ReturnType<MemoryController['store']>['access']['setGrant']>[0]) {return this.call(()=>this.store().access.setGrant(b));}
  @Get('references') references(@Query('projectId') pid:string,@Query('sessionId') sid:string,@Query('requestId') requestId:string) {
    return this.call(()=>{this.validateProject(pid,sid);return this.store().access.references(pid,sid,requestId)||{projectId:pid,sessionId:sid,requestId,revision:0,selections:[]};});
  }
  @Post('references') @HttpCode(200) setReferences(@Body() b:Parameters<ReturnType<MemoryController['store']>['access']['setReferences']>[0]) {
    return this.call(()=>{this.validateProject(b.projectId,b.sessionId);if(!b.projectId||!b.sessionId)throw new Error('Choose a conversation');return this.store().access.setReferences(b);});
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
    @Body() b: { projectId?: string; spaceId?:string; title: string; content: string; reference?: string },
  ) {
    return this.call(() => {
      this.validateProject(b.projectId);
      if(b.spaceId)this.manager.projectContext().validateMemoryOwner({kind:'space',id:b.spaceId});
      return this.store().ingest({
        key: 'document:' + (b.spaceId||b.projectId) + ':' + (b.reference || b.title),
        kind: 'document',
        projectId: b.projectId||'',spaceId:b.spaceId,
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
      spaceId?:string;
      sessionId?: string;
      conversations?: boolean;
      legacy?: boolean;
      artifacts?: boolean;
    },
  ) {
    return this.call(() => {
      this.validateProject(b.projectId, b.sessionId);
      const service = new MemorySources(this.manager, this.store(), this.state);
      if(b.spaceId){const space=this.manager.projectSpaces().projects.find(p=>p.id===b.spaceId);if(!space)throw new Error('Project not found');return space.members.map(ref=>({projectId:ref.projectId,sessionId:ref.sessionId,...service.ingestProject(ref.projectId,{...b,sessionId:ref.sessionId,legacy:false})}));}
      const
        projects = b.projectId ? b.sessionId ? [b.projectId] : this.manager.projectContext().sourceProjects(b.projectId) : this.manager.listProjects().projects.map((p) => p.id);
      if (projects.length > 100) throw new Error('Import up to 100 projects at a time');
      return projects.map((projectId) => ({ projectId, ...service.ingestProject(projectId, b) }));
    });
  }
  @Get('context') context(
    @Query('projectId') pid: string,
    @Query('sessionId') sid: string,
    @Query('query') query?: string,
    @Query('provider') targetProvider?: 'claude' | 'codex',
    @Query('requestId') requestId?:string,
    @Query('callerProjectId') callerPid?:string,
    @Query('callerSessionId') callerSid?:string,
  ) {
    return this.call(() => {
      if(callerPid&&callerSid){pid=callerPid;sid=callerSid;requestId=this.manager.memoryRequestId(pid,sid);targetProvider=undefined;}
      this.validateProject(pid, sid);
      if (!pid) throw new Error('Choose a project');
      const provider = targetProvider || this.manager.historyContext(pid, sid || '').adapter.id;
      if (!['claude', 'codex'].includes(provider)) throw new Error('Unknown provider');
      return {
        ...this.store().context(pid, sid || '', provider, query || '',requestId),
        preview: true,
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
  @Get('activity') activity(@Query('projectId') pid?: string, @Query('sessionId') sid?: string,@Query('spaceId') spaceId?:string) {
    return this.store().contextHistory(pid, sid,spaceId);
  }
  @Get('settings') settings() {
    return this.store().settings();
  }
  @Post('settings') @HttpCode(200) setSettings(@Body() b: Partial<MemorySettings>) {
    return this.call(() => this.store().setSettings(b));
  }
  @Post('link') @HttpCode(200) link(@Body() b: { from: string; to: string; kind: string;callerProjectId?:string;callerSessionId?:string }) {
    return this.call(() => {if(b.callerProjectId&&b.callerSessionId){const q=this.callerQuery(b);for(const id of [b.from,b.to]){const e=this.store().get(id);if(!e)throw new Error('Memory unavailable');const reason=this.store().contextProblem(e,q);if(reason)throw new Error(reason);}}return this.store().link(b.from, b.to, b.kind);});
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
      grants?:import('./memory-access.js').MemoryGrant[];
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
