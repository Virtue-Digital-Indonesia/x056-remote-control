import 'reflect-metadata';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../server/main.js';
import { AccountRegistry } from '../src/accounts.js';

const token='project-audit-fixture-token-0123456789',auth={Authorization:'Bearer '+token};
let app:INestApplication,base:string,a:any,b:any,chat:any,reader:any,doc:any,note:any;
const api=(path:string,body?:unknown)=>fetch(base+path,{method:body===undefined?'GET':'POST',headers:{...auth,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
const json=async(path:string,body?:unknown)=>{const response=await api(path,body);const data=await response.json();expect(response.ok,JSON.stringify({path,status:response.status,data})).toBe(true);return data;};
beforeAll(async()=>{
 const root=mkdtempSync(join(tmpdir(),'project-audit-')),workspaceRoot=join(root,'workspace');mkdirSync(workspaceRoot);
 mkdirSync(join(root,'state'));mkdirSync(join(root,'account'));
 AccountRegistry.init(join(root,'state','accounts.json'),[{name:'fixture',configDir:join(root,'account')}]);
 app=await createApp({token,stateDir:join(root,'state'),workspaceRoot,chatEnabled:true,projectSpacesEnabled:true});await app.listen(0,'127.0.0.1');base=await app.getUrl();
 a=await json('/api/project-spaces',{requestId:randomUUID(),name:'Proposal'});b=await json('/api/project-spaces',{requestId:randomUUID(),name:'Research'});
 chat=await json('/api/chats',{requestId:randomUUID(),name:'Owner',spaceId:a.id});reader=await json('/api/chats',{requestId:randomUUID(),name:'Reader',spaceId:b.id});
 const form=new FormData();form.append('files',new Blob(['# Terms\nAuditPrivateSource retained original bytes.']),'terms.md');const uploaded=await fetch(base+'/api/project-spaces/'+a.id+'/files',{method:'POST',headers:{...auth,'x-upload-id':randomUUID()},body:form});expect(uploaded.ok).toBe(true);const file=(await uploaded.json()).files[0];
 doc=await json('/api/memory/documents',{operationId:randomUUID(),owner:{kind:'space',id:a.id},file:{ownerId:a.id,fileId:file.id,versionId:file.latestVersionId}});
 await vi.waitFor(async()=>{doc=(await json('/api/memory/documents/jobs?id='+doc.id)).document;expect(doc.state).toBe('ready');},{timeout:12000});
 note=await json('/api/memory/entry',{entry:{title:'Approved summary',content:'A shareable summary.',scope:'space',spaceId:a.id,status:'confirmed',sources:[{id:doc.id,versionId:doc.activeVersionId,label:'Terms'}]}});
},20000);
afterAll(async()=>{await app?.close();});
it('rejects identity, revision, archive and prototype fields in a settings update without changing state',async()=>{
 const original=await json('/api/project-spaces/'+a.id);
 for(const field of ['id','revision','archivedAt','createdAt','__proto__','constructor','requests','members']){
  const response=await api('/api/project-spaces/'+a.id,{expectedRevision:original.revision,[field]:field==='id'?'space_replaced':123});expect(response.status,field).toBe(400);
 }
 expect(await json('/api/project-spaces/'+a.id)).toEqual(original);
 const updated=await json('/api/project-spaces/'+a.id,{expectedRevision:original.revision,name:'Renamed proposal',defaultWorkProjectId:''});expect(updated.id).toBe(a.id);expect(updated.revision).toBe(original.revision+1);expect(updated.archivedAt).toBeUndefined();
});
it('requires authentication and rejects incomplete callers instead of returning library data',async()=>{
 const paths=['/api/project-spaces','/api/project-spaces/'+a.id,'/api/memory/documents','/api/memory/documents/jobs?id='+doc.id,'/api/memory/grants?kind=source&id='+doc.id,'/api/memory/source/read?id='+doc.id,'/api/memory/source/download?id='+doc.id+'&versionId='+doc.activeVersionId];
 for(const path of paths)expect((await fetch(base+path)).status,path).toBe(401);
 for(const query of [{callerProjectId:reader.id},{callerSessionId:reader.lastSessionId},{callerProjectId:reader.id,callerSessionId:''}]){
  const suffix='&'+new URLSearchParams(query as Record<string,string>);
  for(const path of ['source/read?id='+doc.id,'source/search?query=AuditPrivateSource','source?id='+doc.id,'sources?query=AuditPrivateSource','entry?id='+note.id,'search?query=summary','context?projectId='+reader.id,'source/download?id='+doc.id+'&versionId='+doc.activeVersionId])expect((await api('/api/memory/'+path+suffix)).status,path).toBe(400);
 }
 expect((await api('/api/memory/propose',{entry:{title:'Invalid caller',content:'No write',projectId:reader.id},callerProjectId:reader.id})).status).toBe(400);
 expect((await api('/api/memory/link',{from:note.id,to:note.id,kind:'related',callerSessionId:reader.lastSessionId})).status).toBe(400);
 expect((await json('/api/memory/source/read?id='+doc.id)).items[0].text).toContain('AuditPrivateSource');
});
it('keeps note grants separate from originals, revokes downloads and never permits a shared-file checkout',async()=>{
 const who=new URLSearchParams({callerProjectId:reader.id,callerSessionId:reader.lastSessionId}),read='/api/memory/source/read?id='+doc.id+'&'+who,download='/api/memory/source/download?id='+doc.id+'&versionId='+doc.activeVersionId+'&'+who;
 await json('/api/memory/grants',{operationId:randomUUID(),subject:{kind:'entry',id:note.id},recipient:{kind:'space',id:b.id},expectedVersion:String(note.revision),expectedRevision:0,active:true});
 const shared=await json('/api/memory/entry?id='+note.id+'&'+who);expect(shared.entry.content).toBe(note.content);expect(shared.sources[0].current).toBeUndefined();
 expect((await api(read)).status).toBe(400);expect((await api(download)).status).toBe(400);
 expect((await json('/api/memory/source/search?query=AuditPrivateSource&'+who)).items).toEqual([]);
 const grant=await json('/api/memory/grants',{operationId:randomUUID(),subject:{kind:'source',id:doc.id},recipient:{kind:'space',id:b.id},expectedVersion:doc.activeVersionId,expectedRevision:0,active:true});
 expect((await json(read)).items[0].citation.file.fileId).toBe(doc.file.fileId);
 const original=await api(download);expect(original.status).toBe(200);expect(original.headers.get('content-disposition')).toContain('attachment;');expect(original.headers.get('x-content-type-options')).toBe('nosniff');expect(original.headers.get('content-security-policy')).toContain('sandbox');expect(await original.text()).toContain('AuditPrivateSource');
 expect((await api('/api/project-spaces/'+a.id+'/files/'+doc.file.fileId+'/checkout',{versionId:doc.file.versionId,executionId:reader.id,sessionId:reader.lastSessionId})).status).toBe(400);
 await json('/api/memory/grants',{operationId:randomUUID(),subject:grant.subject,recipient:grant.recipient,expectedVersion:doc.activeVersionId,expectedRevision:grant.revision,active:false});
 expect((await api(read)).status).toBe(400);expect((await api(download)).status).toBe(400);
});
it('counts the selected memory bank and excludes file documents before source pagination',async()=>{
 const c=await json('/api/project-spaces',{requestId:randomUUID(),name:'Empty bank'}),empty=await json('/api/memory/stats?spaceId='+c.id);expect(empty.entries.every((e:any)=>e.count===0)).toBe(true);expect(empty.sources).toBe(0);
 const local=await json('/api/memory/stats?spaceId='+a.id);expect(local.entries.find((e:any)=>e.status==='confirmed').count).toBe(1);expect(local.sources).toBe(1);
 expect((await json('/api/memory/sources?spaceId='+a.id+'&omitFileDocuments=true')).total).toBe(0);
 expect((await json('/api/memory/sources?spaceId='+a.id)).total).toBe(1);
});
