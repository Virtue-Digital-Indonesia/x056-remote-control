import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AccountRegistry } from '../src/accounts.js';
import { createApp } from '../server/main.js';

const TOKEN = 'test-token-0123456789abcdefghij';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
let app: INestApplication;
let base = '';

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}
async function register(name = 'Claude Desktop'): Promise<string> {
  const res = await fetch(`${base}/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}
/** Approve as the operator and pull the code out of the redirect. */
async function approve(clientId: string, challenge: string, redirect = REDIRECT): Promise<string | null> {
  const res = await fetch(`${base}/authorize/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
    body: new URLSearchParams({ client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', token: TOKEN }),
  });
  const loc = res.headers.get('location');
  return loc ? new URL(loc).searchParams.get('code') : null;
}
async function exchange(params: Record<string, string>): Promise<any> {
  const res = await fetch(`${base}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return res.json();
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'x056-oauth-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg-a') }]);
  app = await createApp({ token: TOKEN, stateDir, workspaceRoot: dir });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(async () => { await app?.close(); });

describe('OAuth for MCP connectors (Claude Desktop / claude.ai refuse a bare token)', () => {
  it('publishes the discovery documents a connector looks for', async () => {
    const pr = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as any;
    expect(pr.resource).toBe(`${base}/mcp`);
    expect(pr.authorization_servers).toEqual([base]);
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as any;
    expect(as.issuer).toBe(base);
    expect(as.registration_endpoint).toBe(`${base}/register`);
    expect(as.code_challenge_methods_supported).toEqual(['S256']); // plain must not be offered
  });

  it('tells an unauthenticated caller where to authenticate (RFC 9728)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toMatch(/resource_metadata=".*\.well-known\/oauth-protected-resource"/);
  });

  it('registers a client dynamically, as a public client with no secret', async () => {
    const res = await fetch(`${base}/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude Desktop', redirect_uris: [REDIRECT] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.client_id).toMatch(/^x056-/);
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('completes the whole flow and the issued token works on /mcp', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    expect(code).toBeTruthy();
    const tok = await exchange({ grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(tok.token_type).toBe('Bearer');
    expect(tok.access_token).toBeTruthy();
    const mcp = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(mcp.status).toBe(200);
    expect(((await mcp.json()) as any).result.tools).toHaveLength(4);
  });

  it('refuses to issue a code to a browser that is not logged in to the panel', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const res = await fetch(`${base}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' })}`);
    expect(res.status).toBe(401); // the human gate: approving requires an x056 session
  });

  it('rejects a code redeemed with the wrong PKCE verifier', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const code = await approve(clientId, challenge);
    const out = await exchange({ grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: b64url(randomBytes(32)) });
    expect(out.error).toBe('invalid_grant');
    expect(out.access_token).toBeUndefined();
  });

  it('makes a code single-use', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const first = await exchange({ grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(first.access_token).toBeTruthy();
    const replay = await exchange({ grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(replay.error).toBe('invalid_grant');
  });

  it('binds the code to its redirect_uri and to its client', async () => {
    const clientId = await register();
    const other = await register('someone else');
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    expect((await exchange({ grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: 'https://evil.example/cb', code_verifier: verifier })).error).toBe('invalid_grant');
    const code2 = await approve(clientId, pkce().challenge);
    expect((await exchange({ grant_type: 'authorization_code', code: code2!, client_id: other, redirect_uri: REDIRECT, code_verifier: verifier })).error).toBe('invalid_grant');
  });

  it('refuses an unregistered redirect_uri and non-S256 PKCE at /authorize', async () => {
    const clientId = await register();
    const bad = await fetch(`${base}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256', token: TOKEN })}`);
    expect(bad.status).toBe(400);
    const plain = await fetch(`${base}/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x', code_challenge_method: 'plain', token: TOKEN })}`);
    expect(plain.status).toBe(400);
  });

  it('does not accept an invented bearer token on /mcp', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { Authorization: 'Bearer made-up', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('rotates refresh tokens', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const code = await approve(clientId, challenge);
    const first = await exchange({ grant_type: 'authorization_code', code: code!, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(first.access_token);
    // the old refresh token is spent
    expect((await exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId })).error).toBe('invalid_grant');
  });
});
