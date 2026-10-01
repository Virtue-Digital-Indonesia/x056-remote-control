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

// ---- notices (server/notices.ts) as the manager attaches them ----
it('a settled turn carries its origin, duration and notice; a relayed turn is quiet', async () => {
  const {manager,pid,turns,events}=fixture();
  vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','Date'] });
  const sid=manager.start('go',undefined,undefined,pid);
  await vi.advanceTimersByTimeAsync(60_000);
  turns[0].resolve({status:'completed',failovers:0,resultText:'**Shipped.** The deed parser keeps leading zeros.'});
  await vi.advanceTimersByTimeAsync(4000);
  const done=events.find(e=>e.kind==='session_done')!.data;
  expect(done).toMatchObject({origin:'human',completionPending:true});
  expect(Number(done.durationMs)).toBeGreaterThanOrEqual(60_000);
  expect(done.notice).toBeUndefined(); // pending: the settled event speaks
  const settled=events.find(e=>e.kind==='conversation_settled')!.data;
  expect(settled.notice).toMatchObject({tier:'normal',title:'go',kind:'conversation_settled',tag:'x056-conv-'+sid});
  expect((settled.notice as {body:string}).body).toMatch(/^Notifications · Claude\n1m 0\ds · Shipped\. The deed parser keeps leading zeros\.$/);
  manager.continueSession(pid,sid,'from elsewhere',{sender:{kind:'conversation',sessionId:'other'}});
  await vi.advanceTimersByTimeAsync(60_000);
  turns[1].resolve({status:'completed',failovers:0,resultText:'ok'});
  await vi.advanceTimersByTimeAsync(4000);
  expect(events.filter(e=>e.kind==='conversation_settled').at(-1)!.data.notice).toMatchObject({tier:'quiet',category:'automation'});
});
it('a failed cron turn is urgent; a cron delivery failure is its own urgent notice', async () => {
  const {manager,pid,turns,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  turns[0].resolve(complete);await flush();
  manager.continueSession(pid,sid,'nightly',{sender:{kind:'automation'}});
  turns[1].resolve({status:'failed',failovers:0,reason:'OAuth session expired',finalAccount:'a'});await flush();
  expect(events.filter(e=>e.kind==='session_done').at(-1)!.data.notice).toMatchObject({tier:'urgent',body:'Notifications · Claude\nSign-in expired for account a'});
  manager.reportCronFailure({id:'j1',projectId:pid,sessionId:sid,label:'Nightly report',prompt:'x'},'Conversation unavailable');
  expect(events.find(e=>e.kind==='cron_failed')!.data.notice).toMatchObject({tier:'urgent',body:'Notifications · Claude\nNightly report failed: Conversation unavailable'});
});
it('an autopilot run ends in one notice that counts its steps', async () => {
  const {manager,pid,turns,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  manager.setAutopilot(pid,sid,{count:5});
  (manager as unknown as {disarmAutopilot:(p:string,s:string,r:string)=>void}).disarmAutopilot(pid,sid,'done');
  expect(events.filter(e=>e.kind==='autopilot'&&e.data.active===false).at(-1)!.data.notice).toMatchObject({tier:'normal',body:'Notifications · Claude\nAutopilot finished'});
  turns[0].resolve(complete);await flush();
});
it('MCP approvals push while pending only', () => {
  const {manager,pid,events}=fixture();
  const sid=manager.start('go',undefined,undefined,pid);
  const a=manager.requestMcpSend(pid,sid,'Please add the changelog entry',{from:sid});
  const ev=events.filter(e=>e.kind==='mcp_approval');
  expect(ev[0].data.notice).toMatchObject({tier:'urgent',tag:'x056-urgent-approval:'+a.id,body:'Claude in go wants to message go: “Please add the changelog entry”'});
  manager.decideMcpApproval(a.id,false);
  expect(events.filter(e=>e.kind==='mcp_approval').at(-1)!.data.notice).toBeUndefined();
});
it('a short turn that leaves background work running is timed to when the conversation settles', async () => {
  const {manager,pid,turns,events}=fixture();
  vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','Date'] });
  const sid=manager.start('go',undefined,undefined,pid);
  await vi.advanceTimersByTimeAsync(10_000);
  turns[0].resolve({status:'completed',failovers:0,resultText:'Started the long job in the background.'});
  const emit=(manager as unknown as {emit:(k:string,d:Record<string,unknown>)=>void}).emit.bind(manager);
  for(let i=0;i<60;i++){ emit('activity',{projectId:pid,sessionId:sid,status:'start',label:'Bash'}); await vi.advanceTimersByTimeAsync(1000); }
  await vi.advanceTimersByTimeAsync(4000);
  expect(Number(events.find(e=>e.kind==='session_done')!.data.durationMs)).toBeLessThan(15_000);
  const n=events.find(e=>e.kind==='conversation_settled')!.data.notice as {tier:string;body:string};
  expect(n.tier).toBe('normal');
  expect(n.body.split('\n')[1]).toMatch(/^1m \d\ds · Started the long job/);
});
