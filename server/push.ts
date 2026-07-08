import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import type { PushSubscription } from 'web-push';

/**
 * Self-contained Web Push: generates+persists a VAPID keypair, stores browser
 * push subscriptions, and pushes a notification when a turn needs the user
 * (asks a question), finishes, or was interrupted by a restart. Lets the panel,
 * installed to an iOS/Android home screen, buzz the phone while it's closed.
 */
export interface StoredSub {
  sub: PushSubscription;
  at: number;
}

const NOTIFY_KINDS = new Set(['question', 'session_done', 'turn_orphaned', 'autopilot']);

export class PushService {
  private vapid: { publicKey: string; privateKey: string };
  private subs: StoredSub[] = [];

  constructor(
    private readonly stateDir: string,
    private readonly nameOf: (pid: string) => string,
    private readonly isAutopilot: (sessionId: string) => boolean,
  ) {
    this.vapid = this.loadOrCreateVapid();
    webpush.setVapidDetails('mailto:x056@val.id', this.vapid.publicKey, this.vapid.privateKey);
    this.subs = this.loadSubs();
  }

  private get dir(): string { return join(this.stateDir, 'push'); }
  private get vapidFile(): string { return join(this.dir, 'vapid.json'); }
  private get subsFile(): string { return join(this.dir, 'subscriptions.json'); }

  get publicKey(): string { return this.vapid.publicKey; }

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

  /** Turn a gateway event into a push, when it's one the user should know about.
   *  Autopilot projects emit session_done every step, so those are suppressed —
   *  the user is pinged only when autopilot as a whole finishes/stops. */
  async notify(kind: string, data: Record<string, unknown>): Promise<void> {
    if (!NOTIFY_KINDS.has(kind) || this.subs.length === 0) return;
    const pid = typeof data.projectId === 'string' ? data.projectId : '';
    const project = pid ? this.nameOf(pid) : 'a project';
    let title = '', body = '';
    if (kind === 'question') {
      title = `${project} needs you`;
      body = typeof data.question === 'string' ? String(data.question).slice(0, 140) : 'Claude asked a question';
    } else if (kind === 'session_done') {
      const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
      if (sid && this.isAutopilot(sid)) return; // mid-autopilot step, not a real stop
      const status = typeof data.status === 'string' ? data.status : 'done';
      title = status === 'completed' ? `${project} finished` : `${project} stopped`;
      body = status === 'completed' ? 'The turn completed — tap to continue.' : `Turn ${status}.`;
    } else if (kind === 'turn_orphaned') {
      title = `${project} was interrupted`;
      body = 'A turn stopped mid-flight — tap to resume.';
    } else if (kind === 'autopilot') {
      // Only the terminal states; 'stopped' is a deliberate user action, skip it.
      if (data.active !== false) return;
      const reason = typeof data.reason === 'string' ? data.reason : '';
      if (!reason || reason === 'stopped') return;
      title = reason === 'done' ? `${project} autopilot done` : `${project} autopilot stopped`;
      body = reason === 'done' ? 'The task reported complete.' : `Autopilot ${reason}.`;
    }
    if (!title) return;
    await this.sendToAll({ title, body, projectId: pid });
  }

  private async sendToAll(payload: { title: string; body: string; projectId: string }): Promise<void> {
    const json = JSON.stringify(payload);
    const dead: string[] = [];
    await Promise.all(this.subs.map(async (s) => {
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
