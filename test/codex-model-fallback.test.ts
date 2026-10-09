import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import type { TurnOptions } from '../src/turn.js';
import { codexSpeedForAccount } from '../src/codex-model-policy.js';
import { codexAdapter } from '../src/adapters/codex.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function catalog(dir: string, slugs: string[]) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: 'list', supported_reasoning_levels: ['low', 'high', 'ultra'].map((effort) => ({ effort })) })) }));
}

// GPT-6.1-Sol reached the Pro account before the Business ones. A turn that
// failover lands on a Business account must still run, on GPT-6-Sol.
it('a Codex turn runs on the model the chosen account has, and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'x056-fallback-')); dirs.push(dir);
  const pro = join(dir, 'e'), business = join(dir, 'd');
  catalog(pro, ['gpt-6.1-sol', 'gpt-6-sol']);
  catalog(business, ['gpt-6-sol']);
  AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'e', configDir: pro, provider: 'codex' },
    { name: 'd', configDir: business, provider: 'codex' },
  ]);
  const mgr = new SessionManager({ stateDir: dir, workspaceRoot: dir });
  const started: TurnOptions[] = [], rows: Record<string, unknown>[] = [];
  const adapter = { id: 'codex', startTurn: (o: TurnOptions) => { started.push(o); return {} as never; } };
  const m = mgr as unknown as { persistentCodex?: unknown; turnStarter: (a: unknown, l: unknown, s: string, w: (o: TurnOptions) => TurnOptions) => (o: TurnOptions) => unknown };
  m.persistentCodex = undefined;
  const start = m.turnStarter(adapter, { append: (r: Record<string, unknown>) => rows.push(r) }, 'sess-12345678', (o) => o);
  const turn = { cwd: dir, sessionId: 'sess-12345678', mode: 'new', prompt: 'hi', model: 'gpt-6.1-sol', effort: 'ultra' } as TurnOptions;

  start({ ...turn, configDir: pro });
  start({ ...turn, configDir: business });
  expect(started.map((o) => [o.model, o.effort])).toEqual([['gpt-6.1-sol', 'ultra'], ['gpt-6-sol', 'ultra']]);
  expect(rows).toEqual([{ type: 'model_fallback', sessionId: 'sess-12345678', account: 'd', from: 'gpt-6.1-sol', to: 'gpt-6-sol', effort: 'ultra' }]);
});

function tierCatalog(dir: string, tiers: Record<string, string[]>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models_cache.json'), JSON.stringify({ models: Object.entries(tiers).map(([slug, ids]) => ({ slug, visibility: 'list', service_tiers: ids.map((id) => ({ id, name: id, description: id + ' desc' })) })) }));
}

describe('Speed: the tier a turn really runs with', () => {
  const tiers = new Map([['gpt-6.1-sol', ['priority', 'ultrafast']], ['gpt-6-sol', ['priority']], ['gpt-5.6-terra', []]]);
  it('steps Ultrafast down to Fast, and Fast down to off, never sending an unlisted tier', () => {
    expect(codexSpeedForAccount('/x', 'gpt-6.1-sol', 'ultrafast', tiers)).toEqual({ speed: 'ultrafast' });
    expect(codexSpeedForAccount('/x', 'gpt-6-sol', 'ultrafast', tiers)).toEqual({ speed: 'fast', from: 'ultrafast' });
    expect(codexSpeedForAccount('/x', 'gpt-5.6-terra', 'fast', tiers)).toEqual({ from: 'fast' });
    expect(codexSpeedForAccount('/x', 'gpt-6-sol', undefined, tiers)).toEqual({});
    expect(codexSpeedForAccount('/x', 'gpt-6-sol', 'fast', undefined)).toEqual({ from: 'fast' }); // unknown catalog = off
    expect(codexSpeedForAccount('/x', undefined, 'fast', tiers)).toEqual({ from: 'fast' }); // default model: must be on every model
  });

  it('a turn on an account without Ultrafast runs Fast and logs speed_fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-speed-')); dirs.push(dir);
    const high = join(dir, 'g'), pro = join(dir, 'e'), none = join(dir, 'k');
    tierCatalog(high, { 'gpt-6.1-sol': ['priority', 'ultrafast'] });
    tierCatalog(pro, { 'gpt-6.1-sol': ['priority'] });
    tierCatalog(none, { 'gpt-6.1-sol': [] });
    AccountRegistry.init(join(dir, 'accounts.json'), [high, pro, none].map((d, i) => ({ name: 'gek'[i], configDir: d, provider: 'codex' as const })));
    const mgr = new SessionManager({ stateDir: dir, workspaceRoot: dir });
    const started: TurnOptions[] = [], rows: Record<string, unknown>[] = [];
    const adapter = { id: 'codex', startTurn: (o: TurnOptions) => { started.push(o); return {} as never; } };
    const m = mgr as unknown as { persistentCodex?: unknown; turnStarter: (a: unknown, l: unknown, s: string, w: (o: TurnOptions) => TurnOptions) => (o: TurnOptions) => unknown };
    m.persistentCodex = undefined;
    const start = m.turnStarter(adapter, { append: (r: Record<string, unknown>) => rows.push(r) }, 'sess-speed', (o) => o);
    const turn = { cwd: dir, sessionId: 'sess-speed', mode: 'new', prompt: 'hi', model: 'gpt-6.1-sol', speed: 'ultrafast' } as TurnOptions;
    start({ ...turn, configDir: high }); start({ ...turn, configDir: pro }); start({ ...turn, configDir: none });
    expect(started.map((o) => o.speed)).toEqual(['ultrafast', 'fast', undefined]);
    expect(rows).toEqual([
      { type: 'speed_fallback', sessionId: 'sess-speed', account: 'e', model: 'gpt-6.1-sol', from: 'ultrafast', to: 'fast' },
      { type: 'speed_fallback', sessionId: 'sess-speed', account: 'k', model: 'gpt-6.1-sol', from: 'ultrafast', to: null },
    ]);
  });

  it('the model list carries the union of tiers with the config dirs that offer each', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-speed-')); dirs.push(dir);
    const a = join(dir, 'a'), b = join(dir, 'b');
    tierCatalog(a, { 'gpt-6-astra': ['priority', 'ultrafast'], 'gpt-5.6-terra': ['priority'] });
    tierCatalog(b, { 'gpt-6-astra': ['priority'] });
    const models = codexAdapter.listModels!([a, b]);
    expect(models.find((x) => x.slug === 'gpt-6-astra')?.tiers).toMatchObject([{ id: 'priority', configDirs: [a, b].sort() }, { id: 'ultrafast', configDirs: [a] }].map((t) => ({ ...t, configDirs: expect.arrayContaining(t.configDirs) })));
    expect(models.find((x) => x.slug === 'gpt-5.6-terra')?.tiers?.map((t) => t.id)).toEqual(['priority']);
  });
});
