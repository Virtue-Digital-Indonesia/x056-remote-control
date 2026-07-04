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
import type { Response } from 'express';
import { AccountRegistry } from '../src/accounts.js';
import { fetchUsage } from '../src/quota.js';
import { join } from 'node:path';
import { BusyError, SessionManager } from './manager.js';

// NB: this project runs under tsx (esbuild), which does not implement
// `emitDecoratorMetadata` — Nest's controller instantiation (driven by
// `controllers: [...]` in the module, a DI path separate from any
// `providers` override for the same token) can't infer constructor
// param types via reflection. Explicit @Inject tokens sidestep that:
// they rely only on `experimentalDecorators`, which esbuild does support.
export const STATE_DIR = Symbol('x056-state-dir');

@Controller('api')
export class ApiController {
  constructor(
    @Inject(SessionManager) private readonly manager: SessionManager,
    @Inject(STATE_DIR) private readonly stateDir: string,
  ) {}

  @Post('sessions')
  startSession(@Body() body: { prompt?: string; cwd?: string }): { sessionId: string } {
    if (!body?.prompt) throw new BadRequestException('prompt required');
    try {
      return { sessionId: this.manager.start(body.prompt, body.cwd) };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('busy');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('sessions/current/messages')
  continueSession(@Body() body: { prompt?: string }): { sessionId: string } {
    if (!body?.prompt) throw new BadRequestException('prompt required');
    try {
      return { sessionId: this.manager.continueLast(body.prompt) };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('busy');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get('sessions/current/stream')
  stream(@Res() res: Response, @Query('since') since?: string): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    const unsub = this.manager.subscribe((e) => {
      res.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    }, since ? Number(since) : 0);
    res.on('close', () => {
      clearInterval(ping);
      unsub();
    });
  }

  @Get('sessions')
  sessions(): unknown {
    return this.manager.snapshot();
  }

  @Get('accounts')
  async accounts(): Promise<unknown[]> {
    const registry = AccountRegistry.load(join(this.stateDir, 'accounts.json'));
    return Promise.all(
      registry.list().map(async (acct) => {
        try {
          return { ...acct, quota: await fetchUsage(acct.configDir) };
        } catch (err) {
          return { ...acct, quota: null, quotaError: (err as Error).message };
        }
      }),
    );
  }

  @Post('switch')
  @HttpCode(200)
  switch(): { switched: boolean } {
    if (!this.manager.forceSwitch()) throw new ConflictException('no session running');
    return { switched: true };
  }
}
