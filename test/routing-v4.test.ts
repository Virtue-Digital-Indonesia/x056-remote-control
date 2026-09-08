import { ApiController } from '../server/api.controller.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountRegistry } from '../src/accounts.js';
import { runSession, type RunSessionOptions, type RunControl } from '../src/failover.js';
import { EventLog } from '../src/eventlog.js';
import { SessionManager } from '../server/manager.js';
import { RoutingState } from '../server/routing-state.js';
import { accountHealth } from '../server/routing-health.js';
const dirs: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'x056-route-'));
  dirs.push(dir);
  const reg = AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'a', configDir: join(dir, 'a') },
    { name: 'b', configDir: join(dir, 'b') },
    { name: 'g', configDir: join(dir, 'g'), provider: 'codex' },
  ]);
  return { dir, reg };
}
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function quota(dir: string, name: string, provider: 'claude' | 'codex', used: number, reset = 2000) {
  writeFileSync(
    join(dir, 'quota-cache.json'),
    JSON.stringify({
      [name]: {
        at: 1000000,
        quota:
          provider === 'codex'
            ? { windows: [{ utilization: used / 100, resetsAt: reset }] }
            : { fiveHour: { utilization: used, resetsAt: new Date(reset * 1000).toISOString() } },
      },
    }),
  );
}

describe('routing admission and preview', () => {
  it('previews without advancing round robin or consuming a global choice', () => {
    const { dir, reg } = setup();
    reg.setRouting('claude', 'round-robin', ['a', 'b']);
    reg.setActive('a');
    const before = readFileSync(join(dir, 'accounts.json'), 'utf8');
    expect(reg.explain(1000, 'claude', {}, { preferredAccount: 'b' }).selected).toBe('b');
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).toBe(before);
    expect(reg.pickActive(1000, 'claude', {}, { preferredAccount: 'b' })?.name).toBe('b');
    expect(reg.pickActive(1000, 'claude')?.name).toBe('a');
    expect(reg.pickActive(1000, 'claude')?.name).toBe('b');
  });
  it('keeps scoped choices independent and overrides global wait only for that conversation', () => {
    const { reg } = setup();
    reg.setRouting('claude', 'wait', ['a', 'b']);
    expect(reg.explain(1000, 'claude', {}, { preferredAccount: 'b' }).selected).toBe('b');
    reg.markLimited('b', 2000);
    expect(reg.explain(1000, 'claude', {}, { preferredAccount: 'b' }).selected).toBeNull();
    expect(reg.explain(1000, 'claude').selected).toBe('a');
    expect(reg.explain(1000, 'claude', {}, { lockedAccount: 'b' }).selected).toBeNull();
  });
  it('enforces capacities and quota reserves separately from provider hard limits', () => {
    const { reg, dir } = setup();
    reg.setCapacity('a', 2, 20);
    quota(dir, 'a', 'claude', 82);
    expect(reg.explain(1000, 'claude').selected).toBe('b');
    expect(reg.explain(1000, 'claude', {}, { useReserve: true }).selected).toBe('a');
    expect(reg.explain(1000, 'claude', { a: 2 }, { useReserve: true }).selected).toBe('b');
    quota(dir, 'a', 'claude', 100);
    expect(reg.explain(1000, 'claude', {}, { useReserve: true }).selected).toBe('b');
    expect(reg.explain(2100, 'claude').selected).toBe('a');
  });
  it('normalizes Codex fractions and treats unknown usage as unknown', () => {
    const { reg, dir } = setup();
    reg.setCapacity('g', 0, 15);
    quota(dir, 'g', 'codex', 88);
    expect(reg.explain(1000, 'codex').selected).toBeNull();
    expect(reg.explain(1000, 'codex', {}, { useReserve: true }).selected).toBe('g');
    rmSync(join(dir, 'quota-cache.json'));
    const preview = reg.explain(1000, 'codex');
    expect(preview.selected).toBe('g');
    expect(preview.candidates[0].usedPercent).toBeUndefined();
  });
  it('rejects malformed limits and keeps saved settings', () => {
    const { reg, dir } = setup();
    reg.setCapacity('a', 3, 20);
    expect(() => reg.setCapacity('a', -1, 20)).toThrow();
    expect(() => reg.setCapacity('a', 1, 100)).toThrow();
    expect(AccountRegistry.load(join(dir, 'accounts.json')).get('a')).toMatchObject({
      maxConcurrent: 3,
      reservePercent: 20,
    });
  });
  it('checks model-specific weekly limits only for the relevant Claude model', () => {
    const { reg, dir } = setup();
    writeFileSync(
      join(dir, 'quota-cache.json'),
      JSON.stringify({
        a: {
          at: 1000000,
          quota: {
            weeklyScoped: [{ label: 'opus', utilization: 100, resetsAt: new Date(2000000).toISOString() }],
          },
        },
      }),
    );
    expect(reg.explain(1000, 'claude', {}, { model: 'opus' }).selected).toBe('b');
    expect(reg.explain(1000, 'claude', {}, { model: 'sonnet' }).selected).toBe('a');
  });
});

describe('waiting runs', () => {
  it('waits on a lock until unlocked without trying another account first', async () => {
    vi.useFakeTimers();
    const { reg, dir } = setup();
    reg.markLimited('a', 2000);
    const routing: { lockedAccount?: string } = { lockedAccount: 'a' },
      started: string[] = [];
    let control: RunControl | undefined;
    const work = runSession({
      registry: reg,
      log: new EventLog(join(dir, 'events.jsonl')),
      sessionId: 'waiting',
      cwd: dir,
      prompt: 'work',
      now: () => 1000,
      routing,
      forceSwitchSignal: false,
      control: (c) => (control = c),
      startTurnFn: (o) => {
        started.push(o.configDir);
        return {
          kill() {},
          interrupt() {},
          done: Promise.resolve().then(() => {
            o.onEvent({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
            return { code: 0, signal: null };
          }),
        };
      },
    });
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(2100);
    expect(started).toEqual([]);
    routing.lockedAccount = undefined;
    await vi.advanceTimersByTimeAsync(2100);
    expect((await work).status).toBe('completed');
    expect(started).toEqual([join(dir, 'b')]);
    expect(control).toBeDefined();
  });
  it('stopping a capacity wait never starts a turn', async () => {
    const { reg, dir } = setup();
    reg.setCapacity('a', 1, 0);
    reg.setCapacity('b', 1, 0);
    let control: RunControl | undefined;
    const start = vi.fn();
    const work = runSession({
      registry: reg,
      log: new EventLog(join(dir, 'events.jsonl')),
      sessionId: 'waiting',
      cwd: dir,
      prompt: 'work',
      accountLoads: () => ({ a: 1, b: 1 }),
      forceSwitchSignal: false,
      control: (c) => (control = c),
      startTurnFn: start,
    });
    control!.abort();
    expect((await work).status).toBe('failed');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('conversation preferences and provider continuity', () => {
  function manager() {
    const { reg, dir } = setup();
    const launches: RunSessionOptions[] = [],
      finishes: (() => void)[] = [];
    const mgr = new SessionManager({
      stateDir: dir,
      workspaceRoot: dir,
      runSessionFn: async (o) => {
        launches.push(o);
        await new Promise<void>((r) => finishes.push(r));
        return { status: 'completed', failovers: 0 };
      },
    });
    const p = mgr.createProject('Project', dir);
    return { reg, dir, mgr, p, launches, finishes };
  }
  it('saves next-turn choices independently, applies lock changes to waiting runs, records history', async () => {
    const { mgr, p, dir, launches, finishes } = manager();
    const a = mgr.start('first', undefined, undefined, p.id),
      b = mgr.start('second', undefined, undefined, p.id);
    mgr.configureConversationRoute(p.id, a, { nextAccount: 'b' });
    mgr.configureConversationRoute(p.id, b, { nextAccount: 'a' });
    expect(mgr.routingPreview(p.id, a).selected).toBe('b');
    expect(mgr.routingPreview(p.id, b).selected).toBe('a');
    // Saving a next-turn choice does not retarget the current attempt.
    expect(launches[0].routing?.preferredAccount).toBeUndefined();
    launches[0].log.append({ type: 'routing_wait' });
    mgr.configureConversationRoute(p.id, a, { lockedAccount: 'b' });
    expect(launches[0].routing).toMatchObject({ lockedAccount: 'b', preferredAccount: 'b' });
    mgr.configureConversationRoute(p.id, a, { lockedAccount: undefined });
    expect(launches[0].routing?.lockedAccount).toBeUndefined();
    expect(new RoutingState(dir).history(p.id, a).some((x) => x.kind === 'routing_preference')).toBe(true);
    finishes.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
  });
  it('uses a fresh provider session, preserves the source and project defaults, rejects active sources', async () => {
    const { mgr, p, dir, launches, finishes } = manager();
    const source = mgr.start('first', undefined, undefined, p.id);
    expect(() => mgr.startProviderHandoff(p.id, source, 'codex', 'context', 'continue')).toThrow(
      'Finish or stop',
    );
    finishes.shift()!();
    await new Promise((r) => setTimeout(r, 20));
    const target = mgr.startProviderHandoff(p.id, source, 'codex', 'Approved context', 'Run tests');
    expect(target).not.toBe(source);
    const next = launches[1];
    expect(next.adapter?.id).toBe('codex');
    expect(next.resume).toBe(false);
    expect(next.providerSessionId).toBeUndefined();
    expect(next.prompt).toContain('Approved context');
    expect(next.prompt).toContain('Run tests');
    expect(mgr.historyContext(p.id, source).adapter.id).toBe('claude');
    expect(mgr.listProjects().projects.find((x) => x.id === p.id)?.provider || 'claude').toBe('claude');
    expect(new RoutingState(dir).links()[0]).toMatchObject({
      sourceSessionId: source,
      targetSessionId: target,
    });
    finishes.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
  });
  it('rejects cross-provider account locks', async () => {
    const { mgr, p, finishes } = manager();
    const sid = mgr.start('first', undefined, undefined, p.id);
    expect(() => mgr.configureConversationRoute(p.id, sid, { lockedAccount: 'g' })).toThrow('provider');
    finishes.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
  });
});

describe('health reporting', () => {
  it('does not mistake a missing catalog or credentials for verified compatibility or login', () => {
    const { reg } = setup();
    const rows = accountHealth(reg.list(), { a: 2 }, 'gpt-example');
    expect(rows[0]).toMatchObject({
      credentials: 'Credential status unknown',
      compatibility: 'Different provider',
      load: 2,
    });
    expect(rows[2].compatibility).toBe('Catalog unavailable');
    expect(rows[2].quotaStale).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('configDir');
  });
});

describe('routing persistence and safe handoff retries', () => {
  it('versions rapid preference changes even within the same millisecond', () => {
    const { dir } = setup(),
      store = new RoutingState(dir);
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const a = store.set('p', 's', { nextAccount: 'a' }),
      b = store.set('p', 's', { nextAccount: 'b' });
    expect(b.updatedAt).toBeGreaterThan(a.updatedAt!);
    vi.restoreAllMocks();
  });
  it('excludes explicitly signed-out credentials before dispatch', () => {
    const { dir, reg } = setup();
    mkdirSync(join(dir, 'a'));
    writeFileSync(join(dir, 'a', '.credentials.json'), JSON.stringify({ claudeAiOauth: {} }));
    expect(reg.explain(1000, 'claude').selected).toBe('b');
    expect(reg.explain(1000, 'claude').candidates.find((x) => x.name === 'a')?.reasons).toContain(
      'Sign-in required',
    );
  });
  it('counts background capacity once per session, excluding the conversation being routed', async () => {
    const { dir } = setup();
    let finish: () => void = () => {};
    const mgr = new SessionManager({
      stateDir: dir,
      workspaceRoot: dir,
      runSessionFn: async (o) => {
        o.log.append({ type: 'turn_started', account: 'a' });
        await new Promise<void>((r) => (finish = r));
        return { status: 'completed', failovers: 0 };
      },
    });
    const p = mgr.createProject('P', dir),
      sid = mgr.start('run', undefined, undefined, p.id);
    const fields = mgr as unknown as { persistent: unknown };
    fields.persistent = {
      workingAccounts: () => [
        { sessionId: sid, configDir: join(dir, 'a') },
        { sessionId: 'background', configDir: join(dir, 'b') },
      ],
    };
    expect(mgr.accountLoads()).toEqual({ a: 1, b: 1 });
    expect(mgr.accountLoads(sid)).toEqual({ b: 1 });
    fields.persistent = undefined;
    finish();
    await new Promise((r) => setTimeout(r, 20));
  });
});

function controller(mgr: SessionManager, dir: string) {
  return new ApiController(
    mgr,
    dir,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}
it('replaying a handoff request starts exactly one linked conversation', async () => {
  const { dir } = setup();
  const finishes: (() => void)[] = [],
    mgr = new SessionManager({
      stateDir: dir,
      workspaceRoot: dir,
      runSessionFn: async () => {
        await new Promise<void>((r) => finishes.push(r));
        return { status: 'completed', failovers: 0 };
      },
    });
  const p = mgr.createProject('Project', dir),
    source = mgr.start('source', undefined, undefined, p.id);
  finishes.shift()!();
  await new Promise((r) => setTimeout(r, 20));
  const api = controller(mgr, dir),
    body = {
      projectId: p.id,
      sessionId: source,
      provider: 'codex' as const,
      context: 'Reviewed context',
      instruction: 'Run tests',
      requestId: 'routing-handoff-request-123456',
    };
  const first = api.handoff(body),
    second = api.handoff(body);
  expect(first.sessionId).toBe(second.sessionId);
  expect(mgr.listConversations(p.id)).toHaveLength(2);
  expect(() => api.handoff({ ...body, instruction: 'Different task' })).toThrow('already used');
  finishes.forEach((f) => f());
  await new Promise((r) => setTimeout(r, 20));
});
