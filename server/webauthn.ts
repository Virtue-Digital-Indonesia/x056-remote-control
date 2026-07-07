import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  AuthenticatorTransportFuture,
} from '@simplewebauthn/server';

/**
 * Passkey (WebAuthn) auth for the single user. The vetted @simplewebauthn/server
 * does the cryptographic verification; we persist the public keys + session ids
 * in the state volume. The existing X056_TOKEN stays as a fallback (see the
 * AuthGuard), so a passkey hiccup never locks you out.
 */
interface StoredCred {
  id: string; // base64url credential id
  publicKey: string; // base64url of the public key bytes
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  label: string;
  createdAt: number;
}
interface Flow { challenge: string; rpID: string; origin: string; expires: number; }

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const RP_NAME = 'x056 remote control';

export class WebAuthnService {
  private creds: StoredCred[] = [];
  private readonly flows = new Map<string, Flow>();

  constructor(private readonly stateDir: string) {
    this.creds = this.load();
  }

  private get dir(): string { return join(this.stateDir, 'webauthn'); }
  private get file(): string { return join(this.dir, 'credentials.json'); }
  private load(): StoredCred[] {
    try { const a = JSON.parse(readFileSync(this.file, 'utf8')) as StoredCred[]; return Array.isArray(a) ? a : []; }
    catch { return []; }
  }
  private save(): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.creds, null, 2));
    renameSync(tmp, this.file);
  }

  hasAny(): boolean { return this.creds.length > 0; }
  list(): { id: string; label: string; createdAt: number }[] {
    return this.creds.map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt }));
  }
  remove(id: string): void {
    const before = this.creds.length;
    this.creds = this.creds.filter((c) => c.id !== id);
    if (this.creds.length !== before) this.save();
  }

  private putFlow(challenge: string, rpID: string, origin: string): string {
    const now = Date.now();
    for (const [k, v] of this.flows) if (v.expires < now) this.flows.delete(k);
    const flowId = randomUUID();
    this.flows.set(flowId, { challenge, rpID, origin, expires: now + CHALLENGE_TTL_MS });
    return flowId;
  }
  private takeFlow(flowId: string): Flow | undefined {
    const f = this.flows.get(flowId);
    this.flows.delete(flowId);
    if (!f || f.expires < Date.now()) return undefined;
    return f;
  }

  async registrationOptions(rpID: string, origin: string): Promise<{ options: PublicKeyCredentialCreationOptionsJSON; flowId: string }> {
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userID: new TextEncoder().encode('x056-user'),
      userName: 'x056',
      userDisplayName: 'x056 remote control',
      attestationType: 'none',
      excludeCredentials: this.creds.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    return { options, flowId: this.putFlow(options.challenge, rpID, origin) };
  }

  async verifyRegistration(flowId: string, response: RegistrationResponseJSON, label: string): Promise<boolean> {
    const f = this.takeFlow(flowId);
    if (!f) return false;
    const v = await verifyRegistrationResponse({
      response,
      expectedChallenge: f.challenge,
      expectedOrigin: f.origin,
      expectedRPID: f.rpID,
      requireUserVerification: false,
    });
    if (!v.verified || !v.registrationInfo) return false;
    const cred = v.registrationInfo.credential;
    this.creds = this.creds.filter((c) => c.id !== cred.id); // dedupe re-registration
    this.creds.push({
      id: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString('base64url'),
      counter: cred.counter,
      transports: cred.transports,
      label: (label || '').trim() || 'passkey',
      createdAt: Date.now(),
    });
    this.save();
    return true;
  }

  async authenticationOptions(rpID: string, origin: string): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; flowId: string }> {
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: this.creds.map((c) => ({ id: c.id, transports: c.transports })),
      userVerification: 'preferred',
    });
    return { options, flowId: this.putFlow(options.challenge, rpID, origin) };
  }

  async verifyAuthentication(flowId: string, response: AuthenticationResponseJSON): Promise<boolean> {
    const f = this.takeFlow(flowId);
    if (!f) return false;
    const cred = this.creds.find((c) => c.id === response.id);
    if (!cred) return false;
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: f.challenge,
      expectedOrigin: f.origin,
      expectedRPID: f.rpID,
      credential: {
        id: cred.id,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
        counter: cred.counter,
        transports: cred.transports,
      },
      requireUserVerification: false,
    });
    if (!v.verified) return false;
    cred.counter = v.authenticationInfo.newCounter; // clone/replay protection
    this.save();
    return true;
  }
}

/** Opaque session ids minted after a passkey login, persisted so a login
 *  survives a container swap. Checked by the AuthGuard against the cookie. */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export class SessionStore {
  private sessions: Record<string, number> = {}; // id -> expires
  constructor(private readonly stateDir: string) {
    this.sessions = this.load();
  }
  private get file(): string { return join(this.stateDir, 'webauthn', 'sessions.json'); }
  private load(): Record<string, number> {
    try { const o = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, number>; return o && typeof o === 'object' ? o : {}; }
    catch { return {}; }
  }
  private save(): void {
    mkdirSync(join(this.stateDir, 'webauthn'), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.sessions));
    renameSync(tmp, this.file);
  }
  create(): string {
    const now = Date.now();
    for (const [id, exp] of Object.entries(this.sessions)) if (exp < now) delete this.sessions[id];
    const id = randomUUID() + randomUUID().replace(/-/g, '');
    this.sessions[id] = now + SESSION_TTL_MS;
    this.save();
    return id;
  }
  valid(id: string): boolean {
    const exp = this.sessions[id];
    if (!exp) return false;
    if (exp < Date.now()) { delete this.sessions[id]; this.save(); return false; }
    return true;
  }
  destroy(id: string): void {
    if (this.sessions[id]) { delete this.sessions[id]; this.save(); }
  }
}
