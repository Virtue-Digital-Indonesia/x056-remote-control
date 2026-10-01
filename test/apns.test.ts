import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    setVapidDetails: () => {},
    sendNotification: () => Promise.resolve(),
  },
}));

import { ApnsService, apnsEndpoint, type ApnsEnv, type ApnsReply } from '../server/apns.js';
import { PushService } from '../server/push.js';
import { noticeFor, type NoticeContext } from '../server/notices.js';
import { Presence } from '../server/presence.js';
import { closeAllGatewayDbs } from '../server/gateway-db.js';

afterEach(() => closeAllGatewayDbs());

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CFG = { keyId: 'KEY123', teamId: 'Z4NCYN9LKJ', bundleId: 'id.val.x056', key: PEM };
const TOK = (c: string) => c.repeat(64);

interface Call { env: ApnsEnv; path: string; headers: Record<string, string>; body: Record<string, unknown> }

function setup(replies: (call: Call, n: number) => ApnsReply = () => ({ status: 200 }), now = () => 1_800_000_000_000) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-apns-'));
  const calls: Call[] = [];
  const transport = async (env: ApnsEnv, path: string, headers: Record<string, string>, body: string) => {
    const call = { env, path, headers, body: JSON.parse(body) as Record<string, unknown> };
    calls.push(call);
    return replies(call, calls.length);
  };
  return { dir, calls, svc: new ApnsService(dir, transport, now) };
}

function jwtParts(header: string) {
  const [h, c, s] = header.replace(/^bearer /, '').split('.');
  return { head: JSON.parse(Buffer.from(h, 'base64url').toString()), claims: JSON.parse(Buffer.from(c, 'base64url').toString()), signed: `${h}.${c}`, sig: Buffer.from(s, 'base64url') };
}

describe('ApnsService devices', () => {
  it('validates, dedupes and persists device tokens', () => {
    const { svc, dir } = setup();
    expect(() => svc.register('nothex', 'production')).toThrow(/invalid device token/);
    expect(() => svc.register(TOK('a'), 'staging' as ApnsEnv)).toThrow(/env/);
    svc.register(TOK('A'), 'production', 'iPhone');
    svc.register(TOK('a'), 'sandbox'); // same token, case-insensitive: replaces
    svc.register(TOK('b'), 'production');
    const stored = JSON.parse(readFileSync(join(dir, 'push', 'apns-devices.json'), 'utf8'));
    expect(stored.map((d: { token: string; env: string }) => [d.token, d.env])).toEqual([[TOK('a'), 'sandbox'], [TOK('b'), 'production']]);
    svc.unregister(TOK('A'));
    expect(svc.status().devices).toHaveLength(1);
  });

  it('is inert without a key: nothing is sent', async () => {
    const { svc, calls } = setup();
    svc.register(TOK('a'), 'production');
    expect(svc.configured).toBe(false);
    expect(svc.hasTargets()).toBe(false);
    expect(await svc.send({ title: 't', body: 'b', kind: 'question', projectId: 'p' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('ApnsService config', () => {
  it('rejects a key it cannot parse and never reports the key back', () => {
    const { svc, dir } = setup();
    expect(() => svc.setConfig({ ...CFG, key: 'not a key' })).toThrow();
    expect(() => svc.setConfig({ ...CFG, teamId: '' })).toThrow(/teamId required/);
    expect(svc.configured).toBe(false);
    svc.setConfig(CFG);
    const file = join(dir, 'secrets', 'apns.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(svc.status())).not.toContain('PRIVATE KEY');
    expect(svc.status()).toMatchObject({ configured: true, bundleId: 'id.val.x056' });
  });

  it('picks up a key file written by hand after start, without a restart', () => {
    const { svc, dir } = setup();
    expect(svc.configured).toBe(false);
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, 'secrets', 'apns.json'), JSON.stringify(CFG));
    expect(svc.configured).toBe(true);
  });
});

describe('ApnsService send', () => {
  it('signs an ES256 provider token Apple can verify and addresses the right host', async () => {
    const { svc, calls } = setup();
    svc.setConfig(CFG);
    svc.register(TOK('a'), 'production');
    svc.register(TOK('b'), 'sandbox');
    await svc.send({ title: 'ocr needs you', body: 'Proceed?', kind: 'question', projectId: 'p1', sessionId: 's1', tag: 'x056-urgent-question:s1:q1', link: '/w/p1/s1' });
    expect(calls.map((c) => [c.env, c.path])).toEqual([['production', `/3/device/${TOK('a')}`], ['sandbox', `/3/device/${TOK('b')}`]]);
    const h = calls[0].headers;
    expect(h).toMatchObject({ 'apns-topic': 'id.val.x056', 'apns-push-type': 'alert', 'apns-priority': '10' });
    expect(h['apns-collapse-id']).toMatch(/^[0-9a-f]{32}$/);
    const jwt = jwtParts(h.authorization);
    expect(jwt.head).toEqual({ alg: 'ES256', kid: 'KEY123' });
    expect(jwt.claims).toEqual({ iss: 'Z4NCYN9LKJ', iat: 1_800_000_000 });
    expect(verify('sha256', Buffer.from(jwt.signed), { key: publicKey, dsaEncoding: 'ieee-p1363' }, jwt.sig)).toBe(true);
    expect(calls[0].body).toEqual({
      aps: { alert: { title: 'ocr needs you', body: 'Proceed?' }, sound: 'default', 'thread-id': 's1', category: 'X056_REPLY' },
      kind: 'question', projectId: 'p1', sessionId: 's1', url: '/w/p1/s1',
    });
  });

  it('offers a reply only when there is a conversation to reply to', () => {
    const { svc } = setup();
    expect((svc.payload({ title: 't', body: 'b', kind: 'turn_orphaned', projectId: 'p' }).aps as Record<string, unknown>).category).toBeUndefined();
    expect((svc.payload({ title: 't', body: 'b', kind: 'autopilot', projectId: 'p', sessionId: 's' }).aps as Record<string, unknown>).category).toBe('X056_REPLY');
  });

  it('sends only to the tokens it is given', async () => {
    const { svc, calls } = setup();
    svc.setConfig(CFG);
    svc.register(TOK('a'), 'production');
    svc.register(TOK('b'), 'production');
    await svc.send({ title: 't', body: 'b', kind: 'question' }, [TOK('B')]);
    expect(calls.map((c) => c.path)).toEqual([`/3/device/${TOK('b')}`]);
  });

  it('prunes uninstalled and wrong-environment tokens, keeps ones that merely failed', async () => {
    const replies: Record<string, ApnsReply> = {
      [TOK('a')]: { status: 410, reason: 'Unregistered' },
      [TOK('b')]: { status: 400, reason: 'BadDeviceToken' },
      [TOK('c')]: { status: 500, reason: 'InternalServerError' },
      [TOK('d')]: { status: 200 },
    };
    const { svc } = setup((call) => replies[call.path.split('/').pop()!]);
    svc.setConfig(CFG);
    for (const c of 'abcd') svc.register(TOK(c), 'production');
    const results = await svc.send({ title: 't', body: 'b', kind: 'session_done', projectId: 'p' });
    expect(results.map((r) => r.status)).toEqual([410, 400, 500, 200]);
    expect(results[0].token).toBe('…' + TOK('a').slice(-8));
    expect(svc.status().devices.map((d) => d.token)).toEqual(['…' + TOK('c').slice(-8), '…' + TOK('d').slice(-8)]);
  });

  it('re-signs and retries once when Apple calls the provider token expired', async () => {
    let t = 1_800_000_000_000;
    const { svc, calls } = setup((_c, n) => (n === 1 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }), () => t);
    svc.setConfig(CFG);
    svc.register(TOK('a'), 'production');
    t += 1000;
    const [r] = await svc.send({ title: 't', body: 'b', kind: 'question', projectId: 'p' });
    expect(r.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.authorization).not.toBe(calls[0].headers.authorization);
  });

  it('reuses the provider token for 40 minutes, then refreshes it', async () => {
    let t = 1_800_000_000_000;
    const { svc, calls } = setup(undefined, () => t);
    svc.setConfig(CFG);
    svc.register(TOK('a'), 'production');
    const alert = { title: 't', body: 'b', kind: 'question', projectId: 'p' };
    await svc.send(alert);
    t += 39 * 60_000;
    await svc.send(alert);
    t += 2 * 60_000;
    await svc.send(alert);
    const auths = calls.map((c) => c.headers.authorization);
    expect(auths[1]).toBe(auths[0]);
    expect(auths[2]).not.toBe(auths[0]);
  });
});

describe('PushService picks iPhones by the same rules as browsers', () => {
  const ctx: NoticeContext = { conversationTitle: 'Fix deed numbers', projectName: 'ocr', provider: 'claude', link: '/w/p/s' };
  const noticeOf = (kind: string, data: Record<string, unknown>) => noticeFor(kind, data, ctx);
  const settled = (extra: Record<string, unknown> = {}) => ({ projectId: 'p', sessionId: 's', status: 'completed', completionPending: false, origin: 'human', durationMs: 120_000, resultText: 'Deed numbers keep their leading zeros now.', notificationId: 'turn1', ...extra });
  function phone(presence?: Presence) {
    const { svc, calls, dir } = setup();
    svc.setConfig(CFG);
    svc.register(TOK('a'), 'production');
    const push = new PushService(dir, { noticeOf, presence, apns: svc });
    return { push, calls, svc };
  }

  it('pushes a long turn to the app with no browser subscribed, once per turn', async () => {
    const { push, calls } = phone();
    await Promise.all([push.notify('conversation_settled', settled()), push.notify('conversation_settled', settled())]);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ aps: { alert: { title: 'Fix deed numbers' }, 'thread-id': 's', category: 'X056_REPLY' }, kind: 'conversation_settled', sessionId: 's', url: '/w/p/s' });
    expect(calls[0].headers['apns-collapse-id']).toMatch(/^[0-9a-f]{32}$/);
    await push.notify('assistant_text', { projectId: 'p', sessionId: 's', text: 'hi' });
    await push.notify('conversation_settled', settled({ durationMs: 12_000, notificationId: 't2' })); // short: bell only
    expect(calls).toHaveLength(1);
  });

  it('stays quiet without a key, even with a device registered', async () => {
    const { svc, calls, dir } = setup();
    svc.register(TOK('a'), 'production');
    const push = new PushService(dir, { noticeOf, apns: svc });
    await push.notify('question', { projectId: 'p', sessionId: 's', question: 'Proceed?', at: 'q1' });
    expect(calls).toHaveLength(0);
  });

  it('respects presence: nothing for the conversation on screen, only urgent while you are at another screen', async () => {
    const presence = new Presence();
    const { push, calls } = phone(presence);
    presence.update({ clientId: 'panel', projectId: 'p', sessionId: 's', visible: true, endpoint: 'https://push/desk' });
    await push.notify('conversation_settled', settled());
    expect(calls).toHaveLength(0);
    presence.update({ clientId: 'panel', projectId: 'p', sessionId: 'other', visible: true, endpoint: 'https://push/desk' });
    await push.notify('conversation_settled', settled({ notificationId: 't2' }));
    expect(calls).toHaveLength(0);
    await push.notify('question', { projectId: 'p', sessionId: 's', question: 'Proceed?', at: 'q1' });
    expect(calls).toHaveLength(1);
    // The app reporting itself as the visible device makes it the one that buzzes.
    presence.update({ clientId: 'iphone', projectId: 'p', sessionId: 'x', visible: true, endpoint: apnsEndpoint(TOK('a')) });
    await push.notify('conversation_settled', settled({ notificationId: 't3' }));
    expect(calls).toHaveLength(2);
  });

  it('applies the iPhone settings, keyed by apns:<token>', async () => {
    const { push, calls } = phone();
    push.saveSettings(apnsEndpoint(TOK('a')), { finished: false });
    await push.notify('conversation_settled', settled());
    expect(calls).toHaveLength(0);
    await push.notify('question', { projectId: 'p', sessionId: 's', question: 'Proceed?', at: 'q1' });
    expect(calls).toHaveLength(1);
  });
});
