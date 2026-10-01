import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock web-push so no real VAPID/HTTP happens; capture sendNotification calls.
const sent: Array<{ endpoint: string; payload: any }> = [];
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'PUB_' + Math.random().toString(36).slice(2), privateKey: 'PRIV' }),
    setVapidDetails: () => {},
    sendNotification: (sub: { endpoint: string }, payload: string) => {
      sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return Promise.resolve();
    },
  },
}));

import { PushService, inQuietHours, normalizeSettings, deviceWants } from '../server/push.js';
import { noticeFor, type NoticeContext } from '../server/notices.js';
import { Presence } from '../server/presence.js';
import { closeAllGatewayDbs } from '../server/gateway-db.js';

const ctx: NoticeContext = { conversationTitle: 'Fix deed numbers', projectName: 'ocr', provider: 'claude', link: '/w/p/s' };
const noticeOf = (kind: string, data: Record<string, unknown>) => noticeFor(kind, data, ctx);
function svc(opts: { presence?: Presence; now?: () => number; dir?: string } = {}) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'x056-push-'));
  const p = new PushService(dir, { noticeOf, presence: opts.presence, now: opts.now });
  return { p, dir };
}
const sub = (e: string) => ({ endpoint: e, keys: { p256dh: 'x', auth: 'y' } }) as never;
const settled = (extra: Record<string, unknown> = {}) => ({ projectId: 'p', sessionId: 's', status: 'completed', completionPending: false, origin: 'human', durationMs: 120_000, resultText: 'Deed numbers keep their leading zeros now.', notificationId: 'turn1', ...extra });

afterEach(() => closeAllGatewayDbs());

describe('PushService', () => {
  beforeEach(() => { sent.length = 0; });

  it('generates and persists a VAPID keypair, reusing it across instances', () => {
    const { p, dir } = svc();
    const key = p.publicKey;
    expect(key).toMatch(/^PUB_/);
    expect(existsSync(join(dir, 'push', 'vapid.json'))).toBe(true);
    const p2 = new PushService(dir);
    expect(p2.publicKey).toBe(key); // loaded, not regenerated
  });

  it('dedupes subscriptions by endpoint and persists them', () => {
    const { p, dir } = svc();
    p.add(sub('https://push/a'));
    p.add(sub('https://push/a')); // same endpoint — should not double up
    p.add(sub('https://push/b'));
    const stored = JSON.parse(readFileSync(join(dir, 'push', 'subscriptions.json'), 'utf8'));
    expect(stored.map((s: { sub: { endpoint: string } }) => s.sub.endpoint).sort()).toEqual(['https://push/a', 'https://push/b']);
  });

  it('pushes a question to every device, named by the conversation, with a per-question tag', async () => {
    const { p } = svc();
    p.add(sub('https://push/a'));
    p.add(sub('https://push/b'));
    await p.notify('question', { projectId: 'p1', sessionId: 's1', question: 'Proceed?', at: 'q1' });
    expect(sent.length).toBe(2);
    expect(sent[0].payload).toMatchObject({ title: 'Fix deed numbers', body: 'ocr · Claude\nProceed?', projectId: 'p1', tier: 'urgent', tag: 'x056-urgent-question:s1:q1', url: '/w/p/s' });
  });

  it('autopilot steps are silent; the run end is one push', async () => {
    const { p } = svc();
    p.add(sub('https://push/a'));
    await p.notify('conversation_settled', settled({ origin: 'autopilot' }));
    expect(sent.length).toBe(0);
    await p.notify('autopilot', { projectId: 'p', sessionId: 's', active: true, remaining: 4 });
    await p.notify('autopilot', { projectId: 'p', sessionId: 's', active: false, reason: 'done', steps: 6, notificationId: 'r1' });
    await p.notify('autopilot', { projectId: 'p', sessionId: 's', active: false, reason: 'stopped', notificationId: 'r2' });
    await p.notify('assistant_text', { projectId: 'p', text: 'hi' });
    expect(sent.map((x) => x.payload.body)).toEqual(['ocr · Claude\nAutopilot finished after 6 steps']);
  });

  it('a long human turn pushes when it settles, never on the pending session_done', async () => {
    const { p } = svc(); p.add(sub('https://push/a'));
    await p.notify('session_done', settled({ completionPending: true }));
    await p.notify('background_state', { projectId: 'p', sessionId: 's', active: true, agents: 1 });
    expect(sent).toHaveLength(0);
    await p.notify('conversation_settled', settled());
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toMatchObject({ title: 'Fix deed numbers', body: 'ocr · Claude\n2m 00s · Deed numbers keep their leading zeros now.', tag: 'x056-conv-s', tier: 'normal' });
  });

  it('a short turn, a relay and a cron run stay in the bell (no push)', async () => {
    const { p } = svc(); p.add(sub('https://push/a'));
    await p.notify('conversation_settled', settled({ durationMs: 12_000 }));
    await p.notify('conversation_settled', settled({ origin: 'relay', notificationId: 't2' }));
    await p.notify('conversation_settled', settled({ origin: 'cron', notificationId: 't3' }));
    expect(sent).toHaveLength(0);
  });

  it('does nothing when there are no subscribers', async () => {
    const { p } = svc();
    await p.notify('question', { projectId: 'p1', question: 'Proceed?' });
    expect(sent.length).toBe(0);
  });

  it('new pushes: an approval, a cron failure, and every account out', async () => {
    const { p } = svc(); p.add(sub('https://push/a'));
    await p.notify('mcp_approval', { id: 'a1', status: 'pending', projectId: 't', sessionId: 'ts', targetLabel: 'Release notes', message: 'Please add the changelog entry', sender: { kind: 'conversation', conversationTitle: 'Fix deed numbers' } });
    await p.notify('mcp_approval', { id: 'a1', status: 'approved', projectId: 't', sessionId: 'ts', targetLabel: 'Release notes', message: 'x' });
    await p.notify('cron_failed', { projectId: 'p', sessionId: 's', jobId: 'j1', name: 'Nightly report', reason: 'Conversation unavailable', at: 'c1' });
    await p.notify('session_done', { projectId: 'p', sessionId: 's', status: 'parked', parkedUntil: Date.parse('2026-10-01T07:00:00Z') / 1000, notificationId: 'tp' });
    expect(sent.map((x) => x.payload.tier)).toEqual(['urgent', 'urgent', 'urgent']);
    expect(sent[0].payload.body).toBe('Claude in Fix deed numbers wants to message Release notes: “Please add the changelog entry”');
    expect(sent[1].payload.body).toBe('ocr · Claude\nNightly report failed: Conversation unavailable');
    expect(sent[2].payload.body).toMatch(/^ocr · Claude\nAccount limit reached on every account — resets (\w{3} )?14:00$/);
  });
});

describe('notification noise control', () => {
  beforeEach(() => { sent.length = 0; });
  it('silences stopped/cancelled turns and suppressed completions', async () => {
    const { p } = svc(); p.add(sub('https://push/a'));
    for (const status of ['stopped', 'cancelled', 'canceled']) await p.notify('session_done', { sessionId: 's', status });
    await p.notify('session_done', { status: 'failed', reason: 'Stopped by user.' });
    await p.notify('conversation_settled', settled({ notificationSuppressed: true }));
    await p.notify('turn_orphaned', { projectId: 'p', sessionId: 's' });
    expect(sent).toHaveLength(0);
  });
  it('dedupes a terminal event per turn, including concurrent delivery, without muting future turns', async () => {
    const { p } = svc(); p.add(sub('https://push/a'));
    await Promise.all([p.notify('conversation_settled', settled()), p.notify('conversation_settled', settled())]);
    expect(sent).toHaveLength(1);
    await p.notify('conversation_settled', settled({ notificationId: 'turn2' }));
    await p.notify('session_error', { projectId: 'p', sessionId: 's', notificationId: 'turn3', message: 'Connection lost' });
    expect(sent).toHaveLength(3);
    expect(sent[2].payload).toMatchObject({ title: 'Fix deed numbers', body: 'ocr · Claude\nTurn failed: Connection lost', tier: 'urgent' });
  });
  it('remembers what it sent across a restart (gateway.sqlite)', async () => {
    const first = svc(); first.p.add(sub('https://push/a'));
    await first.p.notify('conversation_settled', settled());
    expect(sent).toHaveLength(1);
    closeAllGatewayDbs();
    const again = svc({ dir: first.dir });
    await again.p.notify('conversation_settled', settled());
    expect(sent).toHaveLength(1);
    expect(again.p.wasSent('turn:s:turn1')).toBe(true);
  });
  it('one push per restart, however many conversations it interrupted', async () => {
    const { p } = svc(); p.add(sub('https://push/a'));
    for (const s of ['s1', 's2', 's3']) await p.notify('turn_orphaned', { projectId: 'p', sessionId: s });
    await p.notify('restart_interrupted', { count: 3, bootAt: 'b1' });
    await p.notify('restart_interrupted', { count: 3, bootAt: 'b1' });
    expect(sent.map((x) => x.payload.body)).toEqual(['3 conversations were interrupted by a restart. Open them to resume.']);
  });
});

describe('presence', () => {
  beforeEach(() => { sent.length = 0; });
  it('nothing for the conversation you are reading; normal pushes go only to the device you are at', async () => {
    let t = 1_000_000;
    const presence = new Presence(() => t);
    const { p } = svc({ presence, now: () => t });
    p.add(sub('https://push/phone')); p.add(sub('https://push/desk'));
    presence.update({ clientId: 'tab1', projectId: 'p', sessionId: 's', visible: true, endpoint: 'https://push/desk' });
    await p.notify('conversation_settled', settled());
    await p.notify('question', { projectId: 'p', sessionId: 's', question: 'Ship it?', at: 'q' });
    expect(sent).toHaveLength(0);
    // Looking at another conversation: the long turn goes to the desk only.
    presence.update({ clientId: 'tab1', projectId: 'p', sessionId: 'other', visible: true, endpoint: 'https://push/desk' });
    await p.notify('conversation_settled', settled({ notificationId: 'turn2' }));
    expect(sent.map((x) => x.endpoint)).toEqual(['https://push/desk']);
    // Urgent still reaches every device.
    await p.notify('question', { projectId: 'p', sessionId: 's', question: 'Ship it?', at: 'q2' });
    expect(sent.slice(1).map((x) => x.endpoint).sort()).toEqual(['https://push/desk', 'https://push/phone']);
    // 30 s with no report: you left; everything reaches the phone again.
    t += 31_000;
    await p.notify('conversation_settled', settled({ notificationId: 'turn3' }));
    expect(sent.slice(3).map((x) => x.endpoint).sort()).toEqual(['https://push/desk', 'https://push/phone']);
  });
  it('a hidden tab is not presence', () => {
    let t = 0; const presence = new Presence(() => t);
    presence.update({ clientId: 'a', sessionId: 's', visible: false });
    expect(presence.anyVisible()).toBe(false);
    expect(presence.viewing('p', 's')).toBe(false);
    presence.update({ clientId: 'a', sessionId: 's', visible: true });
    expect(presence.viewing('p', 's')).toBe(true);
    t = 30_001;
    expect(presence.viewing('p', 's')).toBe(false);
    expect(() => presence.update({ clientId: '', visible: true })).toThrow();
  });
});

describe('per-device settings', () => {
  beforeEach(() => { sent.length = 0; });
  it('defaults, persistence, and filtering', async () => {
    const { p, dir } = svc(); p.add(sub('https://push/a')); p.add(sub('https://push/b'));
    expect(p.settings('https://push/a')).toEqual({ finished: true, automation: false, quietHours: { enabled: false, start: '22:00', end: '07:00' } });
    p.saveSettings('https://push/a', { finished: false });
    p.saveSettings('https://push/b', { automation: true });
    closeAllGatewayDbs();
    const again = new PushService(dir, { noticeOf });
    expect(again.settings('https://push/a').finished).toBe(false);
    await again.notify('conversation_settled', settled());
    expect(sent.map((x) => x.endpoint)).toEqual(['https://push/b']);
    sent.length = 0;
    await again.notify('conversation_settled', settled({ origin: 'cron', notificationId: 'c' }));
    expect(sent.map((x) => x.endpoint)).toEqual(['https://push/b']); // automation opted in
    sent.length = 0;
    await again.notify('question', { projectId: 'p', sessionId: 's', question: 'Q?', at: 'qq' });
    expect(sent).toHaveLength(2); // "Needs you" cannot be switched off
  });
  it('quiet hours, in the device zone, across midnight; urgent obeys them only when enabled', () => {
    const s = normalizeSettings({ quietHours: { enabled: true, start: '22:00', end: '07:00' }, timeZone: 'Asia/Jakarta' });
    expect(inQuietHours(s, Date.parse('2026-10-01T16:00:00Z'))).toBe(true); // 23:00 WIB
    expect(inQuietHours(s, Date.parse('2026-10-01T23:30:00Z'))).toBe(true); // 06:30 WIB
    expect(inQuietHours(s, Date.parse('2026-10-01T01:00:00Z'))).toBe(false); // 08:00 WIB
    const urgent = noticeFor('question', { projectId: 'p', sessionId: 's', question: 'Q?' }, ctx)!;
    expect(deviceWants(urgent, s, Date.parse('2026-10-01T16:00:00Z'))).toBe(false);
    expect(deviceWants(urgent, normalizeSettings({}), Date.parse('2026-10-01T16:00:00Z'))).toBe(true);
    expect(normalizeSettings({ quietHours: { enabled: true, start: '25:00' }, timeZone: 'Nowhere/Land' })).toEqual({ finished: true, automation: false, quietHours: { enabled: true, start: '22:00', end: '07:00' } });
  });
  it('a test push reaches only this device, even while you are looking', async () => {
    const presence = new Presence();
    const { p } = svc({ presence }); p.add(sub('https://push/a')); p.add(sub('https://push/b'));
    presence.update({ clientId: 'x', visible: true, sessionId: 's', endpoint: 'https://push/a' });
    expect(await p.test('https://push/a')).toBe(true);
    expect(await p.test('https://push/none')).toBe(false);
    expect(sent.map((x) => [x.endpoint, x.payload.tier, x.payload.tag])).toEqual([['https://push/a', 'normal', 'x056-test']]);
  });
});

describe('a chat is named by its conversation, not "New chat"', () => {
  beforeEach(() => { sent.length = 0; });
  it('waits for a pending chat title, then names the push with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-push-'));
    let title = 'New chat', pending = true;
    const p = new PushService(dir, {
      noticeOf: (k, d) => noticeFor(k, d, { conversationTitle: title, projectName: title, projectKind: 'chat' }),
      titlePending: () => pending, titleWaitMs: 3000,
    });
    p.add(sub('https://push/a'));
    setTimeout(() => { title = 'Quarterly revenue review'; pending = false; }, 700);
    await p.notify('conversation_settled', settled({ notice: undefined }));
    expect(sent[0].payload).toMatchObject({ title: 'Quarterly revenue review', body: '2m 00s · Deed numbers keep their leading zeros now.' });
  });

  it('does not wait at all for a Work project (titlePending is false there)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-push-'));
    const p = new PushService(dir, { noticeOf, titlePending: () => false, titleWaitMs: 5000 });
    p.add(sub('https://push/a'));
    const t0 = Date.now();
    await p.notify('conversation_settled', settled());
    expect(sent).toHaveLength(1);
    expect(Date.now() - t0).toBeLessThan(300);
  });

  it('gives up waiting after the bound and still sends', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-push-'));
    const p = new PushService(dir, { noticeOf: (k, d) => noticeFor(k, d, { conversationTitle: 'New chat', projectName: 'New chat', projectKind: 'chat' }), titlePending: () => true, titleWaitMs: 600 });
    p.add(sub('https://push/a'));
    const t0 = Date.now();
    await p.notify('conversation_settled', settled());
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.title).toBe('New chat');
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});
