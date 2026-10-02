import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { autopilotStopInstruction, composeAutopilotPrompt, DEFAULT_AUTOPILOT_PROMPT } from '../src/autopilot.js';
import { readMessageSender, withMessageSender } from '../src/message-sender.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';
import { SessionManager, type GatewayEvent } from '../server/manager.js';

const managers: SessionManager[] = [];
afterEach(() => { for (const m of managers.splice(0)) m.onModuleDestroy(); vi.restoreAllMocks(); vi.useRealTimers(); });
const done = (resultText = 'working'): SessionResult => ({ status: 'completed', finalAccount: 'a', failovers: 0, resultText });
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  expect(check()).toBe(true);
}
function fixture(turn = async (_o: RunSessionOptions) => done()) {
  const dir = mkdtempSync(join(tmpdir(), 'x056-ap-instruction-')), stateDir = join(dir, 'state'), configDir = join(dir, 'a');
  mkdirSync(stateDir); mkdirSync(configDir);
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{ name: 'a', configDir }]);
  const calls: RunSessionOptions[] = [];
  const runSessionFn = (async (o: RunSessionOptions) => { calls.push(o); return turn(o); }) as typeof import('../src/failover.js').runSession;
  const options = { stateDir, workspaceRoot: dir, runSessionFn, autopilotIntervalMs: 300, projectSpacesEnabled: false };
  const mgr = new SessionManager(options); managers.push(mgr);
  const p = mgr.createProject('P', dir), events: GatewayEvent[] = []; mgr.subscribe(e => events.push(e));
  return { mgr, p, dir, stateDir, configDir, calls, events, options };
}

describe('autopilot standing instruction', () => {
  it('composes the unchanged default with its stop phrase and multiline instruction', () => {
    const prompt = DEFAULT_AUTOPILOT_PROMPT + ' ' + autopilotStopInstruction('AUTOPILOT_DONE');
    expect(composeAutopilotPrompt({ prompt, stopPhrase: 'AUTOPILOT_DONE', instruction: 'Follow docs/plan.md\nTick off each item' })).toBe(prompt + '\n\nStanding instruction from the user:\nFollow docs/plan.md\nTick off each item');
    expect(composeAutopilotPrompt({ prompt, stopPhrase: 'AUTOPILOT_DONE' })).toBe(prompt);
  });

  it('preserves custom prompt whitespace and keeps custom stop guidance before the instruction', () => {
    const prompt = '  Continue the implementation.\nKeep these lines.  ';
    expect(composeAutopilotPrompt({ prompt, stopPhrase: 'FINISHED', instruction: 'Follow the plan' })).toBe(prompt + '\n\n' + autopilotStopInstruction('FINISHED') + '\n\nStanding instruction from the user:\nFollow the plan');
  });

  it('edits during a scheduled gap without spending a step, then sends the new instruction with attribution', async () => {
    const f = fixture(async o => done(readMessageSender(o.prompt).sender ? 'FINISHED' : 'working'));
    const sid = f.mgr.start('initial', undefined, undefined, f.p.id);
    f.mgr.setAutopilot(f.p.id, sid, { count: 3, prompt: '  Custom base  ', stopPhrase: 'FINISHED', instruction: 'Old text' });
    await until(() => !f.mgr.snapshot().running);
    expect(f.mgr.setAutopilotInstruction(f.p.id, sid, '  Follow docs/plan.md\nTick off each item  ')).toBe(true);
    expect(f.mgr.autopilotStatus()[sid]).toEqual({ projectId: f.p.id, remaining: 3, count: 3, instruction: 'Follow docs/plan.md\nTick off each item' });
    await until(() => f.calls.length === 2 && !f.mgr.snapshot().running);
    const sent = readMessageSender(f.calls[1].prompt);
    expect(sent.sender?.kind).toBe('autopilot');
    expect(sent.text).toBe('  Custom base  \n\n' + autopilotStopInstruction('FINISHED') + '\n\nStanding instruction from the user:\nFollow docs/plan.md\nTick off each item');
    expect(f.mgr.autopilotStatus()[sid]).toBeUndefined();
    expect(f.mgr.autopilotLast(f.p.id, sid)).toEqual({ count: 3, instruction: 'Follow docs/plan.md\nTick off each item' });
    expect(f.events.filter(e => e.kind === 'autopilot' && e.data.active).at(-1)?.data).toMatchObject({ count: 3, remaining: 2, instruction: 'Follow docs/plan.md\nTick off each item' });
  });

  it('trims and caps instructions, omits empty status text, and remembers the count after stop', () => {
    const f = fixture(), sid = 'conversation';
    f.mgr.setAutopilot(f.p.id, sid, { count: 12, instruction: '  ' + 'x'.repeat(4100) + '  ' });
    expect(f.mgr.autopilotStatus()[sid].instruction).toHaveLength(4000);
    expect(f.events.at(-1)?.data).toMatchObject({ active: true, count: 12, remaining: 12, instruction: 'x'.repeat(4000) });
    expect(f.mgr.setAutopilotInstruction('other-project', sid, 'wrong')).toBe(false);
    expect(f.mgr.setAutopilotInstruction(f.p.id, sid, ' \n ')).toBe(true);
    expect(f.mgr.autopilotStatus()[sid]).toEqual({ projectId: f.p.id, count: 12, remaining: 12 });
    expect(f.events.at(-1)?.data).toMatchObject({ active: true, count: 12, instruction: '' });
    f.mgr.stopAutopilot(sid);
    expect(f.mgr.autopilotLast(f.p.id, sid)).toEqual({ count: 12 });
    expect(f.mgr.autopilotLast(f.p.id, 'unknown')).toEqual({});
    expect(f.mgr.autopilotLast('other-project', sid)).toEqual({});
    expect(f.mgr.setAutopilotInstruction(f.p.id, sid, 'cannot edit')).toBe(false);
  });

  it('restores active and last settings and reads edits made during startup before sending', () => {
    const f = fixture(), sid = 'conversation';
    f.mgr.setAutopilot(f.p.id, sid, { count: 7, prompt: 'Custom base', instruction: 'Saved instruction' });
    f.mgr.onModuleDestroy();
    vi.useFakeTimers();
    const restarted = new SessionManager(f.options); managers.push(restarted);
    const send = vi.spyOn(restarted, 'continueSession').mockReturnValue(sid);
    expect(restarted.autopilotStatus()[sid]).toEqual({ projectId: f.p.id, count: 7, remaining: 7, instruction: 'Saved instruction' });
    restarted.setAutopilotInstruction(f.p.id, sid, 'New startup instruction');
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledWith(f.p.id, sid, composeAutopilotPrompt({ prompt: 'Custom base', stopPhrase: 'AUTOPILOT_DONE', instruction: 'New startup instruction' }), { sender: { kind: 'autopilot' } });
    restarted.stopAutopilot(sid); restarted.onModuleDestroy();
    const stoppedRestart = new SessionManager(f.options); managers.push(stoppedRestart);
    expect(stoppedRestart.autopilotStatus()).toEqual({});
    expect(stoppedRestart.autopilotLast(f.p.id, sid)).toEqual({ count: 7, instruction: 'New startup instruction' });
  });

  it('edits a paused entry without changing its budget, reason, or pause state', () => {
    const f = fixture(), sid = 'paused';
    f.mgr.setAutopilot(f.p.id, sid, { count: 9 });
    const file = join(f.stateDir, 'autopilot.json'), map = JSON.parse(readFileSync(file, 'utf8'));
    map[sid] = { ...map[sid], remaining: 4, paused: true, pauseReason: 'failed' };
    writeFileSync(file, JSON.stringify(map));
    const before = f.events.length;
    expect(f.mgr.setAutopilotInstruction(f.p.id, sid, 'Follow the recovery plan')).toBe(true);
    expect(f.mgr.autopilotStatus()[sid]).toEqual({ projectId: f.p.id, remaining: 4, count: 9, paused: true, pauseReason: 'failed', instruction: 'Follow the recovery plan' });
    expect(f.events).toHaveLength(before); // editing is not another pause notification
  });

  it('uses the default custom stop phrase on the next step and remembers settings after exhaustion', async () => {
    const f = fixture(), sid = f.mgr.start('initial', undefined, undefined, f.p.id);
    f.mgr.setAutopilot(f.p.id, sid, { count: 1, stopPhrase: 'FINISHED', instruction: 'Follow the plan' });
    await until(() => f.calls.length === 2 && !f.mgr.snapshot().running);
    const text = readMessageSender(f.calls[1].prompt).text;
    expect(text).toBe(DEFAULT_AUTOPILOT_PROMPT + ' ' + autopilotStopInstruction('FINISHED') + '\n\nStanding instruction from the user:\nFollow the plan');
    expect(text).not.toContain('AUTOPILOT_DONE');
    expect(f.mgr.autopilotLast(f.p.id, sid)).toEqual({ count: 1, instruction: 'Follow the plan' });
    expect(f.events.filter(e => e.kind === 'autopilot').at(-1)?.data).toMatchObject({ active: false, reason: 'exhausted' });
  });

  it('keeps the instruction in history but excludes it from Jev previousRequest', async () => {
    const f = fixture(), sid = f.mgr.start('initial', undefined, undefined, f.p.id);
    await until(() => !f.mgr.snapshot().running);
    const text = composeAutopilotPrompt({ prompt: 'Continue implementation', stopPhrase: 'AUTOPILOT_DONE', instruction: 'Unique standing instruction\nFollow docs/plan.md' });
    const transcriptDir = join(f.configDir, 'projects', 'fixture'); mkdirSync(transcriptDir, { recursive: true });
    writeFileSync(join(transcriptDir, sid + '.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: withMessageSender(text, { kind: 'autopilot' }) } }) + '\n');
    vi.spyOn(f.mgr.jev(), 'configured').mockReturnValue(true);
    const decide = vi.spyOn(f.mgr.jev(), 'decide').mockResolvedValue({ at: 't', sessionId: sid, provider: 'claude', notes: [], latencyMs: 1 });
    f.mgr.setDecisionMaker(f.p.id, sid, 'jev');
    f.mgr.continueSession(f.p.id, sid, 'next', {});
    await until(() => f.calls.length === 2 && !f.mgr.snapshot().running);
    expect(decide.mock.calls[0][1].context?.previousRequest).toBe('Continue implementation\n\n' + autopilotStopInstruction('AUTOPILOT_DONE'));
  });
});
