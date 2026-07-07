import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCookie } from '../server/auth.guard.js';
import { SessionStore, WebAuthnService } from '../server/webauthn.js';

describe('readCookie', () => {
  it('extracts a named cookie from the raw header, tolerating spaces and other cookies', () => {
    expect(readCookie('x056_session=abc123', 'x056_session')).toBe('abc123');
    expect(readCookie('foo=1; x056_session=abc123; bar=2', 'x056_session')).toBe('abc123');
    expect(readCookie('foo=1; bar=2', 'x056_session')).toBe('');
    expect(readCookie(undefined, 'x056_session')).toBe('');
    expect(readCookie('x056_session=a%20b', 'x056_session')).toBe('a b'); // url-decoded
  });
});

describe('SessionStore', () => {
  it('creates opaque sessions, validates them, destroys them, and persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-sess-'));
    const store = new SessionStore(dir);
    const id = store.create();
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(store.valid(id)).toBe(true);
    expect(store.valid('not-a-session')).toBe(false);
    expect(existsSync(join(dir, 'webauthn', 'sessions.json'))).toBe(true);
    // A fresh instance (e.g. after a restart) still recognizes the session.
    expect(new SessionStore(dir).valid(id)).toBe(true);
    store.destroy(id);
    expect(store.valid(id)).toBe(false);
    expect(new SessionStore(dir).valid(id)).toBe(false);
  });
});

describe('WebAuthnService', () => {
  it('starts with no credentials and reports availability', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-wa-'));
    const wa = new WebAuthnService(dir);
    expect(wa.hasAny()).toBe(false);
    expect(wa.list()).toEqual([]);
    wa.remove('nope'); // no-op, must not throw
    expect(wa.hasAny()).toBe(false);
  });

  it('produces registration options bound to the given rp id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-wa-'));
    const wa = new WebAuthnService(dir);
    const { options, flowId } = await wa.registrationOptions('localhost', 'http://localhost:4056');
    expect(options.rp.id).toBe('localhost');
    expect(typeof options.challenge).toBe('string');
    expect(typeof flowId).toBe('string');
  });
});
