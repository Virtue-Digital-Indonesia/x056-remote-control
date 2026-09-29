import { afterEach, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import type { TurnOptions } from '../src/turn.js';

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
