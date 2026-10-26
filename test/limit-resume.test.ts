import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager, type GatewayEvent, type SessionManagerOptions } from '../server/manager.js';
import { continueText, failedTaskOf, LimitResumeScheduler, MAX_ATTEMPTS, RETRY_FOR_S, RETRY_S, untilOf, type LimitResumeRecord, type ResumeHost } from '../server/limit-resume.js';
import { noticeFor, originOf } from '../server/notices.js';
import { isAgentSender, ownerRowView } from '../server/owner-view.js';
import { botRowView, turnKindOf, VISIBLE_ORIGINS } from '../server/bot-view.js';
import { AccountRegistry } from '../src/accounts.js';
import { readMessageSender } from '../src/message-sender.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import type { HistoryEntry } from '../src/provider.js';

/** The three live stops of 2026-10-26, as the CLI streams them (see the file's _source). */
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/limit-out-of-turn.json', import.meta.url), 'utf8')) as Record<'T2' | 'T1a' | 'T1b', { at: string; events: Record<string, unknown>[]; resetsAt: string }>;

/** The resume scheduler (R6), parked turns (R5) and parked delegates (R7). */
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((f) => f()); vi.useRealTimers(); vi.restoreAllMocks(); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'limit-resume-')); cleanups.push(() => rmSync(d, { recursive: true, force: true })); return d; };

// ---------------------------------------------------------------- the scheduler

function host(over: Partial<ResumeHost> = {}) {
  let now = 1_800_000_000;
  const delivered: { rec: LimitResumeRecord; text: string }[] = [];
  const emitted: { kind: string; data: Record<string, unknown> }[] = [];
  const logged: Record<string, unknown>[] = [];
  const h: ResumeHost & { set(t: number): void; eligibleNow: boolean } = {
    eligibleNow: true,
    now: () => now,
    set(t) { now = t; },
    eligible() { return h.eligibleNow; },
    nextReset: () => ({ until: now + 3600, estimated: false }),
    skipReason: () => undefined,
    deliver: (rec, text) => { delivered.push({ rec, text }); },
    log: (row) => { logged.push(row); },
    emit: (kind, data) => { emitted.push({ kind, data }); },
    ...over,
  };
  return { h, delivered, emitted, logged };
}
const continueRec = (over: Partial<LimitResumeRecord> = {}) => ({ projectId: 'p', sessionId: 's', provider: 'claude' as const, kind: 'continue' as const, until: 1_800_000_000 + 600, estimated: false, account: 'l', limitKind: 'session' as const, limitAt: 1_800_000_000, ...over });

describe('the resume scheduler', () => {
  it('fires at until + 60 s, through the host, and logs it', () => {
    const dir = tmp(), { h, delivered, logged } = host();
    h.eligibleNow = false;                                  // no account until the reset
    const s = new LimitResumeScheduler(dir, h);
    const rec = s.schedule(continueRec());
    expect(rec.fireAt).toBe(1_800_000_000 + 660);
    s.tick();
    expect(delivered).toHaveLength(0);
    h.set(1_800_000_000 + 659); s.tick();
    expect(delivered).toHaveLength(0);
    h.eligibleNow = true;
    h.set(1_800_000_000 + 660); s.tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toMatch(/^\[Usage limit: account l hit its session limit at \d\d:\d\d WIB \(resets \d\d:\d\d WIB\)\. This continues after the reset\.\]\nContinue where you left off\.$/);
    expect(s.list()).toEqual([]);
    expect(logged.map((r) => r.type)).toEqual(['limit_resume_scheduled', 'limit_resume_fired']);
  });

  it('survives a new instance reading the file (a deploy), and a record whose time passed fires at boot', async () => {
    const dir = tmp(), a = host();
    new LimitResumeScheduler(dir, a.h).schedule(continueRec());
    const b = host(); b.h.set(1_800_000_000 + 7200);
    const s2 = new LimitResumeScheduler(dir, b.h);
    expect(s2.list()).toHaveLength(1);
    s2.start(); cleanups.push(() => s2.stop());
    await new Promise((r) => setTimeout(r, 10));
    expect(b.delivered).toHaveLength(1);
    expect(s2.list()).toEqual([]);
  });

  it('one record per conversation: a newer one replaces it', () => {
    const dir = tmp(), { h } = host();
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec());
    s.schedule(continueRec({ kind: 'resend', prompt: 'again' }));
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]).toMatchObject({ kind: 'resend', prompt: 'again' });
  });

  it('review fix 1: a resend is never replaced; the newer record goes to the host (the queue behind it)', () => {
    const dir = tmp(), { h, logged } = host();
    const kept: [string, string][] = [];
    h.kept = (prev, newer) => { kept.push([prev.prompt!, newer.prompt ?? newer.kind]); };
    const s = new LimitResumeScheduler(dir, h);
    const first = s.schedule(continueRec({ kind: 'resend', prompt: 'the owner\'s message' }));
    expect(s.schedule(continueRec({ kind: 'resend', prompt: 'a cron job' }))).toMatchObject({ id: first.id });
    s.schedule(continueRec({ kind: 'autopilot' }));
    expect(s.list()).toEqual([expect.objectContaining({ id: first.id, prompt: 'the owner\'s message', resumeAutopilot: true })]);
    expect(kept).toEqual([['the owner\'s message', 'a cron job'], ['the owner\'s message', 'autopilot']]);
    expect(logged.filter((r) => r.type === 'limit_resume_kept')).toHaveLength(2);
    // A delegate's resend is kept the same way.
    const d = continueRec({ kind: 'delegate', delegate: { parentSessionId: 's', delegateId: 'd-1', mode: 'resend' }, prompt: 'brief' });
    s.schedule(d); s.schedule({ ...d, delegate: { parentSessionId: 's', delegateId: 'd-1', mode: 'continue' }, prompt: undefined });
    expect(s.forDelegate('s', 'd-1')).toMatchObject({ prompt: 'brief', delegate: { mode: 'resend' } });
  });

  it('re-parks while no account is eligible, and gives up after 6 tries with one notice', () => {
    const dir = tmp(), { h, delivered, emitted, logged } = host();
    h.eligibleNow = false;
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec());
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) { h.set((s.list()[0]?.fireAt ?? h.now()) + 1); s.tick(); }
    expect(delivered).toHaveLength(0);
    expect(logged.filter((r) => r.reparked)).toHaveLength(MAX_ATTEMPTS - 1);
    expect(emitted.filter((e) => e.kind === 'limit_resume')).toEqual([{ kind: 'limit_resume', data: expect.objectContaining({ state: 'gave_up', sessionId: 's', attempts: MAX_ATTEMPTS }) }]);
    expect(logged.filter((r) => r.type === 'limit_resume_gave_up')).toHaveLength(1);
    expect(s.list()).toEqual([]);
  });

  it('loop brake: the 4th auto-continue without a human message is not sent, and one human message starts it over', () => {
    const dir = tmp(), { h, delivered, emitted, logged } = host();
    const s = new LimitResumeScheduler(dir, h);
    for (let i = 0; i < 4; i++) { s.schedule(continueRec({ now: true } as never)); s.tick(); }
    expect(delivered).toHaveLength(3);
    expect(emitted.filter((e) => e.data.state === 'braked')).toHaveLength(1);
    expect(logged.find((r) => r.type === 'limit_resume_skipped')).toMatchObject({ reason: 'loop_brake' });
    s.humanMessage('s');
    s.schedule(continueRec({ now: true } as never)); s.tick();
    expect(delivered).toHaveLength(4);
  });

  it('is cleared without firing for a human message, a stop, and whatever the host says (archived, a pending question)', () => {
    const dir = tmp(), { h, delivered, logged } = host();
    let skip: string | undefined;
    h.skipReason = () => skip;
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec()); s.humanMessage('s');
    s.schedule(continueRec()); s.clear('s', 'stopped');
    skip = 'question'; s.schedule(continueRec({ now: true } as never)); s.tick();
    expect(delivered).toHaveLength(0);
    expect(logged.filter((r) => r.type === 'limit_resume_skipped').map((r) => r.reason)).toEqual(['human', 'stopped', 'question']);
  });

  it('not now (state recovery, membership reconciling) is retried later, never dropped', () => {
    const dir = tmp(), { h, delivered, logged } = host();
    let blocked: string | undefined = 'Project membership is being reconciled';
    h.blocked = () => blocked;
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec({ now: true } as never)); s.tick();
    expect(delivered).toHaveLength(0);
    expect(s.list()[0]).toMatchObject({ attempts: 0, retryingSince: 1_800_000_000, fireAt: 1_800_000_000 + RETRY_S });
    expect(logged.at(-1)).toMatchObject({ type: 'limit_resume_skipped', reason: 'blocked', reparked: true, error: 'Project membership is being reconciled' });
    blocked = undefined; h.set(1_800_000_000 + RETRY_S); s.tick();
    expect(delivered).toHaveLength(1);
  });

  it('a send that fails keeps the record for another try and does not count toward the loop brake', () => {
    const dir = tmp(), { h, delivered, logged } = host();
    let fail = true;
    h.deliver = (rec, text) => { if (fail) throw new Error('Project context recovery is pending'); delivered.push({ rec, text }); };
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec({ now: true } as never)); s.tick();
    expect(s.list()[0]).toMatchObject({ attempts: 0, fireAt: 1_800_000_000 + RETRY_S });
    expect(logged.at(-1)).toMatchObject({ reason: 'delivery_failed', reparked: true });
    fail = false; h.set(1_800_000_000 + RETRY_S); s.tick();
    expect(delivered).toHaveLength(1);
    // Still three in a row allowed: the failed send was not one of them.
    for (let i = 0; i < 3; i++) { s.schedule(continueRec({ now: true } as never)); s.tick(); }
    expect(delivered).toHaveLength(3);
  });

  it('review fix 2: guard refusals and failed sends spend no attempt; they retry every 5 min for 24 h, then give up with the REAL reason', () => {
    const dir = tmp(), { h, delivered, emitted, logged } = host();
    h.blocked = () => 'Project membership is being reconciled';
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec({ kind: 'resend', prompt: 'deploy the fix', now: true } as never));
    // 25 minutes of reconciling at boot: 6 refusals, which used to be all 6 attempts.
    for (let i = 0; i < 6; i++) { h.set(s.list()[0].fireAt); s.tick(); }
    expect(s.list()).toEqual([expect.objectContaining({ attempts: 0, retryingSince: 1_800_000_000 })]);
    expect(emitted).toHaveLength(0);
    // Still refused a day later: it gives up, saying why, quoting the message.
    h.set(1_800_000_000 + RETRY_FOR_S); s.tick();
    expect(s.list()).toEqual([]);
    expect(delivered).toHaveLength(0);
    expect(emitted).toEqual([{ kind: 'limit_resume', data: expect.objectContaining({ state: 'gave_up', reason: 'Project membership is being reconciled', prompt: 'deploy the fix' }) }]);
    expect(logged.find((r) => r.type === 'limit_resume_gave_up')).toMatchObject({ reason: 'Project membership is being reconciled' });
  });

  it('review fix 2: a refusal after an ineligible re-park starts its own 24 h; only ineligible re-parks count toward 6', () => {
    const dir = tmp(), { h, emitted } = host();
    let blocked: string | undefined = 'Project context recovery is pending';
    h.blocked = () => blocked; h.eligibleNow = false;
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec({ now: true } as never)); s.tick();
    blocked = undefined; h.set(s.list()[0].fireAt); s.tick();          // past the guard, no account
    expect(s.list()[0]).toMatchObject({ attempts: 1 });
    expect(s.list()[0].retryingSince).toBeUndefined();
    blocked = 'Project context recovery is pending';
    h.set(1_800_000_000 + RETRY_FOR_S + 10); s.tick();
    expect(s.list()[0]).toMatchObject({ attempts: 1, retryingSince: 1_800_000_000 + RETRY_FOR_S + 10 });
    expect(emitted).toHaveLength(0);
  });

  it('low: a record waiting for a reset fires early on a tick once an account can take it (not one in the guard retry)', () => {
    const dir = tmp(), { h, delivered } = host();
    h.eligibleNow = false;
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec({ until: 1_800_000_000 + 86_400 }));
    s.tick();
    expect(delivered).toHaveLength(0);
    h.set(1_800_000_000 + 30); h.eligibleNow = true; s.tick();      // another account freed up
    expect(delivered).toHaveLength(1);
    // A record in the 5 min guard retry keeps its spacing.
    let blocked: string | undefined = 'Project membership is being reconciled';
    h.blocked = () => blocked;
    s.schedule(continueRec({ now: true } as never)); s.tick();
    blocked = undefined; h.set(1_800_000_000 + 60); s.tick();
    expect(delivered).toHaveLength(1);
    h.set(s.list()[0].fireAt); s.tick();
    expect(delivered).toHaveLength(2);
  });

  it('review fix 7: a skipped resend is never dropped silently (prompt quoted, 120 chars); a delegate is told on EVERY skip', () => {
    const dir = tmp(), { h, emitted } = host();
    let skip: string | undefined = 'question';
    h.skipReason = () => skip;
    const ended: string[] = [];
    h.ended = (rec, reason, detail) => { ended.push(`${rec.delegate?.delegateId ?? rec.sessionId}:${reason}:${detail}`); };
    const s = new LimitResumeScheduler(dir, h);
    const long = 'x'.repeat(200);
    s.schedule(continueRec({ kind: 'resend', prompt: long, now: true } as never)); s.tick();
    expect(emitted).toEqual([{ kind: 'limit_resume', data: expect.objectContaining({ state: 'skipped', reason: 'question', prompt: 'x'.repeat(120) + '…' }) }]);
    skip = 'archived';
    s.schedule(continueRec({ kind: 'delegate', delegate: { parentSessionId: 's', delegateId: 'd-1', mode: 'continue' }, now: true } as never)); s.tick();
    // A continue has no message of its own to lose: no notice, but the delegate is told.
    expect(emitted).toHaveLength(1);
    expect(ended).toEqual(['s:skipped:question', 'd-1:skipped:archived']);
  });

  it('review fix 8: a corrupt file is set aside as .corrupt-<ts> and logged, then the scheduler starts empty', () => {
    const dir = tmp(), { h, logged } = host();
    writeFileSync(join(dir, 'limit-resume.json'), '{"records": [ {"id": "lr-1", truncated');
    const s = new LimitResumeScheduler(dir, h);
    expect(s.list()).toEqual([]);
    const aside = readdirSync(dir).filter((n) => n.startsWith('limit-resume.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toContain('truncated');
    expect(logged.find((r) => r.type === 'limit_resume_corrupt')).toMatchObject({ setAside: join(dir, aside[0]) });
    expect(existsSync(join(dir, 'limit-resume.json'))).toBe(false);
    s.schedule(continueRec());
    expect(s.list()).toHaveLength(1);
  });

  it('low: an out-of-turn reset is capped at now + 8 days', () => {
    expect(untilOf({ kind: 'limited', resetsAt: 1_800_000_000 + 40 * 86_400, source: 'x' }, 1_800_000_000)).toEqual({ until: 1_800_000_000 + 8 * 86_400, estimated: false });
    expect(untilOf({ kind: 'limited', resetsInSeconds: 30 * 86_400, source: 'x' }, 1_800_000_000).until).toBe(1_800_000_000 + 8 * 86_400);
  });

  it('a record that ends unsent (gave up, loop brake) tells the host, so a delegate never waits forever', () => {
    const dir = tmp(), { h } = host();
    const ended: string[] = [];
    h.ended = (rec, reason) => { ended.push(`${rec.delegate?.delegateId}:${reason}`); };
    h.eligible = () => h.eligibleNow;
    const s = new LimitResumeScheduler(dir, h);
    const dRec = (id: string) => continueRec({ kind: 'delegate', delegate: { parentSessionId: 's', delegateId: id, mode: 'continue' } });
    h.eligibleNow = false;
    s.schedule(dRec('d-1'));
    for (let i = 0; i < MAX_ATTEMPTS; i++) { h.set(s.list()[0].fireAt); s.tick(); }
    h.eligibleNow = true;
    for (let i = 0; i < 4; i++) { s.schedule({ ...dRec('d-2'), now: true } as never); s.tick(); }
    expect(ended).toEqual(['d-1:gave_up', 'd-2:braked']);
  });

  it('a delegate record is its own, beside its orchestrator\'s', () => {
    const dir = tmp(), { h } = host();
    const s = new LimitResumeScheduler(dir, h);
    s.schedule(continueRec());
    s.schedule(continueRec({ kind: 'delegate', delegate: { parentSessionId: 's', delegateId: 'd-1', mode: 'resend' }, prompt: 'brief' }));
    expect(s.list()).toHaveLength(2);
    expect(s.waiting('s')).toBe(true);
    s.clear('s', 'human');
    expect(s.waiting('s')).toBe(false);
    expect(s.forDelegate('s', 'd-1')).toMatchObject({ prompt: 'brief' });
  });
});

describe('the continue text', () => {
  it('names the account, the window, both times in WIB, and the dead agents; a reset on another day carries its date', () => {
    const at = Date.parse('2026-10-26T05:31:30Z') / 1000;
    const t = continueText({ account: 'l', limitKind: 'session', limitAt: at, until: Date.parse('2026-10-26T08:30:00Z') / 1000, createdAt: '', failedTasks: [failedTaskOf(fixtures.T2.events[0])!] });
    expect(t).toBe('[Usage limit: account l hit its session limit at 12:31 WIB (resets 15:30 WIB). This continues on another account.]\nContinue where you left off.\n'
      + 'These background agents were stopped by the limit and did not finish; re-run them if they are still needed:\n- "Multibox end-to-end integration test" (aeb663d0b2fd979ef)');
    const weekly = continueText({ account: 'l', limitKind: 'weekly', limitAt: at, until: Date.parse('2026-10-30T09:00:00Z') / 1000, createdAt: '' });
    expect(weekly).toBe('[Usage limit: account l hit its weekly limit at 12:31 WIB (resets Oct 30 16:00 WIB). This continues on another account.]\nContinue where you left off.');
  });

  it('a failed notification counts only when the limit killed it', () => {
    expect(failedTaskOf(fixtures.T1a.events[0])).toEqual({ id: 'a9d6daf38937ec862', description: 'Contract analysis phase 1 web' });
    expect(failedTaskOf({ ...fixtures.T2.events[0], summary: 'Agent "x" failed: exit 1' })).toBeUndefined();
    expect(failedTaskOf({ ...fixtures.T2.events[0], status: 'completed' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- parks (R5) and delegates (R7)

function fixture(stateRoot?: string, extra: Partial<SessionManagerOptions> = {}) {
  const root = stateRoot ?? tmp(), stateDir = join(root, 'state');
  mkdirSync(join(root, 'cfg-a'), { recursive: true });
  if (!stateRoot) AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'cfg-a') }]);
  const calls: RunSessionOptions[] = [];
  const open: ((r: SessionResult) => void)[] = [];
  let script: ((o: RunSessionOptions) => void) | undefined;
  const manager = new SessionManager({ stateDir, workspaceRoot: root, titleGenerator: async () => null, claudePath: '/nonexistent/claude', autopilotIntervalMs: 10, ...extra,
    runSessionFn: ((o: RunSessionOptions) => new Promise<SessionResult>((resolve) => {
      calls.push(o); open.push(resolve); script?.(o);
      o.control?.({ abort: () => resolve({ status: 'stopped', failovers: 0 }), forceSwitch: () => {} });
    })) as never });
  const events: GatewayEvent[] = []; manager.subscribe((e) => events.push(e));
  cleanups.push(() => manager.onModuleDestroy());
  const reg = () => (manager as unknown as { registry(): AccountRegistry }).registry();
  return { manager, root, stateDir, calls, open, events, reg, setScript: (f: typeof script) => { script = f; } };
}
type F = ReturnType<typeof fixture>;
const until = async (cond: () => boolean, ms = 3000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); } };
const of = (f: F, kind: string) => f.events.filter((e) => e.kind === kind);
const now = () => Math.floor(Date.now() / 1000);
const parked: SessionResult = { status: 'parked', failovers: 0 };
const queue = (f: F, pid: string) => (f.manager.queues()[pid] ?? []);
/** Past the reset: the account is usable again and the record is due. */
function afterReset(f: F) {
  const rec = f.manager.limitResumeList()[0];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime((rec.fireAt + 1) * 1000);
}

describe('a parked turn (R5)', () => {
  it('that never started is resent as it was after the reset; the notice says when, and nobody has to act', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, { model: 'opus', effort: 'high' }, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => of(f, 'session_done').length === 1);
    const done = of(f, 'session_done')[0].data;
    expect(done.autoResume).toMatchObject({ kind: 'resend' });
    expect(done.notice).toMatchObject({ tier: 'normal', body: expect.stringMatching(/Paused by a usage limit until .+; continues automatically/) });
    const [rec] = f.manager.limitResumeList();
    expect(rec).toMatchObject({ kind: 'resend', sessionId: sid, prompt: 'deploy the fix', model: 'opus', effort: 'high', estimated: false });
    expect(rec.fireAt).toBe(rec.until + 60);
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('deploy the fix');
    expect(f.calls[1].model).toBe('opus');
    expect(f.calls[1].effort).toBe('high');
    // A brand-new conversation's first turn never ran: no session to --resume yet.
    expect(f.calls[0].resume).toBe(false);
    expect(f.calls[1].resume).toBe(false);
    expect(f.manager.limitResumeList()).toEqual([]);
  });

  it('a panel message with its request id and an attached file is resent with both', async () => {
    const f = fixture(undefined, { chatEnabled: true });
    f.reg().markLimited('a', now() + 3600);
    const chat = f.manager.createChat({ requestId: 'chat-limit-resend-0001' });
    const src = join(f.root, 'brief.txt'); writeFileSync(src, 'the brief');
    const [file] = await f.manager.files().upload(chat.id, 'upload-limit-resend-0001', [{ path: src, name: 'brief.txt' }]);
    const fileRefs = [{ fileId: file.id, versionId: file.latestVersionId }];
    f.manager.continueSession(chat.id, chat.lastSessionId!, 'summarise the brief', { requestId: 'req-limit-resend-0001', fileRefs });
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'resend', requestId: 'req-limit-resend-0001', attachments: fileRefs, fresh: true });
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('summarise the brief');
    expect(f.calls[1].prompt).toContain('brief.txt');
    expect(f.calls[1].resume).toBe(false);
    expect(readFileSync(join(f.stateDir, 'events.jsonl'), 'utf8')).not.toContain('delivery_failed');
    expect(f.manager.limitResumeList()).toEqual([]);
  });

  it('survives a restart: a new manager reads the record and fires it after the reset', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    f.manager.onModuleDestroy();
    const g = fixture(f.root);
    expect(g.manager.limitResumeList()).toHaveLength(1);
    afterReset(g);
    g.manager.limitResume().tick();
    await until(() => g.calls.length === 1);
    expect(g.calls[0].prompt).toContain('deploy the fix');
  });

  it('that ran is continued, with the limit text and sender limit_resume', async () => {
    const f = fixture();
    f.setScript((o) => { if (f.calls.length === 1) { o.log.append({ type: 'turn_started', sessionId: o.sessionId, account: 'a' }); o.log.append({ type: 'limit_detected', sessionId: o.sessionId, account: 'a', limitKind: 'weekly' }); f.reg().markLimited('a', now() + 3600); } });
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'continue', account: 'a', limitKind: 'weekly' });
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toMatch(/^\[Usage limit: account a hit its weekly limit at .+ WIB \(resets .+ WIB\)\. This continues after the reset\.\]\nContinue where you left off\./);
    expect(f.calls[1].resume).toBe(true);
    expect(readMessageSender(f.calls[1].prompt).sender).toMatchObject({ kind: 'limit_resume' });
  });

  it('a human message in between clears it', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    f.manager.continueSession(pid, sid, 'never mind, I did it by hand');
    expect(f.manager.limitResumeList()).toEqual([]);
    const log = readFileSync(join(f.stateDir, 'events.jsonl'), 'utf8');
    expect(log).toMatch(/"type":"limit_resume_skipped","reason":"human"/);
  });

  it('an operator stop clears it', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    f.manager.stopTurn(pid, sid);
    expect(f.manager.limitResumeList()).toEqual([]);
  });

  it('the queue is not drained into a second park; it drains after the resumed turn', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.manager.enqueue(pid, { sessionId: sid, text: 'then tag the release' });
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    await new Promise((r) => setTimeout(r, 600));          // a drain waits 400 ms
    f.manager.tickQueuePlanner();
    await new Promise((r) => setTimeout(r, 600));
    expect(f.calls).toHaveLength(1);
    expect(queue(f, pid)).toHaveLength(1);
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('deploy the fix');
    vi.useRealTimers();
    f.open[1]({ status: 'completed', failovers: 0, resultText: 'Deployed.' });
    await until(() => f.calls.length === 3);
    expect(f.calls[2].prompt).toContain('then tag the release');
  });

  it('an autopilot STEP that parked is replaced by un-pausing autopilot, not by a continue', async () => {
    const f = fixture();
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('work through the backlog', undefined, undefined, pid);
    f.manager.setAutopilot(pid, sid, { count: 3 });
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'Did the first item.' });
    await until(() => f.calls.length === 2);
    expect(readMessageSender(f.calls[1].prompt).sender).toMatchObject({ kind: 'autopilot' });
    f.reg().markLimited('a', now() + 3600);
    f.open[1](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0].kind).toBe('autopilot');
    expect(f.manager.autopilotStatus()[sid]).toMatchObject({ paused: true });
    // One push: the parked notice. The pause itself is quiet.
    expect((of(f, 'autopilot').at(-1)!.data.notice as { tier: string }).tier).toBe('quiet');
    afterReset(f);
    f.manager.limitResume().tick();
    vi.useRealTimers();
    expect(f.manager.autopilotStatus()[sid]?.paused).toBeUndefined();
    await until(() => f.calls.length === 3);
    expect(readMessageSender(f.calls[2].prompt).sender).toMatchObject({ kind: 'autopilot' });
  });

  it('the owner\'s own message parked while autopilot ran is resent, and autopilot goes on after it', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('work through the backlog', undefined, undefined, pid);
    f.manager.setAutopilot(pid, sid, { count: 3 });
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'resend', resumeAutopilot: true, prompt: 'work through the backlog' });
    expect(f.manager.autopilotStatus()[sid]).toMatchObject({ paused: true });
    afterReset(f);
    f.manager.limitResume().tick();
    vi.useRealTimers();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('work through the backlog');
    expect(readMessageSender(f.calls[1].prompt).sender).toBeUndefined();
    expect(f.manager.autopilotStatus()[sid]?.paused).toBeUndefined();
    f.open[1]({ status: 'completed', failovers: 0, resultText: 'Did the first item.' });
    await until(() => f.calls.length === 3);
    expect(readMessageSender(f.calls[2].prompt).sender).toMatchObject({ kind: 'autopilot' });
  });

  it('a resend queued behind a busy turn is still the scheduler\'s: draining it does not reset the loop brake', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    // Another conversation's message runs meanwhile (not a human one: the record stays).
    f.manager.continueSession(pid, sid, 'status?', { sender: { kind: 'conversation', projectId: pid, sessionId: 'other', conversationTitle: 'Ops' } });
    await until(() => f.calls.length === 2);
    expect(f.manager.limitResumeList()).toHaveLength(1);
    afterReset(f);
    f.manager.limitResume().tick();
    vi.useRealTimers();
    expect(queue(f, pid)).toEqual([expect.objectContaining({ text: 'deploy the fix', limitResume: true })]);
    f.open[1]({ status: 'completed', failovers: 0, resultText: 'All green.' });
    await until(() => f.calls.length === 3);
    expect(f.calls[2].prompt).toContain('deploy the fix');
    const file = JSON.parse(readFileSync(join(f.stateDir, 'limit-resume.json'), 'utf8')) as { streaks: Record<string, number> };
    expect(file.streaks[sid]).toBe(1);
  });

  it('a project in state recovery at boot keeps its record (retried), only archiving drops it', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    afterReset(f);
    const m = f.manager as unknown as { recoveryIssues: string[] };
    m.recoveryIssues = ['projects.json: unreadable'];
    // Review fix 2: a long recovery is retried, never counted as "no account".
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) { f.manager.limitResume().tick(); vi.setSystemTime((f.manager.limitResumeList()[0].fireAt + 1) * 1000); }
    expect(f.manager.limitResumeList()).toEqual([expect.objectContaining({ attempts: 0, retryingSince: expect.any(Number) })]);
    expect(of(f, 'limit_resume')).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
    m.recoveryIssues = [];
    const rev = (f.manager as unknown as { projects(): { get(id: string): { revision?: number } } }).projects().get(pid).revision ?? 0;
    f.manager.archiveWorkProject(pid, { expectedRevision: rev, operationId: 'archive-op-limit-1', archived: true });
    vi.setSystemTime((f.manager.limitResumeList()[0].fireAt + 1) * 1000);
    f.manager.limitResume().tick();
    expect(f.manager.limitResumeList()).toEqual([]);
    expect(readFileSync(join(f.stateDir, 'events.jsonl'), 'utf8')).toMatch(/"type":"limit_resume_skipped","reason":"archived"/);
  });
});

/** Two Claude accounts, a and b, in a fresh state root. */
function fixture2(extra: Partial<SessionManagerOptions> = {}) {
  const root = tmp(), stateDir = join(root, 'state');
  for (const n of ['a', 'b']) mkdirSync(join(root, 'cfg-' + n), { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), ['a', 'b'].map((name) => ({ name, configDir: join(root, 'cfg-' + name) })));
  return fixture(root, extra);
}

describe('review fixes (2026-10-27)', () => {
  it('1: a cron message into a conversation whose owner message is parked is queued behind it, never launched or put in its place', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    const out = f.manager.deliverMcpMessage(pid, sid, 'nightly: run the backups', { sender: { kind: 'automation' } });
    expect(out.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 600));          // a drain waits 400 ms
    expect(f.calls).toHaveLength(1);
    expect(f.manager.limitResumeList()).toEqual([expect.objectContaining({ kind: 'resend', prompt: 'deploy the fix' })]);
    afterReset(f);
    f.manager.limitResume().tick();
    vi.useRealTimers();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('deploy the fix');
    f.open[1]({ status: 'completed', failovers: 0, resultText: 'Deployed.' });
    await until(() => f.calls.length === 3);
    expect(f.calls[2].prompt).toContain('nightly: run the backups');
  });

  it('1: a second park while a resend waits keeps the resend; the newer message queues behind it', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    // Something that bypasses the queue gate starts a turn anyway, and parks too.
    f.manager.continueSession(pid, sid, 'status?', { sender: { kind: 'conversation', projectId: pid, sessionId: 'other', conversationTitle: 'Ops' } });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => queue(f, pid).length === 1);
    expect(f.manager.limitResumeList()).toEqual([expect.objectContaining({ kind: 'resend', prompt: 'deploy the fix' })]);
    expect(queue(f, pid)[0]).toMatchObject({ limitResume: true, sender: expect.objectContaining({ kind: 'conversation' }) });
    expect(queue(f, pid)[0].text).toContain('status?');
    afterReset(f);
    f.manager.limitResume().tick();
    vi.useRealTimers();
    await until(() => f.calls.length === 3);
    expect(f.calls[2].prompt).toContain('deploy the fix');
    f.open[2]({ status: 'completed', failovers: 0, resultText: 'Deployed.' });
    await until(() => f.calls.length === 4);
    expect(f.calls[3].prompt).toContain('status?');
  });

  it('3: a park waits when the only other account is out of the MODEL\'s own weekly window (no immediate re-fire)', async () => {
    const f = fixture2();
    f.reg().markLimited('a', now() + 3600);
    writeFileSync(join(f.stateDir, 'quota-cache.json'), JSON.stringify({ b: { at: Date.now(), quota: { weeklyScoped: [{ label: 'Opus', utilization: 100, resetsAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }] } } }));
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, { model: 'opus' }, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    const [rec] = f.manager.limitResumeList();
    expect(rec.immediate).toBeUndefined();
    expect(rec.fireAt).toBe(rec.until + 60);
    f.manager.limitResume().tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(f.calls).toHaveLength(1);
    expect(f.manager.limitResumeList()).toHaveLength(1);
  });

  it('3: a park is never `now`; a tick fires it early once another account can take it', async () => {
    const f = fixture2();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, { model: 'sonnet' }, pid);
    await until(() => f.calls.length === 1);
    await new Promise((r) => setTimeout(r, 20));             // past the boot tick
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0].immediate).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.calls).toHaveLength(1);
    f.manager.limitResume().tick();                          // b can take it
    await until(() => f.calls.length === 2);
    expect(f.calls[1].prompt).toContain('deploy the fix');
  });

  it('6: a continue of a cron turn ends as quietly as that turn, with no push', async () => {
    const f = fixture();
    f.setScript((o) => { if (f.calls.length === 1) { o.log.append({ type: 'turn_started', sessionId: o.sessionId, account: 'a' }); o.log.append({ type: 'limit_detected', sessionId: o.sessionId, account: 'a', limitKind: 'session' }); f.reg().markLimited('a', now() + 3600); } });
    const pid = f.manager.createProject('Nightly', f.root).id;
    const sid = f.manager.start('first', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.setScript(undefined);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'ok' });
    await until(() => of(f, 'session_done').length === 1);
    f.setScript((o) => { if (f.calls.length === 2) { o.log.append({ type: 'turn_started', sessionId: o.sessionId, account: 'a' }); o.log.append({ type: 'limit_detected', sessionId: o.sessionId, account: 'a', limitKind: 'session' }); f.reg().markLimited('a', now() + 3600); } });
    f.manager.deliverMcpMessage(pid, sid, 'nightly: run the backups', { sender: { kind: 'automation' } });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'continue', origin: 'cron' });
    afterReset(f);
    f.manager.limitResume().tick();
    vi.useRealTimers();
    await until(() => f.calls.length === 3);
    expect(f.calls[2].prompt).toContain('"resumeOf":"cron"');
    f.open[2]({ status: 'completed', failovers: 0, resultText: 'Backups done.' });
    await until(() => of(f, 'conversation_settled').some((e) => e.data.origin === 'limit_resume'));
    const done = of(f, 'session_done').at(-1)!.data;
    expect(done).toMatchObject({ origin: 'limit_resume', resumeOrigin: 'cron' });
    const settled = of(f, 'conversation_settled').find((e) => e.data.origin === 'limit_resume')!.data;
    expect((settled.notice as { tier: string }).tier).toBe('quiet');
  });

  it('6: a park with NO account limited (all signed out) stays urgent; one on a real limit is normal', async () => {
    const f = fixture();
    f.reg().markUnauthenticated('a');
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0]({ ...parked, parkedUntil: now() + 1800 });
    await until(() => of(f, 'session_done').length === 1);
    const done = of(f, 'session_done')[0].data;
    expect(done.autoResume).toMatchObject({ estimated: true });
    expect(done.notice).toMatchObject({ tier: 'urgent', category: 'needs_you' });
  });

  it('7: a parked owner message skipped for a pending question raises an urgent notice quoting it', async () => {
    const f = fixture();
    f.reg().markLimited('a', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    const sid = f.manager.start('deploy the fix to production now', undefined, undefined, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    (f.manager as unknown as { pendingQuestions: Map<string, unknown> }).pendingQuestions.set(sid, { question: 'Which region?' });
    afterReset(f);
    f.manager.limitResume().tick();
    expect(f.manager.limitResumeList()).toEqual([]);
    const ev = of(f, 'limit_resume').at(-1)!.data;
    expect(ev).toMatchObject({ state: 'skipped', reason: 'question', prompt: 'deploy the fix to production now' });
    expect(ev.notice).toMatchObject({ tier: 'urgent', category: 'needs_you', body: expect.stringContaining('was not sent (a question is waiting for you). Not sent: “deploy the fix to production now”') });
  });

  it('low: a resend keeps the account and reserve choice the message asked for', async () => {
    const f = fixture2();
    f.reg().markLimited('a', now() + 3600); f.reg().markLimited('b', now() + 3600);
    const pid = f.manager.createProject('Deploys', f.root).id;
    f.manager.start('deploy the fix', undefined, { account: 'b', useReserve: true }, pid);
    await until(() => f.calls.length === 1);
    f.open[0](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'resend', routeAccount: 'b', useReserve: true });
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 2);
    expect(f.calls[1].routing).toMatchObject({ preferredAccount: 'b', useReserve: true });
  });
});

describe('a parked delegate (R7)', () => {
  it('waits for the reset instead of being gated blocked, wakes nobody, and is resent after it', async () => {
    const f = fixture();
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'planned' });
    await until(() => of(f, 'session_done').length === 1);
    f.reg().markLimited('a', now() + 3600);
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run the multibox test.' });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => f.manager.listDelegates(p.id, sid, d.id)[0].status === 'waiting_for_reset');
    await new Promise((r) => setTimeout(r, 50));
    expect(of(f, 'delegate_report')).toHaveLength(0);
    expect(queue(f, p.id)).toHaveLength(0);
    expect(f.manager.listDelegates(p.id, sid, d.id)[0].working).toBe(false);
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'delegate', delegate: { parentSessionId: sid, delegateId: d.id, mode: 'resend' }, prompt: 'Run the multibox test.' });
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 3);
    expect(f.calls[2].sessionId).toBe(d.sessionId);
    expect(f.calls[2].prompt).toContain('Run the multibox test.');
    expect(f.manager.listDelegates(p.id, sid, d.id)[0].status).toBe('working');
  });

  it('one whose turn started before the park is continued, resuming its session even before a first report', async () => {
    const f = fixture();
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'planned' });
    f.setScript((o) => { if (f.calls.length === 2) { o.log.append({ type: 'turn_started', sessionId: o.sessionId, account: 'a' }); o.log.append({ type: 'limit_detected', sessionId: o.sessionId, account: 'a', limitKind: 'session' }); f.reg().markLimited('a', now() + 3600); } });
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run the multibox test.' });
    await until(() => f.calls.length === 2);
    expect(f.calls[1].resume).toBe(false);
    f.open[1](parked);
    await until(() => f.manager.listDelegates(p.id, sid, d.id)[0].status === 'waiting_for_reset');
    expect(f.manager.limitResumeList()[0]).toMatchObject({ kind: 'delegate', delegate: { mode: 'continue' } });
    afterReset(f);
    f.manager.limitResume().tick();
    await until(() => f.calls.length === 3);
    expect(f.calls[2].sessionId).toBe(d.sessionId);
    expect(f.calls[2].resume).toBe(true);
    expect(f.calls[2].prompt).toMatch(/^\[Usage limit: account a hit its session limit at .+\. This continues after the reset\.\]\nContinue where you left off\./);
  });

  it('one the scheduler gives up on reports BLOCKED and wakes its orchestrator, instead of waiting forever', async () => {
    const f = fixture();
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'planned' });
    await until(() => of(f, 'session_done').length === 1);
    f.reg().markLimited('a', now() + 3600);
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run it.' });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      vi.setSystemTime((f.manager.limitResumeList()[0].fireAt + 1) * 1000);
      f.reg().markLimited('a', now() + 3600);              // still out at every try
      f.manager.limitResume().tick();
    }
    vi.useRealTimers();
    expect(f.manager.limitResumeList()).toEqual([]);
    await until(() => of(f, 'delegate_report').length === 1);
    expect(of(f, 'delegate_report')[0].data).toMatchObject({ delegateId: d.id, status: 'failed', gate: 'blocked', text: expect.stringContaining('auto-continue gave up: no account could take it after 6 tries') });
    expect(f.manager.listDelegates(p.id, sid, d.id)[0].status).toBe('failed');
    expect(of(f, 'limit_resume').at(-1)!.data).toMatchObject({ state: 'gave_up', delegateId: d.id });
    await until(() => f.calls.length === 3);                // the orchestrator is woken with the report
    expect(f.calls[2].sessionId).toBe(sid);
  });

  it('stopping the orchestrator stops a delegate waiting for the reset and drops its record', async () => {
    const f = fixture();
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'planned' });
    f.reg().markLimited('a', now() + 3600);
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run it.' });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    f.manager.stopTurn(p.id, sid);
    expect(f.manager.limitResumeList()).toEqual([]);
    expect(f.manager.listDelegates(p.id, sid, d.id)[0].status).toBe('stopped');
  });

  it('review fix 7: an archived orchestrator skips the record and the delegate leaves waiting_for_reset', async () => {
    const f = fixture();
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'planned' });
    await until(() => of(f, 'session_done').length === 1);
    f.reg().markLimited('a', now() + 3600);
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run it.' });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => f.manager.listDelegates(p.id, sid, d.id)[0].status === 'waiting_for_reset');
    const rev = (f.manager as unknown as { projects(): { get(id: string): { revision?: number } } }).projects().get(p.id).revision ?? 0;
    f.manager.archiveWorkProject(p.id, { expectedRevision: rev, operationId: 'archive-op-limit-2', archived: true });
    afterReset(f);
    f.manager.limitResume().tick();
    expect(f.manager.limitResumeList()).toEqual([]);
    expect(f.manager.listDelegates(p.id, sid, d.id)[0].status).toBe('interrupted');
  });

  it('stopping it clears its record', async () => {
    const f = fixture();
    const p = f.manager.createProject('P', f.root);
    const sid = f.manager.start('orchestrate', undefined, {}, p.id);
    await until(() => f.calls.length === 1);
    f.open[0]({ status: 'completed', failovers: 0, resultText: 'planned' });
    f.reg().markLimited('a', now() + 3600);
    const d = f.manager.startDelegate(p.id, sid, { role: 'tester', brief: 'Run it.' });
    await until(() => f.calls.length === 2);
    f.open[1](parked);
    await until(() => f.manager.limitResumeList().length === 1);
    f.manager.stopDelegates(p.id, sid, d.id);
    expect(f.manager.limitResumeList()).toEqual([]);
  });
});

// ---------------------------------------------------------------- the sender kind and its notices

describe('sender kind limit_resume', () => {
  it('is its own origin, ends the work with a normal notice, and counts as visible', () => {
    expect(originOf({ kind: 'limit_resume' })).toBe('limit_resume');
    const n = noticeFor('conversation_settled', { projectId: 'p', sessionId: 's', status: 'completed', origin: 'limit_resume', resultText: 'Re-ran the test: green.', durationMs: 5000 }, { conversationTitle: 'Signature audit', projectKind: 'chat' });
    expect(n).toMatchObject({ tier: 'normal', category: 'finished' });
    expect(VISIBLE_ORIGINS.has('limit_resume')).toBe(true);
    expect(readMessageSender('Continue.\n\n[x056 message sender v1] {"kind":"limit_resume"}').sender).toEqual({ kind: 'limit_resume' });
  });

  it('stays visible in the owner view and the Bot view: not an agent', () => {
    const sender = { kind: 'limit_resume' as const, messageId: 'm1' };
    expect(isAgentSender(sender, 's')).toBe(false);
    expect(turnKindOf({ sender })).toBe('');
    const rows: HistoryEntry[] = [
      { role: 'user', text: '[Usage limit: account l hit its session limit ...]\nContinue where you left off.', sender } as HistoryEntry,
      { role: 'assistant', text: 'Re-ran the integration test.' } as HistoryEntry,
    ];
    expect(ownerRowView(rows, { sessionId: 's' }).map((r) => r.ownerView)).toEqual(['show', 'show']);
    expect(botRowView(rows).map((r) => r.botView)).toEqual(['show', 'show']);
  });

  it('notices: continuing now is quiet; waiting is normal; giving up and the loop brake need the owner (urgent)', () => {
    const ctx = { conversationTitle: 'Signature audit', projectKind: 'chat', timeZone: 'Asia/Jakarta' };
    const at = Date.parse('2026-10-26T08:31:00Z') / 1000;
    expect(noticeFor('limit_continue', { sessionId: 's', account: 'l', kind: 'session', waiting: false }, ctx)).toMatchObject({ tier: 'quiet', body: 'Account l hit its session limit; continuing on another account' });
    expect(noticeFor('limit_continue', { sessionId: 's', account: 'l', kind: 'weekly', waiting: true, until: at, continueAt: at + 60 }, ctx)).toMatchObject({ tier: 'normal', category: 'finished', body: 'Paused by a usage limit until 15:31; continues automatically' });
    expect(noticeFor('limit_resume', { sessionId: 's', state: 'gave_up', attempts: 6, reason: 'no account could take it after 6 tries' }, ctx)).toMatchObject({ tier: 'urgent', category: 'needs_you', body: expect.stringContaining('Auto-continue gave up: no account could take it after 6 tries') });
    expect(noticeFor('limit_resume', { sessionId: 's', state: 'braked', count: 3 }, ctx)).toMatchObject({ tier: 'urgent', category: 'needs_you' });
    expect(noticeFor('limit_resume', { sessionId: 's', state: 'fired' }, ctx)).toBeNull();
    expect(noticeFor('session_done', { sessionId: 's', status: 'parked', autoResume: { at: at + 60, until: at } }, ctx)).toMatchObject({ tier: 'normal', body: 'Paused by a usage limit until 15:31; continues automatically' });
    // Without a scheduled resume a park still needs a person.
    expect(noticeFor('session_done', { sessionId: 's', status: 'parked', parkedUntil: at }, ctx)).toMatchObject({ tier: 'urgent' });
  });
});
