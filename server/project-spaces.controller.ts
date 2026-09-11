import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { SessionManager } from './manager.js';
import { ProjectConflict } from './projects.js';

/** Parent identities are explicit; /api/projects keeps its execution contracts. */
@Controller('api/project-spaces')
export class ProjectSpacesController {
  constructor(@Inject(SessionManager) private readonly manager: SessionManager) {}
  private enabled() { if (!this.manager.projectSpacesEnabled()) throw new NotFoundException('Project spaces are disabled'); }
  @Get() list() { return this.manager.projectSpaces(); }
  @Get('migration') migration() { this.enabled(); return this.manager.projectSpacesMigration(); }
  @Post('migration') applyMigration(@Body() body: Parameters<SessionManager['applyProjectSpacesMigration']>[0]) { return this.write(() => this.manager.applyProjectSpacesMigration(body)); }
  @Post('membership/preview') preview(@Body() body: Parameters<SessionManager['previewProjectMembership']>[0]) { return this.write(() => this.manager.previewProjectMembership(body)); }
  @Post('membership/apply') applyMembership(@Body() body: Parameters<SessionManager['applyProjectMembership']>[0]) { return this.write(() => this.manager.applyProjectMembership(body)); }
  @Get('membership/operations/:operationId') operation(@Param('operationId') id: string) { this.enabled(); return this.manager.spaces().snapshot().operations.find(o => o.id === id); }
  @Post('executions/:projectId/archive') archiveWork(@Param('projectId') id:string,@Body() body:Parameters<SessionManager['archiveWorkProject']>[1]){return this.write(()=>this.manager.archiveWorkProject(id,body),true);}
  @Post('executions/:projectId/work') newExecutionWork(@Param('projectId') id: string, @Body() body: Parameters<SessionManager['prepareProjectWork']>[1]) { return this.write(() => this.manager.prepareProjectWork(id, body)); }
  @Get('context/:projectId/:sessionId') context(@Param('projectId') id: string, @Param('sessionId') sid: string) { return this.manager.projectContext().resolve(id, sid); }
  @Post(':id/references') reference(@Param('id') id: string, @Body() body: { target: import('./project-space-registry.js').SpaceTarget; expectedRevision: number; requestId: string }) {
    return this.write(() => this.manager.spaces().addReference(id, body.target, body.expectedRevision, body.requestId));
  }
  @Post(':id/references/remove') removeReference(@Param('id') id: string, @Body() body: { referenceId: string; expectedRevision: number }) {
    return this.write(() => { const ref = this.manager.spaces().snapshot().references.find(r => r.id === body.referenceId && r.spaceId === id); if (!ref) throw new Error('Reference unavailable'); return this.manager.spaces().removeReference(ref.id, body.expectedRevision); });
  }
  @Post('handoffs') handoff(@Body() body: import('./project-handoffs.js').ProjectHandoffInput) { return this.write(() => this.manager.projectHandoffs().run(body)); }
  @Get('handoffs') handoffs(@Query('projectId') id: string, @Query('sessionId') sid?: string) { this.enabled(); this.manager.executionProject(id); return this.manager.projectHandoffs().list(id, sid); }
  @Get(':id') get(@Param('id') id: string) {
    this.enabled();
    const canonical=this.manager.spaces().canonical(id),p = this.manager.projectSpaces().projects.find(p => p.id === canonical);
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }
  @Post() create(@Body() body: Parameters<SessionManager['createProjectSpace']>[0]) {
    this.enabled();
    try { return this.manager.createProjectSpace(body); }
    catch (e) { if (e instanceof ProjectConflict) throw new ConflictException(e.message); throw new BadRequestException((e as Error).message); }
  }
  private write<T>(fn: () => T, retainedExecution = false): T {
    if(!retainedExecution)this.enabled();
    try { return fn(); } catch (e) { if (e instanceof ProjectConflict) throw new ConflictException(e.message); throw new BadRequestException((e as Error).message); }
  }
  @Post('membership/:id') membership(@Param('id') id: string, @Body() body: Parameters<SessionManager['moveProjectChat']>[1]) {
    return this.write(() => this.manager.moveProjectChat(id, body));
  }
  @Post(':id') update(@Param('id') id: string, @Body() body: Parameters<SessionManager['updateProjectSpace']>[1]) {
    return this.write(() => this.manager.updateProjectSpace(id, body));
  }
  @Post(':id/work') work(@Param('id') id: string, @Body() body: Parameters<SessionManager['prepareSpaceWork']>[1]) {
    return this.write(() => this.manager.prepareSpaceWork(id, body));
  }
  @Get(':id/capabilities') async capabilities(@Param('id') id: string, @Query('sessionId') sid: string, @Query('refresh') refresh?: string) {
    this.enabled();
    const context = this.manager.historyContext(id, sid), project = this.manager.executionProject(id), service = this.manager.chatCapabilities();
    if (!project.conversations?.some(c => c.sessionId === sid)) throw new BadRequestException('Conversation unavailable');
    if (refresh === '1') this.manager.refreshChatCapabilities();
    return { accounts: await service.inventory({ ...project, provider: context.adapter.id }, refresh === '1'), requirements: service.requirements(id, sid), projectRequirements: this.manager.requiredProjectTools(id, sid) };
  }
  @Post(':id/capabilities') requirements(@Param('id') id: string, @Body() body: { sessionId: string; requirements: import('./chat-capabilities.js').CapabilityRequirement[] }) {
    return this.write(() => { const p = this.manager.executionProject(id); if (!p.conversations?.some(c => c.sessionId === body.sessionId)) throw new Error('Conversation unavailable'); this.manager.chatCapabilities().setRequirements(id, body.requirements, body.sessionId); this.manager.refreshChatCapabilities(); return { requirements: body.requirements }; });
  }
  @Post(':id/archive') archive(@Param('id') id: string, @Body() body: Parameters<SessionManager['archiveProjectSpace']>[1]) {
    return this.write(() => this.manager.archiveProjectSpace(id, body));
  }
  @Post(':id/queue/:queueId/review') review(@Param('id') id: string, @Param('queueId') queueId: string, @Body() body: { expectedMembershipRevision: number; review: NonNullable<Parameters<SessionManager['reviewProjectQueue']>[3]> }) {
    return this.write(() => { if (!body.review) throw new Error('Review the message and its attachments'); this.manager.reviewProjectQueue(id, queueId, body.expectedMembershipRevision, body.review); return { ok: true }; },true);
  }
  @Post(':id/autopilot/:sid/resume') resume(@Param('id') id: string, @Param('sid') sid: string, @Body() body: { expectedMembershipRevision: number }) {
    return this.write(() => { this.manager.resumeProjectAutopilot(id, sid, body.expectedMembershipRevision); return { ok: true }; },true);
  }
}
