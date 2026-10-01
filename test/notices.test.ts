import { describe, expect, it } from 'vitest';
import { noticeFor, originOf, cutWords, replyExcerpt, noticeTitle, failureReason, formatDuration, LONG_TURN_MS, type NoticeContext, type TurnOrigin } from '../server/notices.js';

const work: NoticeContext = { conversationTitle: 'Fix deed numbers', projectName: 'ocr', projectKind: 'project', provider: 'codex', link: '/work/p/s', at: '2026-10-01T03:00:00Z' };
const chat: NoticeContext = { conversationTitle: 'Quarterly revenue review', projectName: 'Quarterly revenue review', projectKind: 'chat', provider: 'claude', link: '/chat/c' };
const turn = (o: Record<string, unknown> = {}) => ({ projectId: 'p', sessionId: 's', status: 'completed', completionPending: false, origin: 'human', durationMs: 252_000, resultText: 'Deed numbers keep their leading zeros now; the limit check is in Review.', requestId: 'r1', ...o });

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
  ] as [TurnOrigin, number, string][])('finished, %s, %i ms → %s', (origin, ms, tier) => {
    expect(settledTier(origin, ms)).toBe(tier);
  });
  it.each([
    ['human', 'urgent'], ['relay', 'urgent'], ['cron', 'urgent'], ['delegate', 'urgent'],
    ['advisor', 'normal'], ['autopilot', 'normal'],
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
  });
  it('durations and cuts', () => {
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(3_900_000)).toBe('1h 05m');
    expect(cutWords('short', 10)).toBe('short');
    expect(cutWords('alpha beta gamma delta', 12)).toBe('alpha beta…');
  });
});
