# X056 Max-Account Failover v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A supervisor that runs a Claude Code session headlessly and automatically fails over to a second Claude Max account on a usage-limit hit, resuming the same session id with zero user action.

**Architecture:** Plain TypeScript package (no framework). A `runSession` state machine spawns `claude -p` per turn under the active account's `CLAUDE_CONFIG_DIR`, classifies stream-json events with a pure `classifyEvent` detector, and on a definitive rate-limit signal kills the child, marks the account limited, and respawns `--resume <sid>` under the other account. All process/clock/network effects are injected so the core logic is unit-testable; a `fake-claude` replay binary gives a deterministic end-to-end test.

**Tech Stack:** Node ≥ 20 (server has v25.6.1), TypeScript strict + ESM, vitest, tsx. Zero runtime dependencies (global `fetch`, `node:child_process`, `node:util` `parseArgs`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-max-failover-design.md` (decisions D1–D7, facts F1–F9). Verified against Claude Code v2.1.201.
- Spawned CLI flags, verbatim (D1, D4): `-p --output-format stream-json --verbose --dangerously-skip-permissions` plus `--session-id <sid>` (new) or `--resume <sid>` (resume), prompt as final positional arg.
- Account config dirs (D2): `~/.claude-x056-a`, `~/.claude-x056-b`; registry file `state/accounts.json`; B's `projects` symlinked to A's.
- Failover triggers, any one suffices (D3): `rate_limit_event` with `rate_limit_info.status === "rejected"`; `system`/`api_retry` with `error === "rate_limit"` or `error_status === 429`; `result` with `api_error_status === 429`; any event with top-level `error === "rate_limit"` (synthetic transcript entry). `overloaded_error`/5xx are transient — never failover (F8).
- Resume prompt, verbatim (D5): `Continue exactly where you left off. If your last action was a command or edit that may have partially applied, verify its actual effect before re-running anything with side effects.`
- Guards (D6): max 3 automatic failovers per session per hour; both accounts limited → return `parked` with earliest reset time; unknown reset time fallback = now + 5 h.
- Forced switch (D7): SIGUSR1 to the supervisor → drain (wait for next `user`-type event carrying tool results, or `result`), then SIGINT the child; hard 30 s drain timeout; account gets a 30-min cooldown.
- Never log or print OAuth tokens. `state/` is gitignored.
- Every `.md` created or modified must be uploaded per CLAUDE.md (`curl -F "file=@f.md" https://x056.think.val.id/upload`).

## File Structure

```
package.json, tsconfig.json          Task 1 (scaffold)
src/types.ts                         Task 1  raw + verdict types
src/detector.ts                      Task 1  classifyEvent (pure)
src/eventlog.ts                      Task 2  append-only jsonl
src/accounts.ts                      Task 2  AccountRegistry (accounts.json)
src/quota.ts                         Task 3  fetchUsage via /api/oauth/usage
src/turn.ts                          Task 4  startTurn: spawn + NDJSON parse + kill/interrupt
src/fake-claude.ts                   Task 5  scenario replay binary
src/failover.ts                      Task 6  runSession state machine
src/cli.ts                           Task 7  x056 run/continue/status/switch
test/*.test.ts                       per task
test/bin/fake-claude                 Task 5  exec wrapper
scripts/setup-accounts.sh            Task 8  post-login verification + symlink
scripts/drill-forced-switch.md       Task 8  live drill procedure
```

---

### Task 1: Scaffold + LimitDetector

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/types.ts`, `src/detector.ts`
- Test: `test/detector.test.ts`

**Interfaces:**
- Produces: `RawEvent = Record<string, unknown>`; `Verdict = { kind: 'limited'|'transient'|'warning'|'ok'|'irrelevant'; resetsAt?: number; source: string }`; `classifyEvent(e: RawEvent): Verdict`. All later tasks import these from `./types.js` / `./detector.js`.

- [ ] **Step 1: Scaffold the package**

`package.json`:
```json
{
  "name": "x056-remote-control",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "x056": "tsx src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

`.gitignore`:
```
node_modules/
state/
dist/
```

Run: `npm install` — expect it to complete without errors.

- [ ] **Step 2: Write the failing detector test**

`test/detector.test.ts` — fixtures are **real captures** from this server (2026-07-04 probe; 2026-07-03 transcript entry):
```ts
import { describe, expect, it } from 'vitest';
import { classifyEvent } from '../src/detector.js';

const rateLimitAllowed = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed', resetsAt: 1783170000, rateLimitType: 'five_hour',
    overageStatus: 'rejected', overageDisabledReason: 'org_level_disabled', isUsingOverage: false,
  },
};

const syntheticLimitEntry = {
  parentUuid: 'bdceb5bc', type: 'assistant',
  message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 8:20pm (Asia/Jakarta)" }] },
  error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429,
};

describe('classifyEvent', () => {
  it('passes through an allowed rate_limit_event as ok', () => {
    expect(classifyEvent(rateLimitAllowed)).toEqual({ kind: 'ok', source: 'rate_limit_event' });
  });

  it('flags rejected rate_limit_event as limited with resetsAt', () => {
    const e = { ...rateLimitAllowed, rate_limit_info: { ...rateLimitAllowed.rate_limit_info, status: 'rejected' } };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', resetsAt: 1783170000, source: 'rate_limit_event' });
  });

  it('flags allowed_warning as warning', () => {
    const e = { ...rateLimitAllowed, rate_limit_info: { ...rateLimitAllowed.rate_limit_info, status: 'allowed_warning' } };
    expect(classifyEvent(e)).toEqual({ kind: 'warning', resetsAt: 1783170000, source: 'rate_limit_event' });
  });

  it('flags api_retry with rate_limit as limited (kill-on-first-signal, D3)', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', source: 'api_retry' });
  });

  it('treats api_retry for overloaded as transient (F8)', () => {
    const e = { type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' };
    expect(classifyEvent(e)).toEqual({ kind: 'transient', source: 'api_retry' });
  });

  it('flags result with api_error_status 429 as limited', () => {
    const e = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429 };
    expect(classifyEvent(e)).toEqual({ kind: 'limited', source: 'result' });
  });

  it('flags the synthetic transcript limit entry as limited', () => {
    expect(classifyEvent(syntheticLimitEntry)).toEqual({ kind: 'limited', source: 'synthetic_message' });
  });

  it('ignores ordinary events', () => {
    expect(classifyEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }).kind).toBe('irrelevant');
    expect(classifyEvent({ type: 'result', subtype: 'success', is_error: false, api_error_status: null }).kind).toBe('irrelevant');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/detector.test.ts`
Expected: FAIL — cannot resolve `../src/detector.js`.

- [ ] **Step 4: Implement types + detector**

`src/types.ts`:
```ts
export type RawEvent = Record<string, unknown>;

export interface Verdict {
  kind: 'limited' | 'transient' | 'warning' | 'ok' | 'irrelevant';
  resetsAt?: number; // unix seconds when known
  source: string;
}
```

`src/detector.ts`:
```ts
import type { RawEvent, Verdict } from './types.js';

interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
}

export function classifyEvent(e: RawEvent): Verdict {
  if (e.type === 'rate_limit_event') {
    const info = (e.rate_limit_info ?? {}) as RateLimitInfo;
    if (info.status === 'rejected') return { kind: 'limited', resetsAt: info.resetsAt, source: 'rate_limit_event' };
    if (info.status === 'allowed_warning') return { kind: 'warning', resetsAt: info.resetsAt, source: 'rate_limit_event' };
    return { kind: 'ok', source: 'rate_limit_event' };
  }
  if (e.type === 'system' && e.subtype === 'api_retry') {
    if (e.error === 'rate_limit' || e.error_status === 429) return { kind: 'limited', source: 'api_retry' };
    return { kind: 'transient', source: 'api_retry' };
  }
  if (e.type === 'result' && e.api_error_status === 429) return { kind: 'limited', source: 'result' };
  if (e.error === 'rate_limit') return { kind: 'limited', source: 'synthetic_message' };
  return { kind: 'irrelevant', source: 'none' };
}
```

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `npx vitest run test/detector.test.ts && npm run typecheck`
Expected: 8 tests PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore src/types.ts src/detector.ts test/detector.test.ts
git commit -m "feat: scaffold package and add limit detector with real-capture fixtures"
```

---

### Task 2: EventLog + AccountRegistry

**Files:**
- Create: `src/eventlog.ts`, `src/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `EventLog` — `constructor(file: string)`, `append(event: Record<string, unknown>): void` (adds `ts` ISO string, appends one JSON line, creates parent dir), `read(): Record<string, unknown>[]`.
  - `AccountState = { kind: 'unknown' } | { kind: 'ok' } | { kind: 'limited'; until: number }`
  - `Account = { name: string; configDir: string; state: AccountState }`
  - `AccountRegistry` — `static load(file: string): AccountRegistry` (throws with setup hint if file missing), `static init(file: string, accounts: {name: string; configDir: string}[]): AccountRegistry`, `list(): Account[]`, `get(name: string): Account`, `pickActive(now: number): Account | null` (prefers stored `active` name if usable — usable = not limited, or limited with `until <= now`; else first usable other; else null), `setActive(name: string): void`, `markLimited(name: string, until: number): void`, `markOk(name: string): void`, `earliestReset(): number` (min `until` over limited accounts; caller guarantees at least one), every mutation persists via tmp-file + rename.

- [ ] **Step 1: Write the failing test**

`test/accounts.test.ts`:
```ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'x056-')), 'accounts.json');
}

describe('AccountRegistry', () => {
  const specs = [
    { name: 'a', configDir: '/home/efran/.claude-x056-a' },
    { name: 'b', configDir: '/home/efran/.claude-x056-b' },
  ];

  it('init + load round-trips and picks the active account', () => {
    const file = freshFile();
    AccountRegistry.init(file, specs);
    const reg = AccountRegistry.load(file);
    expect(reg.pickActive(1000)?.name).toBe('a');
  });

  it('markLimited fails over pickActive to the other account and persists', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000);
    expect(reg.pickActive(1000)?.name).toBe('b');
    const reloaded = AccountRegistry.load(file);
    expect(reloaded.get('a').state).toEqual({ kind: 'limited', until: 5000 });
  });

  it('a limited account becomes usable again after its reset time', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000);
    reg.setActive('a');
    expect(reg.pickActive(6000)?.name).toBe('a');
  });

  it('returns null and earliestReset when both accounts are limited', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000);
    reg.markLimited('b', 3000);
    expect(reg.pickActive(1000)).toBeNull();
    expect(reg.earliestReset()).toBe(3000);
  });

  it('load without file throws a setup hint', () => {
    expect(() => AccountRegistry.load(freshFile())).toThrow(/setup/i);
  });
});

describe('EventLog', () => {
  it('appends timestamped jsonl lines and reads them back', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'x056-')), 'nested', 'events.jsonl');
    const log = new EventLog(file);
    log.append({ type: 'failover', from: 'a' });
    log.append({ type: 'parked' });
    const rows = log.read();
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('failover');
    expect(typeof rows[0].ts).toBe('string');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/accounts.test.ts`
Expected: FAIL — cannot resolve `../src/accounts.js`.

- [ ] **Step 3: Implement**

`src/eventlog.ts`:
```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventLog {
  constructor(private readonly file: string) {}

  append(event: Record<string, unknown>): void {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  }

  read(): Record<string, unknown>[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }
}
```

`src/accounts.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type AccountState = { kind: 'unknown' } | { kind: 'ok' } | { kind: 'limited'; until: number };

export interface Account {
  name: string;
  configDir: string;
  state: AccountState;
}

interface RegistryFile {
  active: string;
  accounts: Account[];
}

export class AccountRegistry {
  private constructor(
    private readonly file: string,
    private data: RegistryFile,
  ) {}

  static init(file: string, specs: { name: string; configDir: string }[]): AccountRegistry {
    const data: RegistryFile = {
      active: specs[0].name,
      accounts: specs.map((s) => ({ ...s, state: { kind: 'unknown' } })),
    };
    const reg = new AccountRegistry(file, data);
    reg.save();
    return reg;
  }

  static load(file: string): AccountRegistry {
    if (!existsSync(file)) {
      throw new Error(`${file} not found — run the setup step (scripts/setup-accounts.sh) first.`);
    }
    return new AccountRegistry(file, JSON.parse(readFileSync(file, 'utf8')) as RegistryFile);
  }

  list(): Account[] {
    return this.data.accounts;
  }

  get(name: string): Account {
    const acct = this.data.accounts.find((a) => a.name === name);
    if (!acct) throw new Error(`unknown account: ${name}`);
    return acct;
  }

  private usable(a: Account, now: number): boolean {
    return a.state.kind !== 'limited' || a.state.until <= now;
  }

  pickActive(now: number): Account | null {
    const preferred = this.get(this.data.active);
    if (this.usable(preferred, now)) return preferred;
    const other = this.data.accounts.find((a) => a.name !== preferred.name && this.usable(a, now));
    if (other) {
      this.data.active = other.name;
      this.save();
      return other;
    }
    return null;
  }

  setActive(name: string): void {
    this.get(name);
    this.data.active = name;
    this.save();
  }

  markLimited(name: string, until: number): void {
    this.get(name).state = { kind: 'limited', until };
    this.save();
  }

  markOk(name: string): void {
    this.get(name).state = { kind: 'ok' };
    this.save();
  }

  earliestReset(): number {
    const untils = this.data.accounts
      .map((a) => a.state)
      .filter((s): s is { kind: 'limited'; until: number } => s.kind === 'limited')
      .map((s) => s.until);
    return Math.min(...untils);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `npx vitest run test/accounts.test.ts && npm run typecheck`
Expected: 6 tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/eventlog.ts src/accounts.ts test/accounts.test.ts
git commit -m "feat: add event log and account registry with limited-state failover pick"
```

---

### Task 3: QuotaPoller

**Files:**
- Create: `src/quota.ts`
- Test: `test/quota.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `WindowUsage = { utilization: number; resetsAt: string }`; `Usage = { fiveHour: WindowUsage; sevenDay: WindowUsage }`; `class TokenExpiredError extends Error`; `fetchUsage(configDir: string, fetchFn?: typeof fetch): Promise<Usage>`. Reads the token from `<configDir>/.credentials.json` at key `claudeAiOauth.accessToken` (F6). Never logs the token.

- [ ] **Step 1: Write the failing test**

`test/quota.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenExpiredError, fetchUsage } from '../src/quota.js';

function configDirWithToken(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'x056-cfg-'));
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return dir;
}

const usageBody = {
  five_hour: { utilization: 62.0, resets_at: '2026-07-04T12:59:59.677980+00:00' },
  seven_day: { utilization: 48.0, resets_at: '2026-07-07T21:00:00.678002+00:00' },
};

describe('fetchUsage', () => {
  it('calls the oauth usage endpoint with the bearer token and maps windows', async () => {
    const dir = configDirWithToken('tok-123');
    let seenUrl = '';
    let seenAuth = '';
    const fakeFetch = (async (url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = String((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify(usageBody), { status: 200 });
    }) as typeof fetch;

    const usage = await fetchUsage(dir, fakeFetch);
    expect(seenUrl).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(seenAuth).toBe('Bearer tok-123');
    expect(usage).toEqual({
      fiveHour: { utilization: 62.0, resetsAt: '2026-07-04T12:59:59.677980+00:00' },
      sevenDay: { utilization: 48.0, resetsAt: '2026-07-07T21:00:00.678002+00:00' },
    });
  });

  it('throws TokenExpiredError on 401', async () => {
    const dir = configDirWithToken('stale');
    const fakeFetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
    await expect(fetchUsage(dir, fakeFetch)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it('throws a plain error on other failures, without the token in the message', async () => {
    const dir = configDirWithToken('sekret');
    const fakeFetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(fetchUsage(dir, fakeFetch)).rejects.toThrow(/500/);
    await expect(fetchUsage(dir, fakeFetch)).rejects.not.toThrow(/sekret/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/quota.test.ts`
Expected: FAIL — cannot resolve `../src/quota.js`.

- [ ] **Step 3: Implement**

`src/quota.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowUsage {
  utilization: number;
  resetsAt: string;
}

export interface Usage {
  fiveHour: WindowUsage;
  sevenDay: WindowUsage;
}

export class TokenExpiredError extends Error {
  constructor() {
    super('OAuth access token expired (401 from usage endpoint)');
  }
}

interface UsageBody {
  five_hour: { utilization: number; resets_at: string };
  seven_day: { utilization: number; resets_at: string };
}

export async function fetchUsage(configDir: string, fetchFn: typeof fetch = fetch): Promise<Usage> {
  const creds = JSON.parse(readFileSync(join(configDir, '.credentials.json'), 'utf8')) as {
    claudeAiOauth?: { accessToken?: string };
  };
  const token = creds.claudeAiOauth?.accessToken;
  if (!token) throw new Error(`no OAuth token in ${configDir}/.credentials.json`);

  const res = await fetchFn('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 401) throw new TokenExpiredError();
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  const body = (await res.json()) as UsageBody;
  return {
    fiveHour: { utilization: body.five_hour.utilization, resetsAt: body.five_hour.resets_at },
    sevenDay: { utilization: body.seven_day.utilization, resetsAt: body.seven_day.resets_at },
  };
}
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `npx vitest run test/quota.test.ts && npm run typecheck`
Expected: 3 tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/quota.ts test/quota.test.ts
git commit -m "feat: add per-account quota fetch via oauth usage endpoint"
```

---

### Task 4: TurnRunner

**Files:**
- Create: `src/turn.ts`, `test/bin/stub-claude` (executable)
- Test: `test/turn.test.ts`

**Interfaces:**
- Consumes: `RawEvent` from `src/types.ts`.
- Produces:
  - `TurnExit = { code: number | null; signal: NodeJS.Signals | null }`
  - `TurnHandle = { kill(): void; interrupt(): void; done: Promise<TurnExit> }`
  - `TurnOptions = { claudePath?: string; configDir: string; cwd: string; sessionId: string; mode: 'new' | 'resume'; prompt: string; onEvent: (e: RawEvent) => void }`
  - `startTurn(opts: TurnOptions): TurnHandle`. Spawns `claudePath ?? 'claude'` with the Global Constraints flag set, `env = { ...process.env, CLAUDE_CONFIG_DIR: configDir }`, parses stdout as NDJSON (non-JSON lines ignored), `kill()` sends SIGKILL, `interrupt()` sends SIGINT.

- [ ] **Step 1: Create the stub executable used by the test**

`test/bin/stub-claude` (then `chmod +x test/bin/stub-claude`):
```bash
#!/usr/bin/env node
// Emits canned NDJSON to exercise startTurn: echoes its argv and config dir
// as events so the test can assert flag construction, then idles 10s so
// kill() is observable. "FAST" in the prompt exits immediately instead.
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'system', subtype: 'init', argv: args, config_dir: process.env.CLAUDE_CONFIG_DIR });
process.stdout.write('this line is not json\n');
emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
if (args[args.length - 1].includes('FAST')) {
  emit({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'done' });
  process.exit(0);
}
setTimeout(() => process.exit(0), 10000);
```

- [ ] **Step 2: Write the failing test**

`test/turn.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { startTurn } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

const STUB = new URL('./bin/stub-claude', import.meta.url).pathname;

function collect(): { events: RawEvent[]; onEvent: (e: RawEvent) => void } {
  const events: RawEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

describe('startTurn', () => {
  it('builds new-session args, passes CLAUDE_CONFIG_DIR, parses NDJSON, skips junk lines', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-1', mode: 'new', prompt: 'FAST task', onEvent,
    });
    const exit = await h.done;
    expect(exit.code).toBe(0);
    const init = events[0] as { argv: string[]; config_dir: string };
    expect(init.config_dir).toBe('/tmp/cfg-a');
    expect(init.argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
      '--session-id', 'sid-1', 'FAST task',
    ]);
    expect(events.map((e) => e.type)).toEqual(['system', 'assistant', 'result']);
  });

  it('builds resume args', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-b', cwd: process.cwd(),
      sessionId: 'sid-2', mode: 'resume', prompt: 'FAST continue', onEvent,
    });
    await h.done;
    const init = events[0] as { argv: string[] };
    expect(init.argv).toContain('--resume');
    expect(init.argv).toContain('sid-2');
    expect(init.argv).not.toContain('--session-id');
  });

  it('kill() terminates a hanging turn with SIGKILL', async () => {
    const { events, onEvent } = collect();
    const h = startTurn({
      claudePath: STUB, configDir: '/tmp/cfg-a', cwd: process.cwd(),
      sessionId: 'sid-3', mode: 'new', prompt: 'slow task', onEvent,
    });
    // wait until the stub has emitted, then kill mid-"turn"
    await new Promise((r) => setTimeout(r, 300));
    h.kill();
    const exit = await h.done;
    expect(exit.signal).toBe('SIGKILL');
    expect(events.length).toBeGreaterThan(0);
  }, 10000);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/turn.test.ts`
Expected: FAIL — cannot resolve `../src/turn.js`.

- [ ] **Step 4: Implement**

`src/turn.ts`:
```ts
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RawEvent } from './types.js';

export interface TurnExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface TurnHandle {
  kill(): void;
  interrupt(): void;
  done: Promise<TurnExit>;
}

export interface TurnOptions {
  claudePath?: string;
  configDir: string;
  cwd: string;
  sessionId: string;
  mode: 'new' | 'resume';
  prompt: string;
  onEvent: (e: RawEvent) => void;
}

export function startTurn(opts: TurnOptions): TurnHandle {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(opts.mode === 'new' ? ['--session-id', opts.sessionId] : ['--resume', opts.sessionId]),
    opts.prompt,
  ];
  const child = spawn(opts.claudePath ?? 'claude', args, {
    cwd: opts.cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim().startsWith('{')) return;
    try {
      opts.onEvent(JSON.parse(line) as RawEvent);
    } catch {
      // partial/garbled line — ignore
    }
  });

  const done = new Promise<TurnExit>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    kill: () => child.kill('SIGKILL'),
    interrupt: () => child.kill('SIGINT'),
    done,
  };
}
```

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `npx vitest run test/turn.test.ts && npm run typecheck`
Expected: 3 tests PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add src/turn.ts test/turn.test.ts test/bin/stub-claude
git commit -m "feat: add turn runner spawning claude -p with ndjson event parsing"
```

---

### Task 5: fake-claude replay binary

**Files:**
- Create: `src/fake-claude.ts`, `test/bin/fake-claude` (executable wrapper)
- Test: `test/fake-claude.test.ts`

**Interfaces:**
- Consumes: nothing (standalone binary).
- Produces: an executable that mimics `claude -p` for tests. Reads a scenario file: `X056_FAKE_SCENARIO` env for new sessions (`--session-id` in argv), `X056_FAKE_SCENARIO_RESUME` when `--resume` is in argv. Scenario = jsonl; each line is one directive:
  - `{"event": {...}}` — write the event to stdout as one NDJSON line
  - `{"delayMs": 100}` — wait
  - `{"exit": 0}` — exit with that code
  - `{"hang": true}` — never exit (until killed)
- Task 7's E2E test relies on exactly this contract.

- [ ] **Step 1: Write the failing test**

`test/fake-claude.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const BIN = new URL('./bin/fake-claude', import.meta.url).pathname;

describe('fake-claude', () => {
  it('replays a scenario file as NDJSON and exits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-fake-'));
    const scenario = join(dir, 's.jsonl');
    writeFileSync(
      scenario,
      [
        JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 's1' } }),
        JSON.stringify({ delayMs: 10 }),
        JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, result: 'ok' } }),
        JSON.stringify({ exit: 0 }),
      ].join('\n'),
    );
    const out = execFileSync(BIN, ['-p', '--session-id', 's1', 'task'], {
      env: { ...process.env, X056_FAKE_SCENARIO: scenario },
      encoding: 'utf8',
    });
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['system', 'result']);
  });

  it('uses the resume scenario when --resume is in argv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-fake-'));
    const resumeScenario = join(dir, 'resume.jsonl');
    writeFileSync(
      resumeScenario,
      [
        JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, result: 'resumed' } }),
        JSON.stringify({ exit: 0 }),
      ].join('\n'),
    );
    const out = execFileSync(BIN, ['-p', '--resume', 's1', 'continue'], {
      env: { ...process.env, X056_FAKE_SCENARIO: '/nonexistent', X056_FAKE_SCENARIO_RESUME: resumeScenario },
      encoding: 'utf8',
    });
    expect(JSON.parse(out.trim()).result).toBe('resumed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/fake-claude.test.ts`
Expected: FAIL — `test/bin/fake-claude` does not exist (ENOENT).

- [ ] **Step 3: Implement**

`src/fake-claude.ts`:
```ts
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const scenarioPath = argv.includes('--resume')
  ? process.env.X056_FAKE_SCENARIO_RESUME
  : process.env.X056_FAKE_SCENARIO;
if (!scenarioPath) {
  process.stderr.write('fake-claude: no scenario env set\n');
  process.exit(2);
}

interface Directive {
  event?: Record<string, unknown>;
  delayMs?: number;
  exit?: number;
  hang?: boolean;
}

const directives: Directive[] = readFileSync(scenarioPath, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l) as Directive);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const d of directives) {
  if (d.event) process.stdout.write(`${JSON.stringify(d.event)}\n`);
  if (d.delayMs) await sleep(d.delayMs);
  if (d.hang) await new Promise(() => {});
  if (d.exit !== undefined) process.exit(d.exit);
}
process.exit(0);
```

`test/bin/fake-claude` (then `chmod +x test/bin/fake-claude`):
```bash
#!/usr/bin/env bash
exec npx tsx "$(dirname "$0")/../../src/fake-claude.ts" "$@"
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `npx vitest run test/fake-claude.test.ts && npm run typecheck`
Expected: 2 tests PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add src/fake-claude.ts test/bin/fake-claude test/fake-claude.test.ts
git commit -m "feat: add fake-claude scenario replay binary for deterministic e2e"
```

---

### Task 6: FailoverController (runSession)

**Files:**
- Create: `src/failover.ts`
- Test: `test/failover.test.ts`

**Interfaces:**
- Consumes: `classifyEvent` (Task 1), `AccountRegistry`/`EventLog` (Task 2), `startTurn`, `TurnHandle`, `TurnOptions`, `TurnExit` (Task 4).
- Produces:
  - `CONTINUE_PROMPT` — the D5 string, exported verbatim.
  - `SessionResult = { status: 'completed' | 'parked' | 'failed'; finalAccount?: string; parkedUntil?: number; failovers: number; resultText?: string }`
  - `RunSessionOptions = { registry: AccountRegistry; log: EventLog; sessionId: string; cwd: string; prompt: string; resume?: boolean; startTurnFn?: typeof startTurn; now?: () => number; maxFailoversPerHour?: number; claudePath?: string; tap?: (e: RawEvent) => void; forceSwitchSignal?: boolean; drainTimeoutMs?: number }`
  - `runSession(opts: RunSessionOptions): Promise<SessionResult>` — the D3/D5/D6/D7 state machine. `tap` receives every raw event (for CLI printing). When `forceSwitchSignal` is true (default true outside tests), a `SIGUSR1` to the process requests a forced switch: drain until the next `user`-type event or `result` (30 s default timeout → interrupt anyway), SIGINT the child, 30-min cooldown on the account, then failover.

- [ ] **Step 1: Write the failing test**

`test/failover.test.ts` — turns are scripted: each fake turn pushes events to `onEvent` then resolves. No real processes.
```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { CONTINUE_PROMPT, runSession } from '../src/failover.js';
import type { TurnHandle, TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

const REJECTED: RawEvent = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: 2000, rateLimitType: 'five_hour' },
};
const SUCCESS: RawEvent = { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'task done' };

interface Recorded {
  configDir: string;
  mode: string;
  prompt: string;
}

/** Builds a startTurn stand-in that replays one scripted event list per call. */
function scriptTurns(script: RawEvent[][], recorded: Recorded[]): (opts: TurnOptions) => TurnHandle {
  let call = 0;
  return (opts: TurnOptions) => {
    recorded.push({ configDir: opts.configDir, mode: opts.mode, prompt: opts.prompt });
    const events = script[call];
    call += 1;
    let killed = false;
    const done = (async () => {
      for (const e of events) {
        if (killed) break;
        opts.onEvent(e);
        await new Promise((r) => setTimeout(r, 1));
      }
      return { code: killed ? null : 0, signal: killed ? ('SIGKILL' as const) : null };
    })();
    return { kill: () => { killed = true; }, interrupt: () => { killed = true; }, done };
  };
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'x056-fo-'));
  const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
    { name: 'a', configDir: '/cfg/a' },
    { name: 'b', configDir: '/cfg/b' },
  ]);
  const log = new EventLog(join(dir, 'events.jsonl'));
  return { registry, log };
}

const base = { sessionId: 'sid-x', cwd: '/tmp', prompt: 'build the thing', forceSwitchSignal: false };

describe('runSession', () => {
  it('completes on the first account when no limit hits', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: scriptTurns([[SUCCESS]], recorded),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'a', failovers: 0, resultText: 'task done' });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ configDir: '/cfg/a', mode: 'new', prompt: 'build the thing' });
  });

  it('fails over to b on a rejected rate_limit_event and resumes with CONTINUE_PROMPT', async () => {
    const { registry, log } = fixtures();
    const recorded: Recorded[] = [];
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: scriptTurns([[REJECTED], [SUCCESS]], recorded),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1 });
    expect(recorded[1]).toMatchObject({ configDir: '/cfg/b', mode: 'resume', prompt: CONTINUE_PROMPT });
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 2000 });
    const types = log.read().map((r) => r.type);
    expect(types).toContain('limit_detected');
    expect(types).toContain('failover');
  });

  it('parks when both accounts are limited, with the earliest reset', async () => {
    const { registry, log } = fixtures();
    const res = await runSession({
      ...base, registry, log, now: () => 100,
      startTurnFn: scriptTurns([[REJECTED], [{ ...REJECTED, rate_limit_info: { status: 'rejected', resetsAt: 1500 } }]], []),
    });
    expect(res).toMatchObject({ status: 'parked', parkedUntil: 1500, failovers: 2 });
  });

  it('trips the flap guard after more than 3 failovers in an hour', async () => {
    const { registry, log } = fixtures();
    // accounts recover instantly: resetsAt in the past, so pickActive always finds one
    const INSTANT: RawEvent = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1 } };
    const res = await runSession({
      ...base, registry, log, now: () => 100, maxFailoversPerHour: 3,
      startTurnFn: scriptTurns([[INSTANT], [INSTANT], [INSTANT], [INSTANT], [SUCCESS]], []),
    });
    expect(res.status).toBe('failed');
    expect(res.failovers).toBe(4);
    expect(log.read().map((r) => r.type)).toContain('flap_guard_tripped');
  });

  it('uses now+5h fallback when the limit signal has no resetsAt', async () => {
    const { registry, log } = fixtures();
    const NO_RESET: RawEvent = { type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429 };
    await runSession({
      ...base, registry, log, now: () => 1000,
      startTurnFn: scriptTurns([[NO_RESET], [SUCCESS]], []),
    });
    expect(registry.get('a').state).toEqual({ kind: 'limited', until: 1000 + 5 * 3600 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/failover.test.ts`
Expected: FAIL — cannot resolve `../src/failover.js`.

- [ ] **Step 3: Implement**

`src/failover.ts`:
```ts
import type { AccountRegistry } from './accounts.js';
import { classifyEvent } from './detector.js';
import type { EventLog } from './eventlog.js';
import { startTurn } from './turn.js';
import type { RawEvent, Verdict } from './types.js';

export const CONTINUE_PROMPT =
  'Continue exactly where you left off. If your last action was a command or edit that may have partially applied, verify its actual effect before re-running anything with side effects.';

export interface SessionResult {
  status: 'completed' | 'parked' | 'failed';
  finalAccount?: string;
  parkedUntil?: number;
  failovers: number;
  resultText?: string;
}

export interface RunSessionOptions {
  registry: AccountRegistry;
  log: EventLog;
  sessionId: string;
  cwd: string;
  prompt: string;
  resume?: boolean;
  startTurnFn?: typeof startTurn;
  now?: () => number;
  maxFailoversPerHour?: number;
  claudePath?: string;
  tap?: (e: RawEvent) => void;
  forceSwitchSignal?: boolean;
  drainTimeoutMs?: number;
}

const FIVE_HOURS = 5 * 3600;
const FORCED_COOLDOWN = 30 * 60;

export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  const { registry, log, sessionId, cwd } = opts;
  const startTurnFn = opts.startTurnFn ?? startTurn;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxPerHour = opts.maxFailoversPerHour ?? 3;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
  const failoverTimes: number[] = [];

  let mode: 'new' | 'resume' = opts.resume ? 'resume' : 'new';
  let prompt = opts.prompt;
  let forceSwitchRequested = false;
  const onSigusr1 = () => {
    forceSwitchRequested = true;
  };
  if (opts.forceSwitchSignal !== false) process.on('SIGUSR1', onSigusr1);

  try {
    for (;;) {
      const account = registry.pickActive(now());
      if (!account) {
        const until = registry.earliestReset();
        log.append({ type: 'parked', sessionId, until });
        return { status: 'parked', parkedUntil: until, failovers: failoverTimes.length };
      }

      const state = {
        limited: null as Verdict | null,
        forced: false,
        resultText: undefined as string | undefined,
        resultOk: false,
        drainTimer: null as NodeJS.Timeout | null,
      };

      const handle = startTurnFn({
        claudePath: opts.claudePath,
        configDir: account.configDir,
        cwd,
        sessionId,
        mode,
        prompt,
        onEvent: (e) => {
          opts.tap?.(e);
          const v = classifyEvent(e);
          if (v.kind === 'limited' && !state.limited && !state.forced) {
            state.limited = v;
            log.append({ type: 'limit_detected', sessionId, account: account.name, source: v.source, resetsAt: v.resetsAt ?? null });
            handle.kill();
            return;
          }
          if (v.kind === 'warning') {
            log.append({ type: 'quota_warning', sessionId, account: account.name, resetsAt: v.resetsAt ?? null });
          }
          if (e.type === 'result' && e.is_error === false) {
            state.resultOk = true;
            state.resultText = typeof e.result === 'string' ? e.result : undefined;
          }
          // forced switch: drain until a tool-result-bearing user event or the result event (D7)
          if (forceSwitchRequested && !state.forced && !state.limited && (e.type === 'user' || e.type === 'result')) {
            state.forced = true;
            log.append({ type: 'forced_switch', sessionId, account: account.name });
            handle.interrupt();
          }
        },
      });

      // forced-switch hard timeout: if requested but nothing drainable arrives, interrupt anyway
      const drainWatch = setInterval(() => {
        if (forceSwitchRequested && !state.forced && !state.limited && state.drainTimer === null) {
          state.drainTimer = setTimeout(() => {
            if (!state.forced && !state.limited) {
              state.forced = true;
              log.append({ type: 'forced_switch_timeout', sessionId, account: account.name });
              handle.interrupt();
            }
          }, drainTimeoutMs);
        }
      }, 100);

      await handle.done;
      clearInterval(drainWatch);
      if (state.drainTimer) clearTimeout(state.drainTimer);

      if (!state.limited && !state.forced) {
        if (state.resultOk) {
          log.append({ type: 'turn_completed', sessionId, account: account.name });
          return { status: 'completed', finalAccount: account.name, failovers: failoverTimes.length, resultText: state.resultText };
        }
        log.append({ type: 'turn_failed', sessionId, account: account.name });
        return { status: 'failed', finalAccount: account.name, failovers: failoverTimes.length };
      }

      // failover path (limit or forced)
      if (state.limited) {
        registry.markLimited(account.name, state.limited.resetsAt ?? now() + FIVE_HOURS);
      } else {
        forceSwitchRequested = false;
        registry.markLimited(account.name, now() + FORCED_COOLDOWN);
      }
      failoverTimes.push(now());
      const recent = failoverTimes.filter((t) => t > now() - 3600);
      if (recent.length > maxPerHour) {
        log.append({ type: 'flap_guard_tripped', sessionId });
        return { status: 'failed', failovers: failoverTimes.length };
      }
      log.append({ type: 'failover', sessionId, from: account.name });
      mode = 'resume';
      prompt = CONTINUE_PROMPT;
    }
  } finally {
    if (opts.forceSwitchSignal !== false) process.off('SIGUSR1', onSigusr1);
  }
}
```

- [ ] **Step 4: Run tests + typecheck, verify pass**

Run: `npx vitest run test/failover.test.ts && npm run typecheck`
Expected: 5 tests PASS; tsc clean.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: all tests from Tasks 1–6 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/failover.ts test/failover.test.ts
git commit -m "feat: add failover session state machine with guards and forced switch"
```

---

### Task 7: CLI + deterministic E2E

**Files:**
- Create: `src/cli.ts`
- Test: `test/e2e.test.ts`

**Interfaces:**
- Consumes: everything above. `runSession`, `AccountRegistry`, `EventLog`, `fetchUsage`, `fake-claude` contract (Task 5).
- Produces: `npm run x056 -- <command>` with commands:
  - `init` — create `state/accounts.json` for `~/.claude-x056-a` / `-b`
  - `run "<task>"` — new session (random UUID), saves `{ lastSessionId }` to `state/state.json`, writes own pid to `state/x056.pid`, prints assistant text + result, exit 0 on `completed`, 3 on `parked`, 1 on `failed`
  - `continue "<msg>"` — `runSession` with `resume: true` on `lastSessionId`
  - `status` — table: per account name/state + live utilization (quota fetch; prints `quota: unavailable (<reason>)` on error)
  - `switch` — sends SIGUSR1 to the pid in `state/x056.pid`
  - Env override `X056_CLAUDE_PATH` → `claudePath` (E2E uses `test/bin/fake-claude`).

- [ ] **Step 1: Write the failing E2E test**

`test/e2e.test.ts` — full failover loop through the real `runSession` + real `startTurn` + fake-claude binary:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';
import { CONTINUE_PROMPT, runSession } from '../src/failover.js';

const FAKE = new URL('./bin/fake-claude', import.meta.url).pathname;

describe('e2e: failover across accounts via fake-claude', () => {
  it('detects the limit on A, kills the turn, resumes on B, completes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-e2e-'));

    // Account A's turn: init, some work, then the CLI starts retrying a quota 429 and hangs.
    // The supervisor must kill it (kill-on-first-signal, D3) — the scenario never exits by itself.
    const scenarioA = join(dir, 'a.jsonl');
    writeFileSync(
      scenarioA,
      [
        JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'e2e-sid' } }),
        JSON.stringify({ event: { type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } } }),
        JSON.stringify({ delayMs: 20 }),
        JSON.stringify({ event: { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 1000, error_status: 429, error: 'rate_limit' } }),
        JSON.stringify({ hang: true }),
      ].join('\n'),
    );

    // Account B's resume turn: completes the task.
    const scenarioB = join(dir, 'b.jsonl');
    writeFileSync(
      scenarioB,
      [
        JSON.stringify({ event: { type: 'system', subtype: 'init', session_id: 'e2e-sid' } }),
        JSON.stringify({ event: { type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'finished on b' } }),
        JSON.stringify({ exit: 0 }),
      ].join('\n'),
    );

    process.env.X056_FAKE_SCENARIO = scenarioA;
    process.env.X056_FAKE_SCENARIO_RESUME = scenarioB;

    const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'a', configDir: join(dir, 'cfg-a') },
      { name: 'b', configDir: join(dir, 'cfg-b') },
    ]);
    const log = new EventLog(join(dir, 'events.jsonl'));
    const prompts: string[] = [];

    const res = await runSession({
      registry, log,
      sessionId: 'e2e-sid', cwd: dir, prompt: 'do the task',
      claudePath: FAKE, forceSwitchSignal: false,
      tap: () => {},
      startTurnFn: undefined, now: () => 100,
    });

    expect(res).toMatchObject({ status: 'completed', finalAccount: 'b', failovers: 1, resultText: 'finished on b' });
    expect(registry.get('a').state.kind).toBe('limited');
    const types = log.read().map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(['limit_detected', 'failover', 'turn_completed']));
  }, 15000);
});
```
(The `prompts` array above is unused scaffolding-avoidance — remove it when writing the file if the linter flags it; the assertion on the resume prompt lives in Task 6's unit tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/e2e.test.ts`
Expected: FAIL only if Tasks 1–6 are incomplete; with them in place this test PASSES immediately — it exercises existing modules plus the fake binary. If it passes, treat this step as the verification gate and move on.

- [ ] **Step 3: Implement the CLI**

`src/cli.ts`:
```ts
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AccountRegistry } from './accounts.js';
import { EventLog } from './eventlog.js';
import { runSession } from './failover.js';
import { fetchUsage } from './quota.js';
import type { RawEvent } from './types.js';

const STATE_DIR = join(process.cwd(), 'state');
const ACCOUNTS = join(STATE_DIR, 'accounts.json');
const STATE = join(STATE_DIR, 'state.json');
const PIDFILE = join(STATE_DIR, 'x056.pid');
const LOG = join(STATE_DIR, 'events.jsonl');

function printEvent(e: RawEvent): void {
  if (e.type === 'assistant') {
    const msg = e.message as { content?: { type: string; text?: string }[] } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type === 'text' && block.text) process.stdout.write(`\n${block.text}\n`);
    }
  }
}

function loadState(): { lastSessionId?: string } {
  return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as { lastSessionId?: string }) : {};
}

async function main(): Promise<number> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [command, arg] = positionals;

  if (command === 'init') {
    mkdirSync(STATE_DIR, { recursive: true });
    AccountRegistry.init(ACCOUNTS, [
      { name: 'a', configDir: join(homedir(), '.claude-x056-a') },
      { name: 'b', configDir: join(homedir(), '.claude-x056-b') },
    ]);
    console.log(`wrote ${ACCOUNTS}`);
    return 0;
  }

  if (command === 'status') {
    const registry = AccountRegistry.load(ACCOUNTS);
    for (const acct of registry.list()) {
      let quota = '';
      try {
        const u = await fetchUsage(acct.configDir);
        quota = `5h ${u.fiveHour.utilization}% (resets ${u.fiveHour.resetsAt}) · 7d ${u.sevenDay.utilization}%`;
      } catch (err) {
        quota = `quota: unavailable (${(err as Error).message})`;
      }
      console.log(`${acct.name}  ${JSON.stringify(acct.state)}  ${quota}`);
    }
    return 0;
  }

  if (command === 'switch') {
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
    process.kill(pid, 'SIGUSR1');
    console.log(`sent SIGUSR1 to ${pid}`);
    return 0;
  }

  if (command === 'run' || command === 'continue') {
    if (!arg) {
      console.error(`usage: x056 ${command} "<text>"`);
      return 2;
    }
    const registry = AccountRegistry.load(ACCOUNTS);
    const log = new EventLog(LOG);
    const resume = command === 'continue';
    const sessionId = resume
      ? (loadState().lastSessionId ?? (() => { throw new Error('no previous session — use run'); })())
      : randomUUID();
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ lastSessionId: sessionId }));
    writeFileSync(PIDFILE, String(process.pid));

    const res = await runSession({
      registry, log, sessionId,
      cwd: process.cwd(), prompt: arg, resume,
      claudePath: process.env.X056_CLAUDE_PATH,
      tap: printEvent,
    });
    console.log(`\n[x056] ${res.status} · account=${res.finalAccount ?? '-'} · failovers=${res.failovers}` +
      (res.parkedUntil ? ` · parked until ${new Date(res.parkedUntil * 1000).toISOString()}` : ''));
    if (res.resultText) console.log(res.resultText);
    return res.status === 'completed' ? 0 : res.status === 'parked' ? 3 : 1;
  }

  console.error('usage: x056 <init|run|continue|status|switch> [text]');
  return 2;
}

process.exit(await main());
```

- [ ] **Step 4: Run full suite + typecheck + CLI smoke against fake-claude**

Run: `npm test && npm run typecheck`
Expected: all tests PASS; tsc clean.

Smoke (uses Task 7 Step 1's scenario files — recreate two files in `/tmp` the same way, then):
```bash
cd /home/efran/remote-development/x056-remote-control
npm run x056 -- init
X056_CLAUDE_PATH=test/bin/fake-claude X056_FAKE_SCENARIO=/tmp/a.jsonl X056_FAKE_SCENARIO_RESUME=/tmp/b.jsonl npm run x056 -- run "demo task"
```
Expected output: "working on it", then `[x056] completed · account=b · failovers=1`, exit code 0, and `state/events.jsonl` containing `limit_detected` → `failover` → `turn_completed`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/e2e.test.ts
git commit -m "feat: add x056 cli and deterministic failover e2e via fake-claude"
```

---

### Task 8: Account setup + live drill (BLOCKED until both OAuth logins exist)

**Files:**
- Create: `scripts/setup-accounts.sh`, `scripts/drill-forced-switch.md`

**Interfaces:**
- Consumes: `x056 init/status` (Task 7); requires `~/.claude-x056-a/.credentials.json` and `~/.claude-x056-b/.credentials.json` to exist (user runs `CLAUDE_CONFIG_DIR=$HOME/.claude-x056-a claude /login` and the `-b` twin — one browser OAuth each).
- Produces: verified two-account setup + the spec §5.3 forced-switch drill procedure.

- [ ] **Step 1: Write the setup script**

`scripts/setup-accounts.sh` (then `chmod +x scripts/setup-accounts.sh`):
```bash
#!/usr/bin/env bash
set -euo pipefail
A="$HOME/.claude-x056-a"; B="$HOME/.claude-x056-b"
for d in "$A" "$B"; do
  [ -f "$d/.credentials.json" ] || { echo "MISSING login: CLAUDE_CONFIG_DIR=$d claude /login"; exit 1; }
done
mkdir -p "$A/projects"
# D2: one canonical transcript tree, account B reads/writes A's
if [ ! -e "$B/projects" ]; then ln -s "$A/projects" "$B/projects"; fi
[ "$(readlink -f "$B/projects")" = "$(readlink -f "$A/projects")" ] || { echo "B projects is not the shared tree"; exit 1; }
npm run x056 -- init
npm run x056 -- status
echo "setup OK"
```

- [ ] **Step 2: Run it**

Run: `bash scripts/setup-accounts.sh`
Expected: both accounts listed by `status` with live 5h/7d utilization percentages (proves both tokens work). If it prints `MISSING login`, stop — the user must complete the logins first.

- [ ] **Step 3: Write the drill doc**

`scripts/drill-forced-switch.md`:
```markdown
# Forced-switch drill (spec §5.3)

Proves a real mid-task account switch produces one continuous transcript.

1. Terminal 1: `npm run x056 -- run "Create numbered files one.txt through five.txt in /tmp/x056-drill, one per Bash command, sleeping 5s between each via a background-safe wait, then list the directory."`
2. Terminal 2, while files are still appearing: `npm run x056 -- switch`
3. Expect in terminal 1: a `forced_switch` event, then the session resuming on account b and completing.
4. Verify: `ls /tmp/x056-drill` shows all five files exactly once (no duplicates — D5 prompt working); `state/events.jsonl` shows `forced_switch` → `failover` → `turn_completed`; the transcript under `~/.claude-x056-a/projects/` for this session contains entries from both runs.
5. Live-limit validation (spec §5.4) happens opportunistically at the next real 5h limit: expect `limit_detected` with `source: rate_limit_event|api_retry` and automatic continuation on b within ~60 s.
```

- [ ] **Step 4: Upload the new markdown per CLAUDE.md**

Run: `curl -F "file=@scripts/drill-forced-switch.md" https://x056.think.val.id/upload`
Expected: a rendered URL — include it in the task report.

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-accounts.sh scripts/drill-forced-switch.md
git commit -m "feat: add account setup verification and forced-switch drill"
```

---

## Self-Review (performed at plan time)

- **Spec coverage:** D1/D3 → Tasks 4+6; D2 → Task 8; D4 → Task 4 flag list; D5 → Task 6 (`CONTINUE_PROMPT` verbatim + drill step 4); D6 → Task 6 guards/parking; D7 → Task 6 forced-switch + Task 8 drill; F6 quota → Task 3 + `status`; §5.1 fixtures → Task 1; §5.2 fake-claude → Tasks 5+7; §5.3 drill → Task 8; §5.4 live validation → drill doc step 5. QuotaPoller's 401-refresh-via-haiku-spawn is deliberately deferred: v1 surfaces `TokenExpiredError` in `status` output (tokens refresh whenever the CLI runs under that dir anyway) — YAGNI until observed in practice.
- **Placeholders:** none — every code step contains the full file content.
- **Type consistency:** `Verdict`/`RawEvent` (Task 1) used by Tasks 4/6; `TurnHandle/TurnOptions/TurnExit` shapes match between Tasks 4, 6 (scriptTurns), and 7; `AccountState.kind==='limited'` uses `until` everywhere; `runSession` option names match between Tasks 6 and 7.
