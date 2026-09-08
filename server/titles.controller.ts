import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { SessionManager } from './manager.js';
import type { TitleSettings } from './conversation-titles.js';

@Controller('api/conversation-titles')
export class TitlesController {
  private timer: ReturnType<typeof setInterval>;
  constructor(@Inject(SessionManager) private manager: SessionManager) {
    this.manager.titles();
    this.timer = setInterval(() => {
      void this.manager
        .titles()
        .tick()
        .catch((e) => console.warn('[titles]', e.message));
    }, 5000);
    this.timer.unref();
  }
  onModuleDestroy() {
    clearInterval(this.timer);
    this.manager.titles().close();
  }
  private call<T>(fn: () => T) {
    try {
      return fn();
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }
  @Get('settings') settings() {
    return this.manager.titles().settings();
  }
  @Post('settings') @HttpCode(200) configure(@Body() body: Partial<TitleSettings>) {
    return this.call(() => this.manager.titles().configure(body));
  }
  @Get() list(@Query('projectId') pid?: string, @Query('sessionId') sid?: string) {
    return this.manager.titles().list(pid, sid);
  }
  @Post('suggest') @HttpCode(200) suggest(
    @Body() body: { items: { projectId: string; sessionId: string }[] },
  ) {
    return this.call(() => this.manager.titles().suggest(body?.items));
  }
  @Post('apply') @HttpCode(200) apply(@Body() body: { ids: string[] }) {
    return this.call(() => this.manager.titles().apply(body?.ids));
  }
  @Post('undo') @HttpCode(200) undo(@Body() body: { ids: string[] }) {
    return this.call(() => this.manager.titles().undo(body?.ids));
  }
  @Post('dismiss') @HttpCode(200) dismiss(@Body() body: { ids: string[] }) {
    return this.call(() => this.manager.titles().dismiss(body?.ids));
  }
}
