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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AccountRegistry } from '../src/accounts.js';
import { UsageRateLimitedError, fetchUsage } from '../src/quota.js';
import { join } from 'node:path';
import { BusyError, SessionManager, type TurnRunOptions } from './manager.js';
import { readSessionHistory, type HistoryEntry } from './history.js';
import { withAskInstructions } from './question.js';

const IMG_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

/** Read the human-facing account identity the login stored in <configDir>/.claude.json. */
function accountIdentity(configDir: string): { displayName?: string; email?: string } {
  try {
    const o = (JSON.parse(readFileSync(join(configDir, '.claude.json'), 'utf8')) as {
      oauthAccount?: { displayName?: string; emailAddress?: string };
    }).oauthAccount;
    return { displayName: o?.displayName, email: o?.emailAddress };
  } catch {
    return {};
  }
}

/** Turn a data URL / base64 image into a file under state/uploads, return its absolute path. */
function saveImage(stateDir: string, dataUrl: string): string {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('image must be a data URL');
  const ext = IMG_EXT[m[1]];
  if (!ext) throw new Error(`unsupported image type ${m[1]}`);
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 10 * 1024 * 1024) throw new Error('image exceeds 10MB');
  const dir = join(stateDir, 'uploads');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(path, buf);
  return path;
}

interface SendBody {
  prompt?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  image?: string;
  projectId?: string;
  interactive?: boolean;
}

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

  /** Fold an optional attached image into the prompt as a readable file path. */
  private composePrompt(body: SendBody): { prompt: string; opts: TurnRunOptions } {
    let prompt = body.prompt ?? '';
    if (body.image) {
      const path = saveImage(this.stateDir, body.image);
      prompt += `\n\n[The user attached an image. Read it with the Read tool at: ${path}]`;
    }
    // Teach the model the ASK convention so it can pose questions the panel can
    // surface with quick-reply buttons (opt out with interactive:false).
    if (body.interactive !== false) prompt = withAskInstructions(prompt);
    return { prompt, opts: { model: body.model, effort: body.effort } };
  }

  @Post('sessions')
  startSession(@Body() body: SendBody): { sessionId: string } {
    if (!body?.prompt && !body?.image) throw new BadRequestException('prompt or image required');
    try {
      const { prompt, opts } = this.composePrompt(body);
      return { sessionId: this.manager.start(prompt, body.cwd, opts, body.projectId) };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('busy');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('sessions/current/messages')
  continueSession(@Body() body: SendBody): { sessionId: string } {
    if (!body?.prompt && !body?.image) throw new BadRequestException('prompt or image required');
    try {
      const { prompt, opts } = this.composePrompt(body);
      return { sessionId: this.manager.continueLast(prompt, opts, body.projectId) };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('busy');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('sessions/current')
  @HttpCode(200)
  setCurrent(@Body() body: { sessionId?: string; cwd?: string }): { ok: boolean } {
    if (!body?.sessionId || !body?.cwd) throw new BadRequestException('sessionId and cwd required');
    try {
      this.manager.setCurrent(body.sessionId, body.cwd);
      return { ok: true };
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

  @Get('projects')
  projects(): unknown {
    return this.manager.listProjects();
  }

  @Get('workspace')
  workspace(): unknown {
    return this.manager.listWorkspaceDirs();
  }

  @Get('available-sessions')
  availableSessions(@Query('projectId') projectId?: string): unknown {
    return this.manager.listAvailableSessions(projectId);
  }

  @Post('resume-session')
  @HttpCode(200)
  resumeSession(@Body() body: { projectId?: string; sessionId?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.sessionId) throw new BadRequestException('projectId and sessionId required');
    try {
      this.manager.resumeExisting(body.projectId, body.sessionId);
      return { ok: true };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('busy');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('projects')
  createProject(@Body() body: { name?: string; cwd?: string }): unknown {
    if (!body?.name) throw new BadRequestException('name required');
    try {
      return this.manager.createProject(body.name, body.cwd);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('projects/current')
  @HttpCode(200)
  selectProject(@Body() body: { id?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    try {
      this.manager.selectProject(body.id);
      return { ok: true };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('busy');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('projects/remove')
  @HttpCode(200)
  removeProject(@Body() body: { id?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    try {
      this.manager.removeProject(body.id);
      return { ok: true };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('a turn is running there — stop it first');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('projects/rename')
  @HttpCode(200)
  renameProject(@Body() body: { id?: string; name?: string }): { ok: boolean } {
    if (!body?.id || !body?.name) throw new BadRequestException('id and name required');
    try {
      this.manager.renameProject(body.id, body.name);
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Get('sessions/current/history')
  history(@Query('limit') limit?: string): HistoryEntry[] {
    const sessionId = this.manager.snapshot().lastSessionId;
    if (!sessionId) return [];
    let configDirs: string[];
    try {
      configDirs = AccountRegistry.load(join(this.stateDir, 'accounts.json'))
        .list()
        .map((a) => a.configDir);
    } catch {
      return [];
    }
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
    return readSessionHistory(configDirs, sessionId, n);
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
        const id = accountIdentity(acct.configDir);
        const base = { ...acct, displayName: id.displayName ?? acct.name, email: id.email };
        const cached = this.quotaCache.get(acct.name);
        if (cached && Date.now() - cached.at < QUOTA_TTL_MS) {
          return { ...base, quota: cached.quota };
        }
        const backoffUntil = this.quotaBackoffUntil.get(acct.name) ?? 0;
        if (Date.now() < backoffUntil) {
          if (cached) return { ...base, quota: cached.quota, quotaStale: true };
          return { ...base, quota: null, quotaError: `rate-limited upstream; retrying after ${new Date(backoffUntil).toISOString()}` };
        }
        try {
          const quota = await fetchUsage(acct.configDir);
          this.quotaCache.set(acct.name, { at: Date.now(), quota });
          this.quotaBackoffUntil.delete(acct.name);
          return { ...base, quota };
        } catch (err) {
          const backoffMs = err instanceof UsageRateLimitedError ? err.retryAfterMs : 60_000;
          this.quotaBackoffUntil.set(acct.name, Date.now() + backoffMs);
          if (cached) return { ...base, quota: cached.quota, quotaStale: true };
          return { ...base, quota: null, quotaError: (err as Error).message };
        }
      }),
    );
  }

  @Post('switch')
  @HttpCode(200)
  switch(@Body() body: { projectId?: string }): { switched: boolean } {
    if (!this.manager.forceSwitch(body?.projectId)) throw new ConflictException('no session running');
    return { switched: true };
  }

  @Post('sessions/current/stop')
  @HttpCode(200)
  stop(@Body() body: { projectId?: string }): { stopped: boolean } {
    if (!this.manager.stopTurn(body?.projectId)) throw new ConflictException('no turn running there');
    return { stopped: true };
  }

  @Get('autopilot')
  autopilot(): unknown {
    return this.manager.autopilotStatus();
  }

  @Post('autopilot')
  @HttpCode(200)
  setAutopilot(@Body() body: { projectId?: string; count?: number; prompt?: string; stopPhrase?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.count) throw new BadRequestException('projectId and count required');
    try {
      this.manager.setAutopilot(body.projectId, { count: body.count, prompt: body.prompt, stopPhrase: body.stopPhrase });
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('autopilot/stop')
  @HttpCode(200)
  stopAutopilot(@Body() body: { projectId?: string }): { ok: boolean } {
    if (!body?.projectId) throw new BadRequestException('projectId required');
    this.manager.stopAutopilot(body.projectId);
    return { ok: true };
  }
}
