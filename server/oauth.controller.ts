import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public, readCookie } from './auth.guard.js';
import { OAuthStore } from './oauth.js';
import type { SessionStore } from './webauthn.js';

export const OAUTH_STORE = Symbol('x056-oauth-store');
export const OAUTH_DEPS = Symbol('x056-oauth-deps');
export interface OAuthDeps { sessions: SessionStore; token: string }

/** The public origin the client reached us on — metadata must echo it exactly
 *  or the client rejects the issuer. */
function origin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? (req.secure ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? '';
  return `${proto}://${host}`;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * OAuth 2.1 for MCP clients. Claude Desktop and claude.ai connectors refuse a
 * bare token: they discover an authorization server, register themselves
 * (RFC 7591), and run authorization-code + PKCE. This provides that.
 *
 * Everything here is @Public — a browser hits /authorize with no bearer, and
 * clients hit the metadata/registration/token endpoints unauthenticated by
 * definition. The REAL gate is in /authorize: it only issues a code to a browser
 * that already holds a valid x056 panel session, so approving a connector means
 * being logged into the panel.
 */
@Controller()
export class OAuthController {
  constructor(
    @Inject(OAUTH_STORE) private readonly store: OAuthStore,
    @Inject(OAUTH_DEPS) private readonly deps: OAuthDeps,
  ) {}

  /** RFC 9728 — tells the client which authorization server guards this resource. */
  @Public()
  @Get('.well-known/oauth-protected-resource')
  protectedResource(@Req() req: Request): unknown {
    const o = origin(req);
    return { resource: `${o}/mcp`, authorization_servers: [o], bearer_methods_supported: ['header'] };
  }

  // Some clients probe the path-suffixed form for a resource at /mcp.
  @Public()
  @Get('.well-known/oauth-protected-resource/mcp')
  protectedResourceMcp(@Req() req: Request): unknown { return this.protectedResource(req); }

  /** RFC 8414 — the authorization server's own metadata. */
  @Public()
  @Get('.well-known/oauth-authorization-server')
  authServerMetadata(@Req() req: Request): unknown {
    const o = origin(req);
    return {
      issuer: o,
      authorization_endpoint: `${o}/authorize`,
      token_endpoint: `${o}/token`,
      registration_endpoint: `${o}/register`,
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'], // public client + PKCE
      code_challenge_methods_supported: ['S256'],      // PKCE is required, plain is not offered
    };
  }

  // Same metadata under the OIDC name; some clients look there first.
  @Public()
  @Get('.well-known/openid-configuration')
  openidConfig(@Req() req: Request): unknown { return this.authServerMetadata(req); }

  /** RFC 7591 dynamic client registration. Public clients only — no secret. */
  @Public()
  @Post('register')
  @HttpCode(201)
  register(@Body() body: { client_name?: string; redirect_uris?: string[] }): unknown {
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
    if (!uris.length) return { error: 'invalid_client_metadata', error_description: 'redirect_uris required' };
    const client = this.store.registerClient(body?.client_name, uris);
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };
  }

  /**
   * The consent step, in a browser. Requires an x056 panel session (or the
   * gateway token) — that IS the authorization: only the operator, already
   * logged in, can approve a connector.
   */
  @Public()
  @Get('authorize')
  authorize(@Req() req: Request, @Res() res: Response, @Query() q: Record<string, string>): void {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, resource } = q;
    const client = client_id ? this.store.getClient(client_id) : undefined;
    if (!client) { res.status(400).type('html').send(this.page('Unknown client', 'This connector is not registered. Remove it and add it again.')); return; }
    if (!redirect_uri || !client.redirect_uris.includes(redirect_uri)) {
      res.status(400).type('html').send(this.page('Bad redirect', 'The redirect URI does not match what this connector registered.'));
      return;
    }
    if (!code_challenge || code_challenge_method !== 'S256') {
      res.status(400).type('html').send(this.page('PKCE required', 'This server only accepts S256 PKCE.'));
      return;
    }
    // --- the human gate ---
    if (!this.operatorIsLoggedIn(req)) {
      res.status(401).type('html').send(this.page(
        'Log in to x056 first',
        'Open the x056 panel in this browser and sign in, then click Connect again in your MCP client.',
        `<p><a class="btn" href="/" target="_blank" rel="noopener">Open the x056 panel</a></p>`,
      ));
      return;
    }
    // Approving is an explicit click, not an automatic redirect.
    const params = new URLSearchParams({ client_id, redirect_uri, code_challenge, code_challenge_method });
    if (state) params.set('state', state);
    if (resource) params.set('resource', resource);
    res.type('html').send(this.page(
      'Connect to x056?',
      `<b>${esc(client.client_name || client.client_id)}</b> wants to read and message the conversations on this gateway.`,
      `<form method="POST" action="/authorize/approve">
         ${[...params.entries()].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}
         <button class="btn" type="submit">Approve</button>
       </form>
       <p class="muted">Sending a message still needs your approval in the panel each time.</p>`,
    ));
  }

  /** The approve button posts here; issue the code and bounce back to the client. */
  @Public()
  @Post('authorize/approve')
  approve(@Req() req: Request, @Res() res: Response): void {
    const b = (req.body ?? {}) as Record<string, string>;
    const client = b.client_id ? this.store.getClient(b.client_id) : undefined;
    if (!client || !b.redirect_uri || !client.redirect_uris.includes(b.redirect_uri) || b.code_challenge_method !== 'S256' || !b.code_challenge) {
      res.status(400).type('html').send(this.page('Invalid request', 'Start the connection again from your MCP client.'));
      return;
    }
    if (!this.operatorIsLoggedIn(req)) { res.status(401).type('html').send(this.page('Session expired', 'Sign in to the x056 panel and try again.')); return; }
    const code = this.store.issueCode(b.client_id, b.redirect_uri, b.code_challenge, b.resource);
    const url = new URL(b.redirect_uri);
    url.searchParams.set('code', code);
    if (b.state) url.searchParams.set('state', b.state);
    res.redirect(302, url.toString());
  }

  /** Authorization-code (with PKCE) and refresh_token grants. */
  @Public()
  @Post('token')
  @HttpCode(200)
  token(@Body() body: Record<string, string>, @Res() res: Response): void {
    const b = body ?? {};
    if (b.grant_type === 'refresh_token') {
      const out = b.refresh_token && b.client_id ? this.store.refresh(b.refresh_token, b.client_id) : null;
      if (!out) { res.status(400).json({ error: 'invalid_grant' }); return; }
      res.json({ token_type: 'Bearer', scope: 'mcp', ...out });
      return;
    }
    if (b.grant_type !== 'authorization_code') { res.status(400).json({ error: 'unsupported_grant_type' }); return; }
    if (!b.code || !b.client_id || !b.redirect_uri || !b.code_verifier) { res.status(400).json({ error: 'invalid_request' }); return; }
    const out = this.store.redeemCode(b.code, b.client_id, b.redirect_uri, b.code_verifier);
    if (!out) { res.status(400).json({ error: 'invalid_grant' }); return; }
    res.json({ token_type: 'Bearer', scope: 'mcp', ...out });
  }

  /** A panel session cookie, or the gateway token, proves it's the operator. */
  private operatorIsLoggedIn(req: Request): boolean {
    const sid = readCookie(req.headers.cookie, 'x056_session');
    if (sid && this.deps.sessions.valid(sid)) return true;
    const q = typeof req.query.token === 'string' ? req.query.token : '';
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const presented = bearer || q || (req.body as Record<string, string> | undefined)?.token;
    return !!presented && presented === this.deps.token;
  }

  private page(title: string, body: string, extra = ''): string {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · x056</title>
<style>
 body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#faf9f7;color:#1a1a19;
      display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
 .card{background:#fff;border:1px solid #e5e2dc;border-radius:14px;padding:28px;max-width:420px;width:100%;
       box-shadow:0 8px 30px rgba(0,0,0,.06)}
 h1{font-size:17px;margin:0 0 10px} p{margin:0 0 14px} .muted{color:#6b6862;font-size:13px}
 .btn{display:inline-block;background:#c96442;color:#fff;border:none;border-radius:9px;padding:10px 18px;
      font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
</style>
<div class="card"><h1>${esc(title)}</h1><p>${body}</p>${extra}</div>`;
  }
}
