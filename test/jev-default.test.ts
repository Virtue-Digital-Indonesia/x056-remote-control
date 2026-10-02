// Jev picks model and effort BY DEFAULT: a conversation that never chose a
// picker gets Jev while it is available (a key, and credits left on the
// gateway's own meter); an explicit "Your choice" ('none') is never overridden.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { SessionManager } from '../server/manager.js';
import { effectiveRouter, helpersOf, type ConversationHelpers } from '../server/projects.js';
import { JevService, type JevDecision } from '../server/jev.js';
import { OpenAIDecisionsService } from '../server/openai-decisions.js';
import { AUTO_MODEL } from '../server/decision-maker.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'x056-jevdef-')); dirs.push(d); return d; };
const offline = (async () => { throw new Error('offline in tests'); }) as unknown as typeof fetch;
const keyed = (dir: string) => { mkdirSync(join(dir, 'secrets'), { recursive: true }); writeFileSync(join(dir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' })); };
const ledger = (dir: string, balance: number | undefined, spent: number) => {
  mkdirSync(join(dir, 'jev'), { recursive: true });
  const b = { calls: 1, inputTokens: 1, outputTokens: 0, costUsd: spent };
  writeFileSync(join(dir, 'jev', 'ledger.json'), JSON.stringify({ since: b, total: b, ...(balance !== undefined ? { balance: { amount: balance, syncedAt: '2026-09-29T00:00:00Z' } } : {}) }));
};

describe('effectiveRouter', () => {
  const cases: [ConversationHelpers['router'], boolean, string | undefined][] = [
    [undefined, true, 'jev'], [undefined, false, undefined],
    ['none', true, undefined], ['none', false, undefined],
    ['jev', true, 'jev'], ['jev', false, 'jev'],
    ['decisions', true, 'decisions'], ['decisions', false, 'decisions'],
  ];
  it.each(cases)('saved %s, Jev available %s -> %s', (router, available, want) => {
    expect(effectiveRouter(router ? { router } : {}, available)).toBe(want);
  });
  it('reads legacy decisionMaker rows the same way', () => {
    expect(effectiveRouter(helpersOf({ decisionMaker: 'decisions' }), true)).toBe('decisions');
    expect(effectiveRouter(helpersOf({ decisionMaker: 'advisor' }), true)).toBe('jev');
    expect(effectiveRouter(helpersOf(undefined), false)).toBeUndefined();
  });
});

describe('JevService availability', () => {
  it('needs a key', () => {
    const dir = temp();
    expect(new JevService(dir, offline).availability()).toEqual({ available: false, reason: 'no_key' });
    ledger(dir, 5, 0);
    expect(new JevService(dir, offline).status()).toMatchObject({ configured: false, available: false, unavailableReason: 'no_key' });
  });
  it('a key with a balance never synced is available: nothing says it is empty', () => {
    const dir = temp(); keyed(dir);
    expect(new JevService(dir, offline).availability()).toEqual({ available: true });
    ledger(dir, undefined, 3);
    expect(new JevService(dir, offline).available()).toBe(true);
  });
  it('credits left = synced balance minus spend since; at or below zero is unavailable', () => {
    const dir = temp(); keyed(dir);
    ledger(dir, 5, 0.01);
    expect(new JevService(dir, offline).status()).toMatchObject({ available: true, estimatedLeft: 4.99 });
    ledger(dir, 0.01, 0.01);
    expect(new JevService(dir, offline).availability()).toEqual({ available: false, reason: 'no_credits' });
    ledger(dir, 0.01, 0.02);
    expect(new JevService(dir, offline).status()).toMatchObject({ available: false, unavailableReason: 'no_credits', estimatedLeft: 0 });
  });
  it('syncing the balance clears the cached answer at once', () => {
    const dir = temp(); keyed(dir);
    const jev = new JevService(dir, offline);
    expect(jev.available()).toBe(true);
    jev.syncBalance(0);
    expect(jev.available()).toBe(false);
    jev.syncBalance(2);
    expect(jev.available()).toBe(true);
  });
});

describe('SessionManager: Jev is the default picker', () => {
  function fixture(opts: { key?: boolean } = {}) {
    const dir = temp(), stateDir = join(dir, 'state');
    mkdirSync(stateDir, { recursive: true });
    if (opts.key !== false) keyed(stateDir);
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    (mgr as unknown as { jevService: JevService }).jevService = new JevService(stateDir, offline);
    const decide = vi.spyOn(mgr.jev(), 'decide').mockImplementation(async (s, i) => ({ at: 't', sessionId: s, provider: 'claude', backend: 'jev', notes: [], latencyMs: 1, baseModel: i.currentModel, model: 'haiku', effort: 'low' } as JevDecision));
    return { mgr, calls, dir, stateDir, decide };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('a conversation with no saved picker runs the Jev pick when a key and credits exist', async () => {
    const { mgr, calls, dir, decide } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ model: 'haiku', effort: 'low' });
    const row = mgr.listConversations(p.id).find((c) => c.sessionId === sid)!;
    expect(row.helpers).toBeUndefined(); // nothing saved...
    expect(row.effectiveRouter).toBe('jev'); // ...and Jev runs
  });

  it('an explicit "Your choice" (none) is saved and never picked for', async () => {
    const { mgr, calls, dir, decide } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(mgr.patchHelpers(p.id, sid, { router: 'none' })).toEqual({ router: 'none' });
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)).toMatchObject({ helpers: { router: 'none' }, effectiveRouter: null });
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(decide).toHaveBeenCalledTimes(1); // the first turn only
    expect(calls[1]).toMatchObject({ model: 'sonnet', effort: 'high' });
    // The full-set save and the legacy endpoint store it too.
    mgr.setHelpers(p.id, sid, { advisor: true, router: 'none' });
    expect(helpersOf(mgr.listConversations(p.id).find((c) => c.sessionId === sid))).toEqual({ advisor: true, router: 'none' });
    mgr.setDecisionMaker(p.id, sid, 'jev');
    mgr.setDecisionMaker(p.id, sid, 'none');
    expect(helpersOf(mgr.listConversations(p.id).find((c) => c.sessionId === sid))).toEqual({ router: 'none' });
    // Auto saved under the default, then "Your choice": a later turn reusing
    // the saved '' runs the house default, never the CLI's frontier default.
    mgr.continueSession(p.id, sid, 'auto', { model: '', effort: '' });
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    mgr.continueSession(p.id, sid, 'queued later', {});
    await waitFor(() => calls.length === 4 && !mgr.snapshot().running);
    expect(calls[3].model).toBe(AUTO_MODEL.claude);
    // Back to Jev explicitly.
    expect(mgr.patchHelpers(p.id, sid, { router: 'jev' })).toEqual({ router: 'jev' });
  });

  it('with no credits left the default does not apply, and Auto runs on the house default', async () => {
    const { mgr, calls, dir, decide } = fixture();
    mgr.jev().syncBalance(0);
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(decide).not.toHaveBeenCalled();
    expect(calls[0]).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.effectiveRouter).toBeNull();
    // A panel that still believed Jev would pick sent Auto (''): never the CLI default.
    mgr.continueSession(p.id, sid, 'second', { model: '', effort: '' });
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(calls[1].model).toBe(AUTO_MODEL.claude);
    // An explicit Jev still runs (it then fails or answers as it can).
    mgr.patchHelpers(p.id, sid, { router: 'jev' });
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('without a key nothing changes: no pick, no house-default substitution', async () => {
    const { mgr, calls, dir, decide } = fixture({ key: false });
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, {}, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    expect(decide).not.toHaveBeenCalled();
    expect(calls[0].model).toBeUndefined();
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.effectiveRouter).toBeNull();
  });

  it('the team line and the fork layer follow the effective picker', async () => {
    const { mgr, calls, dir, stateDir, decide } = fixture();
    const team = { model: 'sonnet', effort: 'high', base: { model: 'opus', effort: 'medium' }, pickedModel: 'sonnet', pickedEffort: 'high', modelConfidence: 0.7, effortConfidence: 0.6 };
    decide.mockImplementation(async (s) => ({ at: 't', sessionId: s, provider: 'claude', backend: 'jev', notes: [], latencyMs: 1, team } as JevDecision));
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'opus', effort: 'high' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.patchHelpers(p.id, sid, { team: true });
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2 && !mgr.snapshot().running);
    expect(calls[1].prompt).toContain('Agent team this turn');
    expect(calls[1].prompt).toContain('Picked by Jev');
    mgr.patchHelpers(p.id, sid, { router: 'none' });
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3 && !mgr.snapshot().running);
    expect(calls[2].prompt).not.toContain('Agent team this turn');
    // Forks: the default (no saved picker) goes to Jev...
    mgr.patchHelpers(p.id, sid, { router: 'jev' });
    mgr.setHelpers(p.id, sid, { team: true });
    const jevFork = vi.spyOn(mgr.jev(), 'fork').mockResolvedValue({ at: 't', sessionId: sid, backend: 'jev', verdict: 'sharp', choice: 'a', confidence: 0.9 } as never);
    await mgr.forkDecision(p.id, sid, { question: 'q', options: ['a', 'b'] });
    expect(jevFork).toHaveBeenCalledTimes(1);
    // ...and an explicit OpenAI Decisions picker takes them.
    writeFileSync(join(stateDir, 'secrets', 'openai.json'), JSON.stringify({ apiKey: 'sk-test-000000000000' }));
    const dec = new OpenAIDecisionsService(stateDir, mgr.jev(), offline);
    (mgr as unknown as { openaiDecisionsService: OpenAIDecisionsService }).openaiDecisionsService = dec;
    const decFork = vi.spyOn(dec, 'fork').mockResolvedValue({ at: 't', sessionId: sid, backend: 'openai', verdict: 'split' } as never);
    mgr.patchHelpers(p.id, sid, { router: 'decisions' });
    await mgr.forkDecision(p.id, sid, { question: 'q', options: ['a', 'b'] });
    expect(decFork).toHaveBeenCalledTimes(1);
    expect(jevFork).toHaveBeenCalledTimes(1);
    // The agent tree draws what runs, and says what was saved.
    mgr.patchHelpers(p.id, sid, { router: 'none' });
    expect(mgr.agentTree(p.id, sid).helpers).toEqual({ team: true, savedRouter: 'none' });
    mgr.setHelpers(p.id, sid, { team: true });
    expect(mgr.agentTree(p.id, sid).helpers).toEqual({ team: true, router: 'jev' });
  });
});
