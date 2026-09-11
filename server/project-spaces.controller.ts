import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post } from '@nestjs/common';
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
}
