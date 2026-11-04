import type { ProjectSpaceRegistry } from './project-space-registry.js';
import { realpathSync, statSync, type Stats } from 'node:fs';
import { rolloutHeads } from '../src/adapters/codex.js';
import { sessionIndex, sessionSubagentDir, subagentTranscripts, type SessionIndex } from '../src/adapters/subagents.js';
import { estimateCost, PRICE_DATE, type TokenUsage, type TranscriptStatsReader } from './transcript-stats.js';
import { archivedIdentity } from './archived-usage.js';

const dates = (...sets: string[][]) => [...new Set(sets.flat())].sort();

const empty = (): TokenUsage => ({ input:0, output:0, cacheRead:0, cacheWrite:0, messages:0, byModel:{} });
function add(to: TokenUsage, from: TokenUsage) {
  for (const k of ['input','output','cacheRead','cacheWrite','messages'] as const) to[k] += from[k];
  for (const [model, values] of Object.entries(from.byModel)) {
    const m = to.byModel[model] ??= { input:0, output:0, cacheRead:0, cacheWrite:0 };
    for (const k of ['input','output','cacheRead','cacheWrite'] as const) m[k] += values[k];
  }
}
interface Project { id: string; name: string; conversations?: { sessionId:string; title?:string; lastMessageAt?: number | null }[] }
/** Group already-counted rows; never rescan or add the same transcript twice. */
export function groupSpaceCosts(result: ReturnType<typeof projectCosts>, projects: (Project & { kind?: string; parentProjectId?: string })[], registry?:ProjectSpaceRegistry): (ReturnType<typeof projectCosts>['projects'][number]&{projectIds:string[];conversationKeys?:string[];basis?:string})[] {
  if(registry)return groupEffectiveSpaceCosts(result,projects,registry);
  const groups = new Map<string, typeof result.projects[number] & { projectIds: string[] }>();
  for (const row of result.projects) {
    const execution = projects.find(p => p.id === row.projectId);
    const parent = execution?.parentProjectId ? projects.find(p => p.id === execution.parentProjectId && p.kind !== 'chat') : undefined;
    const id = parent?.id || (execution?.kind === 'chat' ? '__standalone_chats__' : row.projectId);
    let group = groups.get(id);
    if (!group) { group = { ...row, projectId: id, projectName: parent?.name || (execution?.kind === 'chat' ? 'Standalone Chat' : row.projectName), projectIds: [], usage: empty(), cost: { usd: 0, unpriced: [] }, conversations: 0, agentCount: 0, agentUsd: 0, missing: 0, unstarted: 0, archivedRecords: 0, archiveDates: [], partial: false }; groups.set(id, group); }
    group.projectIds.push(row.projectId); add(group.usage, row.usage);
    for (const key of ['conversations','agentCount','agentUsd','missing','unstarted','archivedRecords'] as const) group[key] += row[key];
    group.archiveDates = dates(group.archiveDates, row.archiveDates);
    group.partial ||= row.partial; group.cost = estimateCost(group.usage);
  }
  return [...groups.values()].sort((a,b) => b.cost.usd-a.cost.usd);
}
function groupEffectiveSpaceCosts(result:ReturnType<typeof projectCosts>,projects:(Project&{kind?:string})[],registry:ProjectSpaceRegistry){
  const view=registry.readView(),groups=new Map<string,ReturnType<typeof groupSpaceCosts>[number]&{conversationKeys:string[];basis:string}>();
  const ensure=(id:string,name:string)=>{let g=groups.get(id);if(!g){g={projectId:id,projectName:name,projectIds:[],conversationKeys:[],basis:'Recorded conversation usage under current primary membership. Archived snapshots may be incomplete; references are excluded.',usage:empty(),cost:{usd:0,unpriced:[]},conversations:0,agentCount:0,agentUsd:0,missing:0,unstarted:0,archivedRecords:0,archiveDates:[],partial:false};groups.set(id,g);}return g;};
  for(const space of view.state.spaces)ensure(space.id,space.name);
  for(const p of projects)if(!p.conversations?.length&&!view.defaultForWork(p.id))ensure(p.kind==='chat'?'__standalone_chats__':p.id,p.kind==='chat'?'Standalone Chat':p.name);
  const seen=new Set<string>();
  for(const row of result.conversations){
    const key=JSON.stringify([row.projectId,row.sessionId]);if(seen.has(key))continue;seen.add(key);
    const p=projects.find(p=>p.id===row.projectId),spaceId=view.resolve(row.projectId,row.sessionId).spaceId,space=view.state.spaces.find(s=>s.id===spaceId);
    const g=ensure(spaceId|| (p?.kind==='chat'?'__standalone_chats__':row.projectId),space?.name|| (p?.kind==='chat'?'Standalone Chat':row.projectName));
    if(!g.projectIds.includes(row.projectId))g.projectIds.push(row.projectId);g.conversationKeys.push(key);g.conversations++;add(g.usage,row.usage);
    g.agentCount+=row.agentCount;g.agentUsd+=row.agentCost.usd;g.missing+=Number(row.missing);g.unstarted+=Number(row.unstarted);g.partial ||= row.partial;g.cost=estimateCost(g.usage);
    g.archivedRecords += row.archivedRecords; g.archiveDates = dates(g.archiveDates, row.archiveDates);
  }
  return [...groups.values()].sort((a,b)=>b.cost.usd-a.cost.usd);
}
interface Context { adapter: { id:string }; providerSessionId:string; configDirs:string[] }
interface Source { file:string; agent:boolean }
/** A resolved transcript: `file` is its realpath, `orig` the listed path
 *  (whose layout carries the logical identity), `size` from ONE stat. */
interface Entry extends Source { orig:string; size:number; born:number }

/**
 * Per-call I/O, for tests and benchmarks: realpath resolutions actually run
 * and per-file stats (the parent stat that keys the conversation cache and
 * the subagents dir stat are not per-file and are not counted).
 */
export const projectCostsIo = { realpath: 0, fileStat: 0 };

/** path -> realpath for the life of the process, checked against the inode a
 *  fresh stat of the path returns (a retargeted symlink resolves again) and
 *  dropped when the stat fails. Never derived by prefix substitution: a
 *  relinked transcript is a symlink into ANOTHER project dir, and must
 *  resolve to the file it points at or it would be counted twice. */
const REAL_MAX = 50_000;
const realMemo = new Map<string, { real: string; ino: number }>();
function resolveReal(path: string, st: Stats): string {
  const hit = realMemo.get(path);
  if (hit && hit.ino === st.ino) return hit.real;
  projectCostsIo.realpath++;
  const real = realpathSync.native(path);
  if (realMemo.size >= REAL_MAX) realMemo.clear();
  realMemo.set(path, { real, ino: st.ino });
  return real;
}
function statPath(path: string): Stats | undefined {
  try { return statSync(path, { throwIfNoEntry: false }); } catch { return undefined; }
}

/**
 * Per conversation, what its transcripts resolved to and how big they were,
 * keyed by the parent transcript's ino:size:mtime and the subagent listing
 * (Claude: the subagents dir and its mtime and count; Codex: the descendant
 * rollout paths). A conversation that is not running and has no background
 * work reuses it without a per-file stat; one that is re-stats every file.
 * Anything older than REFRESH_MS is re-stat'd regardless, which catches a
 * subagent file that grew while nothing listed changed. Per stats reader, so
 * two state dirs (tests) never share entries.
 */
const REFRESH_MS = 10 * 60_000;
interface ConvMemo { key:string; at:number; entries:Entry[] }
const convMemos = new WeakMap<TranscriptStatsReader, Map<string, ConvMemo>>();

export interface ProjectCostsOptions {
  /** `projectId/sessionId` of conversations whose transcripts may be growing
   *  without a gateway turn (background work): never served from the
   *  conversation cache. Rows in `running` never are either. */
  active?: Set<string>;
  now?: number;
}

/** One budget across both providers and their agents. Cached figures remain
 * visible while the unread portion converges over subsequent requests. */
export function projectCosts(projects: Project[], context: (pid:string,sid:string)=>Context, running:Set<string>, stats:TranscriptStatsReader, budget=400, opts:ProjectCostsOptions={}) {
  const now=opts.now??Date.now();
  let memos=convMemos.get(stats);if(!memos){memos=new Map();convMemos.set(stats,memos);}
  const claude=new Map<string,SessionIndex>(), codex=new Map<string,ReturnType<typeof rolloutHeads>>();
  const seen=new Set<string>(), liveIdentities=new Set<string>(), parentOwners=new Map<string, number>();
  const rows=projects.flatMap(p=>(p.conversations??[]).map(c=>({ projectId:p.id,projectName:p.name,sessionId:c.sessionId,title:c.title??c.sessionId.slice(0,8),running:running.has(`${p.id}/${c.sessionId}`), usage:empty(), cost:{usd:0,unpriced:[] as string[]}, agentCost:{usd:0,unpriced:[] as string[]}, agentCount:0, archivedRecords:0,archiveDates:[] as string[],archiveParent:'',partial:false,scanned:0,size:0,missing:false,unstarted:c.lastMessageAt===null, sources:[] as Entry[] })));
  for (const row of rows) {
    try {
      const {adapter,providerSessionId:id,configDirs}=context(row.projectId,row.sessionId), key=configDirs.join('\0');
      const listed:Source[]=[];let ownStat:Stats|undefined,listing='',sortAgents=false;
      if(adapter.id==='claude') {
        row.archiveParent=id;parentOwners.set(id,(parentOwners.get(id)||0)+1);
        let index=claude.get(key);if(!index){index=sessionIndex(configDirs);claude.set(key,index);}
        const own=index.transcripts.get(id); if(own)listed.push({file:own,agent:false}); else if(!row.unstarted)row.missing=true;
        // Names only: the subagent files' own stats are what the cache saves.
        const sub=sessionSubagentDir(index,id),agents=sub?subagentTranscripts(sub.dir,sub.mtimeMs):[];
        listed.push(...agents.map(file=>({file,agent:true})));
        listing=sub?`${sub.dir}\0${sub.mtimeMs}\0${agents.length}`:'';sortAgents=true;
      } else if(adapter.id==='codex') {
        let heads=codex.get(key);if(!heads){heads=rolloutHeads(configDirs);codex.set(key,heads);}
        const own=heads.find(h=>h.id===id); if(own)listed.push({file:own.file,agent:false});else if(!row.unstarted)row.missing=true;
        const descendants=new Set([id]);let changed=true;
        while(changed){changed=false;for(const h of heads)if(h.parent&&descendants.has(h.parent)&&!descendants.has(h.id)){descendants.add(h.id);listed.push({file:h.file,agent:true});changed=true;}}
        listing=listed.map(s=>s.file).join('\0');
      } else row.missing=true;
      const parent=listed[0]&&!listed[0].agent?listed[0]:undefined;
      if(parent)ownStat=statPath(parent.file);
      const convKey=`${row.projectId}/${row.sessionId}`;
      const memoKey=ownStat?`${ownStat.ino}:${ownStat.size}:${ownStat.mtimeMs}\0${listing}`:'';
      const memo=memos.get(convKey);
      let entries:Entry[];
      if(memoKey&&memo&&memo.key===memoKey&&now-memo.at<REFRESH_MS&&!row.running&&!opts.active?.has(convKey)) entries=memo.entries;
      else {
        entries=[];let complete=true;
        for(const source of listed){
          let st:Stats|undefined;
          if(source===parent)st=ownStat;else{projectCostsIo.fileStat++;st=statPath(source.file);}
          let file:string|undefined;
          if(st)try{file=resolveReal(source.file,st);}catch{file=undefined;}
          if(!file){
            realMemo.delete(source.file);complete=false;
            // listSubagents() skipped a subagent file it could not stat; a
            // listed parent or Codex rollout that vanished is missing.
            if(!(sortAgents&&source.agent))row.missing=true;
            continue;
          }
          entries.push({...source,orig:source.file,file,size:st!.size,born:st!.birthtimeMs||st!.ctimeMs});
        }
        // Same order listSubagents() returned: oldest first, stable.
        if(sortAgents){const head=entries.filter(e=>!e.agent),agents=entries.filter(e=>e.agent);agents.sort((a,b)=>a.born-b.born);entries=[...head,...agents];}
        if(memoKey&&complete)memos.set(convKey,{key:memoKey,at:now,entries});else memos.delete(convKey);
      }
      for(const source of entries){
        const logical=archivedIdentity(source.orig)?.identity;
        if(logical){if(liveIdentities.has(logical))continue;liveIdentities.add(logical);}
        // A shared CODEX_HOME or imported alias cannot multiply a transcript.
        if(seen.has(source.file))continue;seen.add(source.file);row.sources.push(source);
      }
    } catch { row.missing=true; }
  }
  const jobs=rows.flatMap(row=>row.sources.map(source=>({row,source,known:stats.cachedReal(source.file,source.size),size:source.size})));
  jobs.sort((a,b)=>Number(b.row.running)-Number(a.row.running)||Number(!!b.known)-Number(!!a.known)||a.size-b.size);
  const start=Date.now();
  let pending=0,pendingBytes=0;
  for(const job of jobs){
    let st=job.known;
    const left=budget-(Date.now()-start);
    if((!st||st.partial)&&left>0)st=stats.statsFor(job.source.file,Math.max(1,left*60_000),{real:true});
    const unread=Math.max(0,job.size-(st?.scanned??0));
    if(unread){pending++;pendingBytes+=unread;job.row.partial=true;}
    job.row.size+=job.size;job.row.scanned+=st?.scanned??0;
    if(job.source.agent)job.row.agentCount++;
    if(!st)continue;
    add(job.row.usage,st.usage);
    if(job.source.agent){const c=estimateCost(st.usage);job.row.agentCost.usd+=c.usd;job.row.agentCost.unpriced.push(...c.unpriced);}
  }
  const archivedSeen=new Set<string>();
  for(const row of rows){
    // A parent registered under multiple conversations has ambiguous ownership.
    // Keep its missing signal; never guess which Project should receive evidence.
    if(row.archiveParent && parentOwners.get(row.archiveParent)===1){
      for(const archived of stats.archives.forParent(row.archiveParent)){
        if(liveIdentities.has(archived.identity)||archivedSeen.has(archived.identity))continue;
        archivedSeen.add(archived.identity);add(row.usage,archived.usage);
        if(archived.usage.messages||archived.usage.input+archived.usage.output+archived.usage.cacheRead+archived.usage.cacheWrite)row.unstarted=false;
        row.archivedRecords++;row.archiveDates=dates(row.archiveDates,archived.asOf?[archived.asOf]:[]);
        // Archived bytes are evidence, not a currently available transcript.
        row.missing=true;
        if(archived.agent){row.agentCount++;const c=estimateCost(archived.usage);row.agentCost.usd+=c.usd;row.agentCost.unpriced.push(...c.unpriced);}
      }
    }
    row.cost=estimateCost(row.usage);
  }
  const groups=projects.map(p=>{
    const conversations=rows.filter(r=>r.projectId===p.id),usage=empty();conversations.forEach(r=>add(usage,r.usage));
    return {projectId:p.id,projectName:p.name,usage,cost:estimateCost(usage),conversations:conversations.length,agentCount:conversations.reduce((n,r)=>n+r.agentCount,0),agentUsd:conversations.reduce((n,r)=>n+r.agentCost.usd,0),archivedRecords:conversations.reduce((n,r)=>n+r.archivedRecords,0),archiveDates:dates(...conversations.map(r=>r.archiveDates)),partial:conversations.some(r=>r.partial),missing:conversations.filter(r=>r.missing).length,unstarted:conversations.filter(r=>r.unstarted).length};
  }).sort((a,b)=>b.cost.usd-a.cost.usd);
  const total=empty();rows.forEach(r=>add(total,r.usage));
  return {conversations:rows.map(({sources,archiveParent,...r})=>r),projects:groups,totals:{...total,...estimateCost(total),archivedRecords:rows.reduce((n,r)=>n+r.archivedRecords,0),archiveDates:dates(...rows.map(r=>r.archiveDates))},pending,pendingBytes,missing:rows.filter(r=>r.missing).length,unstarted:rows.filter(r=>r.unstarted).length,running:rows.filter(r=>r.running).length,
    pricing:{date:PRICE_DATE,basis:'Recorded conversation and subagent tokens repriced at current Standard short-context API rates. Subscription charges, tool fees, processing-tier adjustments, regional and long-context premiums are excluded. Cache writes assume the 5-minute rate. This is an API-equivalent estimate, not historical spending, a bill or a forecast.'}};
}

/**
 * GET /api/usage/all's body, without the controller: `projects` is ONE
 * listProjects() result (used for the costs and the space grouping alike) and
 * `context` one historyContexts() snapshot, so a call parses projects.json a
 * constant number of times however many conversations there are.
 */
export function usageAllReport(args: { projects: (Project & { kind?: string; parentProjectId?: string })[]; context: (pid:string,sid:string)=>Context; running: Set<string>; active?: Set<string>; stats: TranscriptStatsReader; budget: number; spaces?: ProjectSpaceRegistry }) {
  const result = projectCosts(args.projects, args.context, args.running, args.stats, args.budget, { active: args.active });
  return { ...result, ...(args.spaces ? { projectSpaces: groupSpaceCosts(result, args.projects, args.spaces) } : {}) };
}
