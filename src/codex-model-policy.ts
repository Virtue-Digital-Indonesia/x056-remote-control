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
