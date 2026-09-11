import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { SessionManager } from './manager.js';

@Controller('api/chats')
export class ChatsController {
  constructor(@Inject(SessionManager) private readonly manager: SessionManager) {}

  @Get()
  list() {
    return { enabled: this.manager.chatsEnabled(), chats: this.manager.chatsEnabled()
      ? this.manager.listProjects().projects.filter(p => p.kind === 'chat') : [] };
  }

  @Post()
  create(@Body() body: Parameters<SessionManager['createChat']>[0]) {
    if (!this.manager.chatsEnabled()) throw new NotFoundException('Chat is disabled');
    try { return this.manager.createChat(body); }
    catch (error) { throw new BadRequestException((error as Error).message); }
  }

  @Get(':id')
  get(@Param('id') id: string) {
    try { return this.manager.chat(id); }
    catch (error) { throw new NotFoundException((error as Error).message); }
  }

  @Get(':id/capabilities')
  async capabilities(@Param('id') id: string, @Query('refresh') refresh?: string) {
    const chat = this.get(id), service = this.manager.chatCapabilities();
    if (refresh === '1') this.manager.refreshChatCapabilities();
    return { accounts: await service.inventory(chat, refresh === '1'), requirements: service.requirements(id) };
  }

  @Post(':id/capabilities')
  requirements(@Param('id') id: string, @Body() body: { requirements: import('./chat-capabilities.js').CapabilityRequirement[] }) {
    this.get(id);
    try { this.manager.chatCapabilities().setRequirements(id, body.requirements); return { requirements: this.manager.chatCapabilities().requirements(id) }; }
    catch (error) { throw new BadRequestException((error as Error).message); }
  }
  @Post(':id/references')
  references(@Param('id') id: string, @Body() body: { references: NonNullable<import('./projects.js').Project['references']> }) {
    this.get(id);
    try { this.manager.setChatReferences(id, body.references); return { references: this.manager.chat(id).references }; }
    catch (error) { throw new BadRequestException((error as Error).message); }
  }

  @Post(':id')
  update(@Param('id') id: string, @Body() body: Parameters<SessionManager['updateChat']>[1]) {
    this.get(id);
    try { return this.manager.updateChat(id, body); }
    catch (error) { throw new BadRequestException((error as Error).message); }
  }
}
