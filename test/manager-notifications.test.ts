import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager, type GatewayEvent } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import type { RunSessionOptions, SessionResult } from '../src/failover.js';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.useRealTimers(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notification-manager-')), stateDir = join(root, 'state');
  AccountRegistry.init(join(stateDir, 'accounts.json'), [{name:'a', configDir:'/cfg/a'}]);
  const turns: { resolve:(r:SessionResult)=>void; reject:(e:Error)=>void; abort:ReturnType<typeof vi.fn> }[] = [];
  const manager = new SessionManager({stateDir, workspaceRoot:root, runSessionFn: (options:RunSessionOptions) => new Promise<SessionResult>((resolve,reject) => {
    const abort = vi.fn(); turns.push({resolve,reject,abort}); options.control?.({abort,forceSwitch:()=>{}});
  })});
  const pid = manager.createProject('Notifications', root).id;
  const events:GatewayEvent[] = []; manager.subscribe(e=>events.push(e));
  cleanups.push(()=>{manager.onModuleDestroy();rmSync(root,{recursive:true,force:true});});
  return {manager, pid, events, turns};
}
const complete:SessionResult = { status:'completed', failovers:0, resultText:'Done.\n<<<ASK\nquestion: What next?\n>>>' };
async function flush() { for(let i=0;i<12;i++)await Promise.resolve(); }

it.each(['resolve','reject'])('Stop stays neutral when the provider %s races cancellation', async (mode) => {
  const {manager,pid,turns,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  manager.setAutopilot(pid,sid,{count:3});
  expect(manager.stopTurn(pid,sid)).toBe(true);
  expect(turns[0].abort).toHaveBeenCalledTimes(1);
  if(mode==='resolve')turns[0].resolve(complete);else turns[0].reject(Error('Process killed'));
  await flush();
  expect(events.filter(e=>e.kind==='session_done').at(-1)?.data).toMatchObject({status:'stopped', notificationSuppressed:true});
  expect(events.some(e=>['session_error','question'].includes(e.kind))).toBe(false);
  expect(manager.listConversations(pid).find(c=>c.sessionId===sid)?.lastOutcome?.status).toBe('stopped');
  expect(manager.autopilotStatus()[sid]).toBeUndefined();
});
it('disabling autopilot suppresses its pending finish/question, but not the next human turn', async () => {
  const {manager,pid,turns,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  manager.setAutopilot(pid,sid,{count:3});
  manager.stopAutopilot(sid); manager.stopAutopilot(sid);
  turns[0].resolve(complete);await flush();
  expect(events.filter(e=>e.kind==='autopilot'&&e.data.reason==='stopped')).toHaveLength(1);
  expect(events.filter(e=>e.kind==='session_done').at(-1)?.data.notificationSuppressed).toBe(true);
  expect(events.filter(e=>e.kind==='question')).toHaveLength(0);
  manager.continueSession(pid,sid,'Next human turn');
  turns[1].resolve(complete);await flush();
  expect(events.filter(e=>e.kind==='question')).toHaveLength(1);
});
it('Stop cancels a delayed finished alert even after the provider turn ended', async () => {
  const {manager,pid,turns,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  vi.useFakeTimers(); turns[0].resolve({...complete,resultText:'Done'});await flush();
  expect(events.find(e=>e.kind==='session_done')?.data.completionPending).toBe(true);
  manager.stopTurn(pid,sid);
  await vi.advanceTimersByTimeAsync(4000);
  expect(events.filter(e=>e.kind==='conversation_settled')).toHaveLength(0);
});
it('pauses autopilot once on genuine failure and leaves the failure visible', async () => {
  const {manager,pid,turns,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);manager.setAutopilot(pid,sid,{count:3});
  turns[0].resolve({status:'failed',failovers:0,reason:'Provider unavailable'});await flush();
  expect(manager.autopilotStatus()[sid]).toMatchObject({paused:true,pauseReason:'failed'});
  expect(events.filter(e=>e.kind==='autopilot'&&e.data.active===false)).toHaveLength(1);
  expect(events.find(e=>e.kind==='session_done')?.data).toMatchObject({status:'failed'});
  expect(events.find(e=>e.kind==='session_done')?.data.notificationSuppressed).not.toBe(true);
});
it('holds queued follow-ups when the operator stops the current turn', async () => {
  const {manager,pid,turns}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  manager.enqueue(pid,{sessionId:sid,text:'A queued follow-up',requestId:'queued-after-stop-test'});
  manager.stopTurn(pid,sid);
  turns[0].resolve(complete);await flush();
  expect(turns).toHaveLength(1);
  expect(manager.queues()[pid]).toHaveLength(1);
});
