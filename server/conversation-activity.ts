import { statSync } from 'node:fs';
import { readFilePage } from '../src/adapters/claude.js';
import { readHistoryPage as codexPage, rolloutHeads } from '../src/adapters/codex.js';
import { transcriptIndex } from '../src/adapters/subagents.js';
import type { Account } from '../src/accounts.js';
import type { Project } from './projects.js';

interface Reading { stamp:string; at:number|null; done:boolean; before?:number }
/** Message activity comes from transcripts, including conversations imported
 * before outcome tracking existed. Unchanged files are free after the first scan. */
export class ConversationActivity {
  private cache=new Map<string,Reading>();
  pending=0;
  enrich<T extends Project>(projects:T[],accounts:Account[],budgetMs=60) {
    this.pending=0;
    const claudeDirs=accounts.filter(a=>a.provider==='claude').map(a=>a.configDir),codexDirs=accounts.filter(a=>a.provider==='codex').map(a=>a.configDir);
    const claude=transcriptIndex(claudeDirs),codex=new Map(rolloutHeads(codexDirs).map(h=>[h.id,h.file]));
    const start=Date.now();
    return projects.map(p=>({...p,conversations:p.conversations?.map(c=>{
      const id=c.providerSessionId||c.sessionId,provider=c.provider||'claude',file=(provider==='codex'?codex:claude).get(id);
      if(!file)return {...c,lastMessageAt:null};
      try {
        const st=statSync(file),stamp=st.ino+':'+st.size+':'+st.mtimeMs;
        let hit=this.cache.get(file);
        if(!hit||hit.stamp!==stamp){hit={stamp,at:hit?.at??null,done:false};this.cache.set(file,hit);}
        if(!hit.done&&Date.now()-start<budgetMs){
          const page=provider==='codex'?codexPage(codexDirs,id,64,hit.before):readFilePage(file,64,hit.before);
          const last=[...page.rows].reverse().find(row=>['user','assistant','command'].includes(row.role)&&row.ts&&Number.isFinite(Date.parse(row.ts)));
          if(last){hit.at=Date.parse(last.ts!);hit.done=true;}
          else {hit.before=page.cursor;hit.done=page.done;if(page.done)hit.at=null;}
        }
        if(!hit.done)this.pending++;
        return {...c,lastMessageAt:hit.at};
      } catch {return {...c,lastMessageAt:null};}
    })}));
  }
}
