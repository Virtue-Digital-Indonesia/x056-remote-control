import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Browser login for Claude Design, per account.
 *
 * `/design-login` grants `user:design:read` + `user:design:write` on a claude.ai
 * login. It only exists inside an INTERACTIVE session, so a headless `-p` turn
 * cannot run it — and the login must stay alive while the operator completes the
 * browser round trip, which outlives any single turn. So it lives here, in the
 * gateway, the same way account onboarding already does.
 *
 * Two things learned by driving this against the real CLI, both load-bearing:
 *
 *  - `--dangerously-skip-permissions` suppresses the trust prompt but ALSO
 *    suppresses the login itself ("can't be approved automatically in this
 *    permission mode"). The session must therefore run WITHOUT it, which means
 *    the first-run prompts have to be handled rather than avoided.
 *  - A config dir that has never run interactively opens on the theme wizard and
 *    swallows whatever is typed. `hasCompletedOnboarding` is set before spawning
 *    so the session starts at the prompt; the trust question is answered by
 *    watching for it, since it is per-directory and cheaper to answer than to
 *    pre-seed.
 */

export const DESIGN_LOGIN = Symbol('x056-design-login');

interface Pending {
  child: ChildProcess;
  buf: string;
  account: string;
  timer: ReturnType<typeof setTimeout>;
  resolved: boolean;
}

/** Drop ANSI so prompts can be matched as plain text. */
const strip = (s: string): string =>
  s.replace(/\x1B\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');

const AUTH_START = 'https://claude.com/cai/oauth/authorize';

/**
 * Pull the authorize URL out of the TUI.
 *
 * The CLI renders it inside a bordered box, so a long URL is WRAPPED — the
 * terminal inserts spaces (and a newline) mid-token. Matching it directly
 * returns a truncated URL that fails the moment it is opened, which is exactly
 * what happened before this: `…client_id=59637612-477b-483` and nothing after.
 * So take a window from the start marker, delete whitespace to rejoin the
 * pieces, and keep only the URL characters that follow.
 */
export function extractAuthUrl(raw: string): string | null {
  const i = raw.indexOf(AUTH_START);
  if (i < 0) return null;
  const window = raw.slice(i, i + 3000);

  // Rejoin token by token rather than deleting all whitespace: the text that
  // FOLLOWS the URL ("Waiting for browser authorization…") is made of letters,
  // which are themselves URL-legal, so a blanket strip silently glues it on and
  // produces a link that fails only once opened.
  //
  // The URL is a query string, so every real continuation carries `=`, `&` or
  // `%`; prose carries none. `state` is the last parameter, so once it is
  // present and complete, a token without those characters is the UI talking.
  const URLCHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
  let url = '';
  for (const token of window.split(/\s+/)) {
    if (!token) continue;
    if (!URLCHARS.test(token)) break;
    const haveState = /[?&]state=[^&]{16,}/.test(url);
    if (url && haveState && !/[=&%]/.test(token)) break;
    url += token;
    if (!url.startsWith(AUTH_START)) return null;
  }
  return url.replace(/[&?]+$/, '') || null;
}

export interface DesignLoginDeps {
  claudePath?: string;
  /** cwd for the spawned session; any directory the account may read. */
  cwd: string;
  spawnFn?: (configDir: string, claudePath: string | undefined, cwd: string) => ChildProcess;
}

function defaultSpawn(configDir: string, claudePath: string | undefined, cwd: string): ChildProcess {
  const bin = claudePath ?? 'claude';
  // `script` gives it a PTY; the CLI refuses to render its login UI otherwise.
  // NOTE: no --dangerously-skip-permissions — it would block the login.
  return spawn('script', ['-qec', bin, '/dev/null'], {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, COLUMNS: '1000', TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export class DesignLoginManager {
  private pending = new Map<string, Pending>();

  constructor(private readonly deps: DesignLoginDeps) {}

  /** Mark onboarding done so the session opens at the prompt, not the wizard. */
  private primeOnboarding(configDir: string): void {
    const file = join(configDir, '.claude.json');
    try {
      const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> : {};
      if (json.hasCompletedOnboarding === true) return;
      json.hasCompletedOnboarding = true;
      writeFileSync(file, JSON.stringify(json, null, 2));
    } catch { /* a wizard we then have to click through is better than failing here */ }
  }

  /**
   * Start a login. Resolves with the URL to open in a browser; the session stays
   * alive waiting for the code until submit(), cancel(), or the timeout.
   */
  start(account: string, configDir: string): Promise<{ loginId: string; url: string }> {
    this.primeOnboarding(configDir);
    const loginId = randomUUID();
    const child = (this.deps.spawnFn ?? defaultSpawn)(configDir, this.deps.claudePath, this.deps.cwd);
    const p: Pending = {
      child, buf: '', account, resolved: false,
      timer: setTimeout(() => this.cancel(loginId), 10 * 60_000),
    };
    this.pending.set(loginId, p);

    return new Promise((resolve, reject) => {
      let trusted = false;
      let asked = false;
      const onData = (d: Buffer | string) => {
        p.buf += strip(String(d));
        const flat = p.buf.replace(/\s+/g, '');

        // First-run trust question — answer it, then ask for the login.
        if (!trusted && /Yes,Itrustthisfolder/i.test(flat)) {
          trusted = true;
          child.stdin?.write('\r');
          setTimeout(() => { if (!asked) { asked = true; child.stdin?.write('/design-login\r'); } }, 2000);
          return;
        }
        // No trust prompt (already trusted): ask once the prompt is up.
        if (!asked && !trusted && /bypass|shortcuts|Message|\?\sfor/i.test(p.buf.slice(-2000))) {
          asked = true;
          setTimeout(() => child.stdin?.write('/design-login\r'), 1500);
        }

        // Wait for the state param before resolving: it is last in the URL, so
        // its presence means the wrapped text has fully arrived.
        const url = extractAuthUrl(p.buf);
        if (url && /[?&]state=[^&]+/.test(url) && !p.resolved) {
          p.resolved = true;
          resolve({ loginId, url });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('error', (err) => { this.cancel(loginId); reject(err); });
      child.on('exit', () => {
        if (!p.resolved) { this.pending.delete(loginId); reject(new Error('the login session exited before printing a URL')); }
      });
      setTimeout(() => {
        if (!p.resolved) { this.cancel(loginId); reject(new Error('timed out waiting for the login URL')); }
      }, 90_000);
    });
  }

  /** Paste the code the browser handed back. */
  submit(loginId: string, code: string): Promise<{ ok: boolean; message: string }> {
    const p = this.pending.get(loginId);
    if (!p) return Promise.resolve({ ok: false, message: 'unknown or expired login' });
    const mark = p.buf.length;
    p.child.stdin?.write(`${code.trim()}\r`);
    return new Promise((resolve) => {
      const done = (ok: boolean, message: string) => {
        clearTimeout(timer);
        this.cancel(loginId);
        resolve({ ok, message });
      };
      const timer = setTimeout(() => {
        const after = p.buf.slice(mark).replace(/\s+/g, ' ').trim();
        // No explicit failure text is the common success path: the CLI just
        // returns to the prompt. Report what it said rather than guessing.
        const failed = /invalid|failed|error|expired|denied/i.test(after);
        done(!failed, after.slice(-300) || 'no output from the CLI');
      }, 12_000);
    });
  }

  cancel(loginId: string): void {
    const p = this.pending.get(loginId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(loginId);
    try { p.child.kill('SIGKILL'); } catch { /* already gone */ }
  }

  /** Live logins, so the panel can show one already in flight. */
  list(): { loginId: string; account: string }[] {
    return [...this.pending.entries()].map(([loginId, p]) => ({ loginId, account: p.account }));
  }
}
