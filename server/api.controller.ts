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
import { UsageRateLimitedError, fetchUsage } from '../src/quota.js';
import { join } from 'node:path';
import { BusyError, SessionManager } from './manager.js';

// NB: this project runs under tsx (esbuild), which does not implement
// `emitDecoratorMetadata` — Nest's controller instantiation (driven by
// `controllers: [...]` in the module, a DI path separate from any
// `providers` override for the same token) can't infer constructor
// param types via reflection. Explicit @Inject tokens sidestep that:
// they rely only on `experimentalDecorators`, which esbuild does support.
export const STATE_DIR = Symbol('x056-state-dir');

const QUOTA_TTL_MS = 90_000;

@Controller('api')
export class ApiController {
  // The oauth usage endpoint rate-limits aggressively; cache per account and
  // serve last-known-good on upstream failures so browser polling never
  // multiplies into upstream 429s.
  private readonly quotaCache = new Map<string, { at: number; quota: unknown }>();
  // While this holds a future timestamp for an account, upstream is not called
  // at all — repeated polling during a rate-limit window would only extend it.
  private readonly quotaBackoffUntil = new Map<string, number>();

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
    const sinceSeq = Number.isFinite(Number(since)) ? Number(since) : 0;
    const unsub = this.manager.subscribe((e) => {
      res.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
    }, sinceSeq);
    const cleanup = () => { clearInterval(ping); unsub(); };
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  @Get('sessions')
  sessions(): unknown {
    return this.manager.snapshot();
  }

  @Get('accounts')
  async accounts(): Promise<unknown[]> {
    let registry: AccountRegistry;
    try {
      registry = AccountRegistry.load(join(this.stateDir, 'accounts.json'));
    } catch {
      return [];
    }
    return Promise.all(
      registry.list().map(async (acct) => {
        const cached = this.quotaCache.get(acct.name);
        if (cached && Date.now() - cached.at < QUOTA_TTL_MS) {
          return { ...acct, quota: cached.quota };
        }
        const backoffUntil = this.quotaBackoffUntil.get(acct.name) ?? 0;
        if (Date.now() < backoffUntil) {
          if (cached) return { ...acct, quota: cached.quota, quotaStale: true };
          return { ...acct, quota: null, quotaError: `rate-limited upstream; retrying after ${new Date(backoffUntil).toISOString()}` };
        }
        try {
          const quota = await fetchUsage(acct.configDir);
          this.quotaCache.set(acct.name, { at: Date.now(), quota });
          this.quotaBackoffUntil.delete(acct.name);
          return { ...acct, quota };
        } catch (err) {
          const backoffMs = err instanceof UsageRateLimitedError ? err.retryAfterMs : 60_000;
          this.quotaBackoffUntil.set(acct.name, Date.now() + backoffMs);
          if (cached) return { ...acct, quota: cached.quota, quotaStale: true };
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
