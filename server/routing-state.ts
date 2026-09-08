import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readState, writeState } from './workspace-store.js';
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
  history(pid?: string, sid?: string): RouteRecord[] {
    return readState<RouteRecord[]>(join(this.state, 'routing-history.json'), []).filter(
      (x) => (!pid || x.projectId === pid) && (!sid || x.sessionId === sid),
    );
  }
  record(row: Omit<RouteRecord, 'id' | 'at'>) {
    const rows = this.history();
    rows.unshift({ ...row, id: randomUUID(), at: new Date().toISOString() });
    writeState(join(this.state, 'routing-history.json'), rows.slice(0, 3000));
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
