import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { SessionStore } from './webauthn.js';

export const TOKEN_KEY = Symbol('x056-token');

/** Mark a route reachable without auth (the passkey login ceremony needs this —
 *  you don't have a session yet while logging in). */
export const IS_PUBLIC = 'x056:isPublic';
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Read one cookie value out of the raw Cookie header (no cookie-parser dep). */
export function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly token: string,
    private readonly sessions: SessionStore,
    private readonly reflector: Reflector,
    /** OAuth tokens issued to approved MCP connectors (optional: unset in tests). */
    private readonly oauth?: { validAccessToken: (t: string) => boolean },
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    // 1. Bearer token or ?token= (the original mechanism; the fallback).
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const query = typeof req.query.token === 'string' ? req.query.token : '';
    const presented = bearer || query;
    if (presented && safeEqual(presented, this.token)) return true;
    // 1b. A token we issued to an MCP connector through the OAuth flow.
    if (bearer && this.oauth?.validAccessToken(bearer)) return true;
    // 2. A passkey session cookie (set after a WebAuthn login).
    const sid = readCookie(req.headers.cookie, 'x056_session');
    if (sid && this.sessions.valid(sid)) return true;
    // MCP clients discover how to authenticate from this header (RFC 9728);
    // without it Claude Desktop can't start the OAuth flow at all.
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
    ctx.switchToHttp().getResponse<{ setHeader: (k: string, v: string) => void }>()
      .setHeader('WWW-Authenticate', `Bearer resource_metadata="${proto}://${host}/.well-known/oauth-protected-resource"`);
    throw new UnauthorizedException();
  }
}
