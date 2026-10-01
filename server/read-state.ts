import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read and unread, shared by every client. The panel used to keep this in
 * the browser (localStorage seen-watermarks) and the iOS app on the phone,
 * so reading a conversation on one never cleared it on the other.
 *
 * Per conversation the gateway keeps three moments: when it was last read,
 * when someone marked it unread, and its last notable event (a question, a
 * failed or parked turn, a finished turn), raised by the same rules the
 * clients used. It is unread when the newest of the last two is after the
 * read. A notable event in a conversation someone has on screen (presence)
 * counts as read at once, like the clients' own "on screen" rule.
 *
 * Every change is broadcast as a `read_state` event, so the other device
 * follows within a second.
 */
export type NoticeKind = 'question' | 'failed' | 'done';

export interface ReadItem {
  readAt?: number;
  unreadAt?: number;
  noticeAt?: number;
  noticeKind?: NoticeKind;
}

export interface ReadView extends ReadItem {
  projectId: string;
  sessionId: string;
  unread: boolean;
  /** What the unread is about: 'unread' when marked by hand. */
  kind?: NoticeKind | 'unread';
}

const RANK: Record<NoticeKind, number> = { question: 3, failed: 2, done: 1 };

export function isUnread(i: ReadItem): boolean {
  return Math.max(i.noticeAt ?? 0, i.unreadAt ?? 0) > (i.readAt ?? 0);
}

export class ReadState {
  private items: Record<string, ReadItem>;

  constructor(
    private readonly stateDir: string,
    /** Publish a `read_state` event (manager.broadcast). */
    private readonly publish: (kind: string, data: Record<string, unknown>) => void = () => {},
    /** Some client has this conversation on screen right now. */
    private readonly viewing: (projectId: string, sessionId: string) => boolean = () => false,
    private readonly now: () => number = Date.now,
  ) {
    this.items = this.load();
  }

  private get file(): string { return join(this.stateDir, 'read-state.json'); }

  static key(projectId: string, sessionId: string): string { return projectId + '::' + sessionId; }

  view(projectId: string, sessionId: string): ReadView {
    const i = this.items[ReadState.key(projectId, sessionId)] ?? {};
    const unread = isUnread(i);
    const kind = !unread ? undefined : (i.unreadAt ?? 0) > (i.noticeAt ?? 0) ? 'unread' : i.noticeKind;
    return { projectId, sessionId, ...i, unread, ...(kind ? { kind } : {}) };
  }

  list(): Record<string, ReadView> {
    const out: Record<string, ReadView> = {};
    for (const k of Object.keys(this.items)) {
      const i = k.indexOf('::');
      out[k] = this.view(k.slice(0, i), k.slice(i + 2));
    }
    return out;
  }

  /** Gateway events in, notable ones recorded. */
  observe(kind: string, data: Record<string, unknown>): void {
    const pid = typeof data.projectId === 'string' ? data.projectId : '';
    const sid = typeof data.sessionId === 'string' ? data.sessionId : '';
    if (!pid || !sid) return;
    const tier = (data.notice as { tier?: string } | undefined)?.tier;
    switch (kind) {
      case 'question':
        return this.notice(pid, sid, 'question');
      case 'conversation_settled':
        if (data.notificationSuppressed !== true && tier !== 'none') this.notice(pid, sid, 'done');
        return;
      case 'session_done':
        if (data.status === 'failed' || data.status === 'parked') this.notice(pid, sid, 'failed');
        else if (data.status === 'stopped') this.read(pid, sid);
        return;
      case 'session_error':
      case 'cron_failed':
        return this.notice(pid, sid, 'failed');
      case 'delegate_report':
        if (tier === 'urgent') this.notice(pid, sid, 'question');
        return;
      case 'question_dismissed':
        this.read(pid, sid);
        return;
    }
  }

  read(projectId: string, sessionId: string): ReadView {
    return this.change(projectId, sessionId, (i) => { i.readAt = this.stamp(i); });
  }

  unread(projectId: string, sessionId: string): ReadView {
    return this.change(projectId, sessionId, (i) => { i.unreadAt = this.stamp(i); });
  }

  /** Read every unread conversation, or only those named. */
  readAll(keys?: string[]): number {
    const targets = (keys ?? Object.keys(this.items)).filter((k) => this.items[k] && isUnread(this.items[k]));
    for (const k of targets) {
      const i = k.indexOf('::');
      this.read(k.slice(0, i), k.slice(i + 2));
    }
    return targets.length;
  }

  private notice(projectId: string, sessionId: string, kind: NoticeKind): void {
    this.change(projectId, sessionId, (i) => {
      // An unread question stays a question when its turn then finishes.
      const keep = isUnread(i) && i.noticeKind && RANK[i.noticeKind] > RANK[kind] ? i.noticeKind : kind;
      i.noticeAt = this.stamp(i);
      i.noticeKind = keep;
      if (this.viewing(projectId, sessionId)) i.readAt = i.noticeAt;
    });
  }

  /** Strictly increasing per conversation, so two changes in the same
   *  millisecond still order. */
  private stamp(i: ReadItem): number {
    return Math.max(this.now(), (i.readAt ?? 0) + 1, (i.unreadAt ?? 0) + 1, (i.noticeAt ?? 0) + 1);
  }

  private change(projectId: string, sessionId: string, fn: (i: ReadItem) => void): ReadView {
    const k = ReadState.key(projectId, sessionId);
    const i = { ...(this.items[k] ?? {}) };
    fn(i);
    this.items[k] = i;
    this.save();
    const v = this.view(projectId, sessionId);
    this.publish('read_state', { ...v });
    return v;
  }

  private load(): Record<string, ReadItem> {
    if (!existsSync(this.file)) return {};
    try {
      const o = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, ReadItem>;
      return o && typeof o === 'object' ? o : {};
    } catch { return {}; }
  }

  private save(): void {
    mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.items));
    renameSync(tmp, this.file);
  }
}
