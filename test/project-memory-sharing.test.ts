import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore, MemoryReferenceConflict, type MemoryEntry } from '../server/memory-store.js';
import { ProjectRegistry } from '../server/projects.js';
import { ProjectSpaceRegistry, type SpaceTarget, type SpaceAssignment } from '../server/project-space-registry.js';
import { ProjectContextResolver } from '../server/project-context.js';
import type { MemorySubject,MemoryOwner } from '../server/memory-access.js';
const stores:MemoryStore[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.close();});
function fixture(){
 const state=mkdtempSync(join(tmpdir(),'memory-sharing-')),file=join(state,'projects.json'),projects=()=>ProjectRegistry.load(file),reg=projects();
 const work=reg.create('Work',state),other=reg.create('Other',state);reg.addConversation(work.id,'one','One');reg.addConversation(work.id,'two','Two');reg.addConversation(other.id,'research','Research');
 reg.createChat({id:'chat',kind:'chat',name:'Chat',cwd:state,lastSessionId:'chat-session',conversations:[{sessionId:'chat-session',title:'Chat',createdAt:1}]});
 const spaces=new ProjectSpaceRegistry(state,()=>projects().list()),a=spaces.create({requestId:'space-create-001',name:'A'}),b=spaces.create({requestId:'space-create-002',name:'B'});
 const move=(target:SpaceTarget,assignment:SpaceAssignment)=>{const preview=spaces.preview({target,assignment});const op=spaces.apply({target,assignment,operationId:randomUUID(),expectedRevision:preview.revision,expectedTopology:preview.topology,expectedImpactHash:preview.impactHash});spaces.complete(op.id);};
 move({kind:'work-project',projectId:work.id},{mode:'space',spaceId:a.id});move({kind:'work-conversation',projectId:work.id,sessionId:'two'},{mode:'space',spaceId:b.id});move({kind:'chat',projectId:'chat'},{mode:'space',spaceId:a.id});
 let enabled=true;const resolver=new ProjectContextResolver(()=>projects().list(),()=>enabled,spaces),store=new MemoryStore(state,resolver);stores.push(store);
 const note=(patch:Partial<MemoryEntry>={})=>store.create({title:'Proposal requirement',content:'Retain the original document.',projectId:work.id,status:'confirmed',pinned:true,...patch});
 const share=(subject:MemorySubject,recipient:MemoryOwner)=>store.access.setGrant({operationId:randomUUID(),subject,expectedVersion:subject.kind==='entry'?String(store.get(subject.id)!.revision):store.source(subject.id)!.hash,recipient,expectedRevision:0,active:true});
 const select=(id:string,requestId=randomUUID(),extra={})=>store.access.setReferences({operationId:randomUUID(),projectId:'chat',sessionId:'chat-session',requestId,expectedRevision:0,selections:[{kind:'entry',id,version:String(store.get(id)!.revision),...extra}]});
 return {state,resolver,store,spaces,a,b,work,other,note,share,select,move,disable:()=>{enabled=false;}};
}
describe('Project memory scope and reviewed sharing',()=>{
 it('keeps original Work and conversation notes local, while both providers inherit the primary Space',()=>{
  const f=fixture(),work=f.note(),privateNote=f.note({scope:'conversation',sessionId:'one'}),space=f.note({projectId:undefined,spaceId:f.a.id,scope:'space'}),chat=f.note({projectId:'chat'});
  for(const provider of ['claude','codex'] as const){
   expect(f.store.context('chat','chat-session',provider,'').items.map(e=>e.id).sort()).toEqual([space.id,chat.id].sort());
   expect(f.store.context(f.work.id,'one',provider,'').items.map(e=>e.id).sort()).toEqual([work.id,privateNote.id,space.id].sort());
   expect(f.store.context(f.work.id,'two',provider,'').items.map(e=>e.id)).toEqual([work.id]);
  }
  f.disable();expect(f.store.context('chat','chat-session','codex','').items.map(e=>e.id)).toEqual([chat.id]);
 });
 it('shares selected approved text without making source evidence eligible',()=>{
  const f=fixture(),source=f.store.ingest({key:'confidential',kind:'document',projectId:f.other.id,title:'Source',content:'Full original source',at:1}).source;
  const note=f.note({projectId:f.other.id,sources:[{id:source.id,hash:source.hash,label:'Evidence'}]});
  f.share({kind:'entry',id:note.id},{kind:'space',id:f.a.id});
  const q={projectId:'chat',sessionId:'chat-session',provider:'codex' as const};
  expect(f.store.searchContext(q).items.map(e=>e.id)).toEqual([note.id]);expect(f.store.sourceContextProblem(source,q)).toContain('scope');
  f.share({kind:'source',id:source.id},{kind:'space',id:f.a.id});expect(f.store.sourceContextProblem(source,q)).toBeUndefined();
  expect(f.store.sources({...q,access:'context',eligibleOnly:true}).items).toHaveLength(1);
 });
 it('does not reinterpret legacy execution recipients as Spaces',()=>{
  const f=fixture(),note=f.note({projectId:f.other.id,scope:'shared',sharedProjectIds:[f.work.id]});
  expect(f.store.context(f.work.id,'one','claude','').items.map(e=>e.id)).toEqual([note.id]);
  expect(f.store.context('chat','chat-session','claude','').items).toEqual([]);
 });
 it('filters library source aggregation by exact membership without enabling agent reads',()=>{
  const f=fixture();for(const sid of ['one','two'])f.store.ingest({key:sid,kind:'conversation',projectId:f.work.id,sessionId:sid,title:sid,content:'Original transcript',at:1});
  expect(f.store.sources({spaceId:f.a.id}).items.map(s=>s.sessionId)).toEqual(['one']);
  expect(f.store.sources({projectId:'chat',sessionId:'chat-session',access:'context',eligibleOnly:true}).items).toEqual([]);
 });
 it('applies eligibility before ranking and pagination',()=>{
  const f=fixture();for(let n=0;n<220;n++)f.note({projectId:f.other.id,title:'Proposal '+n});
  const included=f.note({projectId:'chat'});expect(f.store.searchContext({query:'proposal',projectId:'chat',sessionId:'chat-session',limit:1}).items.map(e=>e.id)).toEqual([included.id]);
 });
 it('pins deliberate turn exceptions with cross-project retrieval off without changing settings',()=>{
  const f=fixture(),note=f.note({projectId:f.other.id});f.store.setSettings({crossProject:false});
  expect(()=>f.select(note.id)).toThrow('Allow reading');
  const refs=f.select(note.id,undefined,{allowReadForTurn:true,allowCrossProjectForTurn:true});
  expect(f.store.context('chat','chat-session','claude','',refs.requestId).items.map(e=>e.id)).toEqual([note.id]);
  expect(f.store.context('chat','chat-session','claude','').items).toEqual([]);expect(f.store.settings().crossProject).toBe(false);
  f.store.setPreferences('chat','chat-session',{excludedIds:[note.id]});expect(()=>f.store.context('chat','chat-session','claude','',refs.requestId)).toThrow('Excluded');
 });
 it('retains exact revisions through account failover and blocks revoked grants after restart',()=>{
  const f=fixture(),note=f.note({projectId:f.other.id}),grant=f.share({kind:'entry',id:note.id},{kind:'space',id:f.a.id});
  const refs=f.select(note.id),snapshot=f.store.context('chat','chat-session','codex','',refs.requestId);
  f.store.update(note.id,1,{content:'Revised after dispatch'});expect(()=>f.store.validateSnapshot('chat','chat-session','codex',snapshot)).not.toThrow();expect(snapshot.text).not.toContain('Revised');
  f.store.access.setGrant({operationId:randomUUID(),subject:grant.subject,recipient:grant.recipient,expectedVersion:'2',expectedRevision:1,active:false});
  const reopened=new MemoryStore(f.state,f.resolver);stores.push(reopened);
  expect(()=>reopened.validateSnapshot('chat','chat-session','codex',snapshot)).toThrow(MemoryReferenceConflict);
  expect(()=>reopened.context('chat','chat-session','codex','',refs.requestId)).toThrow('grant');expect(reopened.searchContext({projectId:'chat',sessionId:'chat-session'}).items).toEqual([]);
 });
 it('invalidates a snapshot when references are removed or membership changes',()=>{
  const f=fixture(),note=f.note({projectId:'chat'}),refs=f.select(note.id),snapshot=f.store.context('chat','chat-session','claude','',refs.requestId);
  f.store.access.setReferences({...refs,operationId:randomUUID(),expectedRevision:1,selections:[]});expect(()=>f.store.validateSnapshot('chat','chat-session','claude',snapshot)).toThrow('references changed');
  const next=f.store.context('chat','chat-session','claude','');f.move({kind:'chat',projectId:'chat'},{mode:'space',spaceId:f.b.id});expect(()=>f.store.validateSnapshot('chat','chat-session','claude',next)).toThrow('membership');
 });
 it('removes references independently without renewing revoked or replaced grants',()=>{
  const f=fixture(),a=f.note({projectId:f.other.id}),b=f.note({projectId:f.other.id});
  const grants=[a,b].map(n=>f.share({kind:'entry',id:n.id},{kind:'space',id:f.a.id}));
  const requestId=randomUUID(),base={projectId:'chat',sessionId:'chat-session',requestId};
  const first=f.store.access.setReferences({...base,operationId:randomUUID(),expectedRevision:0,selections:[a,b].map(n=>({kind:'entry',id:n.id,version:'1'}))});
  for(const g of grants)f.store.access.setGrant({operationId:randomUUID(),subject:g.subject,recipient:g.recipient,expectedVersion:'1',expectedRevision:1,active:false});
  const kept=f.store.access.setReferences({...base,operationId:randomUUID(),expectedRevision:1,selections:first.selections.slice(1)});
  expect(kept.selections[0]).toEqual(first.selections[1]);
  expect(()=>f.store.context('chat','chat-session','claude','',requestId)).toThrow('grant');
  const g=grants[1];f.store.access.setGrant({operationId:randomUUID(),subject:g.subject,recipient:g.recipient,expectedVersion:'1',expectedRevision:2,active:true});
  const unchanged=f.store.access.setReferences({...base,operationId:randomUUID(),expectedRevision:2,selections:kept.selections});
  expect(unchanged.selections[0].grantRevision).toBe(1);
  expect(()=>f.store.context('chat','chat-session','claude','',requestId)).toThrow('grant');
  expect(f.store.access.setReferences({...base,operationId:randomUUID(),expectedRevision:3,selections:[]}).selections).toEqual([]);
 });
 it('preserves grant receipts and rolls back failed changes',()=>{
  const f=fixture(),note=f.note(),input={operationId:randomUUID(),subject:{kind:'entry' as const,id:note.id},expectedVersion:'1',recipient:{kind:'space' as const,id:f.a.id},expectedRevision:0,active:true};
  const first=f.store.access.setGrant(input);expect(f.store.access.setGrant(input)).toEqual(first);
  expect(()=>f.store.access.setGrant({...input,active:false})).toThrow('operationId');
  expect(()=>f.store.access.setGrant({...input,operationId:randomUUID(),expectedVersion:'9'})).toThrow('changed');
  expect(f.store.access.grants(input.subject)).toEqual([first]);
 });
 it('does not share proposals and prevents derived proposals surviving a revoked dependency',()=>{
  const f=fixture(),proposal=f.note({status:'proposed'});expect(()=>f.share({kind:'entry',id:proposal.id},{kind:'space',id:f.a.id})).toThrow('reviewed');
  const source=f.store.ingest({key:'derived',kind:'document',projectId:f.other.id,title:'Source',content:'Evidence',at:1}).source,grant=f.share({kind:'source',id:source.id},{kind:'space',id:f.a.id});
  const derived=f.note({projectId:'chat',sources:[{id:source.id,hash:source.hash,label:'Evidence',grantId:grant.id,grantRevision:grant.revision}]});
  expect(f.store.context('chat','chat-session','claude','').items.map(e=>e.id)).toEqual([derived.id]);
  f.store.access.setGrant({operationId:randomUUID(),subject:grant.subject,recipient:grant.recipient,expectedVersion:source.hash,expectedRevision:1,active:false});expect(f.store.context('chat','chat-session','claude','').items).toEqual([]);
 });
});
