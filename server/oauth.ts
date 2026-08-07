import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The small OAuth 2.1 authorization server the MCP spec requires of a remote
 * server. Claude Desktop / claude.ai connectors will not accept a bare token —
 * they discover the auth server, register themselves dynamically, and run an
 * authorization-code + PKCE flow. This implements exactly that much, and no more.
 *
 * The human gate is the panel's own login: /authorize only issues a code to a
 * browser that already holds a valid panel session, so approving a connector
 * requires being logged in to x056 in that browser.
 */

const CODE_TTL_MS = 5 * 60 * 1000;          // codes are single-use and short-lived
const ACCESS_TTL_MS = 30 * 24 * 3600 * 1000; // long-lived: a connector shouldn't need re-approval weekly

export interface OAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  created: number;
}

interface AuthCode {
  client_id: string;
  redirect_uri: string;
  challenge: string;      // PKCE S256 challenge
  expires: number;
  resource?: string;
}

interface AccessToken {
  client_id: string;
  expires: number;
}

interface OAuthFile {
  clients: Record<string, OAuthClient>;
  tokens: Record<string, AccessToken>;
  refresh: Record<string, { client_id: string }>;
}

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export class OAuthStore {
  private data: OAuthFile = { clients: {}, tokens: {}, refresh: {} };
  // Codes live in memory only: they last five minutes and a restart mid-flow
  // just means the client retries, which is cheaper than persisting secrets.
  private codes = new Map<string, AuthCode>();

  constructor(private readonly stateDir: string) {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as OAuthFile;
      if (raw && typeof raw === 'object') {
        this.data = { clients: raw.clients ?? {}, tokens: raw.tokens ?? {}, refresh: raw.refresh ?? {} };
      }
    } catch { /* nothing registered yet */ }
    this.prune();
  }

  private get file(): string { return join(this.stateDir, 'oauth.json'); }

  private save(): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      renameSync(tmp, this.file);
    } catch { /* best effort — losing this only forces a re-approval */ }
  }

  private prune(): void {
    const now = Date.now();
    let dirty = false;
    for (const [t, v] of Object.entries(this.data.tokens)) if (v.expires < now) { delete this.data.tokens[t]; dirty = true; }
    for (const [c, v] of this.codes) if (v.expires < now) this.codes.delete(c);
    if (dirty) this.save();
  }

  /** Dynamic Client Registration (RFC 7591). Public client — no secret issued. */
  registerClient(name: string | undefined, redirectUris: string[]): OAuthClient {
    const client: OAuthClient = {
      client_id: `x056-${randomUUID()}`,
      client_name: name,
      redirect_uris: redirectUris,
      created: Date.now(),
    };
    this.data.clients[client.client_id] = client;
    this.save();
    return client;
  }

  getClient(id: string): OAuthClient | undefined { return this.data.clients[id]; }

  /** Mint an authorization code bound to the client, redirect URI and PKCE challenge. */
  issueCode(client_id: string, redirect_uri: string, challenge: string, resource?: string): string {
    this.prune();
    const code = b64url(randomBytes(32));
    this.codes.set(code, { client_id, redirect_uri, challenge, expires: Date.now() + CODE_TTL_MS, resource });
    return code;
  }

  /**
   * Redeem a code: single use, must match the client and redirect URI it was
   * issued to, and the PKCE verifier must hash to the stored challenge.
   * Returns null on any mismatch — the caller reports invalid_grant.
   */
  redeemCode(code: string, client_id: string, redirect_uri: string, verifier: string): { access_token: string; refresh_token: string; expires_in: number } | null {
    this.prune();
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code); // single use, even on failure
    if (entry.expires < Date.now()) return null;
    if (entry.client_id !== client_id) return null;
    if (entry.redirect_uri !== redirect_uri) return null;
    const hashed = b64url(createHash('sha256').update(verifier).digest());
    const a = Buffer.from(hashed);
    const b = Buffer.from(entry.challenge);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return this.mint(client_id);
  }

  private mint(client_id: string): { access_token: string; refresh_token: string; expires_in: number } {
    const access_token = b64url(randomBytes(32));
    const refresh_token = b64url(randomBytes(32));
    this.data.tokens[access_token] = { client_id, expires: Date.now() + ACCESS_TTL_MS };
    this.data.refresh[refresh_token] = { client_id };
    this.save();
    return { access_token, refresh_token, expires_in: Math.floor(ACCESS_TTL_MS / 1000) };
  }

  /** refresh_token grant. */
  refresh(refresh_token: string, client_id: string): { access_token: string; refresh_token: string; expires_in: number } | null {
    const entry = this.data.refresh[refresh_token];
    if (!entry || entry.client_id !== client_id) return null;
    delete this.data.refresh[refresh_token]; // rotate
    return this.mint(client_id);
  }

  /** True when this bearer token is one we issued and hasn't expired. */
  validAccessToken(token: string): boolean {
    const entry = this.data.tokens[token];
    if (!entry) return false;
    if (entry.expires < Date.now()) { delete this.data.tokens[token]; this.save(); return false; }
    return true;
  }

  /** Connectors the user has approved, for display/revocation in the panel. */
  listClients(): OAuthClient[] { return Object.values(this.data.clients); }

  /** Drop a client and every token issued to it. */
  revokeClient(client_id: string): boolean {
    if (!this.data.clients[client_id]) return false;
    delete this.data.clients[client_id];
    for (const [t, v] of Object.entries(this.data.tokens)) if (v.client_id === client_id) delete this.data.tokens[t];
    for (const [r, v] of Object.entries(this.data.refresh)) if (v.client_id === client_id) delete this.data.refresh[r];
    this.save();
    return true;
  }
}
