import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import type { ProviderAdapter, ProviderId } from '../provider.js';

/** The provider adapters this gateway can drive, keyed by account.provider.
 *  A separate module (not provider.ts) so the interface stays dependency-free
 *  and importing the concrete adapters can't create a cycle. */
export const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getAdapter(id: ProviderId): ProviderAdapter {
  const a = ADAPTERS[id];
  if (!a) throw new Error(`no adapter for provider: ${id}`);
  return a;
}
