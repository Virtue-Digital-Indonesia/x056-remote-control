import 'reflect-metadata';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import { ApiController } from '../server/api.controller.js';
import { noticeFor } from '../server/notices.js';
import { readMessageSender, stripTeamLine } from '../src/message-sender.js';
import { stripMemoryContext } from '../src/memory-context.js';
import { answeredQuestionIndexes, hasResolved, stripAsk, stripAskInstructions } from '../src/question.js';
import type { RunSessionOptions } from '../src/failover.js';

/**
 * Every way a question card can close (docs: CLAUDE.md "Open questions").
 * The owner's rule: a card stays open until the owner answers it, or the
 * asking chat resolves it explicitly.
 */

type Result = { status: 'completed' | 'failed'; reason?: string; resultText?: string };
type Pending = { projectId: string; sessionId: string; question: string; options: string[]; questions?: { question: string; options: string[] }[]; at: string };

function fixture(script: Result[] = [], opts: { gate?: (call: number) => Promise<void>; questions?: Record<string, Pending>; chatEnabled?: boolean } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-qclose-'));
  const stateDir = join(dir, 'state'), work = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(work, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [{
    id: 'p1', name: 'Work', cwd: work, provider: 'claude', conversations: [{ sessionId: 'x', title: 'X' }, { sessionId: 'y', title: 'Y' }], lastSessionId: 'x',
  }] }));
  if (opts.questions) writeFileSync(join(stateDir, 'questions.json'), JSON.stringify(opts.questions));
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    if (opts.gate) await opts.gate(calls.length);
    const r = script.shift() ?? { status: 'completed', resultText: 'ok' };
    return { ...r, sessionId: o.sessionId, finalAccount: 'a', failovers: 0 };
  }) as unknown as typeof import('../src/failover.js').runSession;
  const manager = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn, ...(opts.chatEnabled ? { chatEnabled: true } : {}) });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  manager.subscribe((e) => events.push({ kind: e.kind, data: e.data }));
  return { dir, stateDir, manager, calls, events };
}
type Fixture = ReturnType<typeof fixture>;
type Internals = {
  afterTurns: Map<string, { sawWork: boolean; seq: number; reply?: { text: string; seq: number; at: string }; openAtStart?: string[]; origin?: string }>;
  onSettled(d: Record<string, unknown>): void;
  pools(): unknown[];
  limitResumeSkip(rec: Record<string, unknown>): string | undefined;
};
const internals = (f: Fixture) => f.manager as unknown as Internals;

function controller(f: Fixture): ApiController {
  const Ctor = ApiController as unknown as new (...args: unknown[]) => ApiController;
  return new Ctor(f.manager, f.stateDir, {}, {}, {}, {}, {}, {}, {}, {}, { list: () => [] }, {}, {}, {}, {});
}
/** The open-question line names each item's id; these checks are about the texts. */
const noIds = (prompt: string) => prompt.replace(/ \(id [0-9a-f]{8}\)/g, '');
const until = async (cond: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); if (!cond()) throw new Error('timed out'); };
const turnsDone = (f: Fixture, sid = 'x') => f.events.filter((e) => e.kind === 'session_done' && e.data.sessionId === sid).length;
const kinds = (f: Fixture, k: string) => f.events.filter((e) => e.kind === k);
const pending = (f: Fixture) => f.manager.listPendingQuestions().filter((q) => q.sessionId === 'x');
const texts = (f: Fixture) => pending(f).flatMap((q) => (q.questions ?? [q]).map((x) => x.question));

const ask = (...qs: [string, string[]][]) => 'Plan ready.\n<<<ASK\n' + qs.map(([q, o]) => `question: ${q}\n` + (o.length ? `options: ${o.join(' | ')}\n` : '')).join('') + '>>>';
const SLA: [string, string[]] = ['Terms of Service: use these SLA values?', ['Use them', 'Change them']];
const PUBLISH: [string, string[]] = ['Publish the Terms?', ['Publish now', 'Wait']];
const TWO = { status: 'completed' as const, resultText: ask(SLA, PUBLISH) };
const ONE = { status: 'completed' as const, resultText: ask(['Proceed with the migration?', ['Yes', 'No']]) };

/** The owner's first turn ends with the ASK: the card is open. */
async function openCard(f: Fixture): Promise<Pending> {
  f.manager.continueSession('p1', 'x', 'draft the terms');
  await until(() => turnsDone(f) === 1);
  expect(pending(f)).toHaveLength(1);
  return pending(f)[0] as Pending;
}
async function ownerSays(f: Fixture, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const before = turnsDone(f);
  f.manager.continueSession('p1', 'x', text, extra);
  await until(() => turnsDone(f) === before + 1);
}
/** What a history reader shows for a prompt the CLI received. */
const shown = (prompt: string) => stripAskInstructions(stripMemoryContext(stripTeamLine(readMessageSender(prompt).text)));

describe('the owner answers the card', () => {
  it('1. the panel card answer (answersQuestionAt, through the route) closes the batch, free text included', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    // Free text typed into the card matches no option and no "N. q" block: the marker alone says it is the answer.
    const res = controller(f).continueSession({ projectId: 'p1', sessionId: 'x', prompt: 'Whatever you think is best', requestId: randomUUID(), answersQuestionAt: card.at });
    expect(res).toMatchObject({ sessionId: 'x' });
    await until(() => turnsDone(f) === 2);
    expect(pending(f)).toEqual([]);
    expect(kinds(f, 'question_answered')).toHaveLength(1);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ sessionId: 'x', at: card.at, by: 'turn' });
  });

  it('1b. a stale answersQuestionAt (another batch) closes nothing by itself', async () => {
    const f = fixture([TWO]);
    await openCard(f);
    await ownerSays(f, 'Whatever you think is best', { answersQuestionAt: '2020-01-01T00:00:00.000Z' });
    expect(texts(f)).toEqual([SLA[0], PUBLISH[0]]);
  });

  it('2. an unrelated owner message keeps the card; the owner\'s turn is told, the displayed prompt is not', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    await ownerSays(f, 'Change emails in privacy to contact@example.com');
    expect(pending(f)).toHaveLength(1);
    expect(pending(f)[0].at).toBe(card.at);
    expect(kinds(f, 'question_answered')).toHaveLength(0);
    const prompt = f.calls[1].prompt;
    expect(noIds(prompt)).toContain(`[Open question to the owner, still unanswered: "${SLA[0]}", "${PUBLISH[0]}". Card at=${card.at}.`);
    for (const item of card.questions ?? []) expect(prompt).toContain(`(id ${(item as { id?: string }).id})`);
    // What the owner sees of their own message: no line, live or read back.
    const started = kinds(f, 'session_started').at(-1)!.data;
    expect(String(started.displayPrompt)).not.toContain('Open question');
    expect(String(started.prompt)).not.toContain('Open question');
    expect(shown(prompt)).toBe('Change emails in privacy to contact@example.com');
  });

  it('3. iOS: the exact option text, no marker, closes only that question', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    await ownerSays(f, '  publish NOW ');
    expect(texts(f)).toEqual([SLA[0]]);
    expect(pending(f)[0]).toMatchObject({ question: SLA[0], options: SLA[1], at: card.at });
    expect(pending(f)[0].questions).toBeUndefined();
    expect(kinds(f, 'question_answered')).toHaveLength(0);
    // The turn is told about what is still open, and only that.
    expect(noIds(f.calls[1].prompt)).toContain(`still unanswered: "${SLA[0]}".`);
  });

  it('3b. an option shared by two questions closes only the first one still open', () => {
    const batch = [{ question: 'A?', options: ['Yes', 'No'] }, { question: 'B?', options: ['yes', 'Later'] }];
    expect(answeredQuestionIndexes(batch, 'YES')).toEqual([0]);
    expect(answeredQuestionIndexes(batch, '1. A?\nAnswer: No\n\nyes')).toEqual([0]);
    expect(answeredQuestionIndexes(batch, 'yes please')).toEqual([]);
  });

  it('4. "N. q / Answer: x" answering 1 of 2 closes only that one; a question event carries the rest, quietly', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    const before = kinds(f, 'question').length;
    await ownerSays(f, `2.  Publish   the Terms?\nAnswer: Wait until Friday`);
    expect(texts(f)).toEqual([SLA[0]]);
    const rest = kinds(f, 'question').slice(before);
    expect(rest).toHaveLength(1);
    expect(rest[0].data).toMatchObject({ sessionId: 'x', question: SLA[0], options: SLA[1], at: card.at, remainder: true, answered: [PUBLISH[0]] });
    expect(rest[0].data.latest).toBeUndefined();
    // Same id as the card's first push, and suppressed: nothing is pushed or popped up again.
    expect(rest[0].data.notice).toMatchObject({ id: `question:x:${card.at}`, screenSuppressed: true });
    expect(noticeFor('question', { sessionId: 'x', question: 'q', at: card.at }, {})!.screenSuppressed).toBeUndefined();
    // Both answered: closed, as the panel's batch form sends it.
    await ownerSays(f, `1. ${SLA[0]}\nAnswer: Use them`);
    expect(pending(f)).toEqual([]);
    expect(kinds(f, 'question_answered')).toHaveLength(1);
  });

  it('4c. the Bot\'s digest never takes the remainder (not even after a restart forgot the first push)', async () => {
    const f = fixture([TWO], { chatEnabled: true });
    const bot = f.manager.bot();
    bot.update({ enabled: true });
    await openCard(f);
    expect(bot.pendingDigest().lines).toHaveLength(1); // the card itself is digested, as before
    const digest = bot as unknown as { seen: Set<string>; buffer: string[] };
    digest.seen.clear(); digest.buffer.length = 0; // what a restart leaves
    await ownerSays(f, 'Publish now');
    expect(kinds(f, 'question').at(-1)!.data).toMatchObject({ remainder: true });
    expect(bot.pendingDigest().lines).toEqual([]);
  });

  it('4b. a question that spans lines (a Bot needs_you) is matched across them', () => {
    const batch = [{ question: 'Deploy needs you\n\nApprove the migration?', options: [] }, { question: 'Rotate?', options: [] }];
    expect(answeredQuestionIndexes(batch, '1. Deploy needs you\n\nApprove the migration?\nAnswer: yes\n\n2. Rotate?\nAnswer: no')).toEqual([0, 1]);
  });
});

describe('nobody but the owner or the asking chat closes it', () => {
  it('5. an agent, a cron and a relay turn keep the card (and are told)', async () => {
    const f = fixture([ONE]);
    await openCard(f);
    f.manager.deliverMcpMessage('p1', 'x', 'Yes', { from: 'y', interactive: false }); // even an option's text
    await until(() => turnsDone(f) === 2);
    f.manager.enqueue('p1', { sessionId: 'x', text: 'Yes', sender: { kind: 'automation', jobId: 'j1' } as never });
    await until(() => turnsDone(f) === 3);
    f.manager.enqueue('p1', { sessionId: 'x', text: 'Yes', sender: { kind: 'conversation', projectId: 'p1', sessionId: 'y' } });
    await until(() => turnsDone(f) === 4);
    expect(texts(f)).toEqual(['Proceed with the migration?']);
    expect(kinds(f, 'question_answered')).toHaveLength(0);
    for (const c of f.calls.slice(1)) expect(noIds(c.prompt)).toContain('[Open question to the owner, still unanswered: "Proceed with the migration?"');
  });
});

describe('<<<RESOLVED>>> closes what was open when the turn began, and only on its own line', () => {
  it('6. on its own line it closes the questions open at turn start', async () => {
    const f = fixture([TWO, { status: 'completed', resultText: 'The owner settled both in the docs.\n<<<RESOLVED>>>' }]);
    await openCard(f);
    await ownerSays(f, 'look at the docs folder');
    expect(pending(f)).toEqual([]);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ by: 'resolved' });
  });

  it('7. inline, in backticks or in a code fence it closes nothing', async () => {
    expect(hasResolved('the two Terms cards are still open. <<<RESOLVED>>>')).toBe(false);
    expect(hasResolved('`<<<RESOLVED>>>`')).toBe(false);
    expect(hasResolved('Example:\n```\n<<<RESOLVED>>>\n```')).toBe(false);
    expect(hasResolved('Done.\n  <<<RESOLVED>>>  \n')).toBe(true);
    // still stripped anywhere for display
    expect(stripAsk('still open. <<<RESOLVED>>>')).toBe('still open.');
    const f = fixture([TWO, { status: 'completed', resultText: 'The two Terms cards are still open. <<<RESOLVED>>>' }, { status: 'completed', resultText: 'Use `<<<RESOLVED>>>` to close one.' }]);
    await openCard(f);
    await ownerSays(f, 'status?');
    await ownerSays(f, 'how do I close one?');
    expect(texts(f)).toEqual([SLA[0], PUBLISH[0]]);
    expect(kinds(f, 'question_answered')).toHaveLength(0);
  });

  it('8. RESOLVED + a new ASK in one reply: the old ones resolve, the new one stays', async () => {
    const f = fixture([TWO, { status: 'completed', resultText: ask(['Ship on Monday?', ['Yes', 'No']]) + '\n<<<RESOLVED>>>' }]);
    const card = await openCard(f);
    await ownerSays(f, 'we decided in the meeting, see notes');
    expect(texts(f)).toEqual(['Ship on Monday?']);
    expect(pending(f)[0].at).not.toBe(card.at);
  });

  it('8b. RESOLVED never closes a question raised after its turn began (merged meanwhile)', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = fixture([ONE, { status: 'completed', resultText: 'Settled.\n<<<RESOLVED>>>' }], { gate: (n) => n === 2 ? held : Promise.resolve() });
    await openCard(f);
    f.manager.continueSession('p1', 'x', 'think about it');
    await until(() => f.calls.length === 2);
    // Another ASK lands while that turn runs (here: the Bot-style direct add, by a woken reply's path).
    (f.manager as unknown as { addPendingQuestion(pid: string, sid: string, q: { question: string; options: string[] }): unknown }).addPendingQuestion('p1', 'x', { question: 'Late question?', options: [] });
    release();
    await until(() => turnsDone(f) === 2);
    expect(texts(f)).toEqual(['Late question?']);
  });

  it('9. a woken reply\'s RESOLVED after the turn re-asked keeps the new card', async () => {
    // Turn 2 re-asks the open question and asks a new one; its woken reply then signs off with RESOLVED.
    const f = fixture([ONE, { status: 'completed', resultText: ask(['Proceed with the migration?', ['Yes', 'No']], ['Also rotate the key?', ['Yes', 'No']]) }]);
    await openCard(f);
    await ownerSays(f, 'what else do you need?');
    expect(texts(f)).toEqual(['Proceed with the migration?', 'Also rotate the key?']);
    const st = internals(f).afterTurns.get('x')!;
    expect(st.openAtStart).toEqual([]); // re-asked by the turn itself: no longer "open at its start"
    st.sawWork = true; st.reply = { text: 'Agents finished.\n<<<RESOLVED>>>', seq: 1, at: new Date().toISOString() };
    internals(f).onSettled({ projectId: 'p1', sessionId: 'x', status: 'completed', origin: 'human' });
    expect(texts(f)).toEqual(['Proceed with the migration?', 'Also rotate the key?']);
    expect(kinds(f, 'question_answered')).toHaveLength(0);
  });

  it('9b. a woken reply\'s RESOLVED closes what was open at turn start, never what the turn asked', async () => {
    const f = fixture([ONE, { status: 'completed', resultText: ask(['Also rotate the key?', ['Yes', 'No']]) }]);
    await openCard(f);
    await ownerSays(f, 'check the logs first');
    const st = internals(f).afterTurns.get('x')!;
    expect(st.openAtStart).toEqual(['Proceed with the migration?']);
    st.sawWork = true; st.reply = { text: 'The logs answer it.\n<<<RESOLVED>>>', seq: 1, at: new Date().toISOString() };
    internals(f).onSettled({ projectId: 'p1', sessionId: 'x', status: 'completed', origin: 'human' });
    expect(texts(f)).toEqual(['Also rotate the key?']);
  });

  it('9c. a woken reply\'s ASK the settle never reached becomes a card when the next turn starts', async () => {
    const f = fixture([{ status: 'completed', resultText: 'Agents launched.' }, { status: 'completed', resultText: 'ok' }]);
    await ownerSays(f, 'run the agents');
    const st = internals(f).afterTurns.get('x')!;
    st.sawWork = true; st.reply = { text: ask(['Merge the agents\' branches?', ['Yes', 'No']]), seq: 1, at: new Date().toISOString() };
    // A background agent still runs, so no settle; an agent's message starts the next turn.
    f.manager.deliverMcpMessage('p1', 'x', 'status?', { from: 'y', interactive: false });
    await until(() => turnsDone(f) === 2);
    expect(texts(f)).toEqual(['Merge the agents\' branches?']);
    expect(noIds(f.calls[1].prompt)).toContain('still unanswered: "Merge the agents\' branches?"');
  });
});

describe('a queued message draining right after the ASK', () => {
  it('10. the card is still made, and the drained turn gets the open-question line', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = fixture([ONE, { status: 'completed', resultText: 'Noted.' }], { gate: (n) => n === 1 ? held : Promise.resolve() });
    f.manager.continueSession('p1', 'x', 'plan the migration');
    await until(() => f.calls.length === 1);
    f.manager.enqueue('p1', { sessionId: 'x', text: 'FYI: the build finished', sender: { kind: 'conversation', projectId: 'p1', sessionId: 'y' } });
    release();
    await until(() => turnsDone(f) === 2);
    expect(texts(f)).toEqual(['Proceed with the migration?']);
    const q = kinds(f, 'question');
    expect(q).toHaveLength(1);
    // The card came before the drained turn started.
    const order = f.events.map((e) => e.kind);
    expect(order.indexOf('question')).toBeLessThan(order.lastIndexOf('session_started'));
    expect(noIds(f.calls[1].prompt)).toContain('[Open question to the owner, still unanswered: "Proceed with the migration?"');
  });
});

describe('a human steer', () => {
  async function steer(f: Fixture, text: string, opts: { answersQuestionAt?: string } = {}): Promise<boolean> {
    const m = f.manager as unknown as { pools: () => unknown[] };
    const real = m.pools;
    m.pools = () => [{ injectMessage: async () => true }];
    try { return await f.manager.steerSession('p1', 'x', text, opts); } finally { m.pools = real; }
  }
  it('11. free text keeps the card; the option\'s text closes that question; the card\'s own steer closes it', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    expect(await steer(f, 'also fix the footer')).toBe(true);
    expect(texts(f)).toEqual([SLA[0], PUBLISH[0]]);
    expect(await steer(f, 'Use them')).toBe(true);
    expect(texts(f)).toEqual([PUBLISH[0]]);
    expect(kinds(f, 'question').at(-1)!.data).toMatchObject({ remainder: true, by: 'steer', at: card.at });
    expect(await steer(f, 'not sure yet, ask me tomorrow', { answersQuestionAt: card.at })).toBe(true);
    expect(pending(f)).toEqual([]);
    expect(kinds(f, 'question_answered')[0].data).toMatchObject({ by: 'steer' });
  });
});

describe('unchanged', () => {
  it('12. dismiss still closes the card', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    expect(f.manager.dismissPendingQuestion('p1', 'x', card.at)).toBe(true);
    expect(pending(f)).toEqual([]);
    expect(kinds(f, 'question_dismissed')[0].data).toMatchObject({ sessionId: 'x', at: card.at });
  });

  it('12b. a partly answered card keeps its `at`, so dismissing the rest still works', async () => {
    const f = fixture([TWO]);
    const card = await openCard(f);
    await ownerSays(f, 'Publish now');
    expect(f.manager.dismissPendingQuestion('p1', 'x', card.at)).toBe(true);
    expect(pending(f)).toEqual([]);
  });

  it('13. the 14-day boot purge still purges, a 3-day-old card is stale but kept', () => {
    const old = new Date(Date.now() - 15 * 24 * 3600_000).toISOString();
    const stale = new Date(Date.now() - 4 * 24 * 3600_000).toISOString();
    const f = fixture([], { questions: {
      x: { projectId: 'p1', sessionId: 'x', question: 'Ancient?', options: [], at: old },
      y: { projectId: 'p1', sessionId: 'y', question: 'Stale?', options: [], at: stale },
    } });
    const list = f.manager.listPendingQuestions();
    expect(list.map((q) => q.question)).toEqual(['Stale?']);
    expect(list[0]).toMatchObject({ stale: true });
  });

  it('a parked owner message is not held by a card already open when it was sent; a newer one, or an agent\'s, still holds', async () => {
    const f = fixture([ONE]);
    const card = await openCard(f);
    const later = new Date(Date.parse(card.at) + 60_000).toISOString();
    const earlier = new Date(Date.parse(card.at) - 60_000).toISOString();
    const rec = (over: Record<string, unknown>) => ({ id: 'r', projectId: 'p1', sessionId: 'x', provider: 'claude', kind: 'resend', until: 0, estimated: false, fireAt: 0, attempts: 0, createdAt: later, origin: 'human', ...over });
    const skip = (r: Record<string, unknown>) => internals(f).limitResumeSkip(r);
    expect(skip(rec({}))).toBeUndefined();
    expect(skip(rec({ kind: 'continue' }))).toBeUndefined();
    expect(skip(rec({ createdAt: earlier }))).toBe('question');
    expect(skip(rec({ origin: 'relay' }))).toBe('question');
  });
});
