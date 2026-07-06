import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock web-push so no real VAPID/HTTP happens; capture sendNotification calls.
const sent: Array<{ endpoint: string; payload: unknown }> = [];
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

import { PushService } from '../server/push.js';

function svc(opts?: { name?: string; autopilot?: (pid: string) => boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-push-'));
  const p = new PushService(dir, () => opts?.name ?? 'Proj', opts?.autopilot ?? (() => false));
  return { p, dir };
}
const sub = (e: string) => ({ endpoint: e, keys: { p256dh: 'x', auth: 'y' } }) as never;

describe('PushService', () => {
  beforeEach(() => { sent.length = 0; });

  it('generates and persists a VAPID keypair, reusing it across instances', () => {
    const { p, dir } = svc();
    const key = p.publicKey;
    expect(key).toMatch(/^PUB_/);
    expect(existsSync(join(dir, 'push', 'vapid.json'))).toBe(true);
    const p2 = new PushService(dir, () => 'Proj', () => false);
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

  it('pushes a question to all subscribers with a project-named title', async () => {
    const { p } = svc({ name: 'ocr' });
    p.add(sub('https://push/a'));
    p.add(sub('https://push/b'));
    await p.notify('question', { projectId: 'p1', question: 'Proceed?' });
    expect(sent.length).toBe(2);
    expect(sent[0].payload).toMatchObject({ title: 'ocr needs you', body: 'Proceed?', projectId: 'p1' });
  });

  it('suppresses session_done while a project is on autopilot, but pushes when it is not', async () => {
    const onAP = new Set(['p-ap']);
    const { p } = svc({ autopilot: (pid) => onAP.has(pid) });
    p.add(sub('https://push/a'));
    await p.notify('session_done', { projectId: 'p-ap', status: 'completed' });
    expect(sent.length).toBe(0); // mid-autopilot step, suppressed
    await p.notify('session_done', { projectId: 'p-manual', status: 'completed' });
    expect(sent.length).toBe(1);
    expect(sent[0].payload).toMatchObject({ title: 'Proj finished' });
  });

  it('pushes autopilot completion but not a user-initiated stop, and ignores unrelated kinds', async () => {
    const { p } = svc();
    p.add(sub('https://push/a'));
    await p.notify('autopilot', { projectId: 'p1', active: false, reason: 'done' });
    expect(sent.length).toBe(1);
    await p.notify('autopilot', { projectId: 'p1', active: false, reason: 'stopped' });
    await p.notify('autopilot', { projectId: 'p1', active: true, remaining: 5 });
    await p.notify('assistant_text', { projectId: 'p1', text: 'hi' });
    expect(sent.length).toBe(1); // no new pushes
  });

  it('does nothing when there are no subscribers', async () => {
    const { p } = svc();
    await p.notify('question', { projectId: 'p1', question: 'Proceed?' });
    expect(sent.length).toBe(0);
  });
});
