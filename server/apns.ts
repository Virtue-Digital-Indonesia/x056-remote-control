import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { connect, type ClientHttp2Session } from 'node:http2';
import { join } from 'node:path';
import type { Notice } from './notices.js';

/**
 * Apple Push (APNs) for the native iOS app, beside the panel's Web Push.
 *
 * Config (0600, never returned by any route): state/secrets/apns.json
 *   { keyId, teamId, bundleId, key }   key = the .p8 file's PEM text
 * Without it the service is inert: devices still register, nothing is sent.
 *
 * Each device records the APNs environment it was built for. A Debug build run
 * from Xcode gets SANDBOX tokens; a TestFlight build gets PRODUCTION ones, and
 * the other host answers BadDeviceToken. One gateway serves both.
 */
export type ApnsEnv = 'production' | 'sandbox';

export interface ApnsConfig { keyId: string; teamId: string; bundleId: string; key: string }

export interface ApnsDevice { token: string; env: ApnsEnv; name?: string; at: number }

/** What APNs needs from a notice (server/notices.ts). */
export type ApnsAlert = Pick<Notice, 'title' | 'body' | 'kind'> & Partial<Pick<Notice, 'projectId' | 'sessionId' | 'id' | 'link' | 'tag'>>;

/** An iPhone's key for push settings and presence (server/presence.ts deviceKey),
 *  in the same namespace as a browser's push endpoint. */
export function apnsEndpoint(token: string): string { return 'apns:' + token.toLowerCase(); }

export interface ApnsReply { status: number; reason?: string }

/** One POST to APNs. Swapped out in tests; the real one is HTTP/2. */
export type ApnsTransport = (env: ApnsEnv, path: string, headers: Record<string, string>, body: string) => Promise<ApnsReply>;

const HOSTS: Record<ApnsEnv, string> = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
};

/** Apple rejects a provider token older than an hour and throttles one
 *  refreshed more often than every 20 minutes. */
const JWT_TTL_MS = 40 * 60_000;

export const TOKEN_RE = /^[0-9a-f]{64,200}$/i;

export function http2Transport(): ApnsTransport {
  const sessions = new Map<ApnsEnv, ClientHttp2Session>();
  const session = (env: ApnsEnv): ClientHttp2Session => {
    const open = sessions.get(env);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(HOSTS[env]);
    s.on('error', () => sessions.delete(env));
    s.on('close', () => sessions.delete(env));
    // Apple drops idle connections; don't let ours hold the event loop open.
    s.unref();
    sessions.set(env, s);
    return s;
  };
  return (env, path, headers, body) => new Promise((resolve) => {
    let req;
    try {
      req = session(env).request({ ':method': 'POST', ':path': path, ...headers });
    } catch (err) {
      resolve({ status: 0, reason: (err as Error).message });
      return;
    }
    let status = 0;
    let data = '';
    const finish = (err?: Error) => {
      let reason: string | undefined = err?.message;
      try { reason = (JSON.parse(data) as { reason?: string }).reason ?? reason; } catch { /* 200 has no body */ }
      resolve({ status, reason: reason ?? (status ? undefined : 'no response') });
    };
    req.setEncoding('utf8');
    req.setTimeout(10_000, () => req.close());
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.on('data', (c: string) => { data += c; });
    // 'close' fires after 'end' and after a timeout or reset; resolve() ignores repeats.
    req.on('close', () => finish());
    req.on('error', (err) => finish(err));
    req.end(body);
  });
}

export class ApnsService {
  private devices: ApnsDevice[];
  private config: ApnsConfig | null = null;
  private signingKey: KeyObject | null = null;
  private jwt: { token: string; at: number } | null = null;

  constructor(
    private readonly stateDir: string,
    private readonly transport: ApnsTransport = http2Transport(),
    private readonly now: () => number = Date.now,
  ) {
    this.devices = this.loadDevices();
    this.loadConfig();
  }

  private get devicesFile(): string { return join(this.stateDir, 'push', 'apns-devices.json'); }
  private get configFile(): string { return join(this.stateDir, 'secrets', 'apns.json'); }

  get configured(): boolean { return this.config !== null || this.loadConfig(); }

  status(): { configured: boolean; bundleId?: string; devices: Array<{ env: ApnsEnv; name?: string; at: number; token: string }> } {
    return {
      configured: this.configured,
      ...(this.config ? { bundleId: this.config.bundleId } : {}),
      // A device token is not a secret, but the tail is enough to tell them apart.
      devices: this.devices.map((d) => ({ env: d.env, name: d.name, at: d.at, token: '…' + d.token.slice(-8) })),
    };
  }

  hasTargets(): boolean { return this.devices.length > 0 && this.configured; }

  tokens(): string[] { return this.devices.map((d) => d.token); }

  register(token: string, env: ApnsEnv, name?: string): void {
    if (!TOKEN_RE.test(token)) throw new Error('invalid device token');
    if (env !== 'production' && env !== 'sandbox') throw new Error('env must be production or sandbox');
    const t = token.toLowerCase();
    this.devices = this.devices.filter((d) => d.token !== t);
    this.devices.push({ token: t, env, ...(name ? { name: name.slice(0, 80) } : {}), at: this.now() });
    this.saveDevices();
  }

  unregister(token: string): void {
    const t = token.toLowerCase();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.token !== t);
    if (this.devices.length !== before) this.saveDevices();
  }

  /** Validate and store the provider key. Throws if Apple's key can't be parsed,
   *  so a bad paste fails here and not silently on the first push. */
  setConfig(cfg: ApnsConfig): void {
    for (const k of ['keyId', 'teamId', 'bundleId', 'key'] as const) {
      if (typeof cfg?.[k] !== 'string' || !cfg[k].trim()) throw new Error(`${k} required`);
    }
    const clean: ApnsConfig = { keyId: cfg.keyId.trim(), teamId: cfg.teamId.trim(), bundleId: cfg.bundleId.trim(), key: cfg.key.trim() + '\n' };
    const key = createPrivateKey(clean.key);
    mkdirSync(join(this.stateDir, 'secrets'), { recursive: true });
    this.writeAtomic(this.configFile, JSON.stringify(clean));
    this.config = clean;
    this.signingKey = key;
    this.jwt = null;
  }

  /** Send to every device, or to `only` those tokens (PushService picks them). */
  async send(alert: ApnsAlert, only?: string[]): Promise<Array<{ token: string; env: ApnsEnv } & ApnsReply>> {
    if (!this.hasTargets()) return [];
    const pick = only ? new Set(only.map((t) => t.toLowerCase())) : null;
    const devices = pick ? this.devices.filter((d) => pick.has(d.token)) : this.devices;
    if (!devices.length) return [];
    const body = JSON.stringify(this.payload(alert));
    const results = await Promise.all(devices.map(async (d) => ({ token: d.token, env: d.env, ...(await this.post(d, alert, body)) })));
    // 410 = the app was uninstalled; 400 BadDeviceToken = a token from the
    // other environment or a mangled one. The app re-registers on launch.
    const dead = results.filter((r) => r.status === 410 || (r.status === 400 && r.reason === 'BadDeviceToken')).map((r) => r.token);
    if (dead.length) {
      this.devices = this.devices.filter((d) => !dead.includes(d.token));
      this.saveDevices();
    }
    return results.map((r) => ({ ...r, token: '…' + r.token.slice(-8) }));
  }

  /** One ActivityKit push to a Live Activity's own token: its own topic and
   *  push type. Priority 5 for step updates (Apple budgets 10s). */
  async sendActivity(token: string, env: ApnsEnv, payload: Record<string, unknown>, priority: 5 | 10): Promise<ApnsReply> {
    if (!this.configured) return { status: 0, reason: 'APNs is not configured' };
    const body = JSON.stringify(payload);
    const attempt = () => this.transport(env, `/3/device/${token}`, {
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': `${this.config!.bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': String(priority),
    }, body);
    let reply = await attempt();
    if (reply.status === 403 && reply.reason === 'ExpiredProviderToken') {
      this.jwt = null;
      reply = await attempt();
    }
    return reply;
  }

  private async post(d: ApnsDevice, alert: ApnsAlert, body: string): Promise<ApnsReply> {
    const attempt = () => this.transport(d.env, `/3/device/${d.token}`, this.headers(alert), body);
    let reply = await attempt();
    if (reply.status === 403 && reply.reason === 'ExpiredProviderToken') {
      this.jwt = null;
      reply = await attempt();
    }
    return reply;
  }

  private headers(alert: ApnsAlert): Record<string, string> {
    const h: Record<string, string> = {
      authorization: `bearer ${this.providerToken()}`,
      'apns-topic': this.config!.bundleId,
      'apns-push-type': 'alert',
      'apns-priority': '10',
    };
    // Same replacement rule as the panel's notification tag: one banner per
    // conversation, one per urgent item. Apple caps the id at 64 bytes, so hash.
    const collapse = alert.tag || alert.id;
    if (collapse) h['apns-collapse-id'] = createHash('sha256').update(collapse).digest('hex').slice(0, 32);
    return h;
  }

  payload(alert: ApnsAlert): Record<string, unknown> {
    return {
      aps: {
        alert: { title: alert.title, body: alert.body },
        sound: 'default',
        'thread-id': alert.sessionId || alert.projectId || 'x056',
        // Any notice about a conversation can be answered from the banner.
        ...(alert.sessionId ? { category: 'X056_REPLY' } : {}),
      },
      kind: alert.kind,
      projectId: alert.projectId ?? '',
      ...(alert.sessionId ? { sessionId: alert.sessionId } : {}),
      ...(alert.link ? { url: alert.link } : {}),
    };
  }

  private providerToken(): string {
    const now = this.now();
    if (this.jwt && now - this.jwt.at < JWT_TTL_MS) return this.jwt.token;
    const cfg = this.config!;
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'ES256', kid: cfg.keyId })}.${b64({ iss: cfg.teamId, iat: Math.floor(now / 1000) })}`;
    const sig = sign('sha256', Buffer.from(unsigned), { key: this.signingKey!, dsaEncoding: 'ieee-p1363' });
    this.jwt = { token: `${unsigned}.${sig.toString('base64url')}`, at: now };
    return this.jwt.token;
  }

  /** Picks the file up when it appears, so a key installed by hand needs no restart. */
  private loadConfig(): boolean {
    if (!existsSync(this.configFile)) return false;
    try {
      const cfg = JSON.parse(readFileSync(this.configFile, 'utf8')) as ApnsConfig;
      if (!cfg.keyId || !cfg.teamId || !cfg.bundleId || !cfg.key) return false;
      this.signingKey = createPrivateKey(cfg.key);
      this.config = cfg;
      return true;
    } catch (err) {
      console.warn('[apns] state/secrets/apns.json unreadable:', (err as Error).message);
      return false;
    }
  }

  private loadDevices(): ApnsDevice[] {
    if (!existsSync(this.devicesFile)) return [];
    try {
      const arr = JSON.parse(readFileSync(this.devicesFile, 'utf8')) as ApnsDevice[];
      return Array.isArray(arr) ? arr.filter((d) => d && TOKEN_RE.test(d.token)) : [];
    } catch { return []; }
  }

  private saveDevices(): void {
    mkdirSync(join(this.stateDir, 'push'), { recursive: true });
    this.writeAtomic(this.devicesFile, JSON.stringify(this.devices));
  }

  private writeAtomic(file: string, data: string): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, file);
  }
}
