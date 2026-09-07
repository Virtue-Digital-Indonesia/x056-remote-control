import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';

/** A CODEX_HOME holding a models_cache.json as the CLI writes it. */
function home(slugs: string[], ageMs = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'x056-models-'));
  const path = join(dir, 'models_cache.json');
  writeFileSync(path, JSON.stringify({
    models: slugs.map((slug) => ({
      slug, display_name: slug.toUpperCase(), visibility: slug === 'hidden' ? 'hide' : 'list',
      supported_reasoning_levels: [{ effort: 'medium' }], default_reasoning_level: 'medium',
    })),
  }));
  const t = new Date(Date.now() - ageMs);
  utimesSync(path, t, t);
  return dir;
}

describe('codex listModels across the fleet', () => {
  // The cache is only rewritten when that account runs, so a revoked account
  // keeps a catalog from before gpt-6-astra shipped. Reading the first account
  // alone hid the model while two healthy accounts had it.
  it('offers a model any account has, ordered by the freshest catalog', () => {
    const stale = home(['gpt-5.6-sol', 'gpt-5.5'], 60 * 60_000);
    const fresh = home(['gpt-6-astra', 'gpt-5.6-sol']);
    const slugs = codexAdapter.listModels!([stale, fresh]).map((m) => m.slug);
    expect(slugs).toEqual(['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.5']);
  });

  it('lists each slug once, with the freshest account\'s metadata', () => {
    const stale = home(['gpt-5.6-sol'], 60 * 60_000);
    const fresh = home(['gpt-5.6-sol']);
    const models = codexAdapter.listModels!([fresh, stale]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ slug: 'gpt-5.6-sol', label: 'GPT-5.6-SOL', efforts: ['medium'], defaultEffort: 'medium' });
  });

  it('skips hidden entries and accounts with no cache yet', () => {
    const never = mkdtempSync(join(tmpdir(), 'x056-models-empty-'));
    const one = home(['gpt-5.5', 'hidden']);
    expect(codexAdapter.listModels!([never, one]).map((m) => m.slug)).toEqual(['gpt-5.5']);
    expect(codexAdapter.listModels!([never])).toEqual([]);
  });
});
