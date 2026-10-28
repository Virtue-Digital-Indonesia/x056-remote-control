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

  /** Shared by the panel and the MCP `create_chat` tool. The bridge marks its
   *  calls `mcp: true` (plus `from` when it knows the caller), and only those
   *  must name provider, model, effort and team explicitly (owner,
   *  2026-10-28); the panel's dialog is unchanged. */
  @Post()
  create(@Body() body: Parameters<SessionManager['createChat']>[0] & { mcp?: boolean; from?: string; team?: boolean }) {
    if (!this.manager.chatsEnabled()) throw new NotFoundException('Chat is disabled');
    const { mcp, from: _from, team, ...input } = body ?? ({} as typeof body);
    if (mcp === true) {
      const choice = this.manager.requireNewConversationChoice({ provider: input.provider, model: input.model, effort: input.effort, team });
      try {
        const chat = this.manager.createChat({ ...input, provider: choice.provider });
        // Applied on a retry with the same requestId too: the same answer.
        if (chat.lastSessionId) this.manager.patchHelpers(chat.id, chat.lastSessionId, { team: choice.team });
        return this.manager.chat(chat.id);
      } catch (error) { throw new BadRequestException((error as Error).message); }
    }
    try { return this.manager.createChat(input); }
    catch (error) { throw new BadRequestException((error as Error).message); }
  }

  @Get(':id')
  get(@Param('id') id: string) {
    // The list's rows carry `bot: true` from listProjects; the single read does too.
    try { const chat = this.manager.chat(id); return this.manager.bot().isBotProject(chat.id) ? { ...chat, bot: true as const, botName: this.manager.bot().displayName(), botAttention: this.manager.botAttention() } : chat; }
    catch (error) { throw new NotFoundException((error as Error).message); }
  }

  @Get(':id/capabilities')
  async capabilities(@Param('id') id: string, @Query('refresh') refresh?: string) {
    const chat = this.get(id), service = this.manager.chatCapabilities();
    if (refresh === '1') this.manager.refreshChatCapabilities();
    return { accounts: await service.inventory(chat, refresh === '1'), requirements: service.requirements(id), projectRequirements: this.manager.requiredProjectTools(id) };
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
