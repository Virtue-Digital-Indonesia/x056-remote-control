import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); });
function boot(seed: (stateDir: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'notices-boot-')), stateDir = join(root, 'state');
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
  seed(stateDir);
  const manager = new SessionManager({ stateDir, workspaceRoot: root, runSessionFn: () => new Promise(() => {}) });
  const events: GatewayEvent[] = []; manager.subscribe((e) => events.push(e));
  cleanups.push(() => { manager.onModuleDestroy(); rmSync(root, { recursive: true, force: true }); });
  return { manager, events, stateDir };
}

it('a restart that killed three turns is ONE notice; the resume cards stay per conversation', () => {
  const { events } = boot((stateDir) => {
    mkdirSync(join(stateDir, 'inflight'), { recursive: true });
    for (const s of ['s1', 's2', 's3']) writeFileSync(join(stateDir, 'inflight', s + '.json'), JSON.stringify({ projectId: 'p', sessionId: s, prompt: 'x' }));
  });
  expect(events.filter((e) => e.kind === 'turn_orphaned')).toHaveLength(3);
  expect(events.filter((e) => e.kind === 'turn_orphaned').every((e) => (e.data.notice as { tier: string }).tier === 'none')).toBe(true);
  const r = events.filter((e) => e.kind === 'restart_interrupted');
  expect(r).toHaveLength(1);
  expect(r[0].data.notice).toMatchObject({ tier: 'normal', body: '3 conversations were interrupted by a restart. Open them to resume.' });
  expect((r[0].data.notice as { id: string }).id).toMatch(/^restart:\d{4}-/);
});
it('a clean boot sends no restart notice', () => {
  const { events } = boot(() => {});
  expect(events.some((e) => e.kind === 'restart_interrupted')).toBe(false);
});
it('questions: stale after 3 days (no bell), purged after 14', () => {
  const day = 24 * 3600_000, ago = (d: number) => new Date(Date.now() - d * day).toISOString();
  const { manager, stateDir } = boot((stateDir) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'questions.json'), JSON.stringify({
      fresh: { projectId: 'p', sessionId: 'fresh', question: 'Now?', options: [], at: ago(1) },
      old: { projectId: 'p', sessionId: 'old', question: 'Last week?', options: [], at: ago(5) },
      ancient: { projectId: 'p', sessionId: 'ancient', question: 'August?', options: [], at: ago(44) },
    }));
  });
  const list = manager.listPendingQuestions();
  expect(list.map((q) => [q.sessionId, !!q.stale])).toEqual([['fresh', false], ['old', true]]);
  expect(Object.keys(JSON.parse(readFileSync(join(stateDir, 'questions.json'), 'utf8')))).toEqual(['fresh', 'old']);
});
