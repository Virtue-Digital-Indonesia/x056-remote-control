import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexAdapter } from '../src/adapters/codex.js';
import { codexTurnForAccount, currentCodexModel, olderCodexModels } from '../src/codex-model-policy.js';

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
    const stale = home(['gpt-6-sol', 'gpt-5.5'], 60 * 60_000);
    const fresh = home(['gpt-6-astra', 'gpt-6-sol']);
    const slugs = codexAdapter.listModels!([stale, fresh]).map((m) => m.slug);
    expect(slugs).toEqual(['gpt-6-astra', 'gpt-6-sol', 'gpt-5.5']);
  });

  it('lists each slug once, with the freshest account\'s metadata', () => {
    const stale = home(['gpt-6-sol'], 60 * 60_000);
    const fresh = home(['gpt-6-sol']);
    const models = codexAdapter.listModels!([fresh, stale]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ slug: 'gpt-6-sol', label: 'GPT-6-SOL', efforts: ['medium'], defaultEffort: 'medium' });
  });

  it('skips hidden entries and accounts with no cache yet', () => {
    const never = mkdtempSync(join(tmpdir(), 'x056-models-empty-'));
    const one = home(['gpt-5.5', 'hidden']);
    expect(codexAdapter.listModels!([never, one]).map((m) => m.slug)).toEqual(['gpt-5.5']);
    expect(codexAdapter.listModels!([never]).map(m => m.slug)).toEqual([]);
  });
});

it('retired caches cannot reintroduce GPT-5.6 Sol or Luna', () => {
  const models = codexAdapter.listModels!([home(['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.6-terra'])]);
  expect(models.map(m => m.slug)).toEqual(['gpt-5.6-terra']);
});

it('uses real replacement entries without inventing models for empty caches', () => {
  expect(codexAdapter.listModels!([home(['gpt-6-sol', 'gpt-6-luna'])]).map(m => m.slug)).toEqual(['gpt-6-sol', 'gpt-6-luna']);
  expect(codexAdapter.listModels!([])).toEqual([]);
});

describe('GPT-6.1-Sol rolls out plan by plan', () => {
  it('replaces GPT-6-Sol in the picker once any account is offered it', () => {
    const pro = home(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']);
    const business = home(['gpt-6-sol', 'gpt-6-astra'], 60_000);
    expect(codexAdapter.listModels!([pro, business]).map(m => m.slug)).toEqual(['gpt-6.1-sol', 'gpt-6-astra']);
  });

  it('keeps GPT-6-Sol while no account has its successor', () => {
    expect(codexAdapter.listModels!([home(['gpt-6-sol', 'gpt-6-astra'])]).map(m => m.slug)).toEqual(['gpt-6-sol', 'gpt-6-astra']);
  });

  it('maps every older Sol forward and knows the line back', () => {
    expect(currentCodexModel('gpt-5.6-sol')).toBe('gpt-6.1-sol');
    expect(currentCodexModel('gpt-6-sol')).toBe('gpt-6.1-sol');
    expect(currentCodexModel('gpt-6-luna')).toBe('gpt-6-luna');
    expect(olderCodexModels('gpt-6.1-sol')).toEqual(['gpt-6-sol', 'gpt-5.6-sol']);
  });

  it('runs a turn on the predecessor where the account lacks the model', () => {
    const business = home(['gpt-6-sol', 'gpt-6-astra']);
    expect(codexTurnForAccount(business, 'gpt-6.1-sol', 'medium')).toEqual({ model: 'gpt-6-sol', effort: 'medium' });
    const pro = home(['gpt-6.1-sol', 'gpt-6-sol']);
    expect(codexTurnForAccount(pro, 'gpt-6.1-sol', 'medium')).toEqual({ model: 'gpt-6.1-sol', effort: 'medium' });
    // No catalog yet: the account's CLI decides; nothing is guessed.
    expect(codexTurnForAccount(mkdtempSync(join(tmpdir(), 'x056-models-empty-')), 'gpt-6.1-sol', 'high')).toEqual({ model: 'gpt-6.1-sol', effort: 'high' });
    // Not in the line at all: unchanged.
    expect(codexTurnForAccount(business, 'gpt-6-luna', 'max')).toEqual({ model: 'gpt-6-luna', effort: 'max' });
  });

  it('clamps an effort the fallback model does not support', () => {
    const offered = new Map([['gpt-6-sol', ['low', 'medium', 'high', 'max']]]);
    expect(codexTurnForAccount('/nowhere', 'gpt-6.1-sol', 'ultra', offered)).toEqual({ model: 'gpt-6-sol', effort: 'max' });
  });
});
