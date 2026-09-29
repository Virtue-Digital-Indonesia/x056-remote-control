import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { ClaudeTransport } from '../src/persistent-transport.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { JevService, JEV_POLICY, applyPolicy, type JevDecision, type JevDecisionInput } from '../server/jev.js';
import { advisorFor, jevCandidates } from '../server/decision-maker.js';

const input = (over: Partial<JevDecisionInput> = {}): JevDecisionInput => ({
  provider: 'claude', prompt: 'rename a variable', currentModel: 'opus', currentEffort: 'high', ...jevCandidates('claude', []), ...over,
});
const base = (): JevDecision => ({ at: 't', sessionId: 's-00000001', provider: 'claude', notes: [], latencyMs: 1 });

describe('advisor pairing', () => {
  // Verified on 2.1.280: an Opus advisor on a Fable main model is silently
  // NOT attached -- it would read as "on" while doing nothing.
  it('pairs Fable with Fable and everything else with Opus; Codex gets none', () => {
    expect(advisorFor('claude', 'claude-fable-5-1')).toBe('fable');
    expect(advisorFor('claude', 'sonnet')).toBe('opus');
    expect(advisorFor('claude', undefined)).toBe('opus');
    expect(advisorFor('codex', 'gpt-6-astra')).toBeUndefined();
  });

  it('reaches the CLI argv and the persistent process identity', () => {
    const t = new ClaudeTransport();
    const o = { configDir: '/c', cwd: '/w', sessionId: 's', mode: 'new' as const, prompt: 'p', onEvent: () => {} };
    const args = t.spawnSpec({ ...o, advisor: 'opus' }).args;
    expect(args[args.indexOf('--advisor') + 1]).toBe('opus');
    expect(t.spawnSpec(o).args).not.toContain('--advisor');
    expect(t.identity({ ...o, advisor: 'opus' })).not.toBe(t.identity(o)); // toggling respawns the process
  });
});

describe('Jev policy', () => {
  it('applies a confident effort, and a model only above the higher bar', () => {
    const d = applyPolicy(base(), input(), { effort: { choice: 'low', confidence: 0.9 }, model: { choice: 'haiku', confidence: 0.85 } }, []);
    expect(d).toMatchObject({ effort: 'low', model: 'haiku', pickedModel: 'haiku', pickedEffort: 'low' });
    const unsure = applyPolicy(base(), input(), { effort: { choice: 'low', confidence: 0.5 }, model: { choice: 'haiku', confidence: 0.7 } }, []);
    expect(unsure.effort).toBeUndefined();
    expect(unsure.model).toBeUndefined();
    expect(unsure.notes.join(' ')).toMatch(/only 70% sure/);
  });

  // A Claude model switch respawns the process and drops the prompt cache.
  it('waits a few turns between Claude model switches; Codex has no such gap', () => {
    const switched: JevDecision[] = [{ ...base(), model: 'haiku' }];
    const pick = { model: { choice: 'opus', confidence: 0.95 } };
    expect(applyPolicy(base(), input({ currentModel: 'haiku' }), pick, switched).model).toBeUndefined();
    const later = [...switched, ...Array.from({ length: JEV_POLICY.claudeModelGapTurns }, base)];
    expect(applyPolicy(base(), input({ currentModel: 'haiku' }), pick, later).model).toBe('opus');
    const codex = input({ provider: 'codex', currentModel: 'gpt-a', models: [{ id: 'gpt-a', about: 'a' }, { id: 'gpt-b', about: 'b' }] });
    expect(applyPolicy({ ...base(), provider: 'codex' }, codex, { model: { choice: 'gpt-b', confidence: 0.9 } }, [{ ...base(), model: 'gpt-a' }]).model).toBe('gpt-b');
  });

  it('never applies an unknown model or an effort the chosen model does not offer', () => {
    const d = applyPolicy(base(), input({ models: [{ id: 'opus', about: 'x', efforts: ['low', 'high'] }] }),
      { model: { choice: 'gpt-9', confidence: 0.99 }, effort: { choice: 'max', confidence: 0.99 } }, []);
    expect(d.model).toBeUndefined();
    expect(d.effort).toBeUndefined();
  });
});

function jevState(key = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'x056-jev-'));
  if (key) { mkdirSync(join(dir, 'secrets')); writeFileSync(join(dir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' })); }
  return dir;
}
const okFetch = (answers: object, input_tokens = 1_000_000) => (async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens, output_tokens: 20 } }), { status: 200 })) as unknown as typeof fetch;

describe('JevService', () => {
  it('meters each call and reports what is left of the synced balance', async () => {
    const s = new JevService(jevState(), okFetch({ effort: { type: 'choice', choice: 'low', confidence: 0.96 } }));
    s.syncBalance(10);
    const d = await s.decide('s-00000001', input());
    expect(d).toMatchObject({ effort: 'low', inputTokens: 1_000_000 });
    expect(s.status()).toMatchObject({ configured: true, balance: 10, spentSinceSync: 0.042, estimatedLeft: 9.958, callsSinceSync: 1 });
    expect(s.decisions('s-00000001')).toHaveLength(1);
    // A re-sync from the console resets the meter but keeps the lifetime total.
    expect(s.syncBalance(9.9)).toMatchObject({ estimatedLeft: 9.9, spentSinceSync: 0, totalSpent: 0.042 });
  });

  it('never throws and changes nothing when Jev fails, is slow, or there is no key', async () => {
    const http500 = new JevService(jevState(), (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch);
    expect(await http500.decide('s-00000001', input())).toMatchObject({ error: 'Jev answered HTTP 500' });
    const slow = new JevService(jevState(), ((_u: string, init: { signal: AbortSignal }) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as unknown as typeof fetch, 50);
    expect((await slow.decide('s-00000001', input())).error).toMatch(/did not answer within 50 ms/);
    const nokey = new JevService(jevState(false), okFetch({}));
    expect((await nokey.decide('s-00000001', input())).error).toMatch(/No Jev API key/);
    for (const d of [await http500.decide('s-00000002', input())]) { expect(d.model).toBeUndefined(); expect(d.effort).toBeUndefined(); }
  });
});

describe('SessionManager: exactly one decision maker per conversation', () => {
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'x056-dm-'));
    const stateDir = join(dir, 'state');
    mkdirSync(join(stateDir, 'secrets'), { recursive: true });
    writeFileSync(join(stateDir, 'secrets', 'typesafe.json'), JSON.stringify({ apiKey: 'k' }));
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: '/cfg/a' }]);
    const calls: RunSessionOptions[] = [];
    const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return { status: 'completed', finalAccount: 'a', failovers: 0 } as SessionResult; }) as unknown as typeof import('../src/failover.js').runSession;
    const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
    return { mgr, calls, dir };
  }
  const waitFor = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 10)); };

  it('advisor passes --advisor to the run; switching to jev removes it (one field)', async () => {
    const { mgr, calls, dir } = fixture();
    const p = mgr.createProject('P', dir);
    const sid = mgr.start('first', undefined, { model: 'sonnet' }, p.id);
    await waitFor(() => calls.length === 1 && !mgr.snapshot().running);
    mgr.setDecisionMaker(p.id, sid, 'advisor');
    mgr.continueSession(p.id, sid, 'second', {});
    await waitFor(() => calls.length === 2);
    expect(calls[1].advisor).toBe('opus');
    await waitFor(() => !mgr.snapshot().running);
    const decide = vi.spyOn(mgr.jev(), 'decide').mockResolvedValue({ ...base(), sessionId: sid, model: 'haiku', effort: 'low', notes: ['model -> haiku'] });
    mgr.setDecisionMaker(p.id, sid, 'jev');
    const seen: GatewayEvent[] = []; mgr.subscribe((e) => seen.push(e));
    mgr.continueSession(p.id, sid, 'third', {});
    await waitFor(() => calls.length === 3);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(calls[2]).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(calls[2].advisor).toBeUndefined();
    expect(seen.some((e) => e.kind === 'jev_decision')).toBe(true);
    // The user's own saved choice is untouched by Jev's per-turn pick.
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.model).toBe('sonnet');
    expect(mgr.listConversations(p.id).find((c) => c.sessionId === sid)?.decisionMaker).toBe('jev');
  });

  it('accepts the advisor on a ChatGPT conversation (gateway-built) and refuses anything but none|advisor|jev', () => {
    const { mgr, dir } = fixture();
    const p = mgr.createProject('C', dir, 'codex');
    const sid = mgr.start('hi', undefined, undefined, p.id);
    expect(() => mgr.setDecisionMaker(p.id, sid, 'advisor')).not.toThrow();
    expect(() => mgr.setDecisionMaker(p.id, sid, 'both' as never)).toThrow(/none, advisor or jev/);
  });
});
