import { createHash } from 'node:crypto';

/**
 * Who is looking at the panel right now, and at what. Safari makes every Web
 * Push show a notification, so the service worker cannot decide to stay
 * silent; the gateway has to decide before sending. Each open panel reports
 * itself (`POST /api/presence`) every 15 s while visible and on every focus,
 * blur or conversation change; a report older than the TTL counts as gone.
 */
export interface PresenceReport {
  clientId: string;
  projectId?: string | null;
  sessionId?: string | null;
  visible: boolean;
  /** This browser's push subscription endpoint, if it has one: lets the
   *  gateway tell "the device you are at" from "your other devices". */
  endpoint?: string | null;
}

interface Entry { projectId?: string; sessionId?: string; visible: boolean; device?: string; at: number }

export const PRESENCE_TTL_MS = 30_000;

/** The key a device's settings and presence share: never the raw endpoint. */
export function deviceKey(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 24);
}

export class Presence {
  private clients = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = PRESENCE_TTL_MS) {}

  update(r: PresenceReport): void {
    if (!r || typeof r.clientId !== 'string' || !r.clientId || r.clientId.length > 100) throw new Error('clientId required');
    this.prune();
    this.clients.set(r.clientId, {
      projectId: typeof r.projectId === 'string' && r.projectId ? r.projectId : undefined,
      sessionId: typeof r.sessionId === 'string' && r.sessionId ? r.sessionId : undefined,
      visible: !!r.visible,
      device: typeof r.endpoint === 'string' && r.endpoint ? deviceKey(r.endpoint) : undefined,
      at: this.now(),
    });
    if (this.clients.size > 500) this.clients.delete(this.clients.keys().next().value!);
  }

  private live(): Entry[] {
    const cut = this.now() - this.ttlMs;
    return [...this.clients.values()].filter((e) => e.visible && e.at >= cut);
  }
  private prune(): void {
    const cut = this.now() - this.ttlMs;
    for (const [k, e] of this.clients) if (e.at < cut) this.clients.delete(k);
  }

  /** Some visible panel has this conversation on screen. */
  viewing(projectId?: string, sessionId?: string): boolean {
    if (!sessionId) return false;
    return this.live().some((e) => e.sessionId === sessionId && (!projectId || !e.projectId || e.projectId === projectId));
  }
  anyVisible(): boolean { return this.live().length > 0; }
  /** Device keys of visible panels that reported a push endpoint. */
  visibleDevices(): Set<string> {
    return new Set(this.live().map((e) => e.device).filter((d): d is string => !!d));
  }
}
