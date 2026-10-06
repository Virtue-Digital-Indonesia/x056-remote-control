import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gatewayDb, GATEWAY_DB } from './gateway-db.js';
import type { HeaderApplyResult } from './mcp-servers.js';

/**
 * Sign in to an http MCP server that uses OAuth, ONCE, from the panel, and keep
 * every account of both providers signed in.
 *
 * Flow: discovery (RFC 9728 protected-resource metadata -> RFC 8414
 * authorization-server metadata, with the 401's WWW-Authenticate hints and
 * the origin's own well-known as fallbacks), dynamic client registration
 * (RFC 7591) once per (server, issuer, redirect_uri), authorization code +
 * PKCE S256, `resource` (RFC 8707) on every request. The access token is
 * written as `Authorization: Bearer …` into each account's config files
 * (McpServerManager.setHttpHeaders, no CLI); a refresher renews it 20 minutes
 * before it expires and writes it again.
 *
 * Tokens live in gateway.sqlite (`mcp_oauth`) and nowhere else on the gateway
 * side; status() is the only thing any API returns, and it carries none.
 */

export interface OAuthAsMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
}

export interface Discovery {
  /** The protected resource's own identifier (RFC 8707 `resource`). */
  resource?: string;
  as: OAuthAsMeta;
  scope?: string;
  /** Why the gateway cannot run the flow against it (no DCR, no S256...). */
  unsupported?: string;
}

export interface McpOAuthStatus {
  /** null = not known yet (discovery still running or never finished). */
  supported: boolean | null;
  signedIn: boolean;
  expiresAt: number | null;
  lastRefreshAt: number | null;
  /** 'signin_required' (the panel says "Sign in again"), or a short reason. */
  error: string | null;
}

export interface McpOAuthServers {
  findHttpServer(name: string): { name: string; url: string } | undefined;
  setHttpHeaders(name: string, mutate: (h: Record<string, string>) => Record<string, string>): Promise<HeaderApplyResult[]>;
}

export interface McpOAuthOptions {
  stateDir: string;
  servers: McpOAuthServers;
  /** X056_PUBLIC_URL: the gateway's public origin. Else from the request. */
  publicUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** Once per transition into signin_required. */
  onSigninRequired?: (name: string) => void;
  /** After new headers were written to the accounts. */
  onApplied?: (name: string) => void;
  refreshAheadMs?: number;
  tickMs?: number;
  requestTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class OAuthFlowError extends Error {}

interface Pending {
  name: string;
  /** Sign-in applies to every account of both providers. */
  scope: 'all';
  verifier: string;
  redirectUri: string;
  issuer: string;
  issRequired: boolean;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string | null;
  authMethod: string;
  resource?: string;
  oauthScope?: string;
  expiresAt: number;
}

interface Row {
  name: string; issuer: string; token_endpoint: string; client_id: string; client_secret: string | null; auth_method: string;
  redirect_uri: string; resource: string | null; scope: string | null; access_token: string | null; refresh_token: string | null;
  expires_at: number | null; signed_in_at: number; last_refresh_at: number | null; applied_hash: string | null; apply_error: string | null;
  error: string | null; failures: number; next_attempt_at: number | null;
}

export const STATE_TTL_MS = 10 * 60_000;
export const REFRESH_AHEAD_MS = 20 * 60_000;
const DISCOVERY_OK_TTL = 60 * 60_000;
const DISCOVERY_FAIL_TTL = 10 * 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
export const SIGNIN_REQUIRED = 'signin_required';

const b64url = (b: Buffer) => b.toString('base64url');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** `Bearer realm="mcp", error="invalid_token", authorization_server="…"` -> params. */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const re = /([A-Za-z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  for (let m; (m = re.exec(header));) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

/** The metadata URLs to try for an issuer, path-aware (RFC 8414 §3.1). */
export function asMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  if (!path) return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  return [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`];
}

export function prmUrls(resourceUrl: string): string[] {
  const u = new URL(resourceUrl);
  const path = u.pathname.replace(/\/+$/, '');
  return [...(path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : []), `${u.origin}/.well-known/oauth-protected-resource`];
}

/** Whether the gateway can run the flow against this AS; a reason if not. */
export function unsupportedReason(as: OAuthAsMeta): string | undefined {
  if (!as.authorization_endpoint || !as.token_endpoint) return 'no authorization or token endpoint';
  if (!as.registration_endpoint) return 'no dynamic client registration';
  if (as.code_challenge_methods_supported && !as.code_challenge_methods_supported.includes('S256')) return 'no PKCE S256';
  return undefined;
}

/** The redirect URI the gateway registers and sends: always the same string
 *  for one origin. Plain http only for a loopback host (tests, a laptop). */
export function callbackUrl(publicUrl: string | undefined, req?: { proto?: string; host?: string }): string {
  let base = (publicUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    const host = (req?.host ?? '').split(',')[0].trim();
    if (!host) throw new OAuthFlowError('cannot tell the gateway\'s public address; set X056_PUBLIC_URL');
    const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);
    const proto = (req?.proto ?? '').split(',')[0].trim().toLowerCase();
    base = `${loopback && proto === 'http' ? 'http' : 'https'}://${host}`;
  }
  return `${base}/api/mcp/oauth/callback`;
}

export class McpOAuth {
  private readonly pending = new Map<string, Pending>();
  private readonly discovered = new Map<string, { at: number; result: Discovery | null; error?: string }>();
  private readonly discovering = new Map<string, Promise<Discovery | null>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: McpOAuthOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private db() { return gatewayDb(this.opts.stateDir); }
  private log(msg: string) { (this.opts.log ?? ((m) => console.log(m)))(`[mcp-oauth] ${msg}`); }

  /** The database now holds bearer tokens: owner-only, like state/secrets. */
  private lockDown(): void {
    for (const f of [GATEWAY_DB, `${GATEWAY_DB}-wal`, `${GATEWAY_DB}-shm`]) {
      const p = join(this.opts.stateDir, f);
      try { if (existsSync(p)) chmodSync(p, 0o600); } catch { /* best effort */ }
    }
  }

  start(): void {
    if (this.timer) return;
    // At boot: anything expired or close to it is refreshed now.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 60_000);
    this.timer.unref?.();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  callbackUrl(req?: { proto?: string; host?: string }): string { return callbackUrl(this.opts.publicUrl, req); }

  // ---- discovery ----------------------------------------------------------

  private async getJson(url: string, init?: RequestInit): Promise<{ status: number; json: unknown; headers: Headers }> {
    const r = await this.fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 6000) });
    let json: unknown = null;
    try { json = await r.json(); } catch { /* not JSON */ }
    return { status: r.status, json, headers: r.headers };
  }

  private async tryJson(url: string): Promise<Record<string, unknown> | null> {
    try {
      const r = await this.getJson(url, { headers: { accept: 'application/json' } });
      return r.status === 200 && r.json && typeof r.json === 'object' ? r.json as Record<string, unknown> : null;
    } catch { return null; }
  }

  /** Fresh discovery, no cache. Null = this server does not speak OAuth. */
  async discoverNow(url: string): Promise<Discovery | null> {
    // 1. What the server says when called without a token.
    let hints: Record<string, string> = {};
    try {
      const r = await this.fetch(url, {
        method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(this.opts.requestTimeoutMs ?? 6000),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x056-discovery', version: '1' } } }),
      });
      if (r.status === 401) hints = parseWwwAuthenticate(r.headers.get('www-authenticate'));
      try { await r.body?.cancel(); } catch { /* ignore */ }
    } catch { /* unreachable now; the well-knowns may still answer */ }

    // 2. Protected-resource metadata: the hint first, then the well-knowns.
    let prm: Record<string, unknown> | null = null;
    for (const u of [...(hints.resource_metadata ? [hints.resource_metadata] : []), ...prmUrls(url)]) {
      prm = await this.tryJson(u);
      if (prm && Array.isArray(prm.authorization_servers)) break;
      prm = null;
    }

    // 3. Authorization-server metadata.
    const candidates: string[] = [];
    for (const issuer of (prm?.authorization_servers as string[] | undefined) ?? []) {
      try { candidates.push(...asMetadataUrls(issuer)); } catch { /* bad url */ }
    }
    if (hints.authorization_server) {
      const h = hints.authorization_server;
      if (h.includes('/.well-known/')) candidates.push(h);
      else try { candidates.push(...asMetadataUrls(h)); } catch { /* bad url */ }
    }
    candidates.push(`${new URL(url).origin}/.well-known/oauth-authorization-server`);
    let as: OAuthAsMeta | null = null;
    for (const u of [...new Set(candidates)]) {
      const j = await this.tryJson(u);
      if (j && typeof j.issuer === 'string' && typeof j.authorization_endpoint === 'string' && typeof j.token_endpoint === 'string') { as = j as unknown as OAuthAsMeta; break; }
    }
    if (!as) return null;
    const scopes = (prm?.scopes_supported as string[] | undefined) ?? (hints.scope ? hints.scope.split(/\s+/) : undefined) ?? as.scopes_supported;
    return {
      resource: typeof prm?.resource === 'string' ? prm.resource : undefined,
      as,
      scope: scopes?.length ? scopes.join(' ') : undefined,
      unsupported: unsupportedReason(as),
    };
  }

  /** Cached discovery; concurrent callers share one run. */
  discover(url: string, force = false): Promise<Discovery | null> {
    const hit = this.discovered.get(url);
    if (!force && hit && this.now() - hit.at < (hit.result ? DISCOVERY_OK_TTL : DISCOVERY_FAIL_TTL)) return Promise.resolve(hit.result);
    const running = this.discovering.get(url);
    if (running) return running;
    const p = this.discoverNow(url)
      .then((result) => { this.discovered.set(url, { at: this.now(), result }); return result; })
      .catch((e) => { this.discovered.set(url, { at: this.now(), result: null, error: (e as Error).message }); return null; })
      .finally(() => this.discovering.delete(url));
    this.discovering.set(url, p);
    return p;
  }

  /** Never waits on the network: unknown until a background discovery lands. */
  supported(url: string): boolean | null {
    const hit = this.discovered.get(url);
    if (!hit || this.now() - hit.at >= (hit.result ? DISCOVERY_OK_TTL : DISCOVERY_FAIL_TTL)) void this.discover(url);
    if (!hit) return null;
    return !!hit.result && !hit.result.unsupported;
  }

  private row(name: string): Row | undefined {
    return this.db().prepare('SELECT * FROM mcp_oauth WHERE name=?').get(name) as Row | undefined;
  }

  /** What the panel sees. Never a token. */
  status(name: string, url: string): McpOAuthStatus {
    const r = this.row(name);
    const supported = r ? true : this.supported(url);
    if (!r) return { supported, signedIn: false, expiresAt: null, lastRefreshAt: null, error: null };
    const signedIn = !!r.access_token && r.error !== SIGNIN_REQUIRED && (r.expires_at ?? Infinity) > this.now();
    return {
      supported,
      signedIn,
      expiresAt: r.expires_at ?? null,
      lastRefreshAt: r.last_refresh_at ?? null,
      error: r.error ?? r.apply_error ?? (signedIn ? null : 'expired'),
    };
  }

  /** Status by name alone (the panel polls this while a sign-in is open). */
  statusByName(name: string): McpOAuthStatus | null {
    const server = this.opts.servers.findHttpServer(name);
    return server ? this.status(name, server.url) : null;
  }

  // ---- sign-in ------------------------------------------------------------

  private async client(name: string, as: OAuthAsMeta, redirectUri: string): Promise<{ clientId: string; clientSecret: string | null; authMethod: string }> {
    const db = this.db();
    const hit = db.prepare('SELECT client_id, client_secret, auth_method FROM mcp_oauth_clients WHERE name=? AND issuer=? AND redirect_uri=?')
      .get(name, as.issuer, redirectUri) as { client_id: string; client_secret: string | null; auth_method: string } | undefined;
    if (hit) return { clientId: hit.client_id, clientSecret: hit.client_secret, authMethod: hit.auth_method };
    const methods = as.token_endpoint_auth_methods_supported;
    const wanted = !methods || methods.includes('none') ? 'none' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
    const r = await this.getJson(as.registration_endpoint!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'x056 gateway',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: wanted,
      }),
    });
    const j = (r.json ?? {}) as { client_id?: string; client_secret?: string; token_endpoint_auth_method?: string; error_description?: string; error?: string };
    if (r.status >= 300 || !j.client_id) throw new OAuthFlowError(`client registration failed (${r.status}${j.error ? ': ' + (j.error_description || j.error) : ''})`);
    const authMethod = j.token_endpoint_auth_method || (j.client_secret ? (wanted === 'none' ? 'client_secret_post' : wanted) : 'none');
    db.prepare('INSERT OR REPLACE INTO mcp_oauth_clients(name, issuer, redirect_uri, client_id, client_secret, auth_method, created_at) VALUES(?,?,?,?,?,?,?)')
      .run(name, as.issuer, redirectUri, j.client_id, j.client_secret ?? null, authMethod, this.now());
    this.lockDown();
    return { clientId: j.client_id, clientSecret: j.client_secret ?? null, authMethod };
  }

  /** Begin a sign-in: returns the URL to open in the browser. */
  async begin(name: string, req?: { proto?: string; host?: string }): Promise<{ authorizeUrl: string }> {
    const server = this.opts.servers.findHttpServer(name);
    if (!server) throw new OAuthFlowError(`no http MCP server named ${name}`);
    const disc = await this.discover(server.url, true);
    if (!disc) throw new OAuthFlowError(`${name} does not publish OAuth metadata`);
    if (disc.unsupported) throw new OAuthFlowError(`${name}: ${disc.unsupported}`);
    const redirectUri = this.callbackUrl(req);
    const c = await this.client(name, disc.as, redirectUri);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(24));
    const now = this.now();
    for (const [k, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(k);
    this.pending.set(state, {
      name, scope: 'all', verifier, redirectUri, issuer: disc.as.issuer,
      issRequired: disc.as.authorization_response_iss_parameter_supported === true,
      tokenEndpoint: disc.as.token_endpoint, clientId: c.clientId, clientSecret: c.clientSecret, authMethod: c.authMethod,
      resource: disc.resource, oauthScope: disc.scope, expiresAt: now + STATE_TTL_MS,
    });
    const u = new URL(disc.as.authorization_endpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', c.clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('code_challenge', b64url(createHash('sha256').update(verifier).digest()));
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('state', state);
    if (disc.scope) u.searchParams.set('scope', disc.scope);
    if (disc.resource) u.searchParams.set('resource', disc.resource);
    return { authorizeUrl: u.toString() };
  }

  private async tokenRequest(endpoint: string, c: { clientId: string; clientSecret: string | null; authMethod: string }, params: Record<string, string | undefined>) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (c.authMethod === 'client_secret_basic' && c.clientSecret) {
      headers.authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret)}`).toString('base64');
    } else {
      body.set('client_id', c.clientId);
      if (c.authMethod === 'client_secret_post' && c.clientSecret) body.set('client_secret', c.clientSecret);
    }
    const r = await this.getJson(endpoint, { method: 'POST', headers, body: body.toString() });
    return { status: r.status, json: (r.json ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number | string; scope?: string; error?: string; error_description?: string } };
  }

  private expiry(tok: { access_token?: string; expires_in?: number | string }): number {
    const n = Number(tok.expires_in);
    if (Number.isFinite(n) && n > 0) return this.now() + n * 1000;
    // No expires_in: a JWT carries its own exp; otherwise assume an hour.
    try {
      const exp = JSON.parse(Buffer.from(String(tok.access_token).split('.')[1], 'base64url').toString()).exp;
      if (typeof exp === 'number') return exp * 1000;
    } catch { /* opaque token */ }
    return this.now() + 60 * 60_000;
  }

  /** The browser came back. Validates the state strictly; single use. */
  async complete(q: { code?: string; state?: string; iss?: string; error?: string; error_description?: string }): Promise<{ name: string }> {
    const p = q.state ? this.pending.get(q.state) : undefined;
    if (!p) throw new OAuthFlowError('This sign-in link is unknown or was already used. Start again from the panel.');
    this.pending.delete(q.state!);
    if (p.expiresAt <= this.now()) throw new OAuthFlowError('This sign-in link expired. Start again from the panel.');
    if (q.error) throw new OAuthFlowError(`The server refused the sign-in: ${String(q.error_description || q.error).slice(0, 200)}`);
    if (q.iss !== undefined ? q.iss !== p.issuer : p.issRequired) throw new OAuthFlowError('The sign-in came back from a different issuer than it went to.');
    if (!q.code) throw new OAuthFlowError('The sign-in came back without a code.');
    const t = await this.tokenRequest(p.tokenEndpoint, p, {
      grant_type: 'authorization_code', code: q.code, redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: p.resource,
    });
    if (t.status >= 300 || !t.json.access_token) throw new OAuthFlowError(`Token exchange failed (${t.status}${t.json.error ? ': ' + String(t.json.error_description || t.json.error).slice(0, 160) : ''})`);
    const now = this.now();
    this.db().prepare(`INSERT OR REPLACE INTO mcp_oauth(name, issuer, token_endpoint, client_id, client_secret, auth_method, redirect_uri, resource, scope,
        access_token, refresh_token, expires_at, signed_in_at, last_refresh_at, applied_hash, apply_error, error, failures, next_attempt_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,NULL,0,NULL)`).run(
      p.name, p.issuer, p.tokenEndpoint, p.clientId, p.clientSecret, p.authMethod, p.redirectUri, p.resource ?? null, t.json.scope ?? p.oauthScope ?? null,
      t.json.access_token, t.json.refresh_token ?? null, this.expiry(t.json), now);
    this.lockDown();
    this.log(`${p.name}: signed in`);
    await this.serial(p.name, () => this.apply(p.name));
    return { name: p.name };
  }

  /** Remove the sign-in and the Authorization header it put on the accounts.
   *  The client registration is kept, so signing in again skips DCR. */
  async signOut(name: string): Promise<{ ok: boolean; accounts: HeaderApplyResult[] }> {
    return this.serial(name, async () => {
      this.db().prepare('DELETE FROM mcp_oauth WHERE name=?').run(name);
      const accounts = await this.opts.servers.setHttpHeaders(name, (h) => dropKeys(h, ['authorization']));
      this.opts.onApplied?.(name);
      return { ok: accounts.every((a) => a.ok), accounts };
    });
  }

  // ---- applying + refreshing ---------------------------------------------

  /** One operation per server at a time: a tick, a sign-in and a sign-out
   *  never interleave their token writes. */
  private serial<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    this.locks.set(name, settled);
    void settled.then(() => { if (this.locks.get(name) === settled) this.locks.delete(name); });
    return next;
  }

  /** Write the current access token into every account that has the server.
   *  A stale `X-MCP-Session` (the manual fallback) goes with it. */
  private async apply(name: string): Promise<HeaderApplyResult[]> {
    const r = this.row(name);
    if (!r?.access_token) return [];
    const bearer = `Bearer ${r.access_token}`;
    const res = await this.opts.servers.setHttpHeaders(name, (h) => ({ ...dropKeys(h, ['authorization', 'x-mcp-session']), Authorization: bearer }));
    const failed = res.filter((a) => !a.ok);
    const applyError = !res.length ? 'not installed on any account' : failed.length ? `could not update ${failed.map((a) => a.account).join(', ')}` : null;
    // Compare-and-set on the token: a refresh that landed meanwhile is not
    // marked applied by this older write.
    this.db().prepare('UPDATE mcp_oauth SET applied_hash=?, apply_error=? WHERE name=? AND access_token=?')
      .run(applyError ? null : sha(r.access_token), applyError, name, r.access_token);
    if (res.some((a) => a.changed)) this.opts.onApplied?.(name);
    return res;
  }

  private markSigninRequired(name: string, why: string): void {
    const r = this.row(name);
    if (!r || r.error === SIGNIN_REQUIRED) return;
    this.db().prepare('UPDATE mcp_oauth SET error=?, next_attempt_at=NULL WHERE name=?').run(SIGNIN_REQUIRED, name);
    this.log(`${name}: sign-in required (${why})`);
    try { this.opts.onSigninRequired?.(name); } catch { /* a notice must not break the refresher */ }
  }

  /** Refresh now (if the row allows it). */
  refresh(name: string): Promise<void> { return this.serial(name, () => this.refreshLocked(name)); }

  private async refreshLocked(name: string): Promise<void> {
    const r = this.row(name);
    if (!r || r.error === SIGNIN_REQUIRED) return;
    if (!r.refresh_token) {
      if ((r.expires_at ?? 0) <= this.now()) this.markSigninRequired(name, 'access token expired and there is no refresh token');
      return;
    }
    let t: Awaited<ReturnType<McpOAuth['tokenRequest']>>;
    try {
      t = await this.tokenRequest(r.token_endpoint, { clientId: r.client_id, clientSecret: r.client_secret, authMethod: r.auth_method }, {
        grant_type: 'refresh_token', refresh_token: r.refresh_token, resource: r.resource ?? undefined,
      });
    } catch (e) {
      return this.backoff(r, `refresh failed: ${(e as Error).message}`);
    }
    if (t.json.error === 'invalid_grant' || (t.status >= 400 && t.status < 500 && t.json.error === 'invalid_client')) {
      return this.markSigninRequired(name, t.json.error);
    }
    if (t.status >= 300 || !t.json.access_token) return this.backoff(r, `refresh failed (${t.status}${t.json.error ? ': ' + t.json.error : ''})`);
    // Rotation: the new refresh token is written in the same statement as the
    // access token, before anything is applied, so a crash in between cannot
    // leave the gateway holding a refresh token the server already retired.
    this.db().prepare(`UPDATE mcp_oauth SET access_token=?, refresh_token=?, expires_at=?, scope=coalesce(?, scope), last_refresh_at=?,
        error=NULL, failures=0, next_attempt_at=NULL WHERE name=?`)
      .run(t.json.access_token, t.json.refresh_token ?? r.refresh_token, this.expiry(t.json), t.json.scope ?? null, this.now(), name);
    this.lockDown();
    await this.apply(name);
  }

  private backoff(r: Row, why: string): void {
    const failures = r.failures + 1;
    const wait = Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** (failures - 1));
    this.db().prepare('UPDATE mcp_oauth SET error=?, failures=?, next_attempt_at=? WHERE name=?').run(why.slice(0, 200), failures, this.now() + wait, r.name);
    this.log(`${r.name}: ${why}; retry in ${Math.round(wait / 1000)} s`);
    // Expired while failing: keep retrying (a network blip must not sign it
    // out), but the panel already shows it as not signed in.
  }

  /** One pass of the refresher. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const rows = this.db().prepare('SELECT * FROM mcp_oauth').all() as unknown as Row[];
      for (const r of rows) {
        if (r.error === SIGNIN_REQUIRED) continue;
        const now = this.now();
        const due = (r.expires_at ?? 0) - now < (this.opts.refreshAheadMs ?? REFRESH_AHEAD_MS);
        try {
          if (due && (r.next_attempt_at ?? 0) <= now) await this.refresh(r.name);
          else if (r.access_token && r.applied_hash !== sha(r.access_token) && (r.expires_at ?? Infinity) > now) await this.serial(r.name, () => this.apply(r.name).then(() => undefined));
        } catch (e) { this.log(`${r.name}: ${(e as Error).message}`); }
      }
    } catch (e) {
      this.log(`tick failed: ${(e as Error).message}`);
    } finally { this.ticking = false; }
  }
}

function dropKeys(h: Record<string, string>, lower: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(h).filter(([k]) => !lower.includes(k.toLowerCase())));
}

/** "carbon-mcp" -> "Carbon MCP". */
export function serverLabel(name: string): string {
  return name.split(/[-_.\s]+/).filter(Boolean)
    .map((w) => (/^(mcp|api|ai|ui)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(' ') || name;
}
