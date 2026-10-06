import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from './auth.guard.js';
import { McpOAuth, OAuthFlowError, serverLabel } from './mcp-oauth.js';

export const MCP_OAUTH = Symbol('x056-mcp-oauth');

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function reqAddress(req: Request): { proto?: string; host?: string } {
  return {
    proto: (req.headers['x-forwarded-proto'] as string | undefined) ?? (req.secure ? 'https' : 'http'),
    host: (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host,
  };
}

/** The page the browser lands on after the server's login. Self-contained,
 *  no secrets; tells an opener tab (same origin) and offers a way back. */
export function callbackPage(ok: boolean, name: string, message: string): string {
  const title = ok ? `Signed in to ${serverLabel(name)}` : 'Sign-in did not finish';
  const payload = JSON.stringify({ type: 'x056-mcp-oauth', ok, name }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,-apple-system,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}
main{max-width:420px;padding:28px 24px;text-align:center}h1{font-size:19px;margin:0 0 8px}p{margin:0 0 18px;opacity:.75}
a{display:inline-block;padding:9px 16px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 25%,transparent);color:inherit;text-decoration:none}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/?mcp=servers">Back to x056</a></main>
<script>(function(){var m=${payload};try{if(window.opener&&!window.opener.closed){window.opener.postMessage(m,location.origin);${ok ? 'setTimeout(function(){window.close();},1200);' : ''}}}catch(e){}})();</script>
</body></html>`;
}

/**
 * Sign in to an OAuth MCP server from the panel. start/signout need the panel
 * token like every other route; the callback cannot (the browser arrives from
 * the server's login page without it), so it alone is @Public and trusts
 * nothing but a single-use, 10-minute `state` it issued itself.
 */
@Controller('api/mcp/oauth')
export class McpOAuthController {
  constructor(@Inject(MCP_OAUTH) private readonly oauth: McpOAuth) {}

  @Post('start')
  @HttpCode(200)
  async start(@Body() body: { name?: string }, @Req() req: Request) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name required');
    try { return await this.oauth.begin(name, reqAddress(req)); }
    catch (e) { throw new BadRequestException((e as Error).message); }
  }

  /** Cheap status for one server (no CLI, no network wait): the panel polls
   *  it while a sign-in tab is open. */
  @Get('status')
  status(@Query('name') name?: string) {
    const st = name ? this.oauth.statusByName(String(name)) : null;
    if (!st) throw new BadRequestException('no http MCP server by that name');
    return st;
  }

  @Post('signout')
  @HttpCode(200)
  async signout(@Body() body: { name?: string }) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name required');
    const r = await this.oauth.signOut(name);
    return { ok: r.ok, accounts: r.accounts.map((a) => ({ provider: a.provider, account: a.account, ok: a.ok })) };
  }

  @Public()
  @Get('callback')
  async callback(@Query() q: Record<string, unknown>, @Res() res: Response) {
    const s = (k: string) => (typeof q[k] === 'string' ? q[k] as string : undefined);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      const { name } = await this.oauth.complete({ code: s('code'), state: s('state'), iss: s('iss'), error: s('error'), error_description: s('error_description') });
      res.status(200).type('html').send(callbackPage(true, name, 'x056 keeps it signed in on every account. You can close this tab.'));
    } catch (e) {
      const msg = e instanceof OAuthFlowError ? e.message : 'The sign-in could not be completed.';
      if (!(e instanceof OAuthFlowError)) console.warn('[mcp-oauth] callback failed:', (e as Error).message);
      res.status(400).type('html').send(callbackPage(false, '', msg));
    }
  }
}
