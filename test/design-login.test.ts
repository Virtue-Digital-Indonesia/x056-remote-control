import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesignLoginManager, extractAuthUrl } from '../server/design-login.js';

/**
 * The real URL as the CLI renders it: inside a bordered box, WRAPPED, so the
 * terminal has inserted spaces and a newline mid-token. Captured from an actual
 * /design-login run — matching this naively yields
 * `…client_id=59637612-477b-483` and a link that 404s the moment it is opened.
 */
const WRAPPED = `Browser didn't open? Use the url below to sign in (c to copy)
https://claude.com/cai/oauth/authorize?code=true&client_id=59637612-477b-483  6-a601-b0589eda7704&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Adesign%3Aread+user%3Adesign%3Awrite&code_challenge=-XNywSrh5oZIu93eKh3IXJVPVIPohdvEGW7vWDYSfpA&code_challenge_method=S256&state=W7-LwVSM5HHHS7JWcqPeVdNMZhoqmjsNH47lSBEvJAk
Waiting for browser authorization…`;

describe('extracting the authorize URL from a wrapped TUI', () => {
  it('rejoins the wrapped pieces instead of truncating at the line break', () => {
    const url = extractAuthUrl(WRAPPED)!;
    expect(url).toContain('client_id=59637612-477b-4836-a601-b0589eda7704');
    expect(url).not.toMatch(/\s/);
  });

  it('keeps every parameter the OAuth flow needs — a missing one fails only in the browser', () => {
    const u = new URL(extractAuthUrl(WRAPPED)!);
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe('-XNywSrh5oZIu93eKh3IXJVPVIPohdvEGW7vWDYSfpA');
    expect(u.searchParams.get('state')).toBe('W7-LwVSM5HHHS7JWcqPeVdNMZhoqmjsNH47lSBEvJAk');
    expect(u.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
  });

  it('asks for exactly the design scopes — the whole point of this login', () => {
    const scope = new URL(extractAuthUrl(WRAPPED)!).searchParams.get('scope') ?? '';
    expect(scope.split(/\s+/)).toEqual(['user:design:read', 'user:design:write']);
  });

  it('stops at the box border rather than swallowing the next line', () => {
    const boxed = WRAPPED.replace('\nWaiting', ' │\nWaiting');
    expect(extractAuthUrl(boxed)).not.toContain('Waiting');
  });

  it('returns null when no URL has been printed yet', () => {
    expect(extractAuthUrl('Design login\nOpening browser…')).toBeNull();
  });
});

/**
 * A stand-in for the PTY. `onTyped` lets a step fire in RESPONSE to input, so a
 * test cannot pass by having the CLI volunteer a URL nobody asked for — which is
 * exactly how an earlier version of these tests hid a real bug.
 */
function fakeCli(script: { after: number; text: string; whenTyped?: RegExp }[]) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter; stderr: EventEmitter;
    stdin: { write: (s: string) => void }; kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const typed: string[] = [];
  child.stdin = { write: (s: string) => { typed.push(s); } };
  child.kill = () => {};
  for (const step of script) {
    if (step.whenTyped) continue;
    setTimeout(() => child.stdout.emit('data', step.text), step.after);
  }
  const reactive = script.filter((s2) => s2.whenTyped);
  child.stdin = {
    write: (s2: string) => {
      typed.push(s2);
      for (const step of reactive) {
        if (step.whenTyped!.test(s2)) setTimeout(() => child.stdout.emit('data', step.text), step.after);
      }
    },
  };
  return { child, typed };
}

function manager(script: { after: number; text: string; whenTyped?: RegExp }[]) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-dl-'));
  mkdirSync(dir, { recursive: true });
  const made = fakeCli(script);
  const m = new DesignLoginManager({ cwd: dir, spawnFn: () => made.child as never });
  return { m, dir, typed: made.typed };
}

describe('DesignLoginManager', () => {
  it('answers the first-run trust prompt, then asks for the login', async () => {
    const { m, dir, typed } = manager([
      { after: 20, text: 'Is this a project you trust?\n❯ 1. Yes, I trust this folder\n' },
      { after: 50, text: WRAPPED, whenTyped: /design-login/ },
    ]);
    const out = await m.start('a', dir);
    expect(typed[0]).toBe('\r');                    // trust confirmed
    expect(typed[1]).toBe('/design-login\r');       // then the command
    expect(out.url).toContain('scope=user%3Adesign%3Aread');
    m.cancel(out.loginId);
  }, 20000);

  it('marks onboarding done first, or the theme wizard eats the command', async () => {
    const { m, dir } = manager([{ after: 20, text: WRAPPED }]);
    const out = await m.start('a', dir).catch(() => null);
    const cfg = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
    expect(cfg.hasCompletedOnboarding).toBe(true);
    if (out) m.cancel(out.loginId);
  });

  it('does not clobber an existing config while priming it', async () => {
    const { m, dir } = manager([{ after: 20, text: WRAPPED }]);
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ keepMe: 'yes' }));
    const out = await m.start('a', dir).catch(() => null);
    const cfg = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8'));
    expect(cfg.keepMe).toBe('yes');
    expect(cfg.hasCompletedOnboarding).toBe(true);
    if (out) m.cancel(out.loginId);
  });

  it('waits for the whole URL rather than resolving on a half-rendered one', async () => {
    const half = WRAPPED.slice(0, WRAPPED.indexOf('&state='));
    const { m, dir } = manager([
      { after: 20, text: half },                    // no state= yet
      { after: 400, text: WRAPPED },                // full render
    ]);
    const out = await m.start('a', dir);
    expect(new URL(out.url).searchParams.get('state')).toBeTruthy();
    m.cancel(out.loginId);
  });

  it('reports an unknown login instead of pretending a code was accepted', async () => {
    const { m } = manager([]);
    expect(await m.submit('nope', '1234')).toEqual({ ok: false, message: 'unknown or expired login' });
  });

  it('lists a login in flight so a second one is not started blindly', async () => {
    const { m, dir } = manager([{ after: 20, text: WRAPPED }]);
    const out = await m.start('a', dir);
    expect(m.list()).toEqual([{ loginId: out.loginId, account: 'a' }]);
    m.cancel(out.loginId);
    expect(m.list()).toEqual([]);
  });
});

describe('regression: the already-trusted folder', () => {
  // The first live run worked only because the folder was UNTRUSTED, so the
  // trust branch fired and typed the command. Once trusted, no prompt appears
  // and the command must still be sent — otherwise start() just times out,
  // which is exactly what the deployed gateway did.
  it('types /design-login even when no trust prompt is shown', async () => {
    const { m, dir, typed } = manager([
      { after: 20, text: '\n ▐▛███▜▌ Claude Code v2.1.220\n' },
      { after: 300, text: '? for shortcuts\n' },
      { after: 8000, text: WRAPPED },
    ]);
    const out = await m.start('a', dir);
    expect(typed.filter((t) => t.includes('/design-login')).length).toBeGreaterThan(0);
    expect(typed).not.toContain('\r'); // nothing to confirm — no trust prompt
    m.cancel(out.loginId);
  }, 20000);
});
