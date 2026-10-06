import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpOAuth, parseWwwAuthenticate, callbackUrl, serverLabel, SIGNIN_REQUIRED, type McpOAuthServers } from '../server/mcp-oauth.js';
import { McpServerManager, type HeaderApplyResult } from '../server/mcp-servers.js';
import { closeAllGatewayDbs } from '../server/gateway-db.js';
import { noticeFor } from '../server/notices.js';
import { AccountRegistry } from '../src/accounts.js';
import { createApp } from '../server/main.js';

// ---- a local fake: MCP resource + authorization server in one process ----
interface Fake {
  base: string;
  registrations: Record<string, unknown>[];
  authorizeQueries: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  /** Next refresh answers this instead of rotating. */
  refreshMode: 'rotate' | 'invalid_grant' | 'error500';
  issuerOverride?: string;
  noPrm?: boolean;
  noIssInMeta?: boolean;
  close(): Promise<void>;
}
const ACCESS_PREFIX = 'AT-SECRET-';
const REFRESH_PREFIX = 'RT-SECRET-';

async function fakeOAuth(): Promise<Fake> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let n = 0;
  let currentRefresh = '';
  const fake = { registrations: [], authorizeQueries: [], tokenRequests: [], refreshMode: 'rotate' } as unknown as Fake;
  const body = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (res: ServerResponse, status: number, o: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o));
  };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url!, fake.base);
    const base = fake.base;
    if (req.method === 'POST' && u.pathname === '/mcp') {
      return json(res, 401, { error: 'unauthorized' }, {
        'www-authenticate': fake.noPrm
          ? `Bearer realm="mcp", error="invalid_token", authorization_server="${base}/.well-known/oauth-authorization-server", scope="openid email"`
          : `Bearer realm="mcp", resource_metadata="${base}/.well-known/oauth-protected-resource", scope="openid email"`,
      });
    }
    if (u.pathname === '/.well-known/oauth-protected-resource') {
      if (fake.noPrm) return json(res, 404, {});
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['openid', 'email', 'profile'] });
    }
    if (u.pathname === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`,
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        ...(fake.noIssInMeta ? {} : { authorization_response_iss_parameter_supported: true }),
      });
    }
    if (u.pathname === '/register') {
      const b = JSON.parse(await body(req)); fake.registrations.push(b);
      return json(res, 201, { client_id: `cid-${fake.registrations.length}`, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    if (u.pathname === '/authorize') {
      fake.authorizeQueries.push(u.searchParams);
      const code = `code-${++n}`;
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirect: u.searchParams.get('redirect_uri')! });
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code); back.searchParams.set('state', u.searchParams.get('state')!);
      back.searchParams.set('iss', fake.issuerOverride ?? base);
      res.writeHead(302, { location: back.toString() }); return res.end();
    }
    if (u.pathname === '/token') {
      const p = new URLSearchParams(await body(req)); fake.tokenRequests.push(p);
      if (p.get('grant_type') === 'authorization_code') {
        const c = codes.get(p.get('code')!); codes.delete(p.get('code')!);
        const ok = c && c.redirect === p.get('redirect_uri')
          && createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === c.challenge;
        if (!ok) return json(res, 400, { error: 'invalid_grant' });
        currentRefresh = `${REFRESH_PREFIX}${++n}`;
        return json(res, 200, { access_token: `${ACCESS_PREFIX}${n}`, refresh_token: currentRefresh, expires_in: 7200, token_type: 'Bearer' });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (fake.refreshMode === 'error500') return json(res, 500, { error: 'server_error' });
        if (fake.refreshMode === 'invalid_grant' || p.get('refresh_token') !== currentRefresh) return json(res, 400, { error: 'invalid_grant' });
        currentRefresh = `${REFRESH_PREFIX}${++n}`;
        return json(res, 200, { access_token: `${ACCESS_PREFIX}${n}`, refresh_token: currentRefresh, expires_in: 7200 });
      }
    }
    json(res, 404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  fake.base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  return fake;
}

/** Accounts of both providers, in memory. */
function fakeServers(url: string): McpOAuthServers & { accounts: Record<string, Record<string, string>> } {
  const accounts: Record<string, Record<string, string>> = {
    'claude/b': { Authorization: 'Bearer manual-token', 'X-MCP-Session': 'sess-1', 'X-Keep': 'keep' },
    'claude/f': { Authorization: 'Bearer manual-token', 'X-MCP-Session': 'sess-1' },
    'codex/e': { 'x-mcp-session': 'sess-1' },
    'codex/g': {},
  };
  return {
    accounts,
    findHttpServer: (name) => (name === 'carbon' ? { name, url } : undefined),
    async setHttpHeaders(name, mutate) {
      if (name !== 'carbon') return [];
      return Object.keys(accounts).map((k): HeaderApplyResult => {
        const next = mutate({ ...accounts[k] });
        const changed = JSON.stringify(next) !== JSON.stringify(accounts[k]);
        accounts[k] = next;
        const [provider, account] = k.split('/');
        return { provider: provider as 'claude' | 'codex', account, ok: true, changed };
      });
    },
  };
}

let fake: Fake;
beforeAll(async () => { fake = await fakeOAuth(); });
afterAll(async () => { await fake.close(); });
afterEach(() => { closeAllGatewayDbs(); fake.refreshMode = 'rotate'; fake.issuerOverride = undefined; fake.noPrm = false; fake.noIssInMeta = false; });

function setup(over: Partial<ConstructorParameters<typeof McpOAuth>[0]> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'x056-mcpoauth-'));
  const servers = fakeServers(`${fake.base}/mcp`);
  let t = Date.parse('2026-10-06T00:00:00Z');
  const notices: string[] = [];
  const oauth = new McpOAuth({
    stateDir, servers, publicUrl: 'https://x056.example', now: () => t,
    onSigninRequired: (n) => notices.push(n), log: () => {}, ...over,
  });
  return { stateDir, servers, oauth, notices, advance: (ms: number) => { t += ms; }, now: () => t };
}

/** Follow the authorize URL at the fake and return the callback query. */
async function authorize(url: string): Promise<Record<string, string>> {
  const r = await fetch(url, { redirect: 'manual' });
  const loc = new URL(r.headers.get('location')!);
  return Object.fromEntries(loc.searchParams);
}

describe('discovery', () => {
  it('parses Carbon\'s WWW-Authenticate header', () => {
    const h = 'Bearer realm="mcp", error="invalid_token", error_description="expired or invalid; re-auth required", authorization_server="https://mcp.carbondesignsystem.com/.well-known/oauth-authorization-server", scope="openid email profile"';
    const p = parseWwwAuthenticate(h);
    expect(p.realm).toBe('mcp');
    expect(p.error_description).toBe('expired or invalid; re-auth required');
    expect(p.authorization_server).toBe('https://mcp.carbondesignsystem.com/.well-known/oauth-authorization-server');
    expect(p.scope).toBe('openid email profile');
  });

  it('finds the AS through protected-resource metadata, with resource and scope', async () => {
    const { oauth } = setup();
    const d = await oauth.discoverNow(`${fake.base}/mcp`);
    expect(d?.as.issuer).toBe(fake.base);
    expect(d?.resource).toBe(`${fake.base}/mcp`);
    expect(d?.scope).toBe('openid email profile');
    expect(d?.unsupported).toBeUndefined();
  });

  it('falls back to the WWW-Authenticate authorization_server hint without PRM', async () => {
    fake.noPrm = true;
    const { oauth } = setup();
    const d = await oauth.discoverNow(`${fake.base}/mcp`);
    expect(d?.as.token_endpoint).toBe(`${fake.base}/token`);
    expect(d?.resource).toBeUndefined();
    expect(d?.scope).toBe('openid email');
  });

  it('reports supported lazily: unknown first, never waiting on the network', async () => {
    const { oauth } = setup();
    expect(oauth.supported(`${fake.base}/mcp`)).toBeNull();
    await oauth.discover(`${fake.base}/mcp`);
    expect(oauth.supported(`${fake.base}/mcp`)).toBe(true);
    expect(oauth.supported('http://127.0.0.1:1/nothing')).toBeNull();
    await oauth.discover('http://127.0.0.1:1/nothing');
    expect(oauth.supported('http://127.0.0.1:1/nothing')).toBe(false);
  });

  it('builds the redirect URI from X056_PUBLIC_URL, else the request; https unless loopback', () => {
    expect(callbackUrl('https://x056.rc.val.id/', { proto: 'http', host: 'evil' })).toBe('https://x056.rc.val.id/api/mcp/oauth/callback');
    expect(callbackUrl(undefined, { proto: 'http', host: 'x056.rc.val.id' })).toBe('https://x056.rc.val.id/api/mcp/oauth/callback');
    expect(callbackUrl(undefined, { proto: 'http', host: '127.0.0.1:4056' })).toBe('http://127.0.0.1:4056/api/mcp/oauth/callback');
  });
});

describe('sign-in', () => {
  it('registers once, sends PKCE S256 + state + redirect_uri + resource, and applies to every account of both providers', async () => {
    const { oauth, servers } = setup();
    const { authorizeUrl } = await oauth.begin('carbon');
    const q = new URL(authorizeUrl).searchParams;
    expect(fake.registrations.at(-1)).toMatchObject({ redirect_uris: ['https://x056.example/api/mcp/oauth/callback'], token_endpoint_auth_method: 'none' });
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(q.get('redirect_uri')).toBe('https://x056.example/api/mcp/oauth/callback');
    expect(q.get('resource')).toBe(`${fake.base}/mcp`);
    expect(q.get('scope')).toBe('openid email profile');
    const regs = fake.registrations.length;
    await oauth.begin('carbon');
    expect(fake.registrations.length).toBe(regs); // DCR once per (server, issuer, redirect_uri)

    const back = await authorize(authorizeUrl);
    expect(await oauth.complete(back)).toEqual({ name: 'carbon' });
    const token = fake.tokenRequests.at(-1)!;
    expect(token.get('redirect_uri')).toBe('https://x056.example/api/mcp/oauth/callback');
    expect(token.get('resource')).toBe(`${fake.base}/mcp`);
    for (const [k, h] of Object.entries(servers.accounts)) {
      expect(h.Authorization, k).toMatch(new RegExp(`^Bearer ${ACCESS_PREFIX}`));
      expect(Object.keys(h).map((x) => x.toLowerCase()), k).not.toContain('x-mcp-session');
    }
    expect(servers.accounts['claude/b']['X-Keep']).toBe('keep');
    const st = oauth.status('carbon', `${fake.base}/mcp`);
    expect(st).toMatchObject({ supported: true, signedIn: true, error: null });
    expect(JSON.stringify(st)).not.toMatch(/SECRET/);
  });

  it('rejects an unknown, reused or expired state, and a wrong or missing iss', async () => {
    const s = setup();
    await expect(s.oauth.complete({ code: 'x', state: 'nope' })).rejects.toThrow(/unknown or was already used/);

    const a = await authorize((await s.oauth.begin('carbon')).authorizeUrl);
    await s.oauth.complete(a);
    await expect(s.oauth.complete(a)).rejects.toThrow(/unknown or was already used/); // single use

    const b = await authorize((await s.oauth.begin('carbon')).authorizeUrl);
    s.advance(11 * 60_000);
    await expect(s.oauth.complete(b)).rejects.toThrow(/expired/);

    fake.issuerOverride = 'https://attacker.example';
    const c = await authorize((await s.oauth.begin('carbon')).authorizeUrl);
    await expect(s.oauth.complete(c)).rejects.toThrow(/different issuer/);

    fake.issuerOverride = undefined;
    const d = await authorize((await s.oauth.begin('carbon')).authorizeUrl);
    const { iss: _drop, ...noIss } = d;
    await expect(s.oauth.complete(noIss)).rejects.toThrow(/different issuer/); // AS advertises iss support
  });
});

describe('refresher', () => {
  async function signedIn() {
    const s = setup();
    await s.oauth.complete(await authorize((await s.oauth.begin('carbon')).authorizeUrl));
    return s;
  }

  it('refreshes inside the last 20 minutes, rotating the refresh token, and re-applies', async () => {
    const s = await signedIn();
    const before = s.servers.accounts['codex/e'].Authorization;
    const reqs = fake.tokenRequests.length;
    await s.oauth.tick();
    expect(fake.tokenRequests.length).toBe(reqs); // 2 h left: not due
    s.advance(7200_000 - 19 * 60_000);
    await s.oauth.tick();
    expect(fake.tokenRequests.length).toBe(reqs + 1);
    expect(fake.tokenRequests.at(-1)!.get('grant_type')).toBe('refresh_token');
    const after = s.servers.accounts['codex/e'].Authorization;
    expect(after).not.toBe(before);
    expect(s.oauth.status('carbon', '').signedIn).toBe(true);
    expect(s.oauth.status('carbon', '').lastRefreshAt).toBe(s.now());
    // The rotated refresh token is the one used next: a reused old one is invalid_grant at the fake.
    s.advance(7200_000 - 19 * 60_000);
    await s.oauth.tick();
    expect(s.oauth.status('carbon', '').error).toBeNull();
    expect(s.servers.accounts['claude/f'].Authorization).not.toBe(after);
  });

  it('puts the header back on an account that lost it, on the next tick', async () => {
    const s = await signedIn();
    const good = s.servers.accounts['claude/b'].Authorization;
    s.servers.accounts['codex/g'] = { Authorization: 'Bearer stale', 'X-MCP-Session': 'again' };
    const reqs = fake.tokenRequests.length;
    await s.oauth.tick();
    expect(fake.tokenRequests.length).toBe(reqs); // no refresh needed for that
    expect(s.servers.accounts['codex/g']).toEqual({ Authorization: good });
  });

  it('a rejected refresh token means sign in again, with one notice', async () => {
    const s = await signedIn();
    fake.refreshMode = 'invalid_grant';
    s.advance(7200_000 - 10 * 60_000);
    await s.oauth.tick();
    await s.oauth.tick();
    expect(s.oauth.status('carbon', '').error).toBe(SIGNIN_REQUIRED);
    expect(s.oauth.status('carbon', '').signedIn).toBe(false);
    expect(s.notices).toEqual(['carbon']);
  });

  it('a server error backs off and keeps the sign-in', async () => {
    const s = await signedIn();
    fake.refreshMode = 'error500';
    s.advance(7200_000 - 10 * 60_000);
    const reqs = fake.tokenRequests.length;
    await s.oauth.tick();
    await s.oauth.tick(); // inside the backoff: no second request
    expect(fake.tokenRequests.length).toBe(reqs + 1);
    const st = s.oauth.status('carbon', '');
    expect(st.error).toMatch(/refresh failed/);
    expect(st.error).not.toBe(SIGNIN_REQUIRED);
    expect(s.notices).toEqual([]);
    fake.refreshMode = 'rotate';
    s.advance(61_000);
    await s.oauth.tick();
    expect(s.oauth.status('carbon', '')).toMatchObject({ signedIn: true, error: null });
  });

  it('sign-out removes the Authorization header everywhere', async () => {
    const s = await signedIn();
    const r = await s.oauth.signOut('carbon');
    expect(r.ok).toBe(true);
    for (const h of Object.values(s.servers.accounts)) expect(h.Authorization).toBeUndefined();
    expect(s.oauth.status('carbon', `${fake.base}/mcp`).signedIn).toBe(false);
  });
});

describe('McpServerManager.setHttpHeaders', () => {
  it('edits .claude.json and config.toml in place, keeping everything else, with no CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-hdr-'));
    const cl = join(root, 'b'), cx = join(root, 'e'), none = join(root, 'f');
    for (const d of [cl, cx, none]) mkdirSync(d);
    writeFileSync(join(cl, '.claude.json'), JSON.stringify({ numStartups: 3, mcpServers: { carbon: { type: 'http', url: 'https://c/mcp', headers: { Authorization: 'Bearer old', 'X-MCP-Session': 's' } }, other: { command: 'x' } } }));
    writeFileSync(join(none, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    writeFileSync(join(cx, 'config.toml'), 'model = "gpt"\n\n[mcp_servers.carbon]\nurl = "https://c/mcp"\nstartup_timeout_sec = 20\n\n[mcp_servers.carbon.http_headers]\n"Authorization" = "Bearer old"\n"X-MCP-Session" = "s"\n\n[mcp_servers.obscura]\nurl = "https://o/mcp"\n');
    const m = new McpServerManager({ claudePath: '/nonexistent', codexPath: '/nonexistent', accounts: (p) => p === 'codex' ? [{ name: 'e', configDir: cx }] : [{ name: 'b', configDir: cl }, { name: 'f', configDir: none }] });
    expect(m.findHttpServer('carbon')).toEqual({ name: 'carbon', url: 'https://c/mcp' });
    const res = await m.setHttpHeaders('carbon', (h) => { delete h['X-MCP-Session']; return { ...h, Authorization: 'Bearer new' }; });
    expect(res.map((r) => [r.provider, r.account, r.ok, r.changed])).toEqual([['claude', 'b', true, true], ['codex', 'e', true, true]]);
    const c = JSON.parse(readFileSync(join(cl, '.claude.json'), 'utf8'));
    expect(c.numStartups).toBe(3);
    expect(c.mcpServers.carbon.headers).toEqual({ Authorization: 'Bearer new' });
    expect(c.mcpServers.other).toEqual({ command: 'x' });
    const t = readFileSync(join(cx, 'config.toml'), 'utf8');
    expect(t).toContain('startup_timeout_sec = 20');
    expect(t).toContain('[mcp_servers.obscura]\nurl = "https://o/mcp"');
    expect(t).toContain('[mcp_servers.carbon.http_headers]\n"Authorization" = "Bearer new"');
    expect(t).not.toContain('X-MCP-Session');
    expect(t).not.toContain('Bearer old');
    const again = await m.setHttpHeaders('carbon', (h) => ({ ...h, Authorization: 'Bearer new' }));
    expect(again.every((r) => r.ok && !r.changed)).toBe(true);
  });
});

describe('notice', () => {
  it('a refused refresh is one normal notice in plain words', () => {
    const n = noticeFor('mcp_oauth', { name: 'carbon-mcp', error: 'signin_required', at: '2026-10-06T08:00:00Z' });
    expect(n).toMatchObject({ tier: 'normal', category: 'needs_you', body: 'Carbon MCP needs you to sign in again', link: '/?mcp=servers', id: 'mcp-oauth:carbon-mcp:2026-10-06T08:00:00Z' });
    expect(noticeFor('mcp_oauth', { name: 'x' })).toBeNull();
    expect(serverLabel('carbon-mcp')).toBe('Carbon MCP');
  });
});

describe('routes', () => {
  const TOKEN = 'mcp-oauth-route-test-token-0123456789';
  let app: Awaited<ReturnType<typeof createApp>>;
  let base: string;
  let cfgDir: string;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-mcpoauth-app-'));
    const stateDir = join(dir, 'state');
    cfgDir = join(dir, 'acct-a');
    mkdirSync(cfgDir, { recursive: true }); mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(cfgDir, '.claude.json'), JSON.stringify({ mcpServers: { carbon: { type: 'http', url: `${fake.base}/mcp`, headers: { 'X-MCP-Session': 'old' } } } }));
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: cfgDir }]);
    app = await createApp({ token: TOKEN, stateDir, workspaceRoot: dir, claudePath: '/nonexistent' });
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => { await app?.close(); });
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  it('the callback needs no panel token; every other /api/mcp route does', async () => {
    const cb = await fetch(`${base}/api/mcp/oauth/callback?code=x&state=forged`);
    expect(cb.status).toBe(400);
    const html = await cb.text();
    expect(html).toContain('unknown or was already used');
    expect((await fetch(`${base}/api/mcp/oauth/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"carbon"}' })).status).toBe(401);
    expect((await fetch(`${base}/api/mcp/oauth/signout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"name":"carbon"}' })).status).toBe(401);
    expect((await fetch(`${base}/api/mcp/oauth/status?name=carbon`)).status).toBe(401);
    expect((await fetch(`${base}/api/mcp/servers`)).status).toBe(401);
  });

  it('runs the whole flow through the gateway and never returns a token', async () => {
    const start = await fetch(`${base}/api/mcp/oauth/start`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'carbon' }) });
    expect(start.status).toBe(200);
    const { authorizeUrl } = await start.json() as { authorizeUrl: string };
    expect(new URL(authorizeUrl).searchParams.get('redirect_uri')).toBe(`${base}/api/mcp/oauth/callback`);
    const r = await fetch(authorizeUrl, { redirect: 'manual' });
    const cb = await fetch(r.headers.get('location')!); // no panel token, as a browser arrives
    const page = await cb.text();
    expect(cb.status).toBe(200);
    expect(page).toContain('Signed in to Carbon');
    expect(page).not.toMatch(/SECRET/);
    const written = JSON.parse(readFileSync(join(cfgDir, '.claude.json'), 'utf8')).mcpServers.carbon.headers;
    expect(written.Authorization).toMatch(new RegExp(`^Bearer ${ACCESS_PREFIX}`));
    expect(written['X-MCP-Session']).toBeUndefined();

    const list = await (await fetch(`${base}/api/mcp/servers`, { headers: auth })).text();
    expect(list).not.toMatch(/SECRET/);
    const row = (JSON.parse(list).servers as { name: string; oauth?: { signedIn: boolean; supported: boolean } }[]).find((s) => s.name === 'carbon');
    expect(row?.oauth).toMatchObject({ supported: true, signedIn: true });
    const st = await (await fetch(`${base}/api/mcp/oauth/status?name=carbon`, { headers: auth })).text();
    expect(JSON.parse(st).signedIn).toBe(true);
    expect(st).not.toMatch(/SECRET/);
    const out = await (await fetch(`${base}/api/mcp/oauth/signout`, { method: 'POST', headers: auth, body: JSON.stringify({ name: 'carbon' }) })).text();
    expect(out).not.toMatch(/SECRET/);
    expect(JSON.parse(readFileSync(join(cfgDir, '.claude.json'), 'utf8')).mcpServers.carbon.headers).toBeUndefined();
  });
});
