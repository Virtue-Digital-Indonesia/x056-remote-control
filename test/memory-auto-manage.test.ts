import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { SessionManager } from '../server/manager.js';
import { AccountRegistry } from '../src/accounts.js';
import type { MemoryEntry } from '../server/memory-store.js';

let dir: string, app: INestApplication, base: string, manager: SessionManager;
let pid: string, sid: string, otherPid: string, otherSid: string, spaceId: string, otherSpaceId: string;
const token = 'memory-auto-manage-test-token';
const caller = () => ({callerProjectId:pid,callerSessionId:sid});
const note = (patch: Partial<MemoryEntry> = {}) => manager.memory().create({title:'Owned knowledge',content:'Original content',scope:'project',projectId:pid,status:'proposed',...patch});
async function post(path:string, body:unknown) {
  const response = await fetch(base+'/api/memory/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,data:await response.json()};
}
beforeAll(async()=>{
  dir=mkdtempSync(join(tmpdir(),'memory-auto-manage-'));
  AccountRegistry.init(join(dir,'accounts.json'),[{name:'claude',configDir:join(dir,'claude')}]);
  app=await createApp({token,stateDir:dir,workspaceRoot:dir,chatEnabled:true,projectSpacesEnabled:true});
  await app.listen(0,'127.0.0.1');base=await app.getUrl();manager=app.get(SessionManager);
  spaceId=manager.spaces().create({requestId:randomUUID(),name:'Owned bank'}).id;
  otherSpaceId=manager.spaces().create({requestId:randomUUID(),name:'Other bank'}).id;
  const chat=manager.createChat({requestId:randomUUID(),name:'Owned chat',provider:'claude',spaceId});
  const other=manager.createChat({requestId:randomUUID(),name:'Other chat',provider:'claude',spaceId:otherSpaceId});
  pid=chat.id;sid=chat.lastSessionId!;otherPid=other.id;otherSid=other.lastSessionId!;
});
beforeEach(()=>manager.memory().setSettings({autoManage:true,enabled:true,providers:['claude','codex'],excludedProjects:[],excludedSpaces:[]}));
afterAll(async()=>{await app?.close();manager?.memory().close();rmSync(dir,{recursive:true,force:true});});

it('automatically saves preferences and scoped notes, edits pending notes, and individually approves existing proposals',async()=>{
  for(const scope of ['conversation','project','space'] as const){
    const entry={title:scope+' preference',content:'Use concise replies '+scope,kind:'preference',scope,...(scope==='space'?{spaceId}:{projectId:pid,...(scope==='conversation'?{sessionId:sid}:{})})};
    const saved=await post('propose',{entry,...caller()});
    expect(saved.status).toBe(200);expect(saved.data.status).toBe('confirmed');
    expect(saved.data.actor).toContain(sid);
  }
  const pending=note();
  const changed=await post('propose',{id:pending.id,revision:1,entry:{content:'Corrected pending content'},...caller()});
  expect(changed.status).toBe(200);expect(changed.data).toMatchObject({status:'confirmed',revision:2});
  const old=note({title:'Reviewed individually'}), untouched=note({title:'Leave pending'});
  const approved=await post('approve',{id:old.id,revision:1,...caller()});
  expect(approved.status).toBe(200);expect(approved.data.status).toBe('confirmed');
  expect(manager.memory().get(untouched.id)?.status).toBe('proposed');
  expect((await post('approve',{id:old.id,revision:1,...caller()})).status).toBe(409);
  const duplicate=note({title:'Duplicate',content:'Exact pending match'});
  const reused=await post('propose',{entry:{title:'Duplicate again',content:duplicate.content,projectId:pid,scope:'project'},...caller()});
  expect(reused.data).toMatchObject({id:duplicate.id,status:'confirmed',revision:2});
});

it('soft deletes one current revision with caller and reason, retains history, and can restore it',async()=>{
  const entry=note({status:'confirmed'}), untouched=note({status:'confirmed'});
  expect((await post('delete',{id:entry.id,revision:1,reason:'',...caller()})).status).toBe(400);
  const deleted=await post('delete',{id:entry.id,revision:1,reason:'Superseded by current decision',...caller()});
  expect(deleted.status).toBe(200);expect(deleted.data).toMatchObject({id:entry.id,status:'deleted',revision:2,content:entry.content});
  expect(deleted.data.actor).toContain(sid);expect(deleted.data.actor).toContain('Superseded by current decision');
  expect(manager.memory().revisions(entry.id)).toHaveLength(2);
  expect(manager.memory().get(untouched.id)?.status).toBe('confirmed');
  expect(manager.memory().context(pid,sid,'claude','').items.map(e=>e.id)).not.toContain(entry.id);
  expect((await post('delete',{id:entry.id,revision:1,reason:'Stale deletion',...caller()})).status).toBe(409);
  const restored=await post('restore-revision',{id:entry.id,revision:2,restoreRevision:1});
  expect(restored.data).toMatchObject({status:'proposed',revision:3,content:entry.content});
});

it('denies foreign ownership even with a read grant and rejects audience changes or unowned global management',async()=>{
  const foreign=note({projectId:otherPid,status:'confirmed'});
  manager.memory().access.setGrant({operationId:randomUUID(),subject:{kind:'entry',id:foreign.id},expectedVersion:'1',recipient:{kind:'space',id:spaceId},expectedRevision:0,active:true});
  expect(manager.memory().context(pid,sid,'claude','').items.map(e=>e.id)).toContain(foreign.id);
  const targets=[foreign,note({projectId:undefined,spaceId:otherSpaceId,scope:'space'}),note({scope:'conversation',sessionId:otherSid}),note({scope:'global',projectId:undefined,status:'confirmed'})];
  for(const entry of targets){
    expect((await post('propose',{id:entry.id,revision:1,entry:{content:'Changed'},...caller()})).status).toBe(400);
    expect((await post('delete',{id:entry.id,revision:1,reason:'Wrong owner',...caller()})).status).toBe(400);
    expect((await post('approve',{id:entry.id,revision:1,...caller()})).status).toBe(400);
    expect(manager.memory().get(entry.id)?.revision).toBe(1);
  }
  const own=note({status:'confirmed'});
  for(const patch of [{scope:'global'},{providers:['claude','codex']},{sharedProjectIds:[otherPid]},{sessionId:otherSid}])
    expect((await post('propose',{id:own.id,revision:1,entry:{content:'Changed',...patch},...caller()})).status).toBe(400);
  for(const scope of ['global','shared']){
    const saved=await post('propose',{entry:{title:scope+' expansion',content:'Requires audience review',scope,projectId:pid,...(scope==='shared'?{sharedProjectIds:[otherPid]}:{})},...caller()});
    expect(saved.data.status).toBe('proposed');
    expect((await post('approve',{id:saved.data.id,revision:1,...caller()})).status).toBe(400);
  }
  const shared=note({scope:'shared',sharedProjectIds:[otherPid],status:'confirmed'});
  const changed=await post('propose',{id:shared.id,revision:1,entry:{content:'Owned shared correction'},...caller()});
  expect(changed.status).toBe(200);expect(changed.data.status).toBe('confirmed');
});

it('requires automatic mode and a verified caller, and obeys provider and owner exclusions',async()=>{
  const entry=note({status:'confirmed'});
  for(const patch of [{autoManage:false},{enabled:false},{providers:['codex']},{excludedProjects:[pid]},{excludedSpaces:[spaceId]}]){
    manager.memory().setSettings({autoManage:true,enabled:true,providers:['claude','codex'],excludedProjects:[],excludedSpaces:[],...patch} as any);
    expect((await post('delete',{id:entry.id,revision:1,reason:'Not allowed',...caller()})).status).toBe(400);
    expect((await post('approve',{id:entry.id,revision:1,...caller()})).status).toBe(400);
  }
  manager.memory().setSettings({autoManage:true,excludedSpaces:[]});
  expect((await post('delete',{id:entry.id,revision:1,reason:'Missing caller'})).status).toBe(400);
  expect((await post('approve',{id:entry.id,revision:1,callerProjectId:pid,callerSessionId:'unknown'})).status).toBe(400);
  manager.memory().setSettings({autoManage:false});
  const correction=await post('propose',{id:entry.id,revision:1,entry:{content:'Manual review correction'},...caller()});
  expect(correction.data.status).toBe('proposed');
});

it('blocks stale or inaccessible evidence on approval, duplicate approval and edit, but permits validated refresh and soft deletion',async()=>{
  const input={key:'changing-source',kind:'conversation' as const,projectId:pid,sessionId:sid,title:'Source evidence',content:'First evidence',at:1};
  const first=manager.memory().ingest(input).source;
  const refs=[{id:first.id,hash:first.hash,label:'Evidence'}];
  const pending=note({title:'Stale pending',content:'Source-derived fact',sources:refs});
  const stale=note({title:'Stale confirmed',status:'confirmed',sources:refs});
  const changed=manager.memory().ingest({...input,content:'Current evidence',at:2}).source;
  expect((await post('approve',{id:pending.id,revision:1,...caller()})).status).toBe(400);
  expect((await post('propose',{entry:{title:pending.title,content:pending.content,scope:'project',projectId:pid},...caller()})).status).toBe(400);
  expect(manager.memory().get(pending.id)?.status).toBe('proposed');
  expect((await post('propose',{id:stale.id,revision:1,entry:{content:'Rewritten without rechecking'},...caller()})).status).toBe(400);
  const foreign=manager.memory().ingest({...input,key:'foreign-source',projectId:otherPid,sessionId:otherSid}).source;
  expect((await post('propose',{id:stale.id,revision:1,entry:{content:'Foreign evidence',sources:[{id:foreign.id,label:'Not granted'}]},...caller()})).status).toBe(400);
  expect((await post('propose',{id:stale.id,revision:1,entry:{content:'Invalid version',sources:[{id:changed.id,versionId:'missing-version',label:'Unknown'}]},...caller()})).status).toBe(400);
  const refreshed=await post('propose',{id:stale.id,revision:1,entry:{content:'Current source-derived fact',sources:[{id:changed.id,label:'Rechecked evidence'}]},...caller()});
  expect(refreshed.status).toBe(200);expect(refreshed.data).toMatchObject({status:'confirmed',revision:2});
  expect(refreshed.data.sources[0].hash).toBe(changed.hash);
  const deleted=await post('delete',{id:pending.id,revision:1,reason:'Outdated evidence',...caller()});
  expect(deleted.status).toBe(200);expect(deleted.data.status).toBe('deleted');
});


it('allows reading owned pending memory for management without injecting it or exposing foreign pending memory',async()=>{
  const own=note({title:'Pending read'}), foreign=note({projectId:otherPid,title:'Foreign pending read'});
  const read=async(id:string)=>fetch(base+'/api/memory/entry?'+new URLSearchParams({id,...caller()}),{headers:{Authorization:'Bearer '+token}});
  const response=await read(own.id);
  expect(response.status).toBe(200);
  const data=await response.json();
  expect(data.entry.status).toBe('proposed');expect(data.revisions[0].status).toBe('proposed');
  expect(manager.memory().context(pid,sid,'claude','').items.map(e=>e.id)).not.toContain(own.id);
  expect((await read(foreign.id)).status).toBe(400);
  expect((await post('approve',{id:own.id,revision:1,...caller()})).data.status).toBe('confirmed');
  manager.memory().setSettings({autoManage:false});
  expect((await read(note().id)).status).toBe(400);
});
