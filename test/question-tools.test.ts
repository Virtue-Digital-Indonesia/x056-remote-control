import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { SessionManager } from '../server/manager.js';
import { ApiController } from '../server/api.controller.js';
import { ConversationJournal } from '../server/conversation-journal.js';
import type { RunSessionOptions } from '../src/failover.js';

/**
 * Question cards over MCP (docs/question-tools-contract.md): stable item ids,
 * ask / edit / close routes, agent closes with `by`, the cross-conversation
 * answer closed at delivery, and the owner's system line.
 */

type Result = { status: 'completed' | 'failed'; reason?: string; resultText?: string };
type Item = { id: string; question: string; options: string[] };
type Batch = { projectId: string; sessionId: string; question: string; options: string[]; id?: string; questions?: Item[]; at: string };

function fixture(script: Result[] = [], opts: { gate?: (call: number) => Promise<void>; questions?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'x056-qtools-'));
  const stateDir = join(dir, 'state'), work = join(dir, 'work');
  mkdirSync(stateDir, { recursive: true }); mkdirSync(work, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(dir, 'cfg') }]);
  writeFileSync(join(stateDir, 'projects.json'), JSON.stringify({ current: 'p1', projects: [{
    id: 'p1', name: 'Work', cwd: work, provider: 'claude', conversations: [{ sessionId: 'x', title: 'Asker' }, { sessionId: 'y', title: 'Helper' }], lastSessionId: 'x',
  }] }));
  if (opts.questions) writeFileSync(join(stateDir, 'questions.json'), JSON.stringify(opts.questions));
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    if (opts.gate) await opts.gate(calls.length);
    const r = script.shift() ?? { status: 'completed', resultText: 'ok' };
    return { ...r, sessionId: o.sessionId, finalAccount: 'a', failovers: 0 };
  }) as unknown as typeof import('../src/failover.js').runSession;
  const manager = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn, chatEnabled: true });
  const events: { kind: string; data: Record<string, unknown> }[] = [];
  manager.subscribe((e) => events.push({ kind: e.kind, data: e.data }));
  const Ctor = ApiController as unknown as new (...args: unknown[]) => ApiController;
  const api = new Ctor(manager, stateDir, {}, {}, {}, {}, {}, {}, {}, {}, { list: () => [] }, {}, {}, {}, {});
  return { dir, stateDir, manager, calls, events, api };
}
type Fixture = ReturnType<typeof fixture>;

const until = async (cond: () => boolean, ms = 4000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); if (!cond()) throw new Error('timed out'); };
const turnsDone = (f: Fixture, sid = 'x') => f.events.filter((e) => e.kind === 'session_done' && e.data.sessionId === sid).length;
const kinds = (f: Fixture, k: string) => f.events.filter((e) => e.kind === k);
const card = (f: Fixture, sid = 'x') => f.manager.listPendingQuestions().find((q) => q.sessionId === sid) as Batch | undefined;
const items = (b: Batch | undefined): Item[] => b ? (b.questions ?? [{ id: b.id!, question: b.question, options: b.options }]) : [];
/** The HTTP error a route threw: status and body. */
function httpError(fn: () => unknown): { status: number; body: Record<string, unknown> } {
  try { fn(); } catch (err) {
    const e = err as { getStatus?: () => number; getResponse?: () => unknown };
    if (e.getStatus) return { status: e.getStatus(), body: e.getResponse!() as Record<string, unknown> };
    throw err;
  }
  throw new Error('expected the route to throw');
}

const TWO = [{ question: 'Use the new schema?', options: ['Yes', 'No'] }, { question: 'Deploy tonight?', options: ['Tonight', 'Tomorrow'] }];
const openTwo = (f: Fixture) => f.api.questionsAsk({ from: 'x', questions: TWO }) as { status: string; at: string; questions: Item[] };

describe('ask_user', () => {
  it('opens the caller\'s card with 8-hex ids, carried in the event and in GET /api/questions (with its filter)', () => {
    const f = fixture();
    const out = openTwo(f);
    expect(out.status).toBe('open');
    expect(out.questions.map((q) => q.question)).toEqual(TWO.map((q) => q.question));
    for (const q of out.questions) expect(q.id).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(out.questions.map((q) => q.id)).size).toBe(2);
    const ev = kinds(f, 'question')[0].data as unknown as Batch;
    expect(ev.questions!.map((q) => q.id)).toEqual(out.questions.map((q) => q.id));
    expect(ev.id).toBe(out.questions[0].id);
    expect(f.api.pendingQuestions('p1', 'x')).toHaveLength(1);
    expect(f.api.pendingQuestions(undefined, 'y')).toHaveLength(0);
    expect(f.api.pendingQuestions()).toHaveLength(1);
    expect(items(card(f))).toEqual(out.questions);
  });

  it('a single question carries its id on the top-level fields too', () => {
    const f = fixture();
    const out = f.api.questionsAsk({ from: 'x', questions: [{ question: 'Proceed?' }] }) as { questions: Item[] };
    expect(card(f)).toMatchObject({ question: 'Proceed?', options: [], id: out.questions[0].id });
    expect(card(f)!.questions).toBeUndefined();
  });

  it('merges into the open card keeping ids (a merge that adds nothing returns the batch), and replace starts over', () => {
    const f = fixture();
    const first = openTwo(f);
    const merged = f.api.questionsAsk({ from: 'x', questions: [{ question: 'Rotate the key?' }] }) as { status: string; at: string; questions: Item[] };
    expect(merged.questions.slice(0, 2)).toEqual(first.questions);
    expect(merged.questions).toHaveLength(3);
    const same = f.api.questionsAsk({ from: 'x', questions: [{ question: 'Deploy tonight?' }] }) as { status: string; at: string; questions: Item[] };
    expect(same).toEqual({ status: 'open', at: merged.at, questions: merged.questions });
    const replaced = f.api.questionsAsk({ from: 'x', questions: [{ question: 'Start over?' }], replace: true }) as { questions: Item[] };
    expect(items(card(f)).map((q) => q.question)).toEqual(['Start over?']);
    expect(merged.questions.map((q) => q.id)).not.toContain(replaced.questions[0].id);
  });

  it('under autopilot nothing opens: the question is recorded for the recap', () => {
    const f = fixture();
    f.manager.setAutopilot('p1', 'x', { count: 3 });
    expect(f.api.questionsAsk({ from: 'x', questions: [{ question: 'Which region?', options: ['EU', 'US'] }] })).toEqual({ status: 'recorded_autopilot' });
    expect(card(f)).toBeUndefined();
    const ap = JSON.parse(readFileSync(join(f.stateDir, 'autopilot.json'), 'utf8'));
    expect(ap.x.questions).toEqual(['Which region? (options: EU | US)']);
  });

  it('refuses another conversation as target (403), and a caller with no identity (403)', () => {
    const f = fixture();
    const foreign = httpError(() => f.api.questionsAsk({ from: 'x', projectId: 'p1', sessionId: 'y', questions: [{ question: 'q?' }] }));
    expect(foreign.status).toBe(403);
    expect(foreign.body).toMatchObject({ error: 'own_conversation_only' });
    expect(typeof foreign.body.message).toBe('string');
    expect(httpError(() => f.api.questionsAsk({ questions: [{ question: 'q?' }] })).status).toBe(403);
  });

  it('validates the limits', () => {
    const f = fixture();
    expect(httpError(() => f.api.questionsAsk({ from: 'x', questions: [] })).status).toBe(400);
    expect(httpError(() => f.api.questionsAsk({ from: 'x', questions: Array.from({ length: 9 }, (_, i) => ({ question: 'q' + i })) })).status).toBe(400);
    expect(httpError(() => f.api.questionsAsk({ from: 'x', questions: [{ question: 'x'.repeat(501) }] })).status).toBe(400);
    expect(httpError(() => f.api.questionsAsk({ from: 'x', questions: [{ question: 'q', options: Array.from({ length: 13 }, (_, i) => 'o' + i) }] })).status).toBe(400);
    expect(httpError(() => f.api.questionsAsk({ from: 'x', questions: [{ question: 'q', options: ['y'.repeat(201)] }] })).status).toBe(400);
  });

  it('the Bot: refused in a turn the owner did not start, with a message for the model', () => {
    const f = fixture();
    const s = f.manager.bot().update({ enabled: true });
    const r = httpError(() => f.api.questionsAsk({ from: s.sessionId!, questions: [{ question: 'Deploy?' }] }));
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'bot_use_message_owner' });
    expect(String(r.body.message)).toContain('message_owner');
    expect(f.manager.listPendingQuestions()).toEqual([]);
  });

  it('the Bot: allowed in a turn the owner started', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = fixture([], { gate: () => held });
    const s = f.manager.bot().update({ enabled: true });
    f.manager.continueSession(s.projectId!, s.sessionId!, 'what should I deploy?');
    await until(() => f.calls.length === 1);
    expect(f.api.questionsAsk({ from: s.sessionId!, questions: [{ question: 'Deploy?' }] })).toMatchObject({ status: 'open' });
    release();
    await until(() => turnsDone(f, s.sessionId!) === 1);
  });

  it('inside a running agent turn: the turn is shown to the owner (forOwner), and the card suppresses the settle', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = fixture([], { gate: () => held });
    f.manager.deliverMcpMessage('p1', 'x', 'check the build', { from: 'y', interactive: false });
    await until(() => f.calls.length === 1);
    f.api.questionsAsk({ from: 'x', questions: [{ question: 'Ship it?' }] });
    release();
    await until(() => turnsDone(f) === 1);
    const done = kinds(f, 'session_done')[0].data;
    expect(done.forOwner).toBe(true);
    expect(done.ownerHidden).toBeUndefined();
    expect(card(f)?.question).toBe('Ship it?');
  });
});

describe('edit_question', () => {
  it('any agent edits any card: same at and id, a quiet remainder event, and a system line', () => {
    const f = fixture();
    const open = openTwo(f);
    const target = open.questions[1];
    const out = f.api.questionsEdit({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, id: target.id, question: 'Deploy on Friday?', options: ['Friday', 'Monday'], reason: 'Tonight is a freeze' }) as { ok: boolean; at: string; questions: Item[] };
    expect(out.ok).toBe(true);
    expect(out.at).toBe(open.at);
    expect(out.questions[1]).toEqual({ id: target.id, question: 'Deploy on Friday?', options: ['Friday', 'Monday'] });
    expect(out.questions[0]).toEqual(open.questions[0]);
    const ev = kinds(f, 'question').at(-1)!.data;
    expect(ev).toMatchObject({ edited: true, remainder: true, reason: 'Tonight is a freeze', at: open.at, by: 'agent', byAgent: { kind: 'agent', sessionId: 'y', projectId: 'p1', title: 'Helper' } });
    expect((ev.notice as { screenSuppressed?: boolean }).screenSuppressed).toBe(true);
    const line = kinds(f, 'question_agent_action').at(-1)!.data;
    expect(line).toMatchObject({ projectId: 'p1', sessionId: 'x', action: 'edited', reason: 'Tonight is a freeze', ids: [target.id], at: open.at, text: 'Question edited by Helper: Tonight is a freeze', by: 'agent', byAgent: { kind: 'agent', sessionId: 'y', title: 'Helper' } });
    expect(line.notice).toMatchObject({ tier: 'quiet' });
  });

  it('409 question_stale for a stale at or an unknown id, with the open batch', () => {
    const f = fixture();
    const open = openTwo(f);
    const staleAt = httpError(() => f.api.questionsEdit({ from: 'y', projectId: 'p1', sessionId: 'x', at: '2020-01-01T00:00:00.000Z', id: open.questions[0].id, question: 'x?', reason: 'r' }));
    expect(staleAt.status).toBe(409);
    expect(staleAt.body).toMatchObject({ error: 'question_stale', open: { at: open.at } });
    expect(typeof staleAt.body.message).toBe('string');
    const unknown = httpError(() => f.api.questionsEdit({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, id: 'deadbeef', question: 'x?', reason: 'r' }));
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ error: 'question_stale' });
    const none = httpError(() => f.api.questionsEdit({ from: 'x', projectId: 'p1', sessionId: 'y', at: open.at, id: open.questions[0].id, question: 'x?', reason: 'r' }));
    expect(none.body).toMatchObject({ error: 'question_stale', open: null });
  });
});

describe('dismiss_question', () => {
  it('a partial dismiss keeps at and the remaining ids; the whole card emits question_dismissed with by and reason', () => {
    const f = fixture();
    const open = openTwo(f);
    const partial = f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, ids: [open.questions[0].id], action: 'dismiss', reason: 'Schema already merged' }) as Record<string, unknown>;
    expect(partial).toMatchObject({ status: 'dismissed', closed: [open.questions[0].id] });
    expect(card(f)!.at).toBe(open.at);
    expect(items(card(f))).toEqual([open.questions[1]]);
    expect(kinds(f, 'question').at(-1)!.data).toMatchObject({ remainder: true, dismissed: ['Use the new schema?'], reason: 'Schema already merged', by: 'agent', byAgent: { title: 'Helper' } });
    expect(kinds(f, 'question_agent_action').at(-1)!.data.text).toBe('Question dismissed by Helper: Schema already merged');
    f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, action: 'dismiss', reason: 'Moot now' });
    expect(card(f)).toBeUndefined();
    expect(kinds(f, 'question_dismissed').at(-1)!.data).toMatchObject({ projectId: 'p1', sessionId: 'x', at: open.at, reason: 'Moot now', by: 'agent', byAgent: { kind: 'agent', sessionId: 'y' } });
    expect(kinds(f, 'question_answered')).toHaveLength(0);
  });

  it('needs a reason', () => {
    const f = fixture();
    const open = openTwo(f);
    expect(httpError(() => f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, action: 'dismiss' })).status).toBe(400);
  });
});

describe('answer_question', () => {
  it('on the caller\'s own card: closed with the answer recorded', () => {
    const f = fixture();
    const open = openTwo(f);
    const out = f.api.questionsClose({ from: 'x', at: open.at, action: 'answer', answer: 'The owner said yes in chat' }) as Record<string, unknown>;
    expect(out).toMatchObject({ status: 'answered', cardClosed: true, at: open.at });
    expect(card(f)).toBeUndefined();
    expect(kinds(f, 'question_answered').at(-1)!.data).toMatchObject({ at: open.at, answer: 'The owner said yes in chat', ids: open.questions.map((q) => q.id), by: 'agent', byAgent: { kind: 'agent', sessionId: 'x', title: 'Asker' } });
    expect(kinds(f, 'question_agent_action').at(-1)!.data.text).toBe('Question answered by Asker: The owner said yes in chat');
    expect(f.calls).toHaveLength(0); // no message, no turn: the agent goes on in its own turn
  });

  it('cross-conversation, automatic mode: delivered as the panel\'s text and the card closes at delivery', async () => {
    const f = fixture();
    f.manager.setMcpSendMode('auto');
    const open = openTwo(f);
    const out = f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, ids: [open.questions[1].id], action: 'answer', answer: 'Tomorrow' }) as Record<string, unknown>;
    expect(out).toMatchObject({ status: 'sent', cardClosed: true, queued: false });
    expect(typeof out.messageId).toBe('string');
    expect(typeof out.hopsUntilCheck).toBe('number');
    expect(items(card(f))).toEqual([open.questions[0]]);
    expect(card(f)!.at).toBe(open.at);
    await until(() => turnsDone(f) === 1);
    const prompt = f.calls[0].prompt;
    expect(prompt).toContain('2. Deploy tonight?\nAnswer: Tomorrow');
    // closed BEFORE the turn: it is told only about what is still open
    expect(prompt).toContain('still unanswered: "Use the new schema?"');
    expect(prompt).not.toContain('"Deploy tonight?" (id');
    expect(kinds(f, 'question_agent_action').at(-1)!.data).toMatchObject({ action: 'answered', answer: 'Tomorrow', ids: [open.questions[1].id] });
  });

  it('cross-conversation, approval mode: nothing closes until approve; send-status carries cardClosed', async () => {
    const f = fixture();
    const open = openTwo(f);
    const out = f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, action: 'answer', answer: 'Yes to both' }) as Record<string, unknown>;
    expect(out).toMatchObject({ mode: 'approval', status: 'pending_approval' });
    expect(card(f)).toBeDefined();
    expect(kinds(f, 'question_agent_action')).toHaveLength(0);
    await f.api.mcpApprovalDecide({ id: String(out.approvalId), approve: true });
    expect(card(f)).toBeUndefined();
    expect(f.api.conversationSendStatus(String(out.approvalId))).toMatchObject({ status: 'approved', cardClosed: true });
    await until(() => turnsDone(f) === 1);
    expect(f.calls[0].prompt).toContain('1. Use the new schema?\nAnswer: Yes to both\n\n2. Deploy tonight?\nAnswer: Yes to both');
  });

  it('approval mode: a card that closed meanwhile is delivered as a plain message with cardClosed false', async () => {
    const f = fixture();
    const open = openTwo(f);
    const out = f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, action: 'answer', answer: 'Yes' }) as Record<string, unknown>;
    f.manager.dismissPendingQuestion('p1', 'x', open.at);
    await f.api.mcpApprovalDecide({ id: String(out.approvalId), approve: true });
    expect(f.api.conversationSendStatus(String(out.approvalId))).toMatchObject({ status: 'approved', cardClosed: false, note: 'card already closed' });
    await until(() => turnsDone(f) === 1);
    expect(kinds(f, 'question_agent_action')).toHaveLength(0);
  });

  it('a relay checkpoint passes through as today\'s 409', () => {
    const f = fixture();
    f.manager.setMcpSendMode('auto');
    const open = openTwo(f);
    // y is six hops deep in an AI chain: its next send is hop 7, a checkpoint.
    (f.manager as unknown as { relayChains: Map<string, unknown> }).relayChains.set('y', { id: 'c', depth: 6, from: 'z' });
    const r = httpError(() => f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, action: 'answer', answer: 'Yes' }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'relay_confirm_required' });
    expect(card(f)).toBeDefined(); // nothing sent, nothing closed
  });

  it('an agent-origin turn carrying answersQuestionAt still never closes the card', async () => {
    const f = fixture();
    const open = openTwo(f);
    f.manager.continueSession('p1', 'x', 'Whatever you think', { sender: { kind: 'conversation', sessionId: 'y', projectId: 'p1' }, answersQuestionAt: open.at });
    await until(() => turnsDone(f) === 1);
    expect(card(f)?.at).toBe(open.at);
    expect(kinds(f, 'question_answered')).toHaveLength(0);
  });
});

describe('the owner sees it, and the store keeps ids', () => {
  it('question_agent_action is journalled as a notice row and comes back on reload', () => {
    const f = fixture();
    const open = openTwo(f);
    f.api.questionsClose({ from: 'y', projectId: 'p1', sessionId: 'x', at: open.at, action: 'dismiss', reason: 'Moot' });
    const action = kinds(f, 'question_agent_action')[0].data;
    const rows = new ConversationJournal(f.stateDir).merge('p1', 'x', [], true);
    expect(rows).toContainEqual(expect.objectContaining({ role: 'notice', messageId: 'question-action:' + String(action.actionId), text: 'Question dismissed by Helper: Moot' }));
  });

  it('a long answer is cut to 160 characters in the line', () => {
    const f = fixture();
    const open = openTwo(f);
    f.api.questionsClose({ from: 'x', at: open.at, action: 'answer', answer: 'word '.repeat(80) });
    expect(String(kinds(f, 'question_agent_action')[0].data.text).length).toBeLessThanOrEqual('Question answered by Asker: '.length + 160);
  });

  it('legacy items get ids at load, and the file is re-saved', () => {
    const at = new Date().toISOString();
    const f = fixture([], { questions: { x: { projectId: 'p1', sessionId: 'x', question: 'A?', options: [], questions: [{ question: 'A?', options: [] }, { question: 'B?', options: ['1'] }], at } } });
    const b = card(f)!;
    expect(items(b).map((q) => q.id)).toEqual([expect.stringMatching(/^[0-9a-f]{8}$/), expect.stringMatching(/^[0-9a-f]{8}$/)]);
    const disk = JSON.parse(readFileSync(join(f.stateDir, 'questions.json'), 'utf8'));
    expect(disk.x.questions.map((q: Item) => q.id)).toEqual(items(b).map((q) => q.id));
    expect(b.at).toBe(at);
  });

  it('the <<<ASK>>> fallback still opens a card and is counted; a trailing question mark no longer does', async () => {
    const f = fixture([{ status: 'completed', resultText: 'Done.\n<<<ASK\nquestion: Ship?\noptions: Yes | No\n>>>' }, { status: 'completed', resultText: 'Done. Should I also deploy it?' }]);
    f.manager.continueSession('p1', 'x', 'go');
    await until(() => turnsDone(f) === 1);
    expect(card(f)?.question).toBe('Ship?');
    expect(card(f)?.id).toMatch(/^[0-9a-f]{8}$/);
    const log = join(f.stateDir, 'events.jsonl');
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/"type":"question_fallback","sessionId":"x","kind":"ask"/);
    f.manager.dismissPendingQuestion('p1', 'x', card(f)!.at);
    f.manager.continueSession('p1', 'x', 'next');
    await until(() => turnsDone(f) === 2);
    expect(card(f)).toBeUndefined();
  });
});
