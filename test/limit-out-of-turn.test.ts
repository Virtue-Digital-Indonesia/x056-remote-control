import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import { parseLimitReset } from '../src/detector.js';
import { readMessageSender } from '../src/message-sender.js';
import { PersistentTurns } from '../src/persistent.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';

/** The three live stops of 2026-10-26, as the CLI streams them (see the file's _source). */
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/limit-out-of-turn.json', import.meta.url), 'utf8')) as Record<'T2' | 'T1a' | 'T1b', { at: string; events: Record<string, unknown>[]; resetsAt: string }>;

/**
 * Usage limits hit OUT OF TURN (docs/limit-resume-contract.md R4, R7): the
 * gateway's turn had ended, a background agent woke the model, and the agent
 * or the woken reply got the 429. Driven through the real runSession and the
 * real pool over a fake CLI, with the stream shapes of the three live stops.
 */
type Fx = typeof fixtures.T2;
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); vi.useRealTimers(); vi.restoreAllMocks(); });

function fakeCli() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: { write: (s: string) => void; destroyed: boolean; writableEnded: boolean }; kill: () => void };
  child.stdout = new EventEmitter();
  const written: string[] = [];
  child.stdin = { write: (s) => { written.push(s); }, destroyed: false, writableEnded: false };
  const st = { killed: false };
  child.kill = () => { st.killed = true; child.emit('close', null, 'SIGKILL'); };
  return {
    child, st,
    emit: (e: unknown) => child.stdout.emit('data', Buffer.from(JSON.stringify(e) + '\n')),
    prompts: () => written.map((w) => JSON.parse(w)).filter((m) => m.type === 'user').map((m) => String(m.message.content[0].text)),
  };
}

function fixture(accounts: string[] = ['l', 'm'], opts: { runSessionFn?: (o: RunSessionOptions) => Promise<SessionResult> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'limit-oot-')), stateDir = join(root, 'state');
  const cfg = (n: string) => join(root, 'cfg-' + n);
  for (const n of accounts) mkdirSync(cfg(n), { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), accounts.map((name) => ({ name, configDir: cfg(name) })));
  const manager = new SessionManager({ stateDir, workspaceRoot: root, titleGenerator: async () => null, claudePath: '/nonexistent/claude', ...(opts.runSessionFn ? { runSessionFn: opts.runSessionFn as never } : {}) });
  const spawned: { cli: ReturnType<typeof fakeCli>; configDir?: string; args: string[] }[] = [];
  const pool = new PersistentTurns({ spawnFn: (_bin, args, _cwd, env) => { const cli = fakeCli(); spawned.push({ cli, configDir: env.CLAUDE_CONFIG_DIR, args }); return cli.child as never; } });
  (manager as unknown as { persistent: PersistentTurns }).persistent = pool;
  const events: GatewayEvent[] = []; manager.subscribe((e) => events.push(e));
  cleanups.push(() => { manager.onModuleDestroy(); pool.shutdown(); rmSync(root, { recursive: true, force: true }); });
  const accountState = (name: string) => AccountRegistry.load(join(stateDir, 'accounts.json')).get(name).state;
  const log = () => readFileSync(join(stateDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  return { manager, root, stateDir, cfg, spawned, events, accountState, log };
}
type F = ReturnType<typeof fixture>;
const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const of = (f: F, kind: string) => f.events.filter((e) => e.kind === kind);
const agent = (id: string, description: string) => ({ type: 'system', subtype: 'task_started', task_id: id, task_type: 'local_agent', description });
const ok = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text });
const limitText = (fx: Fx) => String((fx.events.at(-1) as { result: string }).result);

/** A human turn on account l that ends with one background agent still running. */
async function turnWithAgent(f: F, id = 'aeb663d0b2fd979ef', description = 'Multibox end-to-end integration test') {
  const pid = f.manager.createProject('Signature audit', f.root).id;
  const sid = f.manager.start('run the signature audit', undefined, undefined, pid);
  await until(() => f.spawned.length === 1);
  expect(f.spawned[0].configDir).toBe(f.cfg('l'));
  f.spawned[0].cli.emit(agent(id, description));
  f.spawned[0].cli.emit(ok('Started the integration agent; it runs in the background.'));
  await until(() => of(f, 'session_done').length === 1);
  return { pid, sid };
}

describe('an out-of-turn limit after a background agent died of it (T2)', () => {
  it('marks the PROCESS\'s account, ends that process, and continues on another account naming the dead agent; no "finished", no recap', async () => {
    const f = fixture();
    const { sid } = await turnWithAgent(f);
    const at = Math.floor(Date.now() / 1000);
    for (const e of fixtures.T2.events) f.spawned[0].cli.emit(e);
    await until(() => f.spawned.length === 2);
    // l is benched until the reset its own text names; m, the healthy one, is not.
    const l = f.accountState('l') as { kind: string; until: number; estimated?: boolean };
    expect(l.kind).toBe('limited');
    expect(Math.abs(l.until - parseLimitReset(limitText(fixtures.T2), at)!.until)).toBeLessThanOrEqual(60);
    expect(l.estimated).toBeFalsy();
    expect(f.accountState('m').kind).not.toBe('limited');
    // The limited process is gone; the continue spawned fresh on m with --resume.
    expect(f.spawned[0].cli.st.killed).toBe(true);
    expect(f.spawned[1].configDir).toBe(f.cfg('m'));
    expect(f.spawned[1].args).toContain('--resume');
    const sent = f.spawned[1].cli.prompts()[0];
    expect(sent).toMatch(/^\[Usage limit: account l hit its session limit at \d\d:\d\d WIB \(resets [^)]+ WIB\)\. This continues on another account\.\]\nContinue where you left off\./);
    expect(sent).toContain('These background agents were stopped by the limit and did not finish; re-run them if they are still needed:\n- "Multibox end-to-end integration test" (aeb663d0b2fd979ef)');
    expect(readMessageSender(sent).sender).toMatchObject({ kind: 'limit_resume' });
    // The panel hears the limit, quietly (it continues at once).
    const cont = of(f, 'limit_continue');
    expect(cont).toHaveLength(1);
    expect(cont[0].data).toMatchObject({ sessionId: sid, account: 'l', kind: 'session', waiting: false, failedTasks: [{ id: 'aeb663d0b2fd979ef', description: 'Multibox end-to-end integration test' }] });
    expect((cont[0].data.notice as { tier: string; body: string })).toMatchObject({ tier: 'quiet', body: expect.stringContaining('Account l hit its session limit; continuing on another account') });
    expect(f.log().find((r) => r.type === 'limit_detected')).toMatchObject({ sessionId: sid, account: 'l', kind: 'session', outOfTurn: true });
    expect(f.log().some((r) => r.type === 'limit_resume_fired')).toBe(true);
    // Nothing announced the limit text as a finished reply.
    expect(of(f, 'conversation_settled').filter((e) => !e.data.notificationSuppressed)).toHaveLength(0);
    // The continue turn ends the work: a normal ending, and no recap turn after it.
    f.spawned[1].cli.emit(ok('Re-ran the integration test: green.'));
    await until(() => of(f, 'session_done').length === 2);
    expect(of(f, 'session_done')[1].data).toMatchObject({ status: 'completed', origin: 'limit_resume' });
    await new Promise((r) => setTimeout(r, 600));
    expect(f.spawned).toHaveLength(2);
    expect(f.spawned[1].cli.prompts()).toHaveLength(1);
    expect(f.manager.limitResumeList()).toEqual([]);
  });

  it('the same shape from the CI conversation (T1, 11:02) names its own agent', async () => {
    const f = fixture();
    await turnWithAgent(f, 'a9d6daf38937ec862', 'Contract analysis phase 1 web');
    for (const e of fixtures.T1a.events) f.spawned[0].cli.emit(e);
    await until(() => f.spawned.length === 2);
    expect(f.spawned[1].cli.prompts()[0]).toContain('- "Contract analysis phase 1 web" (a9d6daf38937ec862)');
  });
});

describe('an out-of-turn limit on the main thread, no subagent (T1, 13:18)', () => {
  it('continues on another account without an agent list', async () => {
    const f = fixture();
    await turnWithAgent(f, 'a1', 'Browser test run');
    f.spawned[0].cli.emit({ type: 'system', subtype: 'task_notification', task_id: 'a1', status: 'completed', summary: 'Agent "Browser test run" completed' });
    for (const e of fixtures.T1b.events) f.spawned[0].cli.emit(e);
    await until(() => f.spawned.length === 2);
    const sent = f.spawned[1].cli.prompts()[0];
    expect(sent).toMatch(/^\[Usage limit: account l hit its session limit/);
    expect(sent).toContain('Continue where you left off.');
    expect(sent).not.toContain('background agents');
    expect(f.spawned[1].configDir).toBe(f.cfg('m'));
    expect(f.accountState('m').kind).not.toBe('limited');
  });
});

describe('the held-process trap (contract item 6)', () => {
  it('a message sent while the woken reply runs never reaches the limited process, and the healthy account is never benched', async () => {
    const f = fixture();
    const { pid, sid } = await turnWithAgent(f);
    f.spawned[0].cli.emit(fixtures.T2.events[0]);           // the agent dies of the limit; the model is woken
    f.manager.continueSession(pid, sid, 'what happened to the test?');
    await until(() => of(f, 'supervisor').some((e) => e.data.type === 'turn_started' && of(f, 'session_started').length === 2));
    await new Promise((r) => setTimeout(r, 30));
    expect(f.spawned[0].cli.prompts()).toEqual(['run the signature audit']); // held for the woken reply
    for (const e of fixtures.T2.events.slice(1)) f.spawned[0].cli.emit(e);
    // The held message moved to a fresh process on the account its turn was
    // routed to (l, before the limit was known); its 429 there fails over to m.
    await until(() => f.spawned.length === 2);
    expect(f.spawned[0].cli.prompts()).toEqual(['run the signature audit']);
    expect(f.spawned[1].configDir).toBe(f.cfg('l'));
    expect(f.spawned[1].cli.prompts()[0]).toContain('what happened to the test?');
    f.spawned[1].cli.emit(fixtures.T2.events[1]);
    await until(() => f.spawned.length === 3);
    expect(f.spawned[2].configDir).toBe(f.cfg('m'));
    expect(f.accountState('m').kind).not.toBe('limited');
    // Review fix 4: the owner's turn is the next step. No continue is
    // scheduled to run after it; the dead agent is named in ONE line steered
    // into that running turn.
    await until(() => of(f, 'steered').length === 1);
    expect(of(f, 'steered')[0].data.text).toBe('These background agents were stopped by a usage limit: "Multibox end-to-end integration test" (aeb663d0b2fd979ef). Re-run them if still needed.');
    expect(f.manager.limitResumeList()).toEqual([]);
    expect(of(f, 'limit_continue')).toHaveLength(0);
    f.spawned[2].cli.emit(ok('The agent hit the usage limit; nothing else changed.'));
    await until(() => of(f, 'session_done').length === 2);
    await new Promise((r) => setTimeout(r, 600));
    const later = f.spawned.slice(1).flatMap((x) => x.cli.prompts());
    expect(later.some((p) => p.includes('Continue where you left off'))).toBe(false);
    expect(f.spawned).toHaveLength(3);
    expect(f.accountState('m').kind).not.toBe('limited');
  });

  it('with no agent killed, nothing is steered or scheduled: limit_continue says it was skipped', async () => {
    const f = fixture();
    const { pid, sid } = await turnWithAgent(f);
    f.spawned[0].cli.emit({ type: 'system', subtype: 'task_notification', task_id: 'aeb663d0b2fd979ef', status: 'completed', summary: 'Agent "Multibox end-to-end integration test" completed' });
    f.manager.continueSession(pid, sid, 'and now?');
    await until(() => of(f, 'session_started').length === 2);
    for (const e of fixtures.T1b.events) f.spawned[0].cli.emit(e);
    await until(() => of(f, 'limit_continue').length === 1);
    expect(of(f, 'limit_continue')[0].data).toMatchObject({ sessionId: sid, skipped: 'turn running' });
    expect(of(f, 'limit_continue')[0].data.notice).toBeUndefined();
    expect(of(f, 'steered')).toHaveLength(0);
    expect(f.manager.limitResumeList()).toEqual([]);
  });
});

describe('weekly and session limits out of turn', () => {
  it.each([
    ['session', "You've hit your session limit · resets 3:10pm (UTC)"],
    ['weekly', "You've hit your weekly limit · resets Oct 30, 9am (UTC)"],
  ])('a %s limit benches the account until the reset its text names (not 30 min) and, with no other account, waits for it', async (kind, text) => {
    const f = fixture(['l']);
    const { sid } = await turnWithAgent(f);
    const at = Math.floor(Date.now() / 1000);
    f.spawned[0].cli.emit({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    f.spawned[0].cli.emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: text });
    await until(() => of(f, 'limit_continue').length === 1);
    const want = parseLimitReset(text, at)!;
    expect(want.kind).toBe(kind);
    const l = f.accountState('l') as { kind: string; until: number };
    expect(l).toMatchObject({ kind: 'limited' });
    expect(Math.abs(l.until - want.until)).toBeLessThanOrEqual(60);
    const ev = of(f, 'limit_continue')[0].data;
    expect(ev).toMatchObject({ sessionId: sid, account: 'l', kind, waiting: true });
    expect(ev.continueAt).toBe((ev.until as number) + 60);
    expect((ev.notice as { tier: string; body: string })).toMatchObject({ tier: 'normal', body: expect.stringMatching(/^Paused by a usage limit until .+; continues automatically$/m) });
    const [rec] = f.manager.limitResumeList();
    expect(rec).toMatchObject({ kind: 'continue', sessionId: sid, account: 'l', limitKind: kind, estimated: false });
    expect(f.spawned[0].cli.st.killed).toBe(true);
    expect(f.spawned).toHaveLength(1);                     // nothing ran: it waits for the reset
    expect(f.log().find((r) => r.type === 'limit_detected')).toMatchObject({ kind, outOfTurn: true });
  });
});

describe('review fix 5: out of turn, only the MAIN thread\'s own limit acts', () => {
  it('a top-level rate_limit_event alone never marks, kills or continues', async () => {
    const f = fixture();
    await turnWithAgent(f);
    f.spawned[0].cli.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' } });
    f.spawned[0].cli.emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'Still working on it.' }] } });
    f.spawned[0].cli.emit(ok('Still working on it.'));
    await new Promise((r) => setTimeout(r, 300));
    expect(f.accountState('l').kind).not.toBe('limited');
    expect(f.spawned[0].cli.st.killed).toBe(false);
    expect(of(f, 'limit_continue')).toHaveLength(0);
    expect(f.manager.limitResumeList()).toEqual([]);
  });

  it('a failed task notification alone (the woken reply is fine) only names; nothing is marked or continued', async () => {
    const f = fixture();
    await turnWithAgent(f);
    f.spawned[0].cli.emit(fixtures.T2.events[0]);
    f.spawned[0].cli.emit({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'The agent died of its own limit; I will finish the test myself.' }] } });
    f.spawned[0].cli.emit(ok('The agent died of its own limit; I will finish the test myself.'));
    await new Promise((r) => setTimeout(r, 300));
    expect(f.accountState('l').kind).not.toBe('limited');
    expect(f.spawned[0].cli.st.killed).toBe(false);
    expect(of(f, 'limit_continue')).toHaveLength(0);
    expect(f.log().some((r) => r.type === 'limit_detected')).toBe(false);
  });

  it('a model\'s own window (an Opus limit) never benches the whole account; the work still continues', async () => {
    const f = fixture();
    const { sid } = await turnWithAgent(f);
    const text = "You've hit your Opus limit · resets 3:10pm (UTC)";
    f.spawned[0].cli.emit({ type: 'assistant', parent_tool_use_id: null, error: 'rate_limit', message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
    f.spawned[0].cli.emit({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: text });
    await until(() => of(f, 'limit_continue').length === 1);
    expect(f.accountState('l').kind).not.toBe('limited');
    expect(f.accountState('m').kind).not.toBe('limited');
    expect(of(f, 'limit_continue')[0].data).toMatchObject({ sessionId: sid, kind: 'model' });
    expect(f.log().find((r) => r.type === 'limit_detected')).toMatchObject({ kind: 'model', benched: false, outOfTurn: true });
    expect(f.spawned[0].cli.st.killed).toBe(true);
    await until(() => f.spawned.length === 2);
    expect(f.spawned[1].cli.prompts()[0]).toMatch(/^\[Usage limit: account l hit its model limit/);
  });
});

describe('review fix 6: an automated turn\'s background limit stays as quiet as that turn', () => {
  it('a cron turn\'s out-of-turn limit waits quietly, and its continue carries the cron origin', async () => {
    const f = fixture(['l']);
    const pid = f.manager.createProject('Nightly', f.root).id;
    const sid = f.manager.start('first', undefined, undefined, pid);
    await until(() => f.spawned.length === 1);
    f.spawned[0].cli.emit(ok('ok'));
    await until(() => of(f, 'session_done').length === 1);
    f.manager.deliverMcpMessage(pid, sid, 'nightly: run the backups', { sender: { kind: 'automation' } });
    await until(() => f.spawned[0].cli.prompts().length === 2);
    f.spawned[0].cli.emit(agent('a1', 'Backup run'));
    f.spawned[0].cli.emit(ok('Started the backup agent.'));
    await until(() => of(f, 'session_done').length === 2);
    for (const e of fixtures.T1b.events) f.spawned[0].cli.emit(e);
    await until(() => of(f, 'limit_continue').length === 1);
    const ev = of(f, 'limit_continue')[0].data;
    expect(ev).toMatchObject({ sessionId: sid, waiting: true, origin: 'cron' });
    expect(ev.notice).toMatchObject({ tier: 'quiet' });
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'continue', origin: 'cron' });
  });
});

describe('delegates (R7): an out-of-turn limit on a delegate\'s process', () => {
  it('marks the account, ends the process and sends the delegate a follow-up with the continue text', async () => {
    const calls: RunSessionOptions[] = [];
    const open = new Map<string, (r: SessionResult) => void>();
    const f = fixture(['l', 'm'], { runSessionFn: (o) => new Promise<SessionResult>((resolve) => {
      calls.push(o); open.set(o.sessionId, resolve);
      o.control?.({ abort: () => resolve({ status: 'stopped', failovers: 0 }), forceSwitch: () => {} });
    }) });
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => calls.length === 1);
    open.get(sid)!({ status: 'completed', failovers: 0, resultText: 'planned' });
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run the multibox test.' });
    await until(() => calls.some((c) => c.sessionId === d.sessionId));
    const run = calls.find((c) => c.sessionId === d.sessionId)!;
    // The delegate's turn runs on a pool process of account l, and leaves an agent running.
    const h = run.startTurnFn!({ configDir: f.cfg('l'), cwd: f.root, sessionId: d.sessionId, conversationId: d.sessionId, mode: 'new', prompt: run.prompt, onEvent: () => {} });
    f.spawned[0].cli.emit(agent('aeb663d0b2fd979ef', 'Multibox end-to-end integration test'));
    f.spawned[0].cli.emit(ok('DONE: started the test agent'));
    await h.done;
    open.get(d.sessionId)!({ status: 'completed', failovers: 0, resultText: 'DONE: started the test agent', finalAccount: 'l' });
    await until(() => f.manager.listDelegates(p.id, sid, d.id)[0].status === 'idle');
    const before = calls.length;
    for (const e of fixtures.T2.events) f.spawned[0].cli.emit(e);
    await until(() => calls.length > before && calls.at(-1)!.sessionId === d.sessionId);
    expect(f.accountState('l').kind).toBe('limited');
    expect(f.accountState('m').kind).not.toBe('limited');
    expect(f.spawned[0].cli.st.killed).toBe(true);
    expect(calls.at(-1)!.prompt).toMatch(/^\[Usage limit: account l hit its session limit/);
    expect(calls.at(-1)!.prompt).toContain('- "Multibox end-to-end integration test" (aeb663d0b2fd979ef)');
    expect(f.manager.listDelegates(p.id, sid, d.id)[0].status).toBe('working');
    expect(f.log().find((r) => r.type === 'limit_detected')).toMatchObject({ sessionId: sid, delegateId: d.id, outOfTurn: true });
    expect(of(f, 'limit_continue')).toHaveLength(0);       // the orchestrator's panel is not the delegate's
  });
});
