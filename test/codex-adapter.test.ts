import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { classifyCodexEvent } from '../src/adapters/codex.js';
import { EventLog } from '../src/eventlog.js';
import { runSession } from '../src/failover.js';
import type { TurnHandle, TurnOptions } from '../src/turn.js';
import type { RawEvent } from '../src/types.js';

// Codex wraps each event as { id, msg: { type, ... } }. Helper to build one; a
// few tests also pass the flat form to prove the adapter tolerates both.
const wrap = (msg: Record<string, unknown>): RawEvent => ({ id: '0', msg });

describe('classifyCodexEvent', () => {
  it('flags a terminal error whose text looks like a usage limit as limited, with a RELATIVE reset from rate_limits', () => {
    const e = wrap({ type: 'error', message: "You've hit your usage limit.", rate_limits: { primary: { resets_in_seconds: 3600 } } });
    expect(classifyCodexEvent(e)).toEqual({ kind: 'limited', resetsInSeconds: 3600, source: 'codex_error' });
  });

  it('flags a limit error with NO structured reset as limited with no reset (failover then estimates a cooldown)', () => {
    const e = wrap({ type: 'error', message: 'rate limit reached, try again later' });
    expect(classifyCodexEvent(e)).toEqual({ kind: 'limited', resetsInSeconds: undefined, source: 'codex_error' });
  });

  it('flags a "not logged in" error as auth_required, never limited', () => {
    const e = wrap({ type: 'error', message: 'Not logged in. Please run codex login.' });
    expect(classifyCodexEvent(e)).toEqual({ kind: 'auth_required', source: 'codex_error' });
  });

  it('treats an unrelated error as irrelevant (not a failover trigger)', () => {
    const e = wrap({ type: 'error', message: 'file not found: foo.ts' });
    expect(classifyCodexEvent(e).kind).toBe('irrelevant');
  });

  it('handles a typed rate_limit_exceeded event', () => {
    const e = wrap({ type: 'rate_limit_exceeded', rate_limits: { primary: { resets_in_seconds: 120 } } });
    expect(classifyCodexEvent(e)).toEqual({ kind: 'limited', resetsInSeconds: 120, source: 'codex_rate_limit' });
  });

  it('treats a token_count at/over 100% as a near-limit warning', () => {
    const e = wrap({ type: 'token_count', rate_limits: { primary: { used_percent: 100, resets_in_seconds: 60 } } });
    expect(classifyCodexEvent(e)).toEqual({ kind: 'warning', resetsInSeconds: 60, source: 'codex_token_count' });
  });

  it('treats a token_count under 100% as irrelevant', () => {
    expect(classifyCodexEvent(wrap({ type: 'token_count', rate_limits: { primary: { used_percent: 42 } } })).kind).toBe('irrelevant');
  });

  it('tolerates the FLAT event form (type at top level, no msg envelope)', () => {
    expect(classifyCodexEvent({ type: 'error', message: 'usage limit' } as RawEvent).kind).toBe('limited');
    expect(classifyCodexEvent({ type: 'agent_message', message: 'hello' } as RawEvent).kind).toBe('irrelevant');
  });
});

describe('codexAdapter result + drain-boundary detection', () => {
  it('recognizes task_complete as a successful result and reads last_agent_message', () => {
    const e = wrap({ type: 'task_complete', last_agent_message: 'All done, tests pass.' });
    expect(codexAdapter.isResult(e)).toBe(true);
    expect(codexAdapter.resultOk(e)).toBe(true);
    expect(codexAdapter.resultText(e)).toBe('All done, tests pass.');
  });

  it('does not treat an agent_message as a result', () => {
    expect(codexAdapter.isResult(wrap({ type: 'agent_message', message: 'thinking...' }))).toBe(false);
  });

  it('drains on a closed tool round or completion, not on mid-stream chatter', () => {
    expect(codexAdapter.isDrainBoundary(wrap({ type: 'exec_command_end', exit_code: 0 }))).toBe(true);
    expect(codexAdapter.isDrainBoundary(wrap({ type: 'patch_apply_end', success: true }))).toBe(true);
    expect(codexAdapter.isDrainBoundary(wrap({ type: 'task_complete' }))).toBe(true);
    expect(codexAdapter.isDrainBoundary(wrap({ type: 'agent_message', message: 'x' }))).toBe(false);
  });
});

describe('codexAdapter.toActivity', () => {
  it('maps a shell command begin/end to start + done rows keyed by call_id', () => {
    const begin = codexAdapter.toActivity(wrap({ type: 'exec_command_begin', call_id: 'c1', command: ['bash', '-lc', 'npm test'] }));
    expect(begin).toEqual([{ toolUseId: 'c1', parentToolUseId: null, tool: 'Bash', label: 'Running: bash -lc npm test', status: 'start', isSubagent: false }]);
    const end = codexAdapter.toActivity(wrap({ type: 'exec_command_end', call_id: 'c1', exit_code: 0 }));
    expect(end[0]).toMatchObject({ toolUseId: 'c1', status: 'done' });
    const failed = codexAdapter.toActivity(wrap({ type: 'exec_command_end', call_id: 'c1', exit_code: 1 }));
    expect(failed[0]).toMatchObject({ status: 'error' });
  });

  it('maps a patch apply to an Edit row labeled by the changed file', () => {
    const rows = codexAdapter.toActivity(wrap({ type: 'patch_apply_begin', call_id: 'p1', changes: { 'src/foo.ts': {}, 'src/bar.ts': {} } }));
    expect(rows[0]).toMatchObject({ tool: 'Edit', label: 'Editing foo.ts (+1)', status: 'start' });
  });

  it('emits nothing for events that aren\'t tool activity', () => {
    expect(codexAdapter.toActivity(wrap({ type: 'agent_message', message: 'hi' }))).toEqual([]);
  });
});

describe('codexAdapter.readIdentity', () => {
  it('extracts the email from the ChatGPT id_token JWT in auth.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-codexid-'));
    const payload = Buffer.from(JSON.stringify({ email: 'dev@example.com', name: 'Dev' })).toString('base64url');
    const idToken = `e30.${payload}.sig`;
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { id_token: idToken } }));
    expect(codexAdapter.readIdentity(dir)).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
  });

  it('returns {} when there is no auth.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-codexid-'));
    expect(codexAdapter.readIdentity(dir)).toEqual({});
  });
});

// End-to-end: the REAL codexAdapter drives a full failover through runSession
// using Codex-shaped events — proving the adapter integrates, not just its units.
describe('runSession with the real codexAdapter', () => {
  function scriptTurns(script: RawEvent[][], recorded: { mode: string; prompt: string }[]) {
    let call = 0;
    return (opts: TurnOptions): TurnHandle => {
      recorded.push({ mode: opts.mode, prompt: opts.prompt });
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

  it('fails over between two codex accounts on a codex usage-limit error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'x056-codexfo-'));
    const registry = AccountRegistry.init(join(dir, 'accounts.json'), [
      { name: 'xa', configDir: '/cfg/xa', provider: 'codex' },
      { name: 'xb', configDir: '/cfg/xb', provider: 'codex' },
    ]);
    const log = new EventLog(join(dir, 'events.jsonl'));
    const recorded: { mode: string; prompt: string }[] = [];
    const res = await runSession({
      sessionId: 'cx', cwd: '/tmp', prompt: 'ship it', forceSwitchSignal: false,
      registry, log, now: () => 100, adapter: codexAdapter,
      startTurnFn: scriptTurns(
        [
          [wrap({ type: 'error', message: 'usage limit reached', rate_limits: { primary: { resets_in_seconds: 300 } } })],
          [wrap({ type: 'task_complete', last_agent_message: 'done on xb' })],
        ],
        recorded,
      ),
    });
    expect(res).toMatchObject({ status: 'completed', finalAccount: 'xb', failovers: 1, resultText: 'done on xb' });
    expect(recorded[1]).toMatchObject({ mode: 'resume', prompt: codexAdapter.continuePrompt });
    expect(registry.get('xa').state).toEqual({ kind: 'limited', until: 400 });
    expect(log.read().map((r) => r.type)).toContain('failover');
  });
});
