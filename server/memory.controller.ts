import type { Response } from 'express';
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
  Res,
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
import { EXTRACTION_LIMITS } from './memory-documents.js';
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
  @Get('stats') stats(@Query() q: MemoryQuery) {
    return this.call(() => this.store().stats(q));
  }
  @Get('search') search(@Query() q: MemoryQuery & { callerProjectId?: string; callerSessionId?: string }) {
    return this.call(() => {
      const caller = this.callerQuery(q);
      if (q.callerProjectId && q.callerSessionId) {
        return this.store().searchContext(caller);
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
      this.validateCaller({callerProjectId:callerPid,callerSessionId:callerSid});
      const pinned=callerPid&&callerSid?this.store().access.references(callerPid,callerSid,this.manager.memoryRequestId(callerPid,callerSid))?.selections.find(r=>r.kind==='entry'&&r.id===id):undefined;
      const entry = pinned?this.store().revisions(id).find(e=>String(e.revision)===pinned.version):this.store().get(id);
      if (!entry) throw new Error('Memory not found');
      const contextQuery = callerPid && callerSid ? { projectId: callerPid, sessionId: callerSid, requestId:this.manager.memoryRequestId(callerPid,callerSid),provider: this.manager.historyContext(callerPid, callerSid).adapter.id, access: 'context' as const } : undefined;
      if (callerPid && callerSid) {
        this.validateProject(callerPid, callerSid);
        const caller = this.manager.historyContext(callerPid, callerSid).adapter.id;
        const reason = this.entryReadProblem(entry, { projectId: callerPid, sessionId: callerSid, requestId:this.manager.memoryRequestId(callerPid,callerSid),provider: caller, access: 'context' });
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
        revisions: this.store().revisions(id).filter(e => !contextQuery || !this.entryReadProblem(e, contextQuery)),
        related: this.store().related(id).filter(link => !contextQuery || (link.entry && !this.entryReadProblem(link.entry, contextQuery))),
        sources: entry.sources.map(ref => {
          const current=ref.id?this.store().source(ref.id):undefined, original=ref.id&&(ref.versionId||ref.hash)?this.store().sourceVersion(ref.id,ref.versionId||ref.hash!):undefined;
          const problem=contextQuery&&current?this.store().sourceContextProblem(current,contextQuery):undefined;
          return {...ref,...(problem?{unavailable:problem}:{current,original})};
        }),
      };
    });
  }
  private entryReadProblem(entry: MemoryEntry, q: MemoryQuery): string | undefined {
    if (entry.status === 'proposed' && this.store().settings().autoManage && !this.store().agentWriteProblem(entry,q))
      return this.store().contextProblem({...entry,status:'confirmed'},q);
    return this.store().contextProblem(entry,q);
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
      const full = this.store().settings().autoManage && !!body.callerProjectId && !!body.callerSessionId;
      const current = body.id ? this.store().get(body.id) : undefined;
      if (full) {
        const candidate = {...current, ...body.entry};
        const problem = this.store().agentWriteProblem(candidate, q);
        if (problem) throw new Error(problem);
        if (body.id) {
          if (!current) throw new Error('Memory not found');
          const ownerProblem = this.store().agentWriteProblem(current, q);
          if (ownerProblem) throw new Error(ownerProblem);
          if (!['proposed','confirmed'].includes(current.status)) throw new Error('Restore this memory before editing');
          for (const key of Object.keys(body.entry))
            if (!['title','content','sources'].includes(key)) throw new Error('Automatic corrections may change only title, content and sources');
        }
      }
      if(body.callerProjectId&&body.callerSessionId){
        if(body.id&&!full){const current=this.store().get(body.id);if(!current)throw new Error('Memory not found');const problem=this.store().contextProblem(current,q);if(problem)throw new Error(problem);}
        for(const ref of body.entry.sources||[]){if(!ref.id)continue;const pinned=this.store().access.references(body.callerProjectId,body.callerSessionId,q.requestId)?.selections.find(r=>r.kind==='source'&&r.id===ref.id);const version=ref.versionId||pinned?.version;const source=version?this.store().sourceVersion(ref.id,version):this.store().source(ref.id);if(!source)throw new Error('Source unavailable');const reason=this.store().sourceContextProblem(source,q);if(reason)throw new Error(reason);const grant=this.store().access.eligible({kind:'source',id:ref.id},body.callerProjectId,body.callerSessionId);ref.grantId=grant?.id;ref.grantRevision=grant?.revision;ref.hash=source.hash;ref.versionId=source.versionId;ref.spaceId=source.spaceId;}
      }
      const automatic = full && (current?.status === 'confirmed' || !['shared','global'].includes(current?.scope || body.entry.scope || 'project') && !(current?.sharedProjectIds || body.entry.sharedProjectIds)?.length);
      const entry: Partial<MemoryEntry> = { ...body.entry, status: automatic ? 'confirmed' : 'proposed' };
      if (automatic && current) {
        this.validateAutomaticEntry({...current,...entry},q);
      }
      const settings = this.store().settings();
      const localNote = entry.scope === 'conversation' && !!body.callerProjectId && !!body.callerSessionId &&
        entry.projectId === body.callerProjectId && entry.sessionId === body.callerSessionId &&
        !entry.spaceId && !entry.sharedProjectIds?.length;
      const autoApprove = settings.autoApproveConversationNotes && localNote &&
        !settings.excludedProjects.includes(body.callerProjectId!) &&
        !settings.excludedSpaces.includes(this.manager.projectContext().resolve(body.callerProjectId!, body.callerSessionId).spaceId || '');
      return body.id
        ? this.store().update(body.id, body.revision!, entry, full ? this.agentActor(q, 'edit') : 'agent proposal')
        : this.store().propose(entry, automatic || !!autoApprove, automatic ? this.agentActor(q, 'save') : undefined, automatic ? candidate => this.validateAutomaticEntry(candidate,q) : undefined);
    });
  }
  private validateAutomaticEntry(entry: Partial<MemoryEntry>, q: MemoryQuery): void {
    for (const ref of entry.sources || []) {
      if (!ref.id) continue;
      const source = ref.versionId || ref.hash ? this.store().sourceVersion(ref.id,ref.versionId || ref.hash!) : this.store().source(ref.id);
      if (!source) throw new Error('Source unavailable');
      const problem = this.store().sourceContextProblem(source,q);
      if (problem) throw new Error(problem);
    }
    const problem = this.store().contextProblem({...entry,status:'confirmed'} as MemoryEntry,q);
    if (problem) throw new Error(problem);
  }
  private agentActor(q: MemoryQuery, action: string, reason?: string): string {
    return `agent · ${action} · ${q.provider} · ${q.projectId}/${q.sessionId}${reason ? ' · ' + reason : ''}`.slice(0, 300);
  }
  private managedEntry(body: {id:string;revision:number;callerProjectId?:string;callerSessionId?:string}) {
    if (!body?.callerProjectId || !body.callerSessionId) throw new Error('A verified caller conversation is required');
    const q = this.callerQuery(body);
    if (!this.store().settings().autoManage) throw new Error('Automatic memory management is disabled');
    const entry = this.store().get(body.id);
    if (!entry) throw new Error('Memory not found');
    if (!Number.isSafeInteger(body.revision) || body.revision !== entry.revision) throw new MemoryConflict('Memory changed. Reload the latest revision before saving.');
    const problem = this.store().agentWriteProblem(entry,q);
    if (problem) throw new Error(problem);
    if (!['proposed','confirmed'].includes(entry.status)) throw new Error('Restore this memory before changing it');
    return {entry,q};
  }
  @Post('delete') @HttpCode(200) deleteEntry(
    @Body() body: {id:string;revision:number;reason:string;callerProjectId?:string;callerSessionId?:string},
  ) {
    return this.call(() => {
      const {entry,q} = this.managedEntry(body);
      if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 160) throw new Error('Provide a deletion reason of 1–160 characters');
      return this.store().update(entry.id,body.revision,{status:'deleted'},this.agentActor(q,'delete',body.reason.trim()));
    });
  }
  @Post('approve') @HttpCode(200) approveEntry(
    @Body() body: {id:string;revision:number;callerProjectId?:string;callerSessionId?:string},
  ) {
    return this.call(() => {
      const {entry,q} = this.managedEntry(body);
      if (entry.scope === 'global' || entry.scope === 'shared' || entry.sharedProjectIds.length) throw new Error('Review expanded memory sharing in the Memory page');
      this.validateAutomaticEntry(entry,q);
      return this.store().update(entry.id,body.revision,{status:'confirmed'},this.agentActor(q,'approve'));
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
  private validateCaller(q:{callerProjectId?:string;callerSessionId?:string}):void {
    if(q.callerProjectId===undefined&&q.callerSessionId===undefined)return;
    if(typeof q.callerProjectId!=='string'||!q.callerProjectId||typeof q.callerSessionId!=='string'||!q.callerSessionId)
      throw new Error('Both caller project and conversation are required');
    this.validateProject(q.callerProjectId,q.callerSessionId);
  }
  private callerQuery(q:MemoryQuery & {callerProjectId?:string;callerSessionId?:string}):MemoryQuery {
    this.validateCaller(q);
    if(q.callerProjectId&&q.callerSessionId){return {...q,projectId:q.callerProjectId,sessionId:q.callerSessionId,spaceId:undefined,requestId:this.manager.memoryRequestId(q.callerProjectId,q.callerSessionId),provider:this.manager.historyContext(q.callerProjectId,q.callerSessionId).adapter.id,access:'context',eligibleOnly:true,historical:false};}
    return q;
  }
  @Get('sources') sources(@Query() q: MemoryQuery & { excluded?: string;callerProjectId?:string;callerSessionId?:string }) {
    return this.call(() => this.store().sources(this.callerQuery(q), !q.callerProjectId&&q.excluded === 'true'));
  }
  @Get('source') source(@Query('id') id: string, @Query('hash') hash?: string,@Query('callerProjectId') callerProjectId?:string,@Query('callerSessionId') callerSessionId?:string) {
    return this.call(() => {
      this.validateCaller({callerProjectId,callerSessionId});
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
  @Get('shared') shared(@Query() q:MemoryQuery){return this.call(()=>{
    const recipient=q.spaceId?{kind:'space',id:q.spaceId}:q.projectId?{kind:'execution',id:q.projectId}:undefined;
    if(!recipient)return {entries:[],sources:[],total:0};
    const grants=this.store().access.grants().filter(g=>g.active&&g.recipient.kind===recipient.kind&&g.recipient.id===recipient.id),term=(q.query||'').toLowerCase();
    const entries=grants.filter(g=>g.subject.kind==='entry').map(g=>this.store().get(g.subject.id)).filter((e):e is MemoryEntry=>!!e&&e.status==='confirmed'&&this.store().visible(e,q)&&(!term||(e.title+' '+e.content).toLowerCase().includes(term)));
    const sources=grants.filter(g=>g.subject.kind==='source').map(g=>this.store().source(g.subject.id)).filter(s=>!!s&&!s.excluded&&this.store().sourceVisible(s,q)&&(!term||(s.title+' '+s.content).toLowerCase().includes(term)));
    return {entries,sources,total:entries.length+sources.length};
  });}
  @Get('documents') documents(@Query() q:MemoryQuery){return this.call(()=>{
    const rows=this.store().documents.all().filter(d=>(!q.spaceId||d.owner.kind==='space'&&d.owner.id===q.spaceId)&&(!q.projectId||d.owner.kind==='execution'&&d.owner.id===q.projectId));
    return {items:rows,limits:EXTRACTION_LIMITS};
  });}
  @Post('documents') @HttpCode(200) addDocument(@Body() b:Parameters<ReturnType<MemoryController['store']>['documents']['register']>[0]){return this.call(()=>{if(!this.manager.projectSpacesEnabled())throw new Error('Project file memory is disabled');if(this.manager.fileOwner(b.file.ownerId).archivedAt)throw new Error('Restore the file owner first');return this.store().documents.register(b);});}
  @Get('documents/jobs') documentJobs(@Query('id') id:string){return this.call(()=>({document:this.store().documents.get(id),jobs:this.store().documents.jobs(id)}));}
  @Post('documents/cancel') @HttpCode(200) cancelDocument(@Body() b:Parameters<ReturnType<MemoryController['store']>['documents']['cancel']>[0]){return this.call(()=>this.store().documents.cancel(b));}
  @Post('documents/exclude') @HttpCode(200) excludeDocument(@Body() b:{id:string;excluded:boolean}){return this.call(()=>{if(typeof b.excluded!=='boolean')throw new Error('Invalid exclusion');if(this.store().source(b.id))this.store().excludeSource(b.id,b.excluded);else this.store().documents.setExcluded(b.id,b.excluded);return this.store().documents.get(b.id);});}
  @Get('source/search') searchPassages(@Query() query:MemoryQuery&{callerProjectId?:string;callerSessionId?:string}){return this.call(()=>{
    const q=this.callerQuery(query),result=this.store().documents.search(q);
    for(const p of result.items)if(q.projectId&&q.sessionId)this.store().access.recordRead({kind:'source',id:p.sourceId,version:p.versionId},q.projectId,q.sessionId,q.requestId,[{id:p.id,locator:p.locator}]);
    return {items:result.items.map(p=>({...p,citation:this.store().documents.citation(p,this.store().sourceVersion(p.sourceId,p.versionId)!)})),total:result.total};
  });}
  @Get('source/read') readPassages(@Query() query:MemoryQuery&{id:string;versionId?:string;passageId?:string;callerProjectId?:string;callerSessionId?:string}){return this.call(()=>{
    const q=this.callerQuery(query),pinned=q.projectId&&q.sessionId?this.store().access.references(q.projectId,q.sessionId,q.requestId)?.selections.find(r=>r.kind==='source'&&r.id===query.id):undefined;
    const version=query.versionId||pinned?.version,source=version?this.store().sourceVersion(query.id,version):this.store().source(query.id);if(!source)throw new Error('Source version unavailable');
    if(q.access==='context'){const reason=this.store().sourceContextProblem(source,q);if(reason)throw new Error(reason);}
    const rows=this.store().documents.passages(source.id,source.versionId||source.hash).filter(p=>!query.passageId||p.id===query.passageId);
    const offset=Math.max(0,Number(query.offset)||0),limit=Math.max(1,Math.min(5,Number(query.limit)||3));
    const items=rows.slice(offset,offset+limit).map(p=>({...p,citation:this.store().documents.citation(p,source)}));
    if(q.projectId&&q.sessionId)this.store().access.recordRead({kind:'source',id:source.id,version:source.versionId||source.hash},q.projectId,q.sessionId,q.requestId,items.map(p=>({id:p.id,locator:p.locator})));
    return {sourceId:source.id,versionId:source.versionId||source.hash,title:source.title,items,total:rows.length,offset,limit,downloadPath:source.document?'/api/memory/source/download?'+new URLSearchParams({id:source.id,versionId:source.versionId!,...(query.callerProjectId&&query.callerSessionId?{callerProjectId:query.callerProjectId,callerSessionId:query.callerSessionId}:{})}):undefined};
  });}
  @Get('source/download') sourceDownload(@Query() query:{id:string;versionId:string;callerProjectId?:string;callerSessionId?:string},@Res() res:Response){return this.call(()=>{
    const source=this.store().sourceVersion(query.id,query.versionId);if(!source?.document)throw new Error('Source file version unavailable');
    const q=this.callerQuery(query);if(q.access==='context'){const reason=this.store().sourceContextProblem(source,q);if(reason)throw new Error(reason);}
    const {file,version,path}=this.manager.files().version(source.document.file.ownerId,source.document.file);
    res.setHeader('Content-Type',version.mime);res.setHeader('Content-Disposition',"attachment; filename=download; filename*=UTF-8''"+encodeURIComponent(file.name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16)));res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','private, no-store');res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.sendFile(path,{dotfiles:'allow',cacheControl:false});
  });}
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
      this.validateCaller({callerProjectId:callerPid,callerSessionId:callerSid});
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
    return this.call(() => {const q=this.callerQuery(b);if(b.callerProjectId&&b.callerSessionId){for(const id of [b.from,b.to]){const e=this.store().get(id);if(!e)throw new Error('Memory unavailable');const reason=this.store().contextProblem(e,q);if(reason)throw new Error(reason);}}return this.store().link(b.from, b.to, b.kind);});
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
