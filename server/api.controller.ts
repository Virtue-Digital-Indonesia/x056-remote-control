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
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AccountRegistry } from '../src/accounts.js';
import { UsageRateLimitedError } from '../src/quota.js';
import { CODEGRAPH, CodegraphClient } from './codegraph.js';
import { MEMORY_WRITER, MemoryWriter } from './memories.js';
import { PROVISIONER, AccountProvisioner } from './provision.js';
import { CRON, CronScheduler } from './cron.js';
import { DESIGN_LOGIN, DesignLoginManager } from './design-login.js';
import { DESIGN_CONSENT, DesignConsentGranter } from './design-consent.js';
import { TEMPLATES, TemplateStore } from './templates.js';
import { TRANSCRIPT_STATS, TranscriptStatsReader, estimateCost } from './transcript-stats.js';
import { getAdapter } from '../src/adapters/registry.js';
import { cachedBrief, listSubagents, parentTranscript, readSubagentPage, subagentFiles } from '../src/adapters/subagents.js';
import { join } from 'node:path';
import { BusyError, RelayLimitError, SessionManager, type TurnRunOptions } from './manager.js';
import { PluginManager } from './plugins.js';
import { McpServerManager, type McpServerSpec } from './mcp-servers.js';
import type { HistoryEntry } from './history.js';
import { withAskInstructions } from '../src/question.js';
import type { PushService } from './push.js';
import type { WebAuthnService, SessionStore } from './webauthn.js';
import { Public, readCookie } from './auth.guard.js';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { PushSubscription } from 'web-push';

const IMG_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
};

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50MB — Claude reads from disk, so be generous

/** Sanitize a user-supplied filename to a safe basename (no path separators,
 *  no traversal), preserving a reasonable extension. */
function safeBaseName(name: string | undefined, fallbackExt: string): string {
  const raw = (name ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  if (cleaned && cleaned !== '_') return cleaned;
  return `attachment.${fallbackExt}`;
}


/** Persist a data-URL attachment of ANY type under state/uploads, keeping its
 *  original filename (sanitized) so Claude — which can Read any file — sees a
 *  sensible name. Returns the absolute path, display name, and whether it's an
 *  image. Filenames are namespaced by a uuid dir so two "notes.txt" don't clash. */
function saveAttachment(stateDir: string, dataUrl: string, name?: string): { path: string; name: string; isImage: boolean } {
  const m = /^data:([^;]*);base64,(.+)$/s.exec(dataUrl);
  if (!m) throw new Error('attachment must be a base64 data URL');
  const mime = m[1] || 'application/octet-stream';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_UPLOAD_BYTES) throw new Error('attachment exceeds 50MB');
  const isImage = mime.startsWith('image/');
  const fileName = safeBaseName(name, IMG_EXT[mime] ?? (isImage ? 'png' : 'bin'));
  const dir = join(stateDir, 'uploads', randomUUID());
  mkdirSync(dir, { recursive: true });
  const path = join(dir, fileName);
  writeFileSync(path, buf);
  return { path, name: fileName, isImage };
}

interface Attachment { name?: string; data: string } // data = base64 data URL

interface SendBody {
  prompt?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  image?: string; // legacy single-image field (kept for back-compat)
  images?: string[]; // legacy image-only attachments (data URLs)
  attachments?: Attachment[]; // any file type, with original name
  projectId?: string;
  sessionId?: string; // the conversation a queued follow-up is for
  interactive?: boolean;
}

/** True if the body carries at least one attachment (new or legacy). */
function hasAttachments(body: SendBody): boolean {
  return !!(body?.attachments?.length || body?.images?.length || body?.image);
}

// NB: this project runs under tsx (esbuild), which does not implement
// `emitDecoratorMetadata` — Nest's controller instantiation (driven by
// `controllers: [...]` in the module, a DI path separate from any
// `providers` override for the same token) can't infer constructor
// param types via reflection. Explicit @Inject tokens sidestep that:
// they rely only on `experimentalDecorators`, which esbuild does support.
export const STATE_DIR = Symbol('x056-state-dir');
export const PUSH_SERVICE = Symbol('x056-push-service');
export const WEBAUTHN_SERVICE = Symbol('x056-webauthn-service');
export const SESSION_STORE = Symbol('x056-session-store');
export const PLUGIN_MANAGER = Symbol('x056-plugin-manager');
export const MCP_SERVER_MANAGER = Symbol('x056-mcp-server-manager');

const QUOTA_TTL_MS = 90_000;

/** How quiet a subagent's transcript may go and still count as running. */
const LIVE_SUBAGENT_MS = 10 * 60_000;

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
    @Inject(PUSH_SERVICE) private readonly push: PushService,
    @Inject(WEBAUTHN_SERVICE) private readonly webauthn: WebAuthnService,
    @Inject(SESSION_STORE) private readonly sessionStore: SessionStore,
    @Inject(PLUGIN_MANAGER) private readonly plugins: PluginManager,
    @Inject(MCP_SERVER_MANAGER) private readonly mcpServers: McpServerManager,
    @Inject(CODEGRAPH) private readonly codegraph: CodegraphClient,
    @Inject(MEMORY_WRITER) private readonly memories: MemoryWriter,
    @Inject(PROVISIONER) private readonly provisioner: AccountProvisioner,
    @Inject(CRON) private readonly cron: CronScheduler,
    @Inject(DESIGN_LOGIN) private readonly designLogin: DesignLoginManager,
    @Inject(DESIGN_CONSENT) private readonly designConsent: DesignConsentGranter,
    @Inject(TEMPLATES) private readonly templates: TemplateStore,
    @Inject(TRANSCRIPT_STATS) private readonly stats: TranscriptStatsReader,
  ) {
    this.loadQuotaCache();
  }

  private quotaCacheFile(): string {
    return join(this.stateDir, 'quota-cache.json');
  }

  /** The oauth usage endpoint rate-limits aggressively and can stay down for a
   *  while — without this, every deploy's container restart wipes the in-memory
   *  cache and blanks out every account's usage bars for as long as upstream
   *  happens to be unavailable, even though nothing about the account changed. */
  private loadQuotaCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.quotaCacheFile(), 'utf8')) as Record<string, { at: number; quota: unknown }>;
      for (const [name, entry] of Object.entries(raw)) this.quotaCache.set(name, entry);
    } catch {
      // no cache on disk yet (fresh install) — nothing to load
    }
  }

  private saveQuotaCache(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      writeFileSync(this.quotaCacheFile(), JSON.stringify(Object.fromEntries(this.quotaCache)));
    } catch {
      // best-effort — losing the persisted cache only means a future restart
      // falls back to the old in-memory-only behavior, not a correctness issue
    }
  }

  /** Derive the RP id + origin the browser used, validated against an allowlist
   *  (the production host, plus localhost for dev/e2e) so WebAuthn can't be
   *  driven for some other origin. */
  private rp(req: Request): { rpID: string; origin: string } {
    const hdrOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? (req.secure ? 'https' : 'http');
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
    const origin = hdrOrigin || `${proto}://${host}`;
    let rpID: string;
    try { rpID = new URL(origin).hostname; } catch { throw new BadRequestException('bad origin'); }
    const allowed = (process.env.X056_RP_ID || 'x056.rc.val.id').split(',').map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(rpID) && rpID !== 'localhost' && rpID !== '127.0.0.1') {
      throw new BadRequestException('origin not allowed');
    }
    return { rpID, origin };
  }

  private setSessionCookie(req: Request, res: Response): void {
    const secure = (req.headers['x-forwarded-proto'] as string | undefined) === 'https' || req.secure;
    res.cookie('x056_session', this.sessionStore.create(), {
      httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  /** Fold any attached files into the prompt as readable on-disk paths. Claude
   *  can Read any file (text, code, PDFs, images, …), so every attachment — not
   *  just images — is saved and handed over by path. */
  private composePrompt(body: SendBody): { prompt: string; opts: TurnRunOptions } {
    let prompt = body.prompt ?? '';
    // New unified `attachments` (name + data), plus legacy image-only fields.
    const specs: Attachment[] = [
      ...(Array.isArray(body.attachments) ? body.attachments : []),
      ...(Array.isArray(body.images) ? body.images.map((data) => ({ data })) : []),
      ...(body.image ? [{ data: body.image }] : []),
    ].filter((a) => a && typeof a.data === 'string');
    const saved = specs.map((a) => saveAttachment(this.stateDir, a.data, a.name));
    if (saved.length === 1) {
      const f = saved[0];
      const kind = f.isImage ? 'image' : 'file';
      prompt += `\n\n[The user attached a ${kind} (${f.name}). Read it with the Read tool at: ${f.path}]`;
    } else if (saved.length > 1) {
      prompt += `\n\n[The user attached ${saved.length} files. Read them with the Read tool at:\n${saved.map((f) => `- ${f.path}`).join('\n')}]`;
    }
    // Teach the model the ASK convention so it can pose questions the panel can
    // surface with quick-reply buttons (opt out with interactive:false). But a
    // prompt that IS a slash command (e.g. `/claude-security scan`, from a
    // plugin) must reach the CLI verbatim — appending the ASK block would fold
    // it into the command's arguments and break the invocation.
    const isSlashCommand = (body.prompt ?? '').trimStart().startsWith('/');
    if (body.interactive !== false && !isSlashCommand) prompt = withAskInstructions(prompt);
    return { prompt, opts: { model: body.model, effort: body.effort } };
  }

  @Post('sessions')
  startSession(@Body() body: SendBody): { sessionId: string } {
    if (!body?.prompt && !hasAttachments(body)) throw new BadRequestException('prompt or attachment required');
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
    if (!body?.prompt && !hasAttachments(body)) throw new BadRequestException('prompt or attachment required');
    try {
      const { prompt, opts } = this.composePrompt(body);
      // A human spoke: both brakes reset — the self-message streak and the
      // AI-to-AI relay chain. This is the ONLY thing that clears the relay one.
      if (body.sessionId) {
        this.manager.clearSelfQueueStreak(body.sessionId);
        this.manager.clearRelayChain(body.sessionId);
      }
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
    // Tell a reverse proxy (nginx et al.) NOT to buffer this stream. Without it,
    // nginx's default proxy_buffering holds each small SSE event until its buffer
    // fills or another write arrives — so a lone 'autopilot'/'queue'/'turn_state'
    // event appears "only after refresh" (the refresh re-fetches over plain HTTP),
    // while a busy turn's burst of events flushes the buffer and looks fine live.
    res.setHeader('X-Accel-Buffering', 'no');
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
  createProject(@Body() body: { name?: string; cwd?: string; provider?: string }): unknown {
    if (!body?.name) throw new BadRequestException('name required');
    // A project is pinned to one provider at creation (default Claude); only the
    // known providers are accepted.
    const provider = body.provider === 'codex' ? 'codex' : 'claude';
    try {
      return this.manager.createProject(body.name, body.cwd, provider);
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

  /** Change which provider a project's NEW conversations start on. Existing
   *  conversations keep the provider they were created with. */
  @Post('projects/provider')
  @HttpCode(200)
  setProjectProvider(@Body() body: { id?: string; provider?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    if (body.provider !== 'claude' && body.provider !== 'codex') throw new BadRequestException('unknown provider');
    try {
      this.manager.setProjectProvider(body.id, body.provider);
      return { ok: true };
    } catch (err) {
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

  @Post('projects/reorder')
  @HttpCode(200)
  reorderProjects(@Body() body: { ids?: string[] }): { ok: boolean } {
    if (!Array.isArray(body?.ids)) throw new BadRequestException('ids array required');
    try {
      this.manager.reorderProjects(body.ids.filter((x) => typeof x === 'string'));
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // ---- conversations (multiple sessions grouped under a project) ----
  @Post('conversations/select')
  @HttpCode(200)
  selectConversation(@Body() body: { projectId?: string; sessionId?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.sessionId) throw new BadRequestException('projectId and sessionId required');
    try {
      this.manager.selectConversation(body.projectId, body.sessionId);
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('conversations/rename')
  @HttpCode(200)
  renameConversation(@Body() body: { projectId?: string; sessionId?: string; title?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.sessionId || !body?.title) throw new BadRequestException('projectId, sessionId and title required');
    this.manager.renameConversation(body.projectId, body.sessionId, body.title);
    return { ok: true };
  }

  @Post('conversations/remove')
  @HttpCode(200)
  removeConversation(@Body() body: { projectId?: string; sessionId?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.sessionId) throw new BadRequestException('projectId and sessionId required');
    try {
      this.manager.removeConversation(body.projectId, body.sessionId);
      return { ok: true };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('that conversation has a turn running — stop it first');
      throw new BadRequestException((err as Error).message);
    }
  }

  /** Read ANY conversation's history by address — the MCP bridge's read tool
   *  (the /sessions/current/history endpoint below only reads the currently
   *  selected one, which a cross-conversation reader must not depend on). */
  @Get('conversations/history')
  conversationHistory(
    @Query('projectId') projectId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit?: string,
  ): HistoryEntry[] {
    if (!projectId || !sessionId) throw new BadRequestException('projectId and sessionId required');
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
    try {
      const { adapter, providerSessionId, configDirs } = this.manager.historyContext(projectId, sessionId);
      return adapter.readHistory ? adapter.readHistory(configDirs, providerSessionId, n) : [];
    } catch {
      return [];
    }
  }

  /** Request sending a message to ANY conversation by address (or starting a
   *  new conversation in a project when no sessionId is given) — the MCP
   *  bridge's send tool. This does NOT dispatch: it records a pending approval
   *  that the human operator must explicitly approve in the panel (see
   *  mcpApprovalDecide below) before anything is actually sent to another
   *  conversation. Unlike /sessions/current/messages this never depends on, or
   *  moves, the panel's "current" selection. */
  @Post('conversations/send')
  @HttpCode(200)
  conversationSend(@Body() body: { projectId?: string; sessionId?: string; prompt?: string; model?: string; effort?: string; interactive?: boolean; from?: string }):
    { mode: 'auto'; sessionId: string; queued: boolean; hopsLeft: number } | { mode: 'approval'; approvalId: string } {
    if (!body?.projectId) throw new BadRequestException('projectId required');
    if (!body?.prompt) throw new BadRequestException('prompt required');
    if (body.sessionId) {
      // Only an EXISTING conversation can be a target — a made-up id would
      // spawn a resume against a transcript that doesn't exist.
      const known = this.manager.listConversations(body.projectId).some((c) => c.sessionId === body.sessionId);
      if (!known) throw new BadRequestException('unknown conversation for that project');
    }
    // `from` is the CALLING conversation, supplied by the per-turn MCP config
    // rather than the model, so a caller cannot disown its own chain by leaving
    // it out — an external client (Claude Desktop) genuinely has none.
    const opts = { model: body.model, effort: body.effort, interactive: body.interactive, from: body.from };
    // The MODE is the operator's setting, never the caller's choice — an AI that
    // could ask for 'auto' would make the approval gate worthless.
    if (this.manager.mcpSendMode() === 'auto') {
      try {
        const out = this.manager.deliverMcpMessage(body.projectId, body.sessionId, body.prompt, opts);
        return { mode: 'auto' as const, sessionId: out.sessionId, queued: out.queued, hopsLeft: out.hopsLeft };
      } catch (err) {
        // 409, not 400: the request is well-formed, the exchange is just over.
        if (err instanceof RelayLimitError) throw new ConflictException(err.message);
        throw err;
      }
    }
    const approval = this.manager.requestMcpSend(body.projectId, body.sessionId, body.prompt, opts);
    return { mode: 'approval' as const, approvalId: approval.id };
  }

  /**
   * Halt a conversation from another one: abort its running turn and drop what
   * is queued for it. The MCP bridge's stop tool.
   *
   * Not gated behind the operator's approval, unlike a send. This is the brake
   * on a runaway exchange, and a brake that waits for a human is not a brake —
   * the failure it exists to stop is precisely the one where nobody is watching.
   * It also cannot inject anything: the worst it does is end a turn early, which
   * the panel's own Stop button already does.
   *
   * Stopping does NOT clear the relay chain. An exhausted pair could otherwise
   * halt each other to win back hops.
   */
  @Post('conversations/halt')
  @HttpCode(200)
  conversationHalt(@Body() body: { projectId?: string; sessionId?: string; dropQueued?: boolean }): { stopped: boolean; dropped: number } {
    if (!body?.projectId || !body?.sessionId) throw new BadRequestException('projectId and sessionId required');
    const known = this.manager.listConversations(body.projectId).some((c) => c.sessionId === body.sessionId);
    if (!known) throw new BadRequestException('unknown conversation for that project');
    return this.manager.haltConversation(body.projectId, body.sessionId, body.dropQueued !== false);
  }

  /** A page of older history for scroll-back. Paging is by opaque cursor (a byte
   *  offset into the transcript), so scrolling far back never requires reading
   *  the whole file — these grow past 350MB and would otherwise blow up. */
  @Get('conversations/history-page')
  conversationHistoryPage(
    @Query('projectId') projectId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ): { rows: HistoryEntry[]; cursor: number; done: boolean } {
    if (!projectId || !sessionId) throw new BadRequestException('projectId and sessionId required');
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 60;
    const cur = Number.isFinite(Number(before)) && Number(before) >= 0 ? Number(before) : undefined;
    try {
      const { adapter, providerSessionId, configDirs } = this.manager.historyContext(projectId, sessionId);
      if (adapter.readHistoryPage) return adapter.readHistoryPage(configDirs, providerSessionId, n, cur);
      // Provider without pagination: serve the newest page and report no more.
      const rows = adapter.readHistory ? adapter.readHistory(configDirs, providerSessionId, n) : [];
      return { rows, cursor: 0, done: true };
    } catch {
      return { rows: [], cursor: 0, done: true };
    }
  }

  // ---- subagents: each Task call keeps its own transcript beside the session --

  /**
   * The subagents a conversation has spawned.
   *
   * Claude Code writes each one a complete transcript of its own, so this is a
   * directory listing rather than anything reconstructed from the event stream —
   * and it works identically for a finished turn and one still running.
   */
  @Get('conversations/subagents')
  conversationSubagents(@Query('projectId') projectId?: string, @Query('sessionId') sessionId?: string) {
    if (!projectId || !sessionId) throw new BadRequestException('projectId and sessionId required');
    const empty = { subagents: [], self: null };
    if (!projectId || !sessionId) return empty;
    try {
      const { adapter, providerSessionId, configDirs } = this.manager.historyContext(projectId, sessionId);
      // Codex has no equivalent; an empty list is the honest answer, not an error.
      if (adapter.id !== 'claude') return empty;

      // The parent's own transcript answers two questions at once: what the
      // conversation itself has spent, and — through each Task's tool_result —
      // which subagents have actually come back.
      const parent = parentTranscript(configDirs, providerSessionId);
      const parentStats = parent ? this.stats.statsFor(parent) : null;
      const running = this.manager.isSessionRunning(sessionId);

      // Scan every transcript ONCE — the parent and each subagent — and merge the
      // Task records. A nested subagent's tool_result lives in the transcript of
      // the SUBAGENT that spawned it, not the parent's, and nesting is the common
      // case rather than an edge one: in a real security scan here, 80 of 90
      // subagents were depth 2 or 3. Looking only at the parent reported every
      // one of them as "stopped" when they had all finished. The per-subagent
      // usage below needs the same scan, so this costs no extra reads.
      const list = listSubagents(configDirs, providerSessionId);
      // One directory listing for the whole request — see subagentFiles.
      const files = subagentFiles(configDirs, providerSessionId, list);
      const own = new Map<string, ReturnType<typeof this.stats.statsFor>>();
      const tasks: Record<string, { task: NonNullable<typeof parentStats>['tasks'][string]; by: string }> = {};
      for (const [id, t] of Object.entries(parentStats?.tasks ?? {})) tasks[id] = { task: t, by: '' };
      for (const s of list) {
        const file = files.get(s.agentId);
        if (!file) continue;
        const st = this.stats.statsFor(file);
        own.set(s.agentId, st);
        for (const [id, t] of Object.entries(st.tasks)) tasks[id] = { task: t, by: s.agentId };
      }

      const subagents = list.map((s) => {
        const found = s.toolUseId ? tasks[s.toolUseId] : undefined;
        const task = found?.task;
        const own_ = own.get(s.agentId) ?? null;
        // A tool_result means it came back. Without one it either is still
        // working or never returned — and "a turn is running" alone cannot tell
        // those apart, because a subagent abandoned by an EARLIER turn also has
        // no result and would be reported as running forever. So require the
        // transcript to have been written to recently as well.
        //
        // The window is generous on purpose: a subagent can sit quiet inside one
        // long tool call, and calling that one "stopped" is the worse mistake.
        // An abandoned one is hours stale, not minutes.
        const fresh = s.updatedAt != null && Date.now() - s.updatedAt < LIVE_SUBAGENT_MS;
        const status = task?.done ? (task.isError ? 'failed' : 'done')
          : task ? (running && fresh ? 'running' : 'stopped')
          : running && fresh ? 'running' : 'unknown';
        return {
          ...s,
          status,
          // Which agent spawned this one, for anything below the top level.
          spawnedBy: found?.by ? (list.find((x) => x.agentId === found.by)?.agentType ?? found.by) : undefined,
          // The Task call's own timestamps beat file mtimes: they bracket the
          // work rather than the last write to disk.
          startedAt: task?.startedAt ? Date.parse(task.startedAt) : s.startedAt,
          endedAt: task?.endedAt ? Date.parse(task.endedAt) : undefined,
          brief: (() => { const f = files.get(s.agentId); return f ? cachedBrief(f).slice(0, 600) : ''; })(),
          result: task?.result,
          usage: own_?.usage ?? null,
          cost: own_ ? estimateCost(own_.usage) : null,
        };
      });

      return {
        subagents,
        // The conversation's own spend, so a fan-out can be compared against it.
        self: parentStats
          ? { usage: parentStats.usage, cost: estimateCost(parentStats.usage), partial: parentStats.partial, scanned: parentStats.scanned, size: parentStats.size, running }
          : null,
      };
    } catch {
      return empty;
    }
  }

  /** One subagent's own history — the same rows the main chat renders. */
  @Get('conversations/subagent-history')
  conversationSubagentHistory(
    @Query('projectId') projectId?: string,
    @Query('sessionId') sessionId?: string,
    @Query('agentId') agentId?: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    if (!projectId || !sessionId || !agentId) throw new BadRequestException('projectId, sessionId and agentId required');
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(Number(limit), 500) : 200;
    const cur = Number.isFinite(Number(before)) && Number(before) >= 0 ? Number(before) : undefined;
    try {
      const { adapter, providerSessionId, configDirs } = this.manager.historyContext(projectId, sessionId);
      if (adapter.id !== 'claude') return { rows: [], cursor: 0, done: true };
      return readSubagentPage(configDirs, providerSessionId, agentId, n, cur);
    } catch {
      return { rows: [], cursor: 0, done: true };
    }
  }

  /** Poll the outcome of a requested send — the MCP bridge waits on this until
   *  the human decides (or it expires) before it can report success/failure. */
  @Get('conversations/send-status')
  conversationSendStatus(@Query('id') id?: string) {
    if (!id) throw new BadRequestException('id required');
    const a = this.manager.mcpApprovalStatus(id);
    if (!a) throw new BadRequestException('unknown approval id');
    return a;
  }

  /** Pending cross-conversation sends awaiting the operator's decision — what
   *  the panel renders as approve/deny cards, hydrated on load/reconnect. */
  @Get('mcp/approvals')
  mcpApprovalsList() {
    return this.manager.listMcpApprovals();
  }

  /** The operator's approve/deny decision from the panel. Approving dispatches
   *  the send immediately; denying (or letting it expire) means it is never sent. */
  @Post('mcp/approvals/decide')
  @HttpCode(200)
  mcpApprovalDecide(@Body() body: { id?: string; approve?: boolean }) {
    if (!body?.id) throw new BadRequestException('id required');
    const a = this.manager.decideMcpApproval(body.id, !!body.approve);
    if (!a) throw new BadRequestException('unknown or already-decided approval id');
    return a;
  }

  /** Unanswered questions across all conversations. A question ends its turn and
   *  waits for a human, so the panel hydrates from this on load/reconnect —
   *  otherwise a refresh (or a container swap) drops the card while the
   *  conversation is still genuinely waiting. */
  @Get('questions')
  pendingQuestions() {
    return this.manager.listPendingQuestions();
  }

  // ---- MCP servers. Replicated across every account of the chosen provider:
  //      a turn can run on any of them, so a server configured on only one
  //      silently vanishes on failover. ----
  @Get('mcp/servers')
  listMcpServers() {
    return this.mcpServers.list();
  }

  @Post('mcp/servers/add')
  @HttpCode(200)
  addMcpServer(@Body() body: { provider?: string; server?: McpServerSpec }) {
    const { provider, server } = this.validateMcpBody(body);
    return this.mcpServers.add(provider, server);
  }

  /** Neither CLI has an edit; the manager does remove-then-add. */
  @Post('mcp/servers/update')
  @HttpCode(200)
  updateMcpServer(@Body() body: { provider?: string; server?: McpServerSpec }) {
    const { provider, server } = this.validateMcpBody(body);
    return this.mcpServers.update(provider, server);
  }

  @Post('mcp/servers/remove')
  @HttpCode(200)
  removeMcpServer(@Body() body: { provider?: string; name?: string }) {
    const provider = body?.provider === 'codex' ? 'codex' : 'claude';
    const name = (body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name required');
    return this.mcpServers.remove(provider, name);
  }

  /** Reject a half-specified server here rather than letting the CLI write a
   *  broken entry to every account. */
  private validateMcpBody(body: { provider?: string; server?: McpServerSpec }): { provider: 'claude' | 'codex'; server: McpServerSpec } {
    const provider = body?.provider === 'codex' ? 'codex' : 'claude';
    const s = body?.server;
    const name = (s?.name ?? '').trim();
    if (!name) throw new BadRequestException('server name required');
    if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new BadRequestException('name may only contain letters, numbers, dot, dash, underscore');
    const transport = s?.transport === 'http' ? 'http' : 'stdio';
    if (transport === 'http') {
      const url = (s?.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) throw new BadRequestException('http server needs an http(s) url');
      return { provider, server: { name, transport, url, headers: s?.headers ?? {} } };
    }
    const command = (s?.command ?? '').trim();
    if (!command) throw new BadRequestException('stdio server needs a command');
    return {
      provider,
      server: {
        name, transport,
        command,
        args: Array.isArray(s?.args) ? s!.args!.map(String).filter((x) => x !== '') : [],
        env: s?.env ?? {},
      },
    };
  }

  // ---- Claude Code plugins. Every mutation is replicated across all Claude
  //      failover accounts (see PluginManager) so a plugin stays usable after a
  //      failover, and reads aggregate the pool so drift is visible. ----
  @Get('plugins')
  listPlugins() {
    return this.plugins.list();
  }

  @Post('plugins/install')
  @HttpCode(200)
  async installPlugin(@Body() body: { plugin?: string }) {
    if (!body?.plugin) throw new BadRequestException('plugin required (name@marketplace)');
    return this.plugins.install(body.plugin.trim());
  }

  @Post('plugins/uninstall')
  @HttpCode(200)
  async uninstallPlugin(@Body() body: { plugin?: string }) {
    if (!body?.plugin) throw new BadRequestException('plugin required');
    return this.plugins.uninstall(body.plugin.trim());
  }

  @Post('plugins/enabled')
  @HttpCode(200)
  async setPluginEnabled(@Body() body: { plugin?: string; enabled?: boolean }) {
    if (!body?.plugin) throw new BadRequestException('plugin required');
    return this.plugins.setEnabled(body.plugin.trim(), !!body.enabled);
  }

  @Post('plugins/marketplace/add')
  @HttpCode(200)
  async addMarketplace(@Body() body: { source?: string }) {
    if (!body?.source) throw new BadRequestException('source required (URL, path, or owner/repo)');
    return this.plugins.addMarketplace(body.source.trim());
  }

  @Post('plugins/marketplace/remove')
  @HttpCode(200)
  async removeMarketplace(@Body() body: { name?: string }) {
    if (!body?.name) throw new BadRequestException('name required');
    return this.plugins.removeMarketplace(body.name.trim());
  }

  @Get('sessions/current/history')
  history(@Query('limit') limit?: string): HistoryEntry[] {
    const snap = this.manager.snapshot();
    const pid = snap.currentProjectId;
    const sessionId = snap.lastSessionId;
    if (!pid || !sessionId) return [];
    const n = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 100;
    try {
      // Read through the CONVERSATION's own provider — a Codex conversation's
      // transcript lives under sessions/rollout-*.jsonl (its own thread id), not
      // Claude's projects/*.jsonl, so this can't be a single hardcoded reader.
      const { adapter, providerSessionId, configDirs } = this.manager.historyContext(pid, sessionId);
      return adapter.readHistory ? adapter.readHistory(configDirs, providerSessionId, n) : [];
    } catch {
      return [];
    }
  }

  @Get('accounts')
  async accounts(): Promise<unknown[]> {
    let registry: AccountRegistry;
    try {
      registry = AccountRegistry.load(join(this.stateDir, 'accounts.json'));
    } catch {
      return [];
    }
    // "Next up" and "active" are PER PROVIDER now — a Claude session and a Codex
    // session each have their own next account — so compute them per provider
    // and match each account against its own provider's pointer.
    const nowSec = Math.floor(Date.now() / 1000);
    const providers = [...new Set(registry.list().map((a) => a.provider))];
    const nextUpByProvider = new Map(providers.map((p) => [p, registry.peekActive(nowSec, p)?.name ?? null]));
    const activeByProvider = new Map(providers.map((p) => [p, registry.activeName(p)]));
    return Promise.all(
      registry.list().map(async (acct) => {
        const adapter = getAdapter(acct.provider);
        const id = adapter.readIdentity(acct.configDir);
        // registry.list() returns the raw persisted verdict, which only gets
        // re-evaluated the next time a turn actually tries this account — so a
        // 'limited' mark can sit stale (badge says "limited" long after the
        // cooldown passed). pickActive() already treats an expired `until` as
        // usable; make the badge agree with that instead of the raw record.
        // A signed-out account is otherwise only noticed when a turn tries it,
        // so one left alone for days keeps a long-expired 'limited' badge and
        // never offers the re-login it actually needs. Disk knows better.
        const signedOut = adapter.hasCredentials?.(acct.configDir) === false;
        const state = signedOut
          ? ({ kind: 'unauthenticated' } as const)
          : acct.state.kind === 'limited' && acct.state.until <= nowSec
            ? ({ kind: 'ok' } as const)
            : acct.state;
        const base = { ...acct, providerLabel: adapter.label, state, displayName: id.displayName ?? acct.name, email: id.email, nextUp: acct.name === nextUpByProvider.get(acct.provider), active: acct.name === activeByProvider.get(acct.provider) };
        // A provider with no pollable usage endpoint (e.g. Codex on a ChatGPT
        // plan) simply shows no usage bars — never an error.
        if (!adapter.fetchUsage) return { ...base, quota: null };
        const cached = this.quotaCache.get(acct.name);
        if (cached && Date.now() - cached.at < QUOTA_TTL_MS) {
          return { ...base, quota: cached.quota, quotaAt: cached.at };
        }
        const backoffUntil = this.quotaBackoffUntil.get(acct.name) ?? 0;
        if (Date.now() < backoffUntil) {
          // Cached data never goes dark just because upstream is (still) rate-limited —
          // keep showing the last real reading, marked stale, with its age so the panel
          // can say how old it is instead of a blanket "refreshing" that may not be
          // imminent (upstream retry-after here can run up to an hour).
          if (cached) return { ...base, quota: cached.quota, quotaStale: true, quotaAt: cached.at, quotaRetryAt: backoffUntil };
          return { ...base, quota: null, quotaError: `rate-limited upstream; retrying after ${new Date(backoffUntil).toISOString()}` };
        }
        try {
          const quota = await adapter.fetchUsage(acct.configDir);
          const at = Date.now();
          this.quotaCache.set(acct.name, { at, quota });
          this.saveQuotaCache();
          this.quotaBackoffUntil.delete(acct.name);
          return { ...base, quota, quotaAt: at };
        } catch (err) {
          const backoffMs = err instanceof UsageRateLimitedError ? err.retryAfterMs : 60_000;
          const retryAt = Date.now() + backoffMs;
          this.quotaBackoffUntil.set(acct.name, retryAt);
          if (cached) return { ...base, quota: cached.quota, quotaStale: true, quotaAt: cached.at, quotaRetryAt: retryAt };
          return { ...base, quota: null, quotaError: (err as Error).message };
        }
      }),
    );
  }

  /** Models each provider offers for the accounts actually configured here —
   *  read from the provider's own catalog (Codex caches the account's list), so
   *  the composer's picker shows real, current ids rather than a hardcoded set.
   *  Shape: { codex: [{slug,label,…}] }. Providers with no catalog are omitted. */
  @Get('models')
  models(): Record<string, unknown[]> {
    let registry: AccountRegistry;
    try {
      registry = AccountRegistry.load(join(this.stateDir, 'accounts.json'));
    } catch {
      return {};
    }
    const out: Record<string, unknown[]> = {};
    for (const acct of registry.list()) {
      if (out[acct.provider]) continue; // first account of each provider wins
      const adapter = getAdapter(acct.provider);
      if (!adapter.listModels) continue;
      const models = adapter.listModels(acct.configDir);
      if (models.length) out[acct.provider] = models;
    }
    return out;
  }

  @Post('switch')
  @HttpCode(200)
  switch(@Body() body: { projectId?: string; sessionId?: string; account?: string; force?: boolean }): { switched: boolean } {
    if (!this.manager.forceSwitch(body?.projectId, body?.sessionId, body?.account, body?.force === true)) {
      throw new ConflictException(body?.account ? 'no running turn to switch, or it is already on that account' : 'no session running');
    }
    return { switched: true };
  }

  /** Choose which account the next message uses (when idle). `force: true`
   *  clears a still-'limited' account's mark first — for when the user has
   *  confirmed the limit already reset in reality (see SessionManager.setActiveAccount). */
  @Post('accounts/active')
  @HttpCode(200)
  setActiveAccount(@Body() body: { name?: string; force?: boolean }): { ok: boolean } {
    if (!body?.name) throw new BadRequestException('name required');
    try {
      this.manager.setActiveAccount(body.name, body.force === true);
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  // ---- account onboarding / removal ----
  // With a `name`, this re-authenticates that EXISTING account in place (the CLI
  // reported "Not logged in" for it); without one, it onboards a brand-new account.
  @Post('accounts/login/start')
  @HttpCode(200)
  async accountLoginStart(@Body() body: { name?: string }): Promise<{ loginId: string; url: string }> {
    try {
      return body?.name ? await this.manager.startAccountRelogin(body.name) : await this.manager.startAccountLogin();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('accounts/login/submit')
  @HttpCode(200)
  async accountLoginSubmit(@Body() body: { loginId?: string; code?: string }): Promise<{ name: string; email?: string; displayName?: string }> {
    if (!body?.loginId || !body?.code) throw new BadRequestException('loginId and code required');
    try {
      return await this.manager.submitAccountLoginCode(body.loginId, body.code);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('accounts/login/cancel')
  @HttpCode(200)
  accountLoginCancel(@Body() body: { loginId?: string }): { ok: boolean } {
    if (body?.loginId) this.manager.cancelAccountLogin(body.loginId);
    return { ok: true };
  }

  /** Start an in-panel ChatGPT (Codex) device-auth login → { loginId, url, code }.
   *  The user opens `url`, enters `code`, and the panel polls .../login/status. */
  @Post('accounts/codex/login/start')
  @HttpCode(200)
  async codexLoginStart(): Promise<unknown> {
    try {
      return await this.manager.startCodexLogin();
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** Poll a Codex device-auth login; { done, account? } once auth.json lands. */
  @Post('accounts/codex/login/status')
  @HttpCode(200)
  codexLoginStatus(@Body() body: { loginId?: string }): unknown {
    if (!body?.loginId) throw new BadRequestException('loginId required');
    try {
      return this.manager.codexLoginStatus(body.loginId);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('accounts/codex/login/cancel')
  @HttpCode(200)
  codexLoginCancel(@Body() body: { loginId?: string }): { ok: boolean } {
    if (body?.loginId) this.manager.cancelCodexLogin(body.loginId);
    return { ok: true };
  }

  /** Register an already-authenticated Codex account by its CODEX_HOME path
   *  (advanced: for a login done on the host rather than in-panel). */
  @Post('accounts/codex/register')
  @HttpCode(200)
  registerCodexAccount(@Body() body: { codexHome?: string }): unknown {
    if (!body?.codexHome) throw new BadRequestException('codexHome required');
    try {
      return this.manager.registerCodexAccount(body.codexHome);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('accounts/remove')
  @HttpCode(200)
  accountRemove(@Body() body: { name?: string }): { removed: boolean } {
    if (!body?.name) throw new BadRequestException('name required');
    try {
      this.manager.removeAccount(body.name);
      return { removed: true };
    } catch (err) {
      if (err instanceof BusyError) throw new ConflictException('stop the running turn before removing an account');
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('sessions/current/stop')
  @HttpCode(200)
  stop(@Body() body: { projectId?: string; sessionId?: string }): { stopped: boolean } {
    // Stop targets the named conversation; a sibling conversation running in the
    // same project keeps going.
    if (body?.sessionId && !this.manager.isSessionRunning(body.sessionId)) {
      throw new ConflictException('no turn running in this conversation');
    }
    if (!this.manager.stopTurn(body?.projectId, body?.sessionId)) throw new ConflictException('no turn running there');
    return { stopped: true };
  }

  @Get('autopilot')
  autopilot(): unknown {
    return this.manager.autopilotStatus();
  }

  @Post('autopilot')
  @HttpCode(200)
  setAutopilot(@Body() body: { projectId?: string; sessionId?: string; count?: number; prompt?: string; stopPhrase?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.sessionId || !body?.count) throw new BadRequestException('projectId, sessionId and count required');
    try {
      this.manager.setAutopilot(body.projectId, body.sessionId, { count: body.count, prompt: body.prompt, stopPhrase: body.stopPhrase });
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('autopilot/stop')
  @HttpCode(200)
  stopAutopilot(@Body() body: { sessionId?: string }): { ok: boolean } {
    if (!body?.sessionId) throw new BadRequestException('sessionId required');
    this.manager.stopAutopilot(body.sessionId);
    return { ok: true };
  }

  // ---- auth / passkeys ----
  @Get('auth/status')
  authStatus(): { authed: boolean } {
    return { authed: true }; // reaching this (past the guard) means authenticated
  }

  @Post('auth/logout')
  @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): { ok: boolean } {
    const sid = readCookie(req.headers.cookie, 'x056_session');
    if (sid) this.sessionStore.destroy(sid);
    res.clearCookie('x056_session', { path: '/' });
    return { ok: true };
  }

  @Public()
  @Get('auth/passkey/available')
  passkeyAvailable(): { available: boolean } {
    return { available: this.webauthn.hasAny() };
  }

  @Post('auth/passkey/register/options')
  @HttpCode(200)
  async registerOptions(@Req() req: Request): Promise<unknown> {
    const { rpID, origin } = this.rp(req);
    return this.webauthn.registrationOptions(rpID, origin);
  }

  @Post('auth/passkey/register/verify')
  @HttpCode(200)
  async registerVerify(@Body() body: { flowId?: string; response?: RegistrationResponseJSON; label?: string }): Promise<{ ok: boolean }> {
    if (!body?.flowId || !body?.response) throw new BadRequestException('flowId and response required');
    const ok = await this.webauthn.verifyRegistration(body.flowId, body.response, body.label ?? '');
    if (!ok) throw new BadRequestException('passkey registration failed');
    return { ok: true };
  }

  @Public()
  @Post('auth/passkey/auth/options')
  @HttpCode(200)
  async authOptions(@Req() req: Request): Promise<unknown> {
    const { rpID, origin } = this.rp(req);
    return this.webauthn.authenticationOptions(rpID, origin);
  }

  @Public()
  @Post('auth/passkey/auth/verify')
  @HttpCode(200)
  async authVerify(
    @Body() body: { flowId?: string; response?: AuthenticationResponseJSON },
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: boolean }> {
    if (!body?.flowId || !body?.response) throw new BadRequestException('flowId and response required');
    const ok = await this.webauthn.verifyAuthentication(body.flowId, body.response);
    if (!ok) throw new BadRequestException('passkey login failed');
    this.setSessionCookie(req, res); // logged in — issue a session
    return { ok: true };
  }

  @Get('auth/passkey/list')
  passkeyList(): unknown {
    return this.webauthn.list();
  }

  @Post('auth/passkey/remove')
  @HttpCode(200)
  passkeyRemove(@Body() body: { id?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    this.webauthn.remove(body.id);
    return { ok: true };
  }

  @Get('queue')
  queue(): unknown {
    return this.manager.queues();
  }

  @Post('queue')
  @HttpCode(200)
  enqueue(@Body() body: SendBody): { queued: boolean; id?: string } {
    if (!body?.projectId) throw new BadRequestException('projectId required');
    if (!body?.prompt) throw new BadRequestException('prompt required');
    try {
      if (body.sessionId) {
        this.manager.clearSelfQueueStreak(body.sessionId);
        this.manager.clearRelayChain(body.sessionId);
      }
      const item = this.manager.enqueue(body.projectId, { text: body.prompt, model: body.model, effort: body.effort, sessionId: body.sessionId });
      return { queued: true, id: item.id };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('queue/edit')
  @HttpCode(200)
  editQueue(@Body() body: { projectId?: string; id?: string; prompt?: string; model?: string; effort?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.id) throw new BadRequestException('projectId and id required');
    this.manager.editQueueItem(body.projectId, body.id, { text: body.prompt, model: body.model, effort: body.effort });
    return { ok: true };
  }

  @Post('queue/remove')
  @HttpCode(200)
  removeQueue(@Body() body: { projectId?: string; id?: string }): { ok: boolean } {
    if (!body?.projectId || !body?.id) throw new BadRequestException('projectId and id required');
    this.manager.removeQueueItem(body.projectId, body.id);
    return { ok: true };
  }

  @Get('settings')
  settings(): unknown {
    return this.manager.getSettings();
  }

  @Post('settings/mcp-send-mode')
  @HttpCode(200)
  setMcpSendMode(@Body() body: { mode?: string }): { ok: boolean; mode: 'approval' | 'auto' } {
    const mode = body?.mode === 'auto' ? 'auto' : body?.mode === 'approval' ? 'approval' : null;
    if (!mode) throw new BadRequestException("mode must be 'approval' or 'auto'");
    this.manager.setMcpSendMode(mode);
    return { ok: true, mode };
  }

  @Post('settings/model-effort')
  @HttpCode(200)
  setModelEffort(@Body() body: { modelEffort?: Record<string, string> }): { ok: boolean } {
    if (!body || typeof body.modelEffort !== 'object' || body.modelEffort === null) {
      throw new BadRequestException('modelEffort required');
    }
    this.manager.setModelEffortDefaults(body.modelEffort);
    return { ok: true };
  }

  @Get('push/config')
  pushConfig(): { enabled: boolean; publicKey: string } {
    return { enabled: true, publicKey: this.push.publicKey };
  }

  @Post('push/subscribe')
  @HttpCode(200)
  pushSubscribe(@Body() body: { subscription?: PushSubscription }): { ok: boolean } {
    if (!body?.subscription?.endpoint) throw new BadRequestException('subscription required');
    try {
      this.push.add(body.subscription);
      return { ok: true };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('push/unsubscribe')
  @HttpCode(200)
  pushUnsubscribe(@Body() body: { endpoint?: string }): { ok: boolean } {
    if (body?.endpoint) this.push.remove(body.endpoint);
    return { ok: true };
  }

  /**
   * Proxy one code-graph / memory-wiki query to the knowledge service.
   *
   * Exists so the MCP tools work over BOTH transports without either of them
   * knowing the service URL or holding its token: the gateway keeps the
   * credential and the dind-only address server-side. An external client
   * (Claude Desktop) reaches this through the gateway's normal auth.
   */
  @Post('codegraph/call')
  @HttpCode(200)
  async codegraphCall(@Body() body: { tool?: string; args?: Record<string, unknown> }) {
    const tool = typeof body?.tool === 'string' ? body.tool : '';
    if (!tool) throw new BadRequestException('tool is required');
    if (!this.codegraph.enabled) throw new ConflictException('code graph is not configured on this gateway');
    try {
      return { data: await this.codegraph.call(tool, body?.args ?? {}) };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /**
   * Save a memory into a project, from an external MCP client.
   *
   * The caller names a project by ID, never a path — the cwd is resolved here
   * from the registry, so an unknown project is a 400 rather than a new
   * directory somewhere on disk.
   */
  @Post('memories/save')
  @HttpCode(200)
  saveMemory(@Body() body: { projectId?: string; name?: string; description?: string; content?: string; source?: string }) {
    const projectId = typeof body?.projectId === 'string' ? body.projectId : '';
    const proj = this.manager.listProjects().projects.find((p) => p.id === projectId);
    if (!proj) throw new BadRequestException('unknown projectId — use list_projects');
    try {
      return this.memories.save({
        cwd: proj.cwd,
        name: body?.name ?? '',
        description: body?.description ?? '',
        content: body?.content ?? '',
        source: body?.source,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /** What the fleet collectively has, and which accounts lag behind it. */
  @Get('accounts/baseline')
  accountBaseline(): unknown {
    return { plan: this.provisioner.plan(), adhd: this.provisioner.flagState('.i-have-adhd-always') };
  }

  /** Re-apply the fleet baseline to one account (or every account). */
  @Post('accounts/provision')
  @HttpCode(200)
  async provisionAccount(@Body() body: { account?: string }) {
    const accounts = AccountRegistry.load(join(this.stateDir, 'accounts.json'))
      .list()
      .filter((a) => a.provider === 'claude')
      .filter((a) => !body?.account || a.name === body.account);
    if (!accounts.length) throw new BadRequestException('no matching claude account');
    const results = [];
    for (const a of accounts) results.push(await this.provisioner.provision({ name: a.name, configDir: a.configDir }));
    return { results };
  }

  /**
   * Toggle an opt-in flag file across EVERY Claude account.
   *
   * The i-have-adhd hook resolves its flag through $CLAUDE_CONFIG_DIR, which is
   * per-account — so setting it on one account makes always-on fire only when
   * failover happens to land there, which reads as "randomly broken".
   */
  @Post('accounts/flag')
  @HttpCode(200)
  setAccountFlag(@Body() body: { flag?: string; on?: boolean }) {
    if (typeof body?.flag !== 'string') throw new BadRequestException('flag is required');
    try {
      const res = this.provisioner.setFlag(body.flag, !!body.on);
      return { ...res, state: this.provisioner.flagState(body.flag) };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /**
   * Queue a message from a conversation to ITSELF, delivered when its current
   * turn ends. Identity comes from the per-turn MCP config, not the request, so
   * a caller cannot claim to be a conversation it is not.
   */
  @Post('queue/self')
  @HttpCode(200)
  queueSelf(@Body() body: { projectId?: string; sessionId?: string; prompt?: string }) {
    if (!body?.projectId || !body?.sessionId) throw new BadRequestException('projectId and sessionId required');
    if (!body?.prompt?.trim()) throw new BadRequestException('prompt required');
    try {
      return this.manager.queueSelfMessage(body.projectId, body.sessionId, body.prompt);
    } catch (err) {
      throw new ConflictException((err as Error).message);
    }
  }

  // ---- prompt templates: saved snippets the composer inserts at the caret ----

  @Get('templates')
  listTemplates(): unknown {
    return { templates: this.templates.list() };
  }

  @Post('templates')
  @HttpCode(200)
  addTemplate(@Body() body: { name?: string; body?: string }) {
    try { return this.templates.add({ name: body?.name, body: body?.body }); }
    catch (err) { throw new BadRequestException((err as Error).message); }
  }

  @Post('templates/update')
  @HttpCode(200)
  updateTemplate(@Body() body: { id?: string; name?: string; body?: string }) {
    if (!body?.id) throw new BadRequestException('id required');
    try {
      const t = this.templates.update(body.id, { name: body.name, body: body.body });
      if (!t) throw new BadRequestException('unknown template');
      return t;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('templates/remove')
  @HttpCode(200)
  removeTemplate(@Body() body: { id?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    return { ok: this.templates.remove(body.id) };
  }

  /** Record that a template was inserted, so the picker can rank by use. */
  @Post('templates/used')
  @HttpCode(200)
  usedTemplate(@Body() body: { id?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    return { ok: !!this.templates.used(body.id) };
  }

  @Get('cron')
  listCron(): unknown {
    return { jobs: this.cron.list(), defaultTz: this.cron.defaultTimezone };
  }

  @Post('cron')
  @HttpCode(200)
  addCron(@Body() body: { schedule?: string; projectId?: string; sessionId?: string; prompt?: string; tz?: string; label?: string; createdBy?: string; once?: boolean }) {
    try {
      return this.cron.add({
        schedule: body?.schedule ?? '',
        projectId: body?.projectId ?? '',
        sessionId: body?.sessionId,
        prompt: body?.prompt ?? '',
        tz: body?.tz,
        label: body?.label,
        once: body?.once,
        createdBy: body?.createdBy,
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('cron/remove')
  @HttpCode(200)
  removeCron(@Body() body: { id?: string }): { ok: boolean } {
    if (!body?.id) throw new BadRequestException('id required');
    return { ok: this.cron.remove(body.id) };
  }

  @Post('cron/enabled')
  @HttpCode(200)
  setCronEnabled(@Body() body: { id?: string; enabled?: boolean }) {
    if (!body?.id) throw new BadRequestException('id required');
    const job = this.cron.setEnabled(body.id, !!body.enabled);
    if (!job) throw new BadRequestException('unknown job id');
    return job;
  }

  /**
   * Claude Design login for ONE account. `/design-login` exists only in an
   * interactive session, so the gateway drives one on a PTY and hands back the
   * URL; the session stays alive until the code is submitted.
   */
  @Post('accounts/design-login/start')
  @HttpCode(200)
  async designLoginStart(@Body() body: { account?: string }) {
    const name = body?.account;
    if (!name) throw new BadRequestException('account required');
    const acct = AccountRegistry.load(join(this.stateDir, 'accounts.json')).list()
      .find((a) => a.name === name && a.provider === 'claude');
    if (!acct) throw new BadRequestException(`unknown claude account: ${name}`);
    try {
      return await this.designLogin.start(acct.name, acct.configDir);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Post('accounts/design-login/submit')
  @HttpCode(200)
  async designLoginSubmit(@Body() body: { loginId?: string; code?: string }) {
    if (!body?.loginId || !body?.code) throw new BadRequestException('loginId and code required');
    return this.designLogin.submit(body.loginId, body.code);
  }

  @Post('accounts/design-login/cancel')
  @HttpCode(200)
  designLoginCancel(@Body() body: { loginId?: string }): { ok: boolean } {
    if (body?.loginId) this.designLogin.cancel(body.loginId);
    return { ok: true };
  }

  /**
   * Grant Claude Design AGENT access — the grant the mcp__claude-design__* tools
   * check, which is not the same as the design login above. Turns run with
   * --dangerously-skip-permissions, where the consent prompt can never fire, so
   * without this every design tool call fails with "the user hasn't granted
   * this". Idempotent, and per claude.ai identity, so it runs on every account.
   */
  @Post('accounts/design-consent')
  @HttpCode(200)
  async grantDesignConsent(@Body() body: { account?: string }) {
    const accounts = AccountRegistry.load(join(this.stateDir, 'accounts.json'))
      .list()
      .filter((a) => a.provider === 'claude')
      .filter((a) => !body?.account || a.name === body.account);
    if (!accounts.length) throw new BadRequestException('no matching claude account');
    const results = await this.designConsent.grantAll(
      accounts.map((a) => ({ name: a.name, configDir: a.configDir })),
    );
    return { results };
  }
}
