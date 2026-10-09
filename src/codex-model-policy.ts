import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Each Codex model and the one that replaced it. A retired selection maps
 * forward at dispatch, without rewriting transcript history.
 */
const SUCCESSOR: Record<string, string> = {
  'gpt-5.6-sol': 'gpt-6-sol',
  'gpt-6-sol': 'gpt-6.1-sol',
  'gpt-5.6-luna': 'gpt-6-luna',
};

/** The newest model in `model`'s line. */
export function currentCodexModel(model: string): string {
  let current = model;
  for (let i = 0; i < 8 && SUCCESSOR[current]; i++) current = SUCCESSOR[current];
  return current;
}

/** The models `model` replaced, newest first: where a turn falls back to on an
 *  account that has not been offered `model` yet. */
export function olderCodexModels(model: string): string[] {
  const out: string[] = [];
  for (let current = model, i = 0; i < 8; i++) {
    const older = Object.keys(SUCCESSOR).find((k) => SUCCESSOR[k] === current);
    if (!older) break;
    out.push(older); current = older;
  }
  return out;
}

/** Withdrawn by OpenAI: hidden even from an account whose old catalog lists it. */
const RETIRED = new Set(['gpt-5.6-sol', 'gpt-5.6-luna']);

/** True when the picker should not offer `model`: it is retired, or a newer
 *  model in its line is among `offered`. */
export function supersededCodexModel(model: string, offered: Set<string>): boolean {
  if (RETIRED.has(model)) return true;
  for (let current = SUCCESSOR[model], i = 0; current && i < 8; current = SUCCESSOR[current], i++) {
    if (offered.has(current)) return true;
  }
  return false;
}

export function currentCodexPrefs(model: string, effort: string): { model: string; effort: string } {
  const current = currentCodexModel(model);
  // Codex 0.156.1 supports ultra on Sol, but Luna stops at max.
  return { model: current, effort: current === 'gpt-6-luna' && effort === 'ultra' ? 'max' : effort };
}

interface CachedModel { slug?: string; supported_reasoning_levels?: { effort?: string }[] }

/** The account's own catalog, as its CLI last cached it; undefined when unknown. */
export function offeredCodexModels(configDir: string): Map<string, string[]> | undefined {
  try {
    const cache = JSON.parse(readFileSync(join(configDir, 'models_cache.json'), 'utf8')) as { models?: CachedModel[] };
    if (!Array.isArray(cache.models) || !cache.models.length) return undefined;
    return new Map(cache.models.filter((m) => m.slug).map((m) => [m.slug!, (m.supported_reasoning_levels ?? []).map((l) => l.effort ?? '').filter(Boolean)]));
  } catch {
    return undefined;
  }
}

/**
 * What one turn runs on this account. OpenAI rolls a new model out plan by
 * plan (GPT-6.1-Sol reached Pro before Business), so the selector can offer a
 * model that the account a failover lands on does not have yet; asking for it
 * there fails the turn. Such a turn runs on the newest predecessor the account
 * does have, with the effort clamped to what that model supports.
 */
export function codexTurnForAccount(configDir: string, model: string | undefined, effort: string | undefined, offered = offeredCodexModels(configDir)): { model?: string; effort?: string } {
  if (!model || !offered || offered.has(model)) return { model, effort };
  const fallback = olderCodexModels(model).find((m) => offered.has(m) && !RETIRED.has(m));
  if (!fallback) return { model, effort };
  const levels = offered.get(fallback) ?? [];
  const fits = !effort || !levels.length || levels.includes(effort);
  return { model: fallback, effort: fits ? effort : levels.includes('max') ? 'max' : levels[levels.length - 1] };
}

/** The Speed switch: what the user picks, and the service-tier id Codex knows
 *  it by. Off is "no tier", never a value. */
export type Speed = 'fast' | 'ultrafast';
export const SPEED_TIER: Record<Speed, string> = { fast: 'priority', ultrafast: 'ultrafast' };

/** Anything that is not a known speed is off. */
export function asSpeed(value: unknown): Speed | undefined {
  return value === 'fast' || value === 'ultrafast' ? value : undefined;
}

interface CachedTierModel { slug?: string; visibility?: string; service_tiers?: { id?: string }[] }

/** Service-tier ids each model offers on this account, from its own catalog;
 *  undefined when the catalog is unknown. */
export function offeredCodexTiers(configDir: string): Map<string, string[]> | undefined {
  try {
    const cache = JSON.parse(readFileSync(join(configDir, 'models_cache.json'), 'utf8')) as { models?: CachedTierModel[] };
    if (!Array.isArray(cache.models) || !cache.models.length) return undefined;
    return new Map(cache.models.filter((m) => m.slug && m.visibility !== 'hide').map((m) => [m.slug!, (m.service_tiers ?? []).map((t) => t.id ?? '').filter(Boolean)]));
  } catch {
    return undefined;
  }
}

/**
 * The speed one turn really runs at on this account and model. Plans differ
 * (Ultrafast is on the highest plan and on two models only), so a request the
 * account/model does not list steps down: Ultrafast to Fast, Fast to off. A
 * tier is never sent unless the catalog lists it; an unknown catalog is off.
 * With no model named the CLI default applies, so the tier must be on every
 * listed model.
 */
export function codexSpeedForAccount(configDir: string, model: string | undefined, speed: Speed | undefined, tiers = offeredCodexTiers(configDir)): { speed?: Speed; from?: Speed } {
  if (!speed) return {};
  const has = (tier: string) => {
    if (!tiers) return false;
    if (model) return !!tiers.get(model)?.includes(tier);
    return tiers.size > 0 && [...tiers.values()].every((t) => t.includes(tier));
  };
  const order: Speed[] = speed === 'ultrafast' ? ['ultrafast', 'fast'] : ['fast'];
  const got = order.find((s) => has(SPEED_TIER[s]));
  return got === speed ? { speed } : { ...(got ? { speed: got } : {}), from: speed };
}
