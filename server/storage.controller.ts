import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import { relyingParty, WEBAUTHN_SERVICE } from './api.controller.js';
import type { StepUpKey, WebAuthnService } from './webauthn.js';
import { STORAGE_SWEEPER, type StorageApprovers, type StorageSweeper } from './storage-sweeper.js';

export const STORAGE_APPROVERS = Symbol('x056-storage-approvers');

/**
 * Settings > Storage. Reading, and starting a sweep, take the ordinary panel
 * auth: a sweep deletes only AUTO items (or nothing, as a dry run).
 *
 * Approving manifest items is the human gate. Every AI session in this
 * container holds X056_TOKEN, can read state files (so the passkey session
 * cookie) and can register a push device or a passkey with the token. What it
 * cannot do is sign a WebAuthn assertion with the owner's passkey: the
 * private key is on the owner's device. So an approval needs a fresh
 * assertion with user verification, bound to the manifest id, its digest and
 * the exact item ids, from a passkey in the approver set, pinned by credential id
 * AND public-key fingerprint (a passkey a session registers is not in it,
 * and neither is a key re-registered under an approver's id). There is no MCP tool for any of this, and
 * a request carrying the MCP bridge's caller identity is refused outright.
 */
@Controller('api/storage')
export class StorageController {
  constructor(
    @Inject(STORAGE_SWEEPER) private readonly sweeper: StorageSweeper,
    @Inject(STORAGE_APPROVERS) private readonly approvers: StorageApprovers,
    @Inject(WEBAUTHN_SERVICE) private readonly webauthn: WebAuthnService,
  ) {}

  @Get()
  status(): Record<string, unknown> {
    return { ...this.sweeper.status(), approvers: this.approvers.allowed(this.webauthn.keys()).length };
  }

  @Get('manifest')
  manifest(): { manifest: unknown } {
    return { manifest: this.sweeper.manifest() };
  }

  @Get('runs/:runId')
  run(@Param('runId') runId: string): unknown {
    const r = this.sweeper.receipts(runId);
    if (!r) throw new NotFoundException('unknown run');
    return r;
  }

  /** Manual sweep. Defaults to a dry run: nothing is deleted unless dryRun is false. */
  @Post('sweep')
  @HttpCode(200)
  sweep(@Body() body: { dryRun?: boolean; budgetMinutes?: number }): { runId: string; dryRun: boolean } {
    const dryRun = body?.dryRun !== false;
    const mins = Number(body?.budgetMinutes);
    const budgetMs = Number.isFinite(mins) && mins > 0 ? Math.min(mins, 60) * 60_000 : undefined;
    try {
      const { runId, done } = this.sweeper.sweep({ trigger: 'manual', dryRun, budgetMs });
      done.catch((e) => console.warn('[storage] manual run failed:', (e as Error).message));
      return { runId, dryRun };
    } catch (e) { throw new ConflictException((e as Error).message); }
  }

  /** Step 1 of an approval: the passkey challenge for exactly these items. */
  @Post('approve/options')
  @HttpCode(200)
  async approveOptions(@Req() req: Request, @Body() body: ApproveBody): Promise<unknown> {
    refuseAgentCaller(req, body);
    const a = this.check(body);
    const allow = this.allowed();
    try {
      const { options, flowId } = await this.webauthn.stepUpOptions(relyingParty(req).rpID, relyingParty(req).origin, a.purpose, allow);
      return { options, flowId, items: a.items.length, bytes: a.bytes };
    } catch (e) { throw new ForbiddenException((e as Error).message); }
  }

  /** Step 2: the signed assertion. Only now is anything deleted. */
  @Post('approve')
  @HttpCode(200)
  async approve(@Req() req: Request, @Body() body: ApproveBody & { flowId?: string; response?: AuthenticationResponseJSON }): Promise<{ runId: string; items: number }> {
    refuseAgentCaller(req, body);
    const a = this.check(body);
    if (!body.flowId || !body.response) throw new BadRequestException('flowId and response required');
    const by = await this.webauthn.verifyStepUp(body.flowId, body.response, a.purpose, this.allowed());
    if (!by) throw new ForbiddenException('passkey approval failed');
    try {
      const { runId, done } = this.sweeper.executeApproved(body.manifestId!, body.digest!, body.itemIds!);
      done.catch((e) => console.warn('[storage] approved run failed:', (e as Error).message));
      return { runId, items: a.items.length };
    } catch (e) { throw new ConflictException((e as Error).message); }
  }

  @Get('approvers')
  approverList(): { passkeys: { id: string; label: string; createdAt: number; approver: boolean }[] } {
    const ok = this.approvers.allowed(this.webauthn.keys());
    return { passkeys: this.webauthn.keys().map(({ key, ...c }) => ({ ...c, approver: ok.some((a) => a.id === c.id && a.key === key) })) };
  }

  /** Let another passkey approve: signed by a passkey that already may. */
  @Post('approvers/options')
  @HttpCode(200)
  async approverOptions(@Req() req: Request, @Body() body: { credentialId?: string }): Promise<unknown> {
    refuseAgentCaller(req, body);
    const k = this.knownCredential(body?.credentialId);
    const allow = this.allowed();
    try {
      const { rpID, origin } = relyingParty(req);
      return await this.webauthn.stepUpOptions(rpID, origin, `storage-approver:${k.id}:${k.key}`, allow);
    } catch (e) { throw new ForbiddenException((e as Error).message); }
  }

  @Post('approvers')
  @HttpCode(200)
  async addApprover(@Req() req: Request, @Body() body: { credentialId?: string; flowId?: string; response?: AuthenticationResponseJSON }): Promise<{ ok: boolean }> {
    refuseAgentCaller(req, body);
    const k = this.knownCredential(body?.credentialId);
    if (!body.flowId || !body.response) throw new BadRequestException('flowId and response required');
    const by = await this.webauthn.verifyStepUp(body.flowId, body.response, `storage-approver:${k.id}:${k.key}`, this.allowed());
    if (!by) throw new ForbiddenException('passkey approval failed');
    this.approvers.add({ id: k.id, key: k.key, label: k.label }, by);
    return { ok: true };
  }

  private check(body: ApproveBody) {
    try { return this.sweeper.approval(body?.manifestId as string, body?.digest as string, body?.itemIds as string[]); }
    catch (e) { throw new BadRequestException((e as Error).message); }
  }
  /** Approver passkeys (id + key fingerprint) that exist now. None = refused: never a fallback to the token. */
  private allowed(): StepUpKey[] {
    const allow = this.approvers.allowed(this.webauthn.keys());
    if (!allow.length) throw new ForbiddenException('no passkey may approve storage cleanup: only a passkey registered before 2026-10-26, or one an approver added, can (see docs/storage-sweeper-contract.md)');
    return allow;
  }
  private knownCredential(id: unknown): { id: string; key: string; label: string } {
    const k = typeof id === 'string' ? this.webauthn.keys().find((c) => c.id === id) : undefined;
    if (!k) throw new BadRequestException('unknown passkey');
    return k;
  }
}

interface ApproveBody { manifestId?: string; digest?: string; itemIds?: string[] }

/**
 * The MCP bridge identifies its caller in the body (`from`, `self`,
 * `delegate`; see /api/conversations/steer), and a bridge-made call may carry
 * an X-X056-Caller header. Either one means an AI is asking: refused. This is
 * a backstop only; the passkey is the gate (a bare curl with the token has no
 * identity to refuse, and still cannot sign).
 */
export function refuseAgentCaller(req: Pick<Request, 'headers'>, body: unknown): void {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (['from', 'self', 'delegate'].some((k) => b[k] != null) || req.headers['x-x056-caller'] != null) {
    throw new ForbiddenException('storage approval is for the owner in the panel, not for an agent');
  }
}
