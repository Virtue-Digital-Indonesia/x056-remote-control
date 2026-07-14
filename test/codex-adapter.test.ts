import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { codexAdapter, captureSessionId, classifyCodexEvent } from '../src/adapters/codex.js';
import { EventLog } from '../src/eventlog.js';
import { runSession } from '../src/failover.js';
import type { TurnHandle, TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

// These events use the REAL codex-cli 0.144.3 `exec --json` shape: flat objects
// with dotted `type` names, tool activity as thread ITEMS, terminal turn.failed
// carrying a structured reason code. (Captured from a live unauth run + the
// binary's serde tags; see the adapter header.)

describe('classifyCodexEvent', () => {
  it('flags turn.failed with the usage_limit_exceeded code as limited (the ChatGPT-plan limit)', () => {
    const e = { type: 'turn.failed', error: { code: 'usage_limit_exceeded', message: "You've hit your usage limit." } };
    expect(classifyCodexEvent(e)).toEqual({ kind: 'limited', resetsInSeconds: undefined, source: 'codex_turn_failed' });
  });

  it('reads a relative reset off rate_limits.primary when present', () => {
    const e = { type: 'turn.failed', error: { code: 'usage_limit_exceeded' }, rate_limits: { primary: { resets_in_seconds: 1800 } } };
    expect(classifyCodexEvent(e)).toEqual({ kind: 'limited', resetsInSeconds: 1800, source: 'codex_turn_failed' });
  });

  it('classifies a limit by message text even without a code', () => {
    const e = { type: 'turn.failed', error: { message: 'rate limit reached, try again later' } };
    expect(classifyCodexEvent(e).kind).toBe('limited');
  });

  it('flags a 401/not-logged-in turn.failure as auth_required, never limited', () => {
    const e = { type: 'turn.failed', error: { message: '401 Unauthorized: Missing bearer authentication' } };
    expect(classifyCodexEvent(e)).toEqual({ kind: 'auth_required', source: 'codex_turn_failed' });
  });

  it('does NOT treat context_window_exceeded as a failover-worthy limit', () => {
    const e = { type: 'turn.failed', error: { code: 'context_window_exceeded', message: 'context window exceeded' } };
    expect(classifyCodexEvent(e).kind).toBe('irrelevant');
  });

  it('treats pre-terminal reconnect chatter (top-level error) as transient, not a limit', () => {
    const e = { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized ...)' };
    expect(classifyCodexEvent(e)).toEqual({ kind: 'transient', source: 'codex_reconnect' });
  });

  it('treats turn.completed at/over 100% usage as a near-limit warning', () => {
    const e = { type: 'turn.completed', rate_limits: { primary: { used_percent: 100, resets_in_seconds: 90 } } };
    expect(classifyCodexEvent(e)).toEqual({ kind: 'warning', resetsInSeconds: 90, source: 'codex_rate_limits' });
  });

  it('ignores ordinary lifecycle events', () => {
    expect(classifyCodexEvent({ type: 'thread.started', thread_id: 'x' }).kind).toBe('irrelevant');
    expect(classifyCodexEvent({ type: 'turn.started' }).kind).toBe('irrelevant');
    expect(classifyCodexEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }).kind).toBe('irrelevant');
  });
});

describe('captureSessionId', () => {
  it('pulls the codex-assigned thread id from thread.started', () => {
    expect(captureSessionId({ type: 'thread.started', thread_id: '019f5cac-7eee-74b1' })).toBe('019f5cac-7eee-74b1');
    expect(captureSessionId({ type: 'turn.started' })).toBe('');
  });
});

describe('codexAdapter result + drain-boundary detection', () => {
  it('recognizes turn.completed as the successful result', () => {
    expect(codexAdapter.isResult({ type: 'turn.completed' })).toBe(true);
    expect(codexAdapter.resultOk({ type: 'turn.completed' })).toBe(true);
    expect(codexAdapter.isResult({ type: 'item.completed', item: { type: 'agent_message' } })).toBe(false);
  });

  it('drains on a completed item or the completed turn, not on mid-stream events', () => {
    expect(codexAdapter.isDrainBoundary({ type: 'item.completed', item: { type: 'command_execution' } })).toBe(true);
    expect(codexAdapter.isDrainBoundary({ type: 'turn.completed' })).toBe(true);
    expect(codexAdapter.isDrainBoundary({ type: 'item.started', item: { type: 'command_execution' } })).toBe(false);
    expect(codexAdapter.isDrainBoundary({ type: 'turn.started' })).toBe(false);
  });
});

describe('codexAdapter.toActivity', () => {
  it('maps a command_execution item start→completed to Bash start + done rows keyed by item id', () => {
    const begin = codexAdapter.toActivity({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: ['bash', '-lc', 'npm test'] } });
    expect(begin).toEqual([{ toolUseId: 'i1', parentToolUseId: null, tool: 'Bash', label: 'Running: bash -lc npm test', status: 'start', isSubagent: false }]);
    const ok = codexAdapter.toActivity({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 0 } });
    expect(ok[0]).toMatchObject({ toolUseId: 'i1', status: 'done' });
    const bad = codexAdapter.toActivity({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 1 } });
    expect(bad[0]).toMatchObject({ status: 'error' });
  });

  it('maps a file_change item to an Edit row labeled by the changed file', () => {
    const rows = codexAdapter.toActivity({ type: 'item.started', item: { id: 'p1', type: 'file_change', changes: [{ path: 'src/foo.ts' }, { path: 'src/bar.ts' }] } });
    expect(rows[0]).toMatchObject({ tool: 'Edit', label: 'Editing foo.ts (+1)', status: 'start' });
  });

  it('emits nothing for text items (agent_message, reasoning) and lifecycle events', () => {
    expect(codexAdapter.toActivity({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })).toEqual([]);
    expect(codexAdapter.toActivity({ type: 'turn.completed' })).toEqual([]);
  });
});

describe('codexAdapter.readIdentity', () => {
  it('extracts the email from the ChatGPT id_token JWT in auth.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-codexid-'));
    const payload = Buffer.from(JSON.stringify({ email: 'dev@example.com', name: 'Dev' })).toString('base64url');
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: `e30.${payload}.sig` } }));
    expect(codexAdapter.readIdentity(dir)).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
  });

  it('returns {} when there is no auth.json', () => {
    expect(codexAdapter.readIdentity(mkdtempSync(join(tmpdir(), 'x056-codexid-')))).toEqual({});
  });
});

// Replay of the ACTUAL authenticated stream captured from codex-cli 0.144.3
// (agent_message → command_execution → turn.completed), asserting the adapter
// reads the real field shapes, not just my synthetic ones.
describe('codexAdapter against the real captured authed stream', () => {
  const stream: RawEvent[] = [
    { type: 'thread.started', thread_id: '019f5ffe-867a-7e91-b667-bd2a62578c36' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'I’ll run the requested command now.' } },
    { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: "/bin/sh -lc 'echo x056-probe-ok'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "/bin/sh -lc 'echo x056-probe-ok'", aggregated_output: 'x056-probe-ok\n', exit_code: 0, status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'DONE' } },
    { type: 'turn.completed', usage: { input_tokens: 23734, cached_input_tokens: 19968, output_tokens: 76, reasoning_output_tokens: 0 } },
  ];

  it('captures the thread id, streams the real agent_message text, and maps the command item', () => {
    expect(captureSessionId(stream[0])).toBe('019f5ffe-867a-7e91-b667-bd2a62578c36');
    // agent_message text (field `text`, arriving as item.completed)
    expect(codexAdapter.assistantText?.(stream[2])).toEqual(['I’ll run the requested command now.']);
    expect(codexAdapter.assistantText?.(stream[5])).toEqual(['DONE']);
    // command_execution: string command → start row, then done on exit_code 0
    expect(codexAdapter.toActivity(stream[3])).toEqual([
      { toolUseId: 'item_1', parentToolUseId: null, tool: 'Bash', label: "Running: /bin/sh -lc 'echo x056-probe-ok'", status: 'start', isSubagent: false },
    ]);
    expect(codexAdapter.toActivity(stream[4])[0]).toMatchObject({ toolUseId: 'item_1', status: 'done' });
    // turn.completed is the terminal success; no rate_limits present → no warning
    expect(codexAdapter.isResult(stream[6])).toBe(true);
    expect(codexAdapter.classify(stream[6]).kind).toBe('irrelevant');
    // no spurious activity/limit from lifecycle events
    expect(codexAdapter.classify(stream[0]).kind).toBe('irrelevant');
  });
});

// End-to-end: the real codexAdapter drives a full failover through runSession
// using real-shaped codex events — the transient reconnect must NOT trigger it;
// only turn.failed(usage_limit_exceeded) does.
describe('runSession with the real codexAdapter', () => {
  function scriptTurns(script: RawEvent[][], recorded: { mode: string; prompt: string; sessionId: string }[]) {
    let call = 0;
    return (opts: TurnOptions): TurnHandle => {
      recorded.push({ mode: opts.mode, prompt: opts.prompt, sessionId: opts.sessionId });
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

  it('ignores reconnect chatter but fails over on turn.failed(usage_limit_exceeded), honoring the reset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-codexfo-'));
    const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'xa', configDir: '/cfg/xa', provider: 'codex' },
      { name: 'xb', configDir: '/cfg/xb', provider: 'codex' },
    ]);
    const log = new EventLog(join(dir, 'events.jsonl'));
    const recorded: { mode: string; prompt: string; sessionId: string }[] = [];
    const res = await runSession({
      sessionId: 'cx-internal-key', cwd: '/tmp', prompt: 'ship it', forceSwitchSignal: false,
      registry, log, now: () => 100, adapter: codexAdapter,
      startTurnFn: scriptTurns(
        [
          [
            { type: 'thread.started', thread_id: 't-CODEX-99' }, // codex assigns this id
            { type: 'turn.started' },
            { type: 'error', message: 'Reconnecting... 1/5 (401)' }, // must NOT trigger failover
            { type: 'turn.failed', error: { code: 'usage_limit_exceeded' }, rate_limits: { primary: { resets_in_seconds: 300 } } },
          ],
          [
            { type: 'turn.completed' },
          ],
        ],
        recorded,
      ),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'xb', failovers: 1, providerSessionId: 't-CODEX-99' });
    // The NEW turn got the manager's key (codex ignores it and assigns its own);
    // the RESUME turn got the CAPTURED codex thread id, so it continues the same
    // thread on the other account — the crux of codex failover.
    expect(recorded[0]).toMatchObject({ mode: 'new', sessionId: 'cx-internal-key' });
    expect(recorded[1]).toMatchObject({ mode: 'resume', prompt: codexAdapter.continuePrompt, sessionId: 't-CODEX-99' });
    expect(registry.get('xa').state).toEqual({ kind: 'limited', until: 400 }); // now(100) + 300
    expect(log.read().map((r) => r.type)).toContain('failover');
  });
});
