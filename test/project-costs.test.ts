import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectCosts } from '../server/project-costs.js';
import { TranscriptStatsReader } from '../server/transcript-stats.js';

const jsonl=(lines:unknown[])=>lines.map(l=>JSON.stringify(l)).join('\n')+'\n';
const token=(n:number)=>({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,cached_input_tokens:n/2,output_tokens:n/10}}}});
function setup(){
 const d=mkdtempSync(join(tmpdir(),'project-costs-')),home=join(d,'home'),alias=join(d,'alias');mkdirSync(join(home,'sessions'),{recursive:true});mkdirSync(alias);symlinkSync(join(home,'sessions'),join(alias,'sessions'));
 const rollout=(id:string,parent?:string)=>{const file=join(home,'sessions',`rollout-test-${id}.jsonl`);writeFileSync(file,jsonl([{type:'session_meta',payload:{id,parent_thread_id:parent}},{type:'turn_context',payload:{model:'gpt-6-astra'}},token(1000)]));return file;};
 rollout('root');rollout('child','root');rollout('grandchild','child');rollout('unrelated');
 const projects=[{id:'p',name:'Project',conversations:[{sessionId:'root',title:'Build'}]},{id:'empty',name:'Empty project',conversations:[]}];
 const context=()=>({adapter:{id:'codex'},providerSessionId:'root',configDirs:[home,alias]});
 return {d,home,projects,context,stats:new TranscriptStatsReader(d)};
}
it('includes nested Codex agents once, preserving a project and conversation breakdown',()=>{
 const f=setup(),r=projectCosts(f.projects,f.context,new Set(),f.stats,1000);
 expect(r.pending).toBe(0);expect(r.missing).toBe(0);expect(r.projects[0].agentCount).toBe(2);
 expect(r.totals).toMatchObject({input:1500,cacheRead:1500,output:300});
 expect(r.projects[0].cost.usd).toBeCloseTo(.0315);expect(r.projects[0].agentUsd).toBeCloseTo(.021);
 expect(r.projects[1].conversations).toBe(0);
});
it('keeps unscanned conversations visible and converges on repeated requests',()=>{
 const f=setup(),cold=projectCosts(f.projects,f.context,new Set(),f.stats,0);
 expect(cold.conversations).toHaveLength(1);expect(cold.pending).toBe(3);expect(cold.projects[0].partial).toBe(true);
 const warm=projectCosts(f.projects,f.context,new Set(),f.stats,1000);
 expect(warm.pendingBytes).toBe(0);expect(warm.projects[0].partial).toBe(false);
 appendFileSync(join(f.home,'sessions','rollout-test-root.jsonl'),jsonl([token(2000)]));
 expect(projectCosts(f.projects,f.context,new Set(),f.stats,1000).totals.output).toBe(400);
});
it('reports missing transcripts instead of calling a project fully priced',()=>{
 const f=setup();const r=projectCosts(f.projects,()=>({...f.context(),providerSessionId:'missing'}),new Set(),f.stats);
 expect(r.missing).toBe(1);expect(r.projects.find(p=>p.projectId==='p')?.missing).toBe(1);
});
it('does not call an unsent conversation a missing transcript',()=>{
 const f=setup();Object.assign(f.projects[0].conversations[0],{lastMessageAt:null});
 const r=projectCosts(f.projects,()=>({...f.context(),providerSessionId:'missing'}),new Set(),f.stats);
 expect(r.missing).toBe(0);expect(r.unstarted).toBe(1);
 expect(r.conversations[0]).toMatchObject({missing:false,unstarted:true,size:0});
 expect(r.projects.find(p=>p.projectId==='p')?.unstarted).toBe(1);
});
