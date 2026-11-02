import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';

/**
 * How a request authenticated, recorded by `AuthGuard` on the request object.
 * `oauth` names the connector the access token was issued to.
 */
export type X056Auth =
  | { kind: 'token' }
  | { kind: 'oauth'; clientId: string }
  | { kind: 'passkey' };

export type AuthedRequest = Request & { x056Auth?: X056Auth };

/**
 * The HTTP MCP endpoint (`/mcp`) runs the tool module in-process and calls the
 * REST API back over loopback with the gateway token, so the downstream route
 * would only ever see "token". These two headers carry the ORIGINAL /mcp
 * caller's credential across that hop. The via header is trusted only together
 * with this secret, which is generated per process and never leaves it (the
 * stdio bridges are other processes and never see it), so an outside caller
 * cannot claim to be "/mcp via OAuth client X".
 */
export const MCP_VIA_HEADER = 'x-x056-mcp-via';
export const MCP_VIA_SECRET_HEADER = 'x-x056-mcp-secret';
const MCP_VIA_SECRET = randomBytes(32).toString('hex');

const sha = (s: string) => createHash('sha256').update(s).digest();

/** Headers for a loopback call made on behalf of an /mcp request. Only the
 *  client id travels (ASCII, ours); the connector's chosen name is
 *  attacker-chosen at registration and is resolved server-side. */
export function mcpViaHeaders(auth: X056Auth | undefined): Record<string, string> {
  if (!auth) return {};
  const via = auth.kind === 'oauth' ? `oauth:${auth.clientId}` : auth.kind;
  return { [MCP_VIA_HEADER]: via, [MCP_VIA_SECRET_HEADER]: MCP_VIA_SECRET };
}

/** The /mcp caller's credential when this request carries a valid via pair,
 *  else undefined (missing or wrong secret = not trusted at all). */
export function trustedMcpVia(req: Pick<Request, 'headers'>): X056Auth | undefined {
  const secret = req.headers[MCP_VIA_SECRET_HEADER];
  const via = req.headers[MCP_VIA_HEADER];
  if (typeof secret !== 'string' || typeof via !== 'string') return undefined;
  if (!timingSafeEqual(sha(secret), sha(MCP_VIA_SECRET))) return undefined;
  if (via === 'token' || via === 'passkey') return { kind: via };
  const m = /^oauth:([A-Za-z0-9._-]{1,120})$/.exec(via);
  return m ? { kind: 'oauth', clientId: m[1] } : undefined;
}
