import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readState, writeState } from './workspace-store.js';
import { gatewayDb, putRoute, trimRoutingHistory } from './gateway-db.js';
import { transaction } from './sqlite.js';
import type { AccountRouteContext } from '../src/accounts.js';
export interface ConversationRoute {
  lockedAccount?: string;
  nextAccount?: string;
  useReserve?: boolean;
  updatedAt?: number;
}
export interface RouteRecord {
  id: string;
  at: string;
  projectId: string;
  sessionId: string;
  kind: string;
  provider?: string;
  account?: string;
  model?: string;
  detail: Record<string, unknown>;
}
export interface HandoffLink {
  id: string;
  projectId: string;
  sourceSessionId: string;
  targetSessionId: string;
  at: string;
  targetProvider: string;
  context: string;
}
export class RoutingState {
  constructor(private state: string) {}
  preferences(): Record<string, ConversationRoute> {
    return readState(join(this.state, 'conversation-routing.json'), {});
  }
  get(pid: string, sid: string): ConversationRoute {
    return this.preferences()[pid + '::' + sid] || {};
  }
  set(pid: string, sid: string, patch: ConversationRoute): ConversationRoute {
    const all = this.preferences(),
      key = pid + '::' + sid;
    all[key] = { ...all[key], ...patch, updatedAt: Math.max(Date.now(), (all[key]?.updatedAt || 0) + 1) };
    writeState(join(this.state, 'conversation-routing.json'), all);
    return all[key];
  }
  context(pid: string, sid: string): AccountRouteContext {
    const p = this.get(pid, sid);
    return { lockedAccount: p.lockedAccount, preferredAccount: p.nextAccount, useReserve: p.useReserve };
  }
  /** Newest first, at most ROUTING_HISTORY_CAP rows (gateway.sqlite). */
  history(pid?: string, sid?: string): RouteRecord[] {
    const where = [pid && 'project_id=?', sid && 'session_id=?'].filter(Boolean);
    return gatewayDb(this.state)
      .prepare(`SELECT data FROM routing_history${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC`)
      .all(...[pid, sid].filter((x): x is string => !!x))
      .map((r) => JSON.parse(String(r.data)) as RouteRecord);
  }
  record(row: Omit<RouteRecord, 'id' | 'at'>) {
    const db = gatewayDb(this.state);
    transaction(db, () => {
      putRoute(db, { ...row, id: randomUUID(), at: new Date().toISOString() });
      trimRoutingHistory(db);
    });
  }
  links(): HandoffLink[] {
    return readState(join(this.state, 'provider-handoffs.json'), []);
  }
  link(row: Omit<HandoffLink, 'id' | 'at'>) {
    const rows = this.links(),
      entry = { ...row, id: randomUUID(), at: new Date().toISOString() };
    rows.unshift(entry);
    writeState(join(this.state, 'provider-handoffs.json'), rows);
    return entry;
  }
}
