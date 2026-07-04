import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

export const TOKEN_KEY = Symbol('x056-token');

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly token: string) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const query = typeof req.query.token === 'string' ? req.query.token : '';
    const presented = bearer || query;
    if (!presented || !safeEqual(presented, this.token)) throw new UnauthorizedException();
    return true;
  }
}
