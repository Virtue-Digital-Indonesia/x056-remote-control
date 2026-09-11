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
  @Get(':id') get(@Param('id') id: string) {
    this.enabled();
    const p = this.manager.projectSpaces().projects.find(p => p.id === id);
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }
  @Post() create(@Body() body: Parameters<SessionManager['createProjectSpace']>[0]) {
    this.enabled();
    try { return this.manager.createProjectSpace(body); }
    catch (e) { if (e instanceof ProjectConflict) throw new ConflictException(e.message); throw new BadRequestException((e as Error).message); }
  }
  private write<T>(fn: () => T): T {
    this.enabled();
    try { return fn(); } catch (e) { if (e instanceof ProjectConflict) throw new ConflictException(e.message); throw new BadRequestException((e as Error).message); }
  }
  @Post('membership/:id') membership(@Param('id') id: string, @Body() body: Parameters<SessionManager['moveProjectChat']>[1]) {
    return this.write(() => this.manager.moveProjectChat(id, body));
  }
  @Post(':id') update(@Param('id') id: string, @Body() body: Parameters<SessionManager['updateProjectSpace']>[1]) {
    return this.write(() => this.manager.updateProjectSpace(id, body));
  }
  @Post(':id/work') work(@Param('id') id: string, @Body() body: Parameters<SessionManager['prepareProjectWork']>[1]) {
    return this.write(() => this.manager.prepareProjectWork(id, body));
  }
  @Get(':id/capabilities') async capabilities(@Param('id') id: string, @Query('sessionId') sid: string, @Query('refresh') refresh?: string) {
    this.enabled();
    const context = this.manager.historyContext(id, sid), project = this.manager.executionProject(id), service = this.manager.chatCapabilities();
    if (refresh === '1') this.manager.refreshChatCapabilities();
    return { accounts: await service.inventory({ ...project, provider: context.adapter.id }, refresh === '1'), requirements: service.requirements(id), projectRequirements: this.manager.requiredProjectTools(id) };
  }
  @Post(':id/capabilities') requirements(@Param('id') id: string, @Body() body: { requirements: import('./chat-capabilities.js').CapabilityRequirement[] }) {
    return this.write(() => { this.manager.executionProject(id); this.manager.chatCapabilities().setRequirements(id, body.requirements); this.manager.refreshChatCapabilities(); return { requirements: body.requirements }; });
  }
  @Post(':id/archive') archive(@Param('id') id: string, @Body() body: Parameters<SessionManager['archiveProjectSpace']>[1]) {
    return this.write(() => this.manager.archiveProjectSpace(id, body));
  }
  @Post(':id/queue/:queueId/review') review(@Param('id') id: string, @Param('queueId') queueId: string, @Body() body: { expectedMembershipRevision: number; review: NonNullable<Parameters<SessionManager['reviewProjectQueue']>[3]> }) {
    return this.write(() => { if (!body.review) throw new Error('Review the message and its attachments'); this.manager.reviewProjectQueue(id, queueId, body.expectedMembershipRevision, body.review); return { ok: true }; });
  }
  @Post(':id/autopilot/:sid/resume') resume(@Param('id') id: string, @Param('sid') sid: string, @Body() body: { expectedMembershipRevision: number }) {
    return this.write(() => { this.manager.resumeProjectAutopilot(id, sid, body.expectedMembershipRevision); return { ok: true }; });
  }
}
