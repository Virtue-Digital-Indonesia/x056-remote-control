import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { PushSubscription } from 'web-push';
import { gatewayDb } from './gateway-db.js';
import { NOTICE_KINDS, type Notice } from './notices.js';
import { deviceKey, type Presence } from './presence.js';
import { apnsEndpoint, type ApnsService } from './apns.js';

/**
 * Self-contained Web Push: generates+persists a VAPID keypair, stores browser
 * push subscriptions, and sends the notices (server/notices.ts) that are worth
 * a buzz. WHAT a notice says and how loud it is lives in notices.ts; this file
 * only decides which devices get it now: presence (someone is looking), the
 * device's own settings, quiet hours, and ids already sent.
 *
 * Browsers get notices over Web Push; the native iOS app gets the same ones
 * over APNs (server/apns.ts), picked by the same rules. An iPhone's settings
 * and presence key is `apns:<token>`, so it is one device among the others.
 */
export interface StoredSub {
  sub: PushSubscription;
  at: number;
}

export interface DeviceSettings {
  /** Long turns you started finished, autopilot runs ended, parked turns. */
  finished: boolean;
  /** Autopilot, cron, relays, delegates: pushed only when this is on. */
  automation: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
  /** The device's IANA zone, so quiet hours mean its own night. */
  timeZone?: string;
}
export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  finished: true,
  automation: false,
  quietHours: { enabled: false, start: '22:00', end: '07:00' },
};
const SENT_RETAIN_MS = 7 * 24 * 3600_000;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function minutesIn(tz: string | undefined, at: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at));
    return Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  } catch {
    const d = new Date(at); return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}
export function inQuietHours(s: DeviceSettings, at: number): boolean {
  const q = s.quietHours;
  if (!q?.enabled || !HHMM.test(q.start) || !HHMM.test(q.end) || q.start === q.end) return false;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const m = minutesIn(s.timeZone, at), a = toMin(q.start), b = toMin(q.end);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/** Does this device's own setup want this notice (ignoring presence)? */
export function deviceWants(n: Notice, s: DeviceSettings, at: number): boolean {
  if (n.tier === 'none') return false;
  if (inQuietHours(s, at)) return false;
  if (n.tier === 'urgent' || n.category === 'needs_you') return true;
  if (n.category === 'automation') return s.automation;
  if (n.tier === 'quiet') return false;
  return s.finished;
}

export function normalizeSettings(raw: unknown): DeviceSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<DeviceSettings>;
  const q = (r.quietHours && typeof r.quietHours === 'object' ? r.quietHours : {}) as Partial<DeviceSettings['quietHours']>;
  return {
    finished: typeof r.finished === 'boolean' ? r.finished : DEFAULT_DEVICE_SETTINGS.finished,
    automation: typeof r.automation === 'boolean' ? r.automation : DEFAULT_DEVICE_SETTINGS.automation,
    quietHours: {
      enabled: typeof q.enabled === 'boolean' ? q.enabled : false,
      start: typeof q.start === 'string' && HHMM.test(q.start) ? q.start : DEFAULT_DEVICE_SETTINGS.quietHours.start,
      end: typeof q.end === 'string' && HHMM.test(q.end) ? q.end : DEFAULT_DEVICE_SETTINGS.quietHours.end,
    },
    ...(typeof r.timeZone === 'string' && r.timeZone.length < 64 && validZone(r.timeZone) ? { timeZone: r.timeZone } : {}),
  };
}
function validZone(tz: string): boolean { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } }

export interface PushOptions {
  /** Recompute an event's notice (after waiting for a chat's title). */
  noticeOf?: (kind: string, data: Record<string, unknown>) => Notice | null;
  /** A title is being generated for this chat right now: its first push
   *  waits (bounded) for the real name. Never true for a Work project. */
  titlePending?: (projectId: string, sessionId: string) => boolean;
  titleWaitMs?: number;
  presence?: Presence;
  /** The iOS app's devices. Absent: browsers only. */
  apns?: ApnsService;
  now?: () => number;
}

export class PushService {
  private vapid: { publicKey: string; privateKey: string };
  private subs: StoredSub[] = [];
  private claims = 0;

  constructor(private readonly stateDir: string, private readonly opts: PushOptions = {}) {
    this.vapid = this.loadOrCreateVapid();
    webpush.setVapidDetails('mailto:x056@val.id', this.vapid.publicKey, this.vapid.privateKey);
    this.subs = this.loadSubs();
    this.pruneSent();
  }

  private get dir(): string { return join(this.stateDir, 'push'); }
  private get vapidFile(): string { return join(this.dir, 'vapid.json'); }
  private get subsFile(): string { return join(this.dir, 'subscriptions.json'); }
  private now(): number { return (this.opts.now ?? Date.now)(); }

  get publicKey(): string { return this.vapid.publicKey; }
  get apns(): ApnsService | undefined { return this.opts.apns; }

  private loadOrCreateVapid(): { publicKey: string; privateKey: string } {
    if (existsSync(this.vapidFile)) {
      try {
        const v = JSON.parse(readFileSync(this.vapidFile, 'utf8')) as { publicKey?: string; privateKey?: string };
        if (v.publicKey && v.privateKey) return { publicKey: v.publicKey, privateKey: v.privateKey };
      } catch { /* fall through and regenerate */ }
    }
    const keys = webpush.generateVAPIDKeys();
    mkdirSync(this.dir, { recursive: true });
    this.writeAtomic(this.vapidFile, JSON.stringify(keys));
    return keys;
  }

  private loadSubs(): StoredSub[] {
    if (!existsSync(this.subsFile)) return [];
    try {
      const arr = JSON.parse(readFileSync(this.subsFile, 'utf8')) as StoredSub[];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  private saveSubs(): void {
    mkdirSync(this.dir, { recursive: true });
    this.writeAtomic(this.subsFile, JSON.stringify(this.subs));
  }

  private writeAtomic(file: string, data: string): void {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  }

  /** Register (or refresh) a browser subscription, deduped by endpoint. */
  add(sub: PushSubscription): void {
    if (!sub || typeof sub.endpoint !== 'string') throw new Error('invalid subscription');
    this.subs = this.subs.filter((s) => s.sub.endpoint !== sub.endpoint);
    this.subs.push({ sub, at: Date.now() });
    this.saveSubs();
  }

  remove(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.sub.endpoint !== endpoint);
    if (this.subs.length !== before) this.saveSubs();
  }

  subscribed(endpoint: string): boolean { return this.subs.some((s) => s.sub.endpoint === endpoint); }

  // ---- per-device settings (gateway.sqlite push_settings) ----
  settings(endpoint: string): DeviceSettings { return this.settingsFor(deviceKey(endpoint)); }
  private settingsFor(device: string): DeviceSettings {
    try {
      const row = gatewayDb(this.stateDir).prepare('SELECT data FROM push_settings WHERE device=?').get(device) as { data?: string } | undefined;
      return normalizeSettings(row?.data ? JSON.parse(row.data) : undefined);
    } catch { return normalizeSettings(undefined); }
  }
  saveSettings(endpoint: string, patch: Partial<DeviceSettings>): DeviceSettings {
    if (typeof endpoint !== 'string' || !endpoint) throw new Error('endpoint required');
    const cur = this.settings(endpoint);
    const next = normalizeSettings({ ...cur, ...patch, quietHours: { ...cur.quietHours, ...(patch?.quietHours ?? {}) } });
    gatewayDb(this.stateDir).prepare('INSERT INTO push_settings(device, data, updated_at) VALUES(?,?,?) ON CONFLICT(device) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at')
      .run(deviceKey(endpoint), JSON.stringify(next), this.now());
    return next;
  }

  // ---- sent ids (gateway.sqlite push_sent): a restart must not resend ----
  /** Record an id as sent; false when it already was. Synchronous, so two
   *  concurrent notifies for the same turn cannot both pass. */
  private claim(id: string): boolean {
    try {
      const r = gatewayDb(this.stateDir).prepare('INSERT OR IGNORE INTO push_sent(id, at) VALUES(?,?)').run(id, this.now());
      if (++this.claims % 200 === 0) this.pruneSent();
      return Number(r.changes) > 0;
    } catch { return true; /* storage trouble must not silence a notice */ }
  }
  private pruneSent(): void {
    try { gatewayDb(this.stateDir).prepare('DELETE FROM push_sent WHERE at < ?').run(this.now() - SENT_RETAIN_MS); } catch { /* best effort */ }
  }
  wasSent(id: string): boolean {
    try { return !!gatewayDb(this.stateDir).prepare('SELECT 1 FROM push_sent WHERE id=?').get(id); } catch { return false; }
  }

  /** Which device keys should get this notice right now; null = none. */
  private wanted(n: Notice): ((key: string) => boolean) | null {
    if (n.tier === 'none') return null;
    const p = this.opts.presence, at = this.now();
    // Nobody needs a buzz about the conversation they are reading.
    if (p?.viewing(n.projectId, n.sessionId)) return null;
    const loud = n.tier !== 'urgent';
    const visible = loud && p?.anyVisible() ? p.visibleDevices() : null;
    return (key) => {
      if (!deviceWants(n, this.settingsFor(key), at)) return false;
      // You are at a screen: the other devices stay quiet for anything that
      // is not urgent.
      if (visible && !visible.has(key)) return false;
      return true;
    };
  }

  /** The browsers that should get this notice right now. */
  targets(n: Notice): StoredSub[] {
    const ok = this.wanted(n);
    return ok ? this.subs.filter((s) => ok(deviceKey(s.sub.endpoint))) : [];
  }

  /** The iPhones (APNs tokens) that should get this notice right now. */
  apnsTargets(n: Notice): string[] {
    const ok = this.opts.apns?.hasTargets() ? this.wanted(n) : null;
    return ok ? this.opts.apns!.tokens().filter((t) => ok(deviceKey(apnsEndpoint(t)))) : [];
  }

  /** Send an event's notice, if it has one worth a push. */
  async notify(kind: string, data: Record<string, unknown>): Promise<void> {
    if (this.subs.length === 0 && !this.opts.apns?.hasTargets()) return;
    // Every event passes through here (text chunks included): only the kinds
    // a notice can come from are worth a lookup.
    if (!NOTICE_KINDS.has(kind)) return;
    let notice = (data.notice as Notice | undefined) ?? this.opts.noticeOf?.(kind, data) ?? null;
    if (!notice || notice.tier === 'none') return;
    let targets = this.targets(notice), phones = this.apnsTargets(notice);
    if (!targets.length && !phones.length) return;
    if (notice.id && !this.claim(notice.id)) return;
    const pid = notice.projectId, sid = notice.sessionId;
    if (pid && sid && this.opts.titlePending?.(pid, sid)) {
      const wait = this.opts.titleWaitMs ?? 12_000;
      for (let waited = 0; waited < wait && this.opts.titlePending(pid, sid); waited += 500) await new Promise((r) => setTimeout(r, 500));
      notice = this.opts.noticeOf?.(kind, data) ?? notice;
      targets = this.targets(notice);
      phones = this.apnsTargets(notice);
    }
    await Promise.all([
      this.send(targets, notice),
      phones.length ? this.opts.apns!.send(notice, phones).catch((err) => console.warn('[apns] send failed:', (err as Error).message)) : undefined,
    ]);
  }

  /** A normal-tier test push to ONE device, past presence and quiet hours. */
  async test(endpoint: string): Promise<boolean> {
    const s = this.subs.find((x) => x.sub.endpoint === endpoint);
    if (!s) return false;
    await this.send([s], { tier: 'normal', category: 'finished', kind: 'test', title: 'x056 test notification', body: 'Notifications reach this device.', link: '/', tag: 'x056-test' });
    return true;
  }

  private async send(targets: StoredSub[], n: Notice): Promise<void> {
    if (!targets.length) return;
    const json = JSON.stringify({
      title: n.title, body: n.body, tag: n.tag, url: n.link, tier: n.tier, kind: n.kind,
      projectId: n.projectId ?? '', sessionId: n.sessionId ?? '', ...(n.id ? { notificationId: n.id } : {}),
    });
    const dead: string[] = [];
    await Promise.all(targets.map(async (s) => {
      try {
        await webpush.sendNotification(s.sub, json);
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(s.sub.endpoint); // subscription gone — prune it
      }
    }));
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.sub.endpoint));
      this.saveSubs();
    }
  }
}
