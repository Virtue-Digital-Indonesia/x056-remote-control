// The question-card MCP tools (docs/question-tools-contract.md, "MCP tools"),
// against a mocked gateway `api`: what each tool sends, and what it makes of
// each answer the contract allows. Every structured result is checked against
// the tool's advertised output schema.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateResult } from './helpers/mcp-contract.js';

type Call = { path: string; body?: any };
type Reply = (call: Call) => unknown;

function mockApi(reply: Reply) {
  const calls: Call[] = [];
  const api = async (path: string, opts?: RequestInit) => {
    const call = { path, ...(opts?.body ? { body: JSON.parse(String(opts.body)) } : {}) };
    calls.push(call);
    return reply(call);
  };
  return { api, calls };
}
const httpError = (status: number, body: Record<string, unknown>) =>
  Object.assign(new Error(String(body.message ?? `gateway returned ${status}`)), { status, body });

async function bridge(env: Record<string, string> = { X056_SELF_PROJECT_ID: 'p', X056_SELF_SESSION_ID: 's' }) {
  for (const k of ['X056_SELF_PROJECT_ID', 'X056_SELF_SESSION_ID', 'X056_RELAY_FROM', 'X056_BOT']) vi.stubEnv(k, env[k] ?? '');
  vi.resetModules();
  return import('../scripts/x056-mcp-tools.mjs');
}
async function run(tools: Awaited<ReturnType<typeof bridge>>, api: any, name: string, args: Record<string, unknown>) {
  const r = await tools.callToolResult(api, name, args);
  return { text: r.content[0].text, data: validateResult(name, r) };
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

const CARD = { projectId: 'p', sessionId: 's', at: '2026-10-30T01:00:00.000Z', question: 'Which DB?', options: ['pg', 'sqlite'],
  questions: [{ id: 'a1b2c3d4', question: 'Which DB?', options: ['pg', 'sqlite'] }, { id: 'e5f6a7b8', question: 'Deploy now?', options: [] }] };

describe('ask_user', () => {
  it('opens a card on the own conversation and says to end the turn', async () => {
    const tools = await bridge();
    const { api, calls } = mockApi(() => ({ status: 'open', at: CARD.at, questions: CARD.questions }));
    const { text, data } = await run(tools, api, 'ask_user', { questions: [{ question: 'Which DB?', options: ['pg', 'sqlite'] }, { question: 'Deploy now?' }], replace: true });
    expect(calls).toEqual([{ path: '/api/questions/ask', body: { from: 's', projectId: 'p', sessionId: 's', replace: true,
      questions: [{ question: 'Which DB?', options: ['pg', 'sqlite'] }, { question: 'Deploy now?', options: [] }] } }]);
    expect(text).toBe(`Card open (at=${CARD.at}, ids a1b2c3d4, e5f6a7b8). End your turn now: the user's answer arrives as your next message.`);
    expect(data).toMatchObject({ status: 'open', at: CARD.at, questions: CARD.questions });
  });

  it('says the question was recorded for the autopilot recap', async () => {
    const tools = await bridge();
    const { api } = mockApi(() => ({ status: 'recorded_autopilot' }));
    const { text, data } = await run(tools, api, 'ask_user', { questions: [{ question: 'x?' }] });
    expect(text).toMatch(/recorded for the autopilot recap/);
    expect(data.status).toBe('recorded_autopilot');
  });

  it('refuses without a conversation identity, delegates included', async () => {
    const { api, calls } = mockApi(() => ({}));
    for (const env of [{}, { X056_RELAY_FROM: 'orch' }] as Record<string, string>[]) {
      const tools = await bridge(env);
      await expect(tools.callToolResult(api, 'ask_user', { questions: [{ question: 'x?' }] }))
        .rejects.toThrow('ask_user needs a conversation identity; delegates report NEEDS HUMAN instead');
    }
    expect(calls).toEqual([]);
  });

  it('description tells the model to end its turn and not guess', async () => {
    const tools = await bridge();
    const d = tools.TOOLS.find((t) => t.name === 'ask_user')!.description;
    expect(d).toMatch(/only the user can make/);
    expect(d).toMatch(/END YOUR TURN/);
    expect(d).toMatch(/next message/);
    expect(d).toMatch(/guess/);
    expect(tools.TOOLS.find((t) => t.name === 'dismiss_question')!.description).toMatch(/replaces writing <<<RESOLVED>>>/);
  });
});

describe('list_questions', () => {
  it('defaults to the own conversation, filters even if the gateway does not', async () => {
    const tools = await bridge();
    const other = { ...CARD, sessionId: 'z', at: '2026-10-30T02:00:00.000Z' };
    const { api, calls } = mockApi(() => [CARD, other]);
    const { text, data } = await run(tools, api, 'list_questions', {});
    expect(calls[0].path).toBe('/api/questions?projectId=p&sessionId=s');
    expect(data.cards).toEqual([{ projectId: 'p', sessionId: 's', at: CARD.at, questions: CARD.questions }]);
    expect(text).toContain('[id a1b2c3d4] Which DB?');
    expect(text).toContain('options: pg | sqlite');
  });

  it('all: true lists every card; a legacy row without questions[] or ids still reads', async () => {
    const tools = await bridge();
    const legacy = { projectId: 'q', sessionId: 't', at: 'x', question: 'Old?', options: ['y'], stale: true };
    const { api, calls } = mockApi(() => [CARD, legacy]);
    const { data } = await run(tools, api, 'list_questions', { all: true });
    expect(calls[0].path).toBe('/api/questions');
    expect(data.cards[1]).toEqual({ projectId: 'q', sessionId: 't', at: 'x', questions: [{ question: 'Old?', options: ['y'] }], stale: true });
  });

  it('without an identity needs a target or all', async () => {
    const tools = await bridge({});
    const { api } = mockApi(() => []);
    await expect(tools.callToolResult(api, 'list_questions', {})).rejects.toThrow(/or all: true/);
    await expect(tools.callToolResult(api, 'list_questions', { session_id: 's' })).rejects.toThrow(/together/);
    expect((await run(tools, api, 'list_questions', { project_id: 'p', session_id: 's' })).data.cards).toEqual([]);
  });
});

describe('edit_question / dismiss_question', () => {
  it('edit sends from + target + reason, keeps at and id', async () => {
    const tools = await bridge();
    const { api, calls } = mockApi(() => ({ at: CARD.at, questions: [{ ...CARD.questions[0], question: 'Which database?' }, CARD.questions[1]] }));
    const { text, data } = await run(tools, api, 'edit_question', { at: CARD.at, id: 'a1b2c3d4', question: 'Which database?', reason: 'clearer', project_id: 'q', session_id: 't' });
    expect(calls[0]).toEqual({ path: '/api/questions/edit', body: { from: 's', projectId: 'q', sessionId: 't', at: CARD.at, id: 'a1b2c3d4', question: 'Which database?', reason: 'clearer' } });
    expect(text).toMatch(/^Edited question a1b2c3d4/);
    expect(data).toMatchObject({ status: 'edited', id: 'a1b2c3d4', card: { projectId: 'q', sessionId: 't' } });
  });

  it('edit needs something to change', async () => {
    const tools = await bridge();
    const { api, calls } = mockApi(() => ({}));
    await expect(tools.callToolResult(api, 'edit_question', { at: 'a', id: 'b', reason: 'r' })).rejects.toThrow(/question or options/);
    expect(calls).toEqual([]);
  });

  it('dismiss posts action dismiss with ids or the whole card', async () => {
    const tools = await bridge();
    const { api, calls } = mockApi(() => ({ ok: true }));
    const whole = await run(tools, api, 'dismiss_question', { at: CARD.at, reason: 'settled in chat' });
    expect(calls[0]).toEqual({ path: '/api/questions/close', body: { from: 's', projectId: 'p', sessionId: 's', at: CARD.at, action: 'dismiss', reason: 'settled in chat' } });
    expect(whole.text).toMatch(/the whole card/);
    const part = await run(tools, api, 'dismiss_question', { at: CARD.at, ids: ['e5f6a7b8'], reason: 'moot' });
    expect(calls[1].body.ids).toEqual(['e5f6a7b8']);
    expect(part.data).toMatchObject({ status: 'dismissed', ids: ['e5f6a7b8'] });
  });

  it('a 409 question_stale returns the current card and asks to re-list', async () => {
    const tools = await bridge();
    const { api } = mockApi(() => { throw httpError(409, { error: 'question_stale', open: CARD, message: 'stale' }); });
    for (const [name, args] of [['edit_question', { at: 'old', id: 'x', options: [], reason: 'r' }], ['dismiss_question', { at: 'old', reason: 'r' }], ['answer_question', { at: 'old', answer: 'pg' }]] as const) {
      const { text, data } = await run(tools, api, name, args);
      expect(text, name).toMatch(/nothing was done/);
      expect(text).toContain('[id e5f6a7b8] Deploy now?');
      expect(text).toMatch(/list_questions/);
      expect(data).toMatchObject({ status: 'stale', open: { at: CARD.at } });
    }
    const gone = mockApi(() => { throw httpError(409, { error: 'question_stale', open: null }); });
    const { text, data } = await run(tools, gone.api, 'dismiss_question', { at: 'old', reason: 'r' });
    expect(text).toMatch(/no longer open/);
    expect(data).toEqual({ status: 'stale', open: null });
  });

  it('a delegate acts with its orchestrator as from; no identity at all refuses', async () => {
    const delegate = await bridge({ X056_RELAY_FROM: 'orch' });
    const { api, calls } = mockApi(() => ({}));
    await run(delegate, api, 'dismiss_question', { at: 'a', reason: 'r', project_id: 'p', session_id: 'o' });
    expect(calls[0].body.from).toBe('orch');
    await expect(delegate.callToolResult(api, 'dismiss_question', { at: 'a', reason: 'r' })).rejects.toThrow(/give project_id and session_id/);
    const none = await bridge({});
    await expect(none.callToolResult(api, 'edit_question', { at: 'a', id: 'b', question: 'q', reason: 'r', project_id: 'p', session_id: 's' })).rejects.toThrow(/needs a conversation identity/);
  });

  it('other errors pass through', async () => {
    const tools = await bridge();
    const { api } = mockApi(() => { throw httpError(403, { error: 'forbidden', message: 'nope' }); });
    await expect(tools.callToolResult(api, 'dismiss_question', { at: 'a', reason: 'r' })).rejects.toThrow('nope');
  });
});

describe('answer_question', () => {
  it('own card: closes with the answer, carry on', async () => {
    const tools = await bridge();
    const { api, calls } = mockApi(() => ({ status: 'answered' }));
    const { text, data } = await run(tools, api, 'answer_question', { at: CARD.at, ids: ['a1b2c3d4'], answer: 'pg' });
    expect(calls[0]).toEqual({ path: '/api/questions/close', body: { from: 's', projectId: 'p', sessionId: 's', at: CARD.at, ids: ['a1b2c3d4'], action: 'answer', answer: 'pg' } });
    expect(text).toMatch(/your own card .* it is closed\. Carry on/);
    expect(data).toMatchObject({ status: 'answered', cardClosed: true });
  });

  it('another conversation, automatic mode: delivered, card closed (or the receipt note when it was not)', async () => {
    const tools = await bridge();
    const sent = mockApi(() => ({ mode: 'auto', sessionId: 't', messageId: 'm1', hopsUntilCheck: 5, cardClosed: true }));
    const a = await run(tools, sent.api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't' });
    expect(a.data).toMatchObject({ status: 'sent', cardClosed: true, messageId: 'm1', hopsUntilCheck: 5 });
    expect(a.text).toMatch(/^Answer delivered/);
    expect(a.text).toMatch(/The card is closed\./);
    expect(a.text).toMatch(/5 hop\(s\) until the next relay checkpoint/);
    const late = mockApi(() => ({ delivered: 'queued', cardClosed: false, note: 'card already closed' }));
    const b = await run(tools, late.api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't' });
    expect(b.data).toMatchObject({ status: 'queued', cardClosed: false, note: 'card already closed' });
    expect(b.text).toMatch(/NOT closed[\s\S]*card already closed/);
  });

  it('another conversation, approval mode: polls send-status like send_message', async () => {
    const tools = await bridge();
    let polls = 0;
    const { api, calls } = mockApi(({ path }) => {
      if (path === '/api/questions/close') return { mode: 'approval', approvalId: 'ap1', messageId: 'm2' };
      polls++;
      return polls < 2 ? { status: 'pending' } : { status: 'approved', resultSessionId: 't', cardClosed: true };
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const pending = run(tools, api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't' });
    await vi.advanceTimersByTimeAsync(2500);
    const { data, text } = await pending;
    expect(calls.filter((c) => c.path === '/api/conversations/send-status?id=ap1')).toHaveLength(2);
    expect(data).toMatchObject({ status: 'sent', cardClosed: true, approvalId: 'ap1', sessionId: 't' });
    expect(text).toMatch(/card is closed/);
  });

  it('an approval whose card closed meanwhile reports the note, not a closed card', async () => {
    const tools = await bridge();
    const { api } = mockApi(({ path }) => path === '/api/questions/close' ? { status: 'pending', approvalId: 'ap3' } : { status: 'approved', note: 'card already closed' });
    const { data, text } = await run(tools, api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't' });
    expect(data).toMatchObject({ status: 'sent', cardClosed: false, note: 'card already closed' });
    expect(text).not.toMatch(/The card is closed/);
    expect(text).toMatch(/NOT closed[\s\S]*card already closed/);
  });

  it('a denied approval leaves the card open', async () => {
    const tools = await bridge();
    const { api } = mockApi(({ path }) => path === '/api/questions/close' ? { delivered: 'pending_approval', approvalId: 'ap2' } : { status: 'denied' });
    const { data, text } = await run(tools, api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't' });
    expect(data).toMatchObject({ status: 'denied', cardClosed: false });
    expect(text).toMatch(/DENIED/);
  });

  it('passes the relay checkpoint through and sends confirmRelay on retry', async () => {
    const tools = await bridge();
    const { api, calls } = mockApi(({ body }) => {
      if (!body.confirmRelay) throw httpError(409, { error: 'relay_confirm_required', hops: 7, checkpointEvery: 6, message: 'Hop 7: is this converging? ... call again with confirm_relay: true' });
      return { mode: 'auto', sessionId: 't', confirmedCheckpoint: true, hopsUntilCheck: 6 };
    });
    const held = await run(tools, api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't' });
    expect(held.text.startsWith(tools.RELAY_CHECKPOINT_PREFIX)).toBe(true);
    expect(held.data).toMatchObject({ status: 'relay_checkpoint', hops: 7, checkpointEvery: 6, cardClosed: false });
    const ok = await run(tools, api, 'answer_question', { at: CARD.at, answer: 'pg', project_id: 'q', session_id: 't', confirm_relay: true });
    expect(calls[1].body.confirmRelay).toBe(true);
    expect(ok.data).toMatchObject({ status: 'sent', confirmedCheckpoint: true });
    expect(ok.text).toMatch(/Relay checkpoint confirmed/);
  });
});

describe('advertised metadata', () => {
  it('annotations and schema validation', async () => {
    const tools = await bridge();
    const t = (n: string) => tools.TOOLS.find((x) => x.name === n)!;
    expect(t('list_questions').annotations.readOnlyHint).toBe(true);
    expect(t('dismiss_question').annotations.destructiveHint).toBe(true);
    expect(t('ask_user').annotations.readOnlyHint).toBe(false);
    const { api } = mockApi(() => ({}));
    await expect(tools.callToolResult(api, 'ask_user', { questions: [] })).rejects.toThrow(/Invalid tool arguments/);
    await expect(tools.callToolResult(api, 'dismiss_question', { at: 'a' })).rejects.toThrow(/Invalid tool arguments/);
  });
});
