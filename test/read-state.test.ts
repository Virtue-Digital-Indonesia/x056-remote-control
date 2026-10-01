import 'reflect-metadata';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReadState } from '../server/read-state.js';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';

function svc(viewing = () => false) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-read-'));
  let t = 1_000;
  const events: Array<Record<string, unknown>> = [];
  const rs = new ReadState(dir, (_k, d) => events.push(d), viewing, () => t);
  return { rs, dir, events, tick: (ms = 10) => { t += ms; } };
}

describe('ReadState rules (the ones both clients used)', () => {
  it('raises unread from notable events and reads them', () => {
    const { rs, tick } = svc();
    rs.observe('question', { projectId: 'p', sessionId: 'q' });
    rs.observe('conversation_settled', { projectId: 'p', sessionId: 'd', notice: { tier: 'normal' } });
    rs.observe('conversation_settled', { projectId: 'p', sessionId: 's', notificationSuppressed: true });
    rs.observe('conversation_settled', { projectId: 'p', sessionId: 'n', notice: { tier: 'none' } });
    rs.observe('session_done', { projectId: 'p', sessionId: 'f', status: 'failed' });
    rs.observe('session_done', { projectId: 'p', sessionId: 'k', status: 'parked' });
    rs.observe('session_error', { projectId: 'p', sessionId: 'e' });
    rs.observe('cron_failed', { projectId: 'p', sessionId: 'c' });
    rs.observe('delegate_report', { projectId: 'p', sessionId: 'u', notice: { tier: 'urgent' } });
    rs.observe('delegate_report', { projectId: 'p', sessionId: 'v', notice: { tier: 'quiet' } });
    rs.observe('assistant_text', { projectId: 'p', sessionId: 'a', text: 'hi' });
    const unread = Object.fromEntries(Object.entries(rs.list()).filter(([, v]) => v.unread).map(([k, v]) => [k, v.kind]));
    expect(unread).toEqual({ 'p::q': 'question', 'p::d': 'done', 'p::f': 'failed', 'p::k': 'failed', 'p::e': 'failed', 'p::c': 'failed', 'p::u': 'question' });
    tick();
    rs.observe('session_done', { projectId: 'p', sessionId: 'f', status: 'stopped' });
    rs.observe('question_dismissed', { projectId: 'p', sessionId: 'q' });
    expect(rs.view('p', 'f').unread).toBe(false);
    expect(rs.view('p', 'q').unread).toBe(false);
  });

  it('keeps an unread question a question when its turn then finishes, but not after a read', () => {
    const { rs, tick } = svc();
    rs.observe('question', { projectId: 'p', sessionId: 's' });
    tick();
    rs.observe('conversation_settled', { projectId: 'p', sessionId: 's', notice: { tier: 'normal' } });
    expect(rs.view('p', 's').kind).toBe('question');
    rs.read('p', 's');
    tick();
    rs.observe('conversation_settled', { projectId: 'p', sessionId: 's', notice: { tier: 'normal' } });
    expect(rs.view('p', 's').kind).toBe('done');
  });

  it('counts an event in a conversation someone is viewing as read', () => {
    const { rs } = svc(() => true);
    rs.observe('question', { projectId: 'p', sessionId: 's' });
    expect(rs.view('p', 's').unread).toBe(false);
  });

  it('marks unread by hand, reads all or some, persists, and broadcasts each change', () => {
    const { rs, dir, events, tick } = svc();
    rs.observe('question', { projectId: 'p', sessionId: 'a' });
    rs.observe('session_error', { projectId: 'q', sessionId: 'b' });
    rs.unread('p', 'c');
    expect(rs.view('p', 'c')).toMatchObject({ unread: true, kind: 'unread' });
    tick();
    expect(rs.readAll(['p::a'])).toBe(1);
    expect(rs.view('p', 'a').unread).toBe(false);
    expect(rs.view('q', 'b').unread).toBe(true);
    expect(rs.readAll()).toBe(2);
    expect(Object.values(rs.list()).some((v) => v.unread)).toBe(false);
    expect(events.at(-1)).toMatchObject({ projectId: expect.any(String), unread: false });
    const again = new ReadState(dir);
    expect(again.view('p', 'c').unread).toBe(false);
    expect(again.view('p', 'a').noticeKind).toBe('question');
  });

  it('orders two changes in the same millisecond', () => {
    const { rs } = svc();
    rs.observe('question', { projectId: 'p', sessionId: 's' });
    rs.read('p', 's');
    expect(rs.view('p', 's').unread).toBe(false);
    rs.unread('p', 's');
    expect(rs.view('p', 's').unread).toBe(true);
  });
});

describe('read-state routes', () => {
  it('serves, reads and unreads, and follows gateway events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'x056-read-http-')), stateDir = join(root, 'state'), workspaceRoot = join(root, 'ws');
    mkdirSync(stateDir); mkdirSync(workspaceRoot);
    AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir: join(root, 'account') }]);
    const token = 'read-state-test-token-0123456789ab';
    const app = await createApp({ token, stateDir, workspaceRoot, projectSpacesEnabled: false });
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const call = async (method: string, path: string, body?: unknown) => {
        const r = await fetch(base + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, json: await r.json() };
      };
      const seen: string[] = [];
      const manager = app.get(SessionManager);
      manager.subscribe((e) => { if (e.kind === 'read_state') seen.push(String(e.data.sessionId)); });
      manager.broadcast('question', { projectId: 'p', sessionId: 's', question: 'Proceed?' });
      expect((await call('GET', '/api/conversations/read-state')).json.items['p::s']).toMatchObject({ unread: true, kind: 'question' });
      expect((await call('POST', '/api/conversations/read', { projectId: 'p', sessionId: 's' })).json.item.unread).toBe(false);
      expect((await call('POST', '/api/conversations/unread', { projectId: 'p', sessionId: 's' })).json.item).toMatchObject({ unread: true, kind: 'unread' });
      expect((await call('POST', '/api/conversations/read-all', {})).json.count).toBe(1);
      expect((await call('POST', '/api/conversations/read', { projectId: 'p' })).status).toBe(400);
      expect(seen.length).toBeGreaterThanOrEqual(4);
    } finally {
      await app.close();
    }
  }, 30_000);
});
