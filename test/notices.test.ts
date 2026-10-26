import { describe, expect, it } from 'vitest';
import { noticeFor, originOf, cutWords, replyExcerpt, noticeTitle, failureReason, formatDuration, LONG_TURN_MS, type NoticeContext, type TurnOrigin } from '../server/notices.js';

const work: NoticeContext = { conversationTitle: 'Fix deed numbers', projectName: 'ocr', projectKind: 'project', provider: 'codex', link: '/work/p/s', at: '2026-10-01T03:00:00Z' };
const chat: NoticeContext = { conversationTitle: 'Quarterly revenue review', projectName: 'Quarterly revenue review', projectKind: 'chat', provider: 'claude', link: '/chat/c' };
const turn = (o: Record<string, unknown> = {}) => ({ projectId: 'p', sessionId: 's', status: 'completed', completionPending: false, origin: 'human', durationMs: 252_000, resultText: 'Deed numbers keep their leading zeros now; the limit check is in Review.', requestId: 'r1', ...o });

it('retains routine Bot notices as events while suppressing screens, and never suppresses needs-you notices', () => {
  const bot = { ...chat, bot: true };
  for (const origin of ['relay', 'brief']) {
    const notice = noticeFor('conversation_settled', turn({ origin }), bot)!;
    expect(notice.screenSuppressed).toBe(true);
    expect(notice.body).toBeTruthy();
  }
  expect(noticeFor('bot_notice', { title: 'Routine Bot status', body: 'Still watching' }, bot)?.screenSuppressed).toBe(true);
  for (const [kind, data] of [
    ['bot_notice', { tier: 'urgent', body: 'Please decide' }],
    ['question', { question: 'Ship?' }],
    ['mcp_approval', { status: 'pending' }],
    ['session_error', { reason: 'Failed', origin: 'relay' }],
  ] as const) expect(noticeFor(kind, data, bot)?.screenSuppressed).toBeUndefined();
  expect(noticeFor('conversation_settled', turn(), work)?.screenSuppressed).toBeUndefined();
});

describe('Bot project: only automated notices leave the screen', () => {
  const bot: NoticeContext = { ...chat, bot: true };
  it('a long turn the owner started in the Bot chat keeps its ordinary notice', () => {
    const n = noticeFor('conversation_settled', turn({ origin: 'human', durationMs: 120_000 }), bot)!;
    expect(n.tier).toBe('normal');
    expect(n.category).toBe('finished');
    expect(n.screenSuppressed).toBeUndefined();
    const short = noticeFor('conversation_settled', turn({ origin: 'human', durationMs: 5_000 }), bot)!;
    expect(short.tier).toBe('quiet');
    expect(short.screenSuppressed).toBeUndefined();
  });
  it.each([
    ['bot_brief', 'brief'], ['bot_event', 'relay'], ['recap', 'recap'], ['advisor', 'advisor'],
    ['automation', 'cron'], ['autopilot', 'autopilot'], ['delegate', 'delegate'],
  ] as const)('a %s turn in the Bot chat is suppressed', (kind, origin) => {
    expect(originOf({ kind })).toBe(origin);
    const n = noticeFor('conversation_settled', turn({ origin }), bot)!;
    if (n.tier !== 'none') expect(n.screenSuppressed).toBe(true);
  });
  it('a Bot turn event with no origin counts as automated', () => {
    expect(noticeFor('conversation_settled', turn({ origin: undefined }), bot)?.screenSuppressed).toBe(true);
  });
  it('non-turn automated status in the Bot project is suppressed', () => {
    expect(noticeFor('supervisor', { projectId: 'p', sessionId: 's', type: 'failover', from: 'a' }, bot)?.screenSuppressed).toBe(true);
    expect(noticeFor('delegate_report', { projectId: 'p', sessionId: 's', role: 'scout', text: 'DONE', gate: 'done' }, bot)?.screenSuppressed).toBe(true);
  });
  it('urgent failures and needs-you items are never suppressed', () => {
    for (const origin of ['human', 'relay', 'brief', 'recap']) {
      const n = noticeFor('session_error', { projectId: 'p', sessionId: 's', reason: 'boom', origin }, bot)!;
      expect(n.tier).toBe('urgent');
      expect(n.screenSuppressed).toBeUndefined();
    }
    expect(noticeFor('conversation_settled', turn({ status: 'parked', reason: undefined, origin: 'relay' }), bot)?.screenSuppressed).toBeUndefined();
    expect(noticeFor('delegate_report', { role: 'scout', text: 'NEEDS HUMAN', gate: 'needs_human' }, bot)?.screenSuppressed).toBeUndefined();
  });
  it('bot_notice: suppressed unless urgent', () => {
    expect(noticeFor('bot_notice', { title: 'Status', body: 'Routine' }, bot)?.screenSuppressed).toBe(true);
    const urgent = noticeFor('bot_notice', { title: 'Decide', body: 'Now', tier: 'urgent' }, bot)!;
    expect(urgent.tier).toBe('urgent');
    expect(urgent.screenSuppressed).toBeUndefined();
  });
  it('outside the Bot project nothing changes', () => {
    expect(noticeFor('supervisor', { projectId: 'p', sessionId: 's', type: 'failover' }, work)?.screenSuppressed).toBeUndefined();
    expect(noticeFor('conversation_settled', turn({ origin: 'relay' }), work)?.screenSuppressed).toBeUndefined();
  });
});

describe('noticeFor: tiers by event × origin × duration', () => {
  const settledTier = (origin: TurnOrigin, durationMs: number) => noticeFor('conversation_settled', turn({ origin, durationMs }), work)?.tier;
  it.each([
    ['human', LONG_TURN_MS, 'normal'],
    ['human', LONG_TURN_MS - 1, 'quiet'],
    ['relay', 600_000, 'quiet'],
    ['cron', 600_000, 'quiet'],
    ['delegate', 600_000, 'quiet'],
    ['advisor', 600_000, 'quiet'],
    ['autopilot', 600_000, 'none'],
    // A recap is the real end of background work or an autopilot run.
    ['recap', 600_000, 'normal'],
    ['recap', 5_000, 'normal'],
  ] as [TurnOrigin, number, string][])('finished, %s, %i ms → %s', (origin, ms, tier) => {
    expect(settledTier(origin, ms)).toBe(tier);
  });
  it.each([
    ['human', 'urgent'], ['relay', 'urgent'], ['cron', 'urgent'], ['delegate', 'urgent'],
    ['advisor', 'normal'], ['autopilot', 'normal'], ['recap', 'urgent'],
  ] as [TurnOrigin, string][])('failed, %s → %s', (origin, tier) => {
    expect(noticeFor('session_done', turn({ status: 'failed', reason: 'boom', origin }), work)?.tier).toBe(tier);
    expect(noticeFor('session_error', turn({ message: 'boom', origin }), work)?.tier).toBe(tier);
  });
  it('none / null where nothing should happen', () => {
    expect(noticeFor('session_done', turn({ completionPending: true }), work)).toBeNull();
    expect(noticeFor('session_done', turn(), work)).toBeNull(); // completed: the settled event speaks
    expect(noticeFor('session_done', turn({ status: 'stopped' }), work)?.tier).toBe('none');
    expect(noticeFor('session_done', turn({ status: 'failed', reason: 'Stopped by user.' }), work)?.tier).toBe('none');
    expect(noticeFor('conversation_settled', turn({ notificationSuppressed: true }), work)?.tier).toBe('none');
    expect(noticeFor('turn_orphaned', { projectId: 'p', sessionId: 's' }, work)?.tier).toBe('none');
    expect(noticeFor('autopilot', { active: true, remaining: 3 }, work)).toBeNull();
    expect(noticeFor('autopilot', { active: false, reason: 'stopped' }, work)?.tier).toBe('none');
    expect(noticeFor('mcp_approval', { id: 'a', status: 'denied' }, work)).toBeNull();
    expect(noticeFor('restart_interrupted', { count: 0 }, work)).toBeNull();
    expect(noticeFor('advisor_consult', {}, work)).toBeNull();
    expect(noticeFor('activity', {}, work)).toBeNull();
  });
  it('urgent / normal / quiet for the rest', () => {
    expect(noticeFor('question', { projectId: 'p', sessionId: 's', question: 'Go?' }, work)?.tier).toBe('urgent');
    expect(noticeFor('delegate_report', { gate: 'needs_human', role: 'tester', text: 'Need creds' }, work)?.tier).toBe('urgent');
    expect(noticeFor('delegate_report', { gate: 'done', role: 'tester', text: 'All green' }, work)?.tier).toBe('quiet');
    expect(noticeFor('delegate_report', { gate: 'needs_orchestrator', role: 'tester', text: 'Pick one' }, work)?.tier).toBe('quiet');
    expect(noticeFor('supervisor', { type: 'failover', from: 'a' }, work)?.tier).toBe('quiet');
    expect(noticeFor('supervisor', { type: 'limit_detected' }, work)).toBeNull(); // failover may still succeed
    expect(noticeFor('supervisor', { type: 'waiting_for_reset', account: 'a', until: 1 }, work)?.tier).toBe('urgent');
    expect(noticeFor('session_done', turn({ status: 'parked', parkedUntil: 1 }), work)?.tier).toBe('urgent');
    expect(noticeFor('session_done', turn({ status: 'parked', reason: 'Automatic switching is disabled for this provider.' }), work)?.tier).toBe('normal');
    expect(noticeFor('autopilot', { active: false, reason: 'exhausted' }, work)?.tier).toBe('normal');
    // A recap follows: its ending is the one push, the end notice goes quiet.
    expect(noticeFor('autopilot', { active: false, reason: 'exhausted', recap: true }, work)?.tier).toBe('quiet');
    expect(noticeFor('autopilot', { active: false, reason: 'done', recap: true }, work)?.tier).toBe('quiet');
    expect(noticeFor('cron_failed', { jobId: 'j', name: 'Nightly', reason: 'x' }, work)?.tier).toBe('urgent');
    expect(noticeFor('restart_interrupted', { count: 2, bootAt: 'b' }, work)?.tier).toBe('normal');
  });
});

describe('noticeFor: exact words', () => {
  it('a long finished turn: duration + the reply, project · provider first', () => {
    const n = noticeFor('conversation_settled', turn(), work)!;
    expect(n).toMatchObject({
      title: 'Fix deed numbers',
      body: 'ocr · ChatGPT\n4m 12s · Deed numbers keep their leading zeros now; the limit check is in Review.',
      tag: 'x056-conv-s', link: '/work/p/s', id: 'turn:s:r1', category: 'finished',
    });
  });
  it('a chat names no project in the body', () => {
    expect(noticeFor('conversation_settled', turn({ durationMs: 50_000, resultText: 'Revenue grew 12%.' }), chat)!.body).toBe('50s · Revenue grew 12%.');
  });
  it('never "New chat" alone', () => {
    expect(noticeTitle({ conversationTitle: 'New chat', projectName: 'x056-remote-control' })).toBe('New chat · x056-remote-control');
    expect(noticeTitle({ conversationTitle: '', projectName: 'ocr' })).toBe('New chat · ocr');
    expect(noticeTitle({ conversationTitle: 'New chat', projectName: 'New chat', projectKind: 'chat' })).toBe('New chat');
  });
  it('titles are cut at a word boundary', () => {
    const t = noticeTitle({ conversationTitle: 'Investigate why the stego sidecar leaves thirteen issuances unmarked after rebuild' });
    expect(t).toBe('Investigate why the stego sidecar leaves thirteen issuances…');
    expect(t.length).toBeLessThanOrEqual(60);
  });
  it('a question, cut at 140 on a word', () => {
    const q = 'Should I rebuild the production stego sidecar now and restart it, or first list which of the thirteen issuances went out unmarked so you can decide?';
    const n = noticeFor('question', { projectId: 'p', sessionId: 's', question: q, at: 'qa' }, work)!;
    expect(n.body.startsWith('ocr · ChatGPT\nShould I rebuild')).toBe(true);
    expect(n.body.split('\n')[1].length).toBeLessThanOrEqual(140);
    expect(n.body.endsWith('…')).toBe(true);
    expect(n.tag).toBe('x056-urgent-question:s:qa');
  });
  it('the reply excerpt drops markdown, protocol blocks and code', () => {
    const raw = '## Summary\n\n**Done.** I fixed the `parseDeed` helper — see [the PR](https://x/y).\n\n```ts\nconst a = 1;\n```\n\n- leading zeros kept\n<<<ASK {"question":"x"}>>>';
    expect(replyExcerpt(raw)).toBe('Done. I fixed the parseDeed helper — see the PR. leading zeros kept');
  });
  it('a reply ending in a question leads with it', () => {
    expect(replyExcerpt('I rebuilt the sidecar and verified 13 issuances. Should I also flip fail_closed?')).toBe('Should I also flip fail_closed? I rebuilt the sidecar and verified 13 issuances.');
  });
  it('a long reply is cut on a word boundary at ~110', () => {
    const e = replyExcerpt('word '.repeat(60));
    expect(e.length).toBeLessThanOrEqual(110);
    expect(e.endsWith('word…')).toBe(true);
  });
  it('failure reasons in plain words', () => {
    expect(failureReason({ reason: 'Claude AI usage limit reached|1759300000', finalAccount: 'b' })).toBe('Account limit reached on account b');
    expect(failureReason({ message: 'OAuth session expired and could not be refreshed', account: 'g' })).toBe('Sign-in expired for account g');
    expect(failureReason({ message: 'Error: ECONNRESET socket hang up\n    at foo (x.js:1)' })).toBe('Turn failed: ECONNRESET socket hang up');
    expect(failureReason({ failovers: 6 })).toBe('Switched accounts too often in an hour, so it stopped');
    const parked = noticeFor('session_done', turn({ status: 'parked', parkedUntil: Date.parse('2026-10-01T07:00:00Z') / 1000 }), { ...work, timeZone: 'Asia/Jakarta' })!;
    expect(parked.body).toMatch(/Account limit reached on every account — resets (\w{3} )?14:00$/);
  });
  it('approval, delegate, autopilot, cron, restart', () => {
    const a = noticeFor('mcp_approval', { id: 'a1', status: 'pending', targetLabel: 'Release notes', message: 'Please add the entry', sender: { kind: 'conversation', conversationTitle: 'Fix deed numbers' } }, { ...work, provider: 'claude' })!;
    expect(a).toMatchObject({ tier: 'urgent', title: 'Fix deed numbers', body: 'Claude in Fix deed numbers wants to message Release notes: “Please add the entry”', tag: 'x056-urgent-approval:a1' });
    expect(noticeFor('delegate_report', { gate: 'needs_human', role: 'tester', text: '\nNEEDS HUMAN: staging creds expired\nmore' }, chat)!.body).toBe('tester: NEEDS HUMAN: staging creds expired');
    expect(noticeFor('autopilot', { active: false, reason: 'done', steps: 1 }, chat)!.body).toBe('Autopilot finished after 1 step');
    expect(noticeFor('autopilot', { active: false, reason: 'exhausted', steps: 20 }, chat)!.body).toBe('Autopilot stopped: step budget used');
    expect(noticeFor('autopilot', { active: false, reason: 'failed' }, chat)!.body).toBe('Autopilot paused: a turn failed');
    expect(noticeFor('cron_failed', { jobId: 'j', name: 'Nightly report', reason: 'Conversation unavailable' }, chat)!.body).toBe('Nightly report failed: Conversation unavailable');
    expect(noticeFor('cron_failed', { jobId: 'j', name: 'Nightly report', reason: 'x' }, { projectName: 'ocr', projectKind: 'project' })!.title).toBe('Scheduled task · ocr');
    expect(noticeFor('restart_interrupted', { count: 1, bootAt: 'b' }, work)).toMatchObject({ title: 'x056 restarted', body: '1 conversation was interrupted by a restart. Open it to resume.', id: 'restart:b', category: 'needs_you' });
  });
  it('no "tap to continue" anywhere', () => {
    for (const [k, d] of [['conversation_settled', turn()], ['session_error', turn({ message: 'x' })], ['restart_interrupted', { count: 2, bootAt: 'b' }]] as const)
      expect(noticeFor(k, d as Record<string, unknown>, work)!.body).not.toMatch(/tap to/i);
  });
});

describe('helpers', () => {
  it('origin from the sender kind', () => {
    expect(originOf(undefined)).toBe('human');
    expect(originOf({ kind: 'automation' })).toBe('cron');
    expect(originOf({ kind: 'conversation' })).toBe('relay');
    expect(originOf({ kind: 'mcp' })).toBe('relay');
    expect(originOf({ kind: 'delegate' })).toBe('delegate');
    expect(originOf({ kind: 'advisor' })).toBe('advisor');
    expect(originOf({ kind: 'autopilot' })).toBe('autopilot');
    expect(originOf({ kind: 'recap' })).toBe('recap');
    expect(originOf({ kind: 'limit_resume' })).toBe('limit_resume');
  });
  it('a usage limit the gateway continues by itself is never urgent', () => {
    // contract R4/R5: the owner does not have to act
    const parkedResume = noticeFor('session_done', { projectId: 'p', sessionId: 's', status: 'parked', autoResume: { at: 1_793_003_460, until: 1_793_003_400 } }, work)!;
    expect(parkedResume).toMatchObject({ tier: 'normal', category: 'finished' });
    expect(parkedResume.body).toBe('ocr · ChatGPT\nPaused by a usage limit until 15:30; continues automatically');
    expect(noticeFor('limit_continue', { projectId: 'p', sessionId: 's', account: 'l', kind: 'session', waiting: false }, work)).toMatchObject({ tier: 'quiet', category: 'automation' });
  });
  it('durations and cuts', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(cutWords('short', 10)).toBe('short');
    expect(cutWords('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });
});
