import type { Account } from '../src/accounts.js';
import { getAdapter } from '../src/adapters/registry.js';

type HealthAccount = Account & {
  displayName?: string;
  email?: string;
  quotaAt?: number;
  quotaStale?: boolean;
  quotaError?: string;
  quotaRetryAt?: number;
};
/** Read local credentials/catalogs and cached usage; never launch a paid probe. */
export function accountHealth(accounts: HealthAccount[], loads: Record<string, number>, model?: string) {
  return accounts.map((a) => {
    const adapter = getAdapter(a.provider),
      credentials = adapter.hasCredentials?.(a.configDir);
    const catalog = adapter.listModels?.([a.configDir]) || [];
    const providerMismatch =
      !!model && (a.provider === 'codex' ? !/^(gpt-|codex-)/i.test(model) : /^(gpt-|codex-)/i.test(model));
    const compatibility = !model
      ? 'No model selected'
      : providerMismatch
        ? 'Different provider'
        : !catalog.length
          ? 'Catalog unavailable'
          : catalog.some((m) => m.slug === model)
            ? 'Listed in account catalog'
            : 'Not listed in cached catalog';
    return {
      name: a.name,
      displayName: a.label || a.displayName || a.email || adapter.label,
      provider: a.provider,
      credentials:
        a.state.kind === 'unauthenticated' || credentials === false
          ? 'Sign-in required'
          : credentials === true
            ? 'Local credentials present; validity not tested'
            : 'Credential status unknown',
      state: a.state,
      paused: !!a.paused,
      load: loads[a.name] || 0,
      maxConcurrent: a.maxConcurrent || 0,
      reservePercent: a.reservePercent || 0,
      quotaAt: a.quotaAt,
      quotaStale: !!a.quotaStale || !a.quotaAt || Date.now() - a.quotaAt > 300000,
      quotaError: a.quotaError,
      quotaRetryAt: a.quotaRetryAt,
      model: model || null,
      compatibility,
    };
  });
}
