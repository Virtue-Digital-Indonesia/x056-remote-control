import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationActivity } from '../server/conversation-activity.js';
import type { Account } from '../src/accounts.js';

describe('conversation last-message activity',()=>{
 it('uses imported messages rather than creation, outcomes or later tool activity, and refreshes its cache',()=>{
  const dir=mkdtempSync(join(tmpdir(),'x056-last-message-'));mkdirSync(join(dir,'projects','project'),{recursive:true});
  const file=join(dir,'projects','project','chat.jsonl');
  const message=(ts:string,text:string)=>JSON.stringify({type:'assistant',timestamp:ts,message:{role:'assistant',content:[{type:'text',text}]}})+'\n';
  writeFileSync(file,message('2026-09-04T09:00:00Z','Last real message')+JSON.stringify({type:'assistant',timestamp:'2026-09-06T09:00:00Z',message:{role:'assistant',content:[{type:'tool_use',id:'t',name:'Read',input:{file_path:'x'}}]}})+'\n');
  const projects=[{id:'p',name:'Imported',cwd:dir,conversations:[{sessionId:'chat',title:'Imported conversation',createdAt:Date.parse('2026-08-01')},{sessionId:'missing',title:'Missing',createdAt:1}]}];
  const accounts:Account[]=[{name:'a',configDir:dir,provider:'claude',state:{kind:'ok'}}],activity=new ConversationActivity();
  const read=()=>activity.enrich(projects,accounts,1000)[0].conversations!;
  activity.enrich(projects,accounts,0);expect(activity.pending).toBe(1);
  expect(read()[0].lastMessageAt).toBe(Date.parse('2026-09-04T09:00:00Z'));expect(activity.pending).toBe(0);
  expect(read()[1].lastMessageAt).toBeNull();
  appendFileSync(file,message('2026-09-07T09:00:00Z','New reply'));
  expect(read()[0].lastMessageAt).toBe(Date.parse('2026-09-07T09:00:00Z'));
  writeFileSync(file,message('2026-09-02T09:00:00Z','Rewritten history'));
  expect(read()[0].lastMessageAt).toBe(Date.parse('2026-09-02T09:00:00Z'));
 });
 it('resolves Codex provider thread ids and ignores trailing bookkeeping',()=>{
  const dir=mkdtempSync(join(tmpdir(),'x056-last-codex-')),day=join(dir,'sessions','2026','09','07');mkdirSync(day,{recursive:true});
  writeFileSync(join(day,'rollout-2026-09-07T09-00-00-thread.jsonl'),[
   {type:'session_meta',timestamp:'2026-09-01T00:00:00Z',payload:{id:'thread',cwd:dir}},
   {type:'event_msg',timestamp:'2026-09-05T10:00:00Z',payload:{type:'user_message',message:'Hello'}},
   {type:'event_msg',timestamp:'2026-09-05T10:02:00Z',payload:{type:'task_complete',last_agent_message:'Done'}},
   {type:'event_msg',timestamp:'2026-09-07T00:00:00Z',payload:{type:'token_count',info:{}}}
  ].map(x=>JSON.stringify(x)).join('\n')+'\n');
  const activity=new ConversationActivity();
  const result=activity.enrich([{id:'p',name:'Codex',cwd:dir,conversations:[{sessionId:'local-id',providerSessionId:'thread',provider:'codex' as const,title:'C',createdAt:1}]}],[{name:'d',configDir:dir,provider:'codex',state:{kind:'ok'}}],1000);
  expect(result[0].conversations![0].lastMessageAt).toBe(Date.parse('2026-09-05T10:02:00Z'));
 });
});
