import { realpathSync, statSync } from 'node:fs';
import { rolloutHeads } from '../src/adapters/codex.js';
import { subagentFiles, transcriptIndex } from '../src/adapters/subagents.js';
import { estimateCost, PRICE_DATE, type TokenUsage, type TranscriptStatsReader } from './transcript-stats.js';

const empty = (): TokenUsage => ({ input:0, output:0, cacheRead:0, cacheWrite:0, messages:0, byModel:{} });
function add(to: TokenUsage, from: TokenUsage) {
  for (const k of ['input','output','cacheRead','cacheWrite','messages'] as const) to[k] += from[k];
  for (const [model, values] of Object.entries(from.byModel)) {
    const m = to.byModel[model] ??= { input:0, output:0, cacheRead:0, cacheWrite:0 };
    for (const k of ['input','output','cacheRead','cacheWrite'] as const) m[k] += values[k];
  }
}
interface Project { id: string; name: string; conversations?: { sessionId:string; title?:string }[] }
interface Context { adapter: { id:string }; providerSessionId:string; configDirs:string[] }
interface Source { file:string; agent:boolean }

/** One budget across both providers and their agents. Cached figures remain
 * visible while the unread portion converges over subsequent requests. */
export function projectCosts(projects: Project[], context: (pid:string,sid:string)=>Context, running:Set<string>, stats:TranscriptStatsReader, budget=400) {

  const claude=new Map<string,Map<string,string>>(), codex=new Map<string,ReturnType<typeof rolloutHeads>>();
  const seen=new Set<string>();
  const rows=projects.flatMap(p=>(p.conversations??[]).map(c=>({ projectId:p.id,projectName:p.name,sessionId:c.sessionId,title:c.title??c.sessionId.slice(0,8),running:running.has(`${p.id}/${c.sessionId}`), usage:empty(), cost:{usd:0,unpriced:[] as string[]}, agentCost:{usd:0,unpriced:[] as string[]}, agentCount:0, partial:false,scanned:0,size:0,missing:false, sources:[] as Source[] })));
  for (const row of rows) {
    try {
      const {adapter,providerSessionId:id,configDirs}=context(row.projectId,row.sessionId), key=configDirs.join('\0');
      let files:Source[]=[];
      if(adapter.id==='claude') {
        let index=claude.get(key);if(!index){index=transcriptIndex(configDirs);claude.set(key,index);}
        const own=index.get(id); if(own)files.push({file:own,agent:false}); else row.missing=true;
        files.push(...[...subagentFiles(configDirs,id).values()].map(file=>({file,agent:true})));
      } else if(adapter.id==='codex') {
        let heads=codex.get(key);if(!heads){heads=rolloutHeads(configDirs);codex.set(key,heads);}
        const own=heads.find(h=>h.id===id); if(own)files.push({file:own.file,agent:false});else row.missing=true;
        const descendants=new Set([id]);let changed=true;
        while(changed){changed=false;for(const h of heads)if(h.parent&&descendants.has(h.parent)&&!descendants.has(h.id)){descendants.add(h.id);files.push({file:h.file,agent:true});changed=true;}}
      } else row.missing=true;
      for(const source of files){
        let file:string;try{file=realpathSync(source.file);}catch{row.missing=true;continue;}
        // A shared CODEX_HOME or imported alias cannot multiply a transcript.
        if(seen.has(file))continue;seen.add(file);row.sources.push({...source,file});
      }
    } catch { row.missing=true; }
  }
  const jobs=rows.flatMap(row=>row.sources.map(source=>{
    const known=stats.cached(source.file);let size=known?.size??0;try{size=statSync(source.file).size;}catch{row.missing=true;}
    return {row,source,known,size};
  }));
  jobs.sort((a,b)=>Number(b.row.running)-Number(a.row.running)||Number(!!b.known)-Number(!!a.known)||a.size-b.size);
  const start=Date.now();
  let pending=0,pendingBytes=0;
  for(const job of jobs){
    let st=job.known;
    const left=budget-(Date.now()-start);
    if((!st||st.partial)&&left>0)st=stats.statsFor(job.source.file,Math.max(1,left*60_000));
    const unread=Math.max(0,job.size-(st?.scanned??0));
    if(unread){pending++;pendingBytes+=unread;job.row.partial=true;}
    job.row.size+=job.size;job.row.scanned+=st?.scanned??0;
    if(job.source.agent)job.row.agentCount++;
    if(!st)continue;
    add(job.row.usage,st.usage);
    if(job.source.agent){const c=estimateCost(st.usage);job.row.agentCost.usd+=c.usd;job.row.agentCost.unpriced.push(...c.unpriced);}
  }
  for(const row of rows)row.cost=estimateCost(row.usage);
  const groups=projects.map(p=>{
    const conversations=rows.filter(r=>r.projectId===p.id),usage=empty();conversations.forEach(r=>add(usage,r.usage));
    return {projectId:p.id,projectName:p.name,usage,cost:estimateCost(usage),conversations:conversations.length,agentCount:conversations.reduce((n,r)=>n+r.agentCount,0),agentUsd:conversations.reduce((n,r)=>n+r.agentCost.usd,0),partial:conversations.some(r=>r.partial),missing:conversations.filter(r=>r.missing).length};
  }).sort((a,b)=>b.cost.usd-a.cost.usd);
  const total=empty();rows.forEach(r=>add(total,r.usage));
  return {conversations:rows.map(({sources,...r})=>r),projects:groups,totals:{...total,...estimateCost(total)},pending,pendingBytes,missing:rows.filter(r=>r.missing).length,running:rows.filter(r=>r.running).length,
    pricing:{date:PRICE_DATE,basis:'Standard API token rates; subscription charges, tool fees, priority/fast tiers and long-context premiums are excluded. Cache writes use the 5-minute rate. Recorded conversation and subagent usage only; this is not a bill or a forecast.'}};
}
