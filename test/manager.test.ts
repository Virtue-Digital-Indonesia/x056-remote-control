import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { BusyError, SessionManager, type GatewayEvent } from '../server/manager.js';

function fixture(result: SessionResult, opts?: { emitEvents?: boolean; delayMs?: number }) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-mgr-'));
  const stateDir = join(dir, 'state');
  mkdirSync(stateDir, { recursive: true });
  AccountRegistry.init(join(stateDir, 'accounts.json'), [
    { name: 'a', configDir: '/cfg/a' },
    { name: 'b', configDir: '/cfg/b' },
  ]);
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => {
    calls.push(o);
    if (opts?.emitEvents !== false) {
      o.tap?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello from claude' }] } });
      o.log.append({ type: 'failover', sessionId: o.sessionId, from: 'a' });
    }
    await new Promise((r) => setTimeout(r, opts?.delayMs ?? 20));
    return result;
  }) as unknown as typeof import('../src/failover.js').runSession;
  const mgr = new SessionManager({ stateDir, workspaceRoot: dir, runSessionFn });
  return { mgr, calls, dir, stateDir };
}

const COMPLETED: SessionResult = { status: 'completed', finalAccount: 'b', failovers: 1, resultText: 'done' };

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SessionManager', () => {
  it('runs a session, emits assistant text + log + lifecycle events, persists state', async () => {
    const { mgr, calls, dir, stateDir } = fixture(COMPLETED);
    const seen: GatewayEvent[] = [];
    mgr.subscribe((e) => seen.push(e));
    const sid = mgr.start('do it');
    expect(calls[0]?.prompt ?? '').toBe('do it');
    await waitFor(() => mgr.snapshot().running === false && seen.some((e) => e.kind === 'session_done'));
    const kinds = seen.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['session_started', 'assistant_text', 'supervisor', 'session_done']));
    expect(seen.find((e) => e.kind === 'assistant_text')?.data.text).toBe('hello from claude');
    expect(seen.find((e) => e.kind === 'supervisor')?.data.type).toBe('failover');
    const st = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
    expect(st.lastSessionId).toBe(sid);
    expect(st.cwd).toBe(dir);
    expect(mgr.snapshot().lastResult).toEqual(COMPLETED);
  });

  it('rejects concurrent starts with BusyError and allows continue after completion', async () => {
    const { mgr, calls } = fixture(COMPLETED, { delayMs: 100 });
    mgr.start('first');
    expect(() => mgr.start('second')).toThrow(BusyError);
    await waitFor(() => mgr.snapshot().running === false);
    const sid2 = mgr.continueLast('again');
    expect(sid2).toBe(mgr.snapshot().currentSessionId ?? sid2);
    await waitFor(() => mgr.snapshot().running === false);
    expect(calls[1]?.resume).toBe(true);
    expect(calls[1]?.sessionId).toBe(calls[0]?.sessionId);
  });

  it('continueLast without prior session throws', () => {
    const { mgr } = fixture(COMPLETED);
    expect(() => mgr.continueLast('x')).toThrow(/no previous session/);
  });

  it('rejects cwd outside workspace root', () => {
    const { mgr } = fixture(COMPLETED);
    expect(() => mgr.start('x', '/etc')).toThrow(/outside workspace root/);
  });

  it('replays buffered events to late subscribers from sinceSeq', async () => {
    const { mgr } = fixture(COMPLETED);
    mgr.start('task');
    await waitFor(() => mgr.snapshot().running === false);
    const all: GatewayEvent[] = [];
    mgr.subscribe((e) => all.push(e));
    expect(all.length).toBeGreaterThanOrEqual(3);
    const later: GatewayEvent[] = [];
    mgr.subscribe((e) => later.push(e), all[1].seq);
    expect(later[0].seq).toBe(all[2].seq);
  });

  it('forceSwitch returns false when idle', () => {
    const { mgr } = fixture(COMPLETED);
    expect(mgr.forceSwitch()).toBe(false);
  });
});
