import { execFile } from 'node:child_process';

/**
 * Claude Design agent access, per account.
 *
 * Two separate things gate the design tools, and confusing them costs an
 * afternoon:
 *
 *  - `/design-login` authorizes design-SYSTEM access for `/design-sync`. It is
 *    interactive-only, which is why it needs a PTY (see design-login.ts).
 *  - `/design-consent` grants the AGENT access to your Design projects. Without
 *    it every `mcp__claude-design__*` call returns "The user hasn't granted this
 *    — run /design consent to grant it (it can't be approved automatically in
 *    this permission mode)". That last clause is the trap: sessions here run
 *    with --dangerously-skip-permissions, so the prompt that would normally ask
 *    can never fire, and the grant has to be made out of band.
 *
 * Unlike the login, this command declares `supportsNonInteractive`, so it runs
 * as a plain `claude -p` — no PTY, no browser round trip.
 *
 * The grant is SERVER-SIDE and tied to the claude.ai identity, so it is per
 * account, not per machine: each failover account needs its own, and each sees
 * only its own identity's design projects.
 */

export const DESIGN_CONSENT = Symbol('x056-design-consent');

export interface ConsentAccount { name: string; configDir: string }

export interface ConsentResult {
  account: string;
  ok: boolean;
  /** What the CLI said, trimmed to one line — the 401 case names the cause. */
  message: string;
}

/**
 * Read the CLI's own words rather than its exit code: `claude -p` exits 0 for a
 * refused grant just as it does for a granted one, so a status-only check would
 * report every account healthy.
 */
export function readConsentOutcome(out: string): { ok: boolean; message: string } {
  const text = out.replace(/\s+/g, ' ').trim();
  const ok = /Design agent access granted/i.test(text);
  // The CLI appends an unrelated "Shell cwd was reset to …" notice; it is noise
  // in a dialog that is otherwise one sentence long.
  const body = text.split(/Shell cwd was reset/i)[0].trim();
  // "Couldn't record Design agent access … Request failed with status code 401"
  // is what a logged-out account returns; keep it verbatim so the real fix (that
  // account needs /login) is visible instead of a generic failure.
  const said = body.match(/(?:Design agent access granted|Couldn't record Design)[^]*/i);
  return { ok, message: (said?.[0] ?? body).trim().slice(0, 300) || 'no output from the CLI' };
}

export interface DesignConsentDeps {
  claudePath?: string;
  cwd: string;
  /** Injected in tests; returns the CLI's stdout+stderr. */
  runFn?: (configDir: string) => Promise<string>;
}

export class DesignConsentGranter {
  constructor(private readonly deps: DesignConsentDeps) {}

  private run(configDir: string): Promise<string> {
    if (this.deps.runFn) return this.deps.runFn(configDir);
    return new Promise((resolve) => {
      const child = execFile(
        this.deps.claudePath ?? 'claude',
        ['-p', '/design-consent'],
        {
          cwd: this.deps.cwd,
          env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        },
        // Report stdout even on a non-zero exit: the CLI prints its refusal
        // there, and an empty message would hide the reason.
        (err, stdout, stderr) => resolve(`${stdout ?? ''}\n${stderr ?? ''}${err ? `\n${err.message}` : ''}`),
      );
      child.on('error', (err) => resolve(String(err)));
    });
  }

  async grant(account: ConsentAccount): Promise<ConsentResult> {
    const out = await this.run(account.configDir);
    return { account: account.name, ...readConsentOutcome(out) };
  }

  /** Grant on every account in turn. One account's 401 must not stop the rest. */
  async grantAll(accounts: ConsentAccount[]): Promise<ConsentResult[]> {
    const results: ConsentResult[] = [];
    for (const a of accounts) results.push(await this.grant(a));
    return results;
  }
}
