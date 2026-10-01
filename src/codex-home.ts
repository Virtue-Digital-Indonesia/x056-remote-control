/**
 * Codex homes still building their index of the shared rollout store.
 *
 * The first `codex app-server` in a CODEX_HOME runs a "state db backfill" over
 * everything under `sessions/` -- linked to the shared store, that is every
 * rollout on the gateway (3.5 GB, 205 threads, 224 s on 2026-09-30) -- and
 * answers nothing, not even `initialize`, until it is done. A turn routed
 * there dies at the 30 s handshake timeout and the next start begins the
 * index again, so the account fails every turn with exit 1 and no message.
 * While a home is being prepared the router skips it.
 */
import { resolve } from 'node:path';

const preparing = new Map<string, number>();

export function markCodexHomePreparing(configDir: string, on: boolean): void {
  if (on) preparing.set(resolve(configDir), Date.now());
  else preparing.delete(resolve(configDir));
}

export function codexHomePreparing(configDir: string): boolean {
  return preparing.has(resolve(configDir));
}

export const CODEX_INDEXING_REASON = 'Indexing the shared session store (first start; a few minutes)';
