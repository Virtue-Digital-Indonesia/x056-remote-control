import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ChatCapabilities, type AccountCapabilities } from '../server/chat-capabilities.js';
import { AccountRegistry } from '../src/accounts.js';
import { runSession } from '../src/failover.js';
import { EventLog } from '../src/eventlog.js';
import type { Project } from '../server/projects.js';

describe('Chat capability routing', () => {
  it('requires readiness and matching skill content while keeping account auth separate', async () => {
    const state=mkdtempSync(join(tmpdir(),'chat-cap-')), registry=AccountRegistry.init(join(state,'accounts.json'),[{name:'a',configDir:'/cfg/a'},{name:'b',configDir:'/cfg/b'},{name:'c',configDir:'/cfg/c'}]);
    const chat:Project={id:'chat',name:'Chat',cwd:state,provider:'claude',kind:'chat'};
    const rows:Record<string,AccountCapabilities>={
      a:{account:'a',errors:[],capabilities:[{key:'skill:docs',name:'docs',kind:'skill',state:'ready',fingerprint:'same'},{key:'plugin:drive',name:'drive',kind:'plugin',state:'ready'}]},
      b:{account:'b',errors:[],capabilities:[{key:'skill:docs',name:'docs',kind:'skill',state:'ready',fingerprint:'different'},{key:'plugin:drive',name:'drive',kind:'plugin',state:'ready'}]},
      c:{account:'c',errors:[],capabilities:[{key:'skill:docs',name:'docs',kind:'skill',state:'ready',fingerprint:'same'},{key:'plugin:drive',name:'drive',kind:'plugin',state:'authorization-needed'}]},
    };
    const service=new ChatCapabilities(state,()=>registry.list(),undefined as never,undefined as never,undefined,async a=>rows[a.name]);
    expect(await service.blocked(chat)).toEqual({});
    service.setRequirements(chat.id,[{key:'skill:docs',fingerprint:'same'},{key:'plugin:drive'}]);
    const blocked=await service.blocked(chat);
    expect(blocked.a).toBeUndefined();expect(blocked.b[0]).toContain('version differs');expect(blocked.c[0]).toContain('authorization-needed');
    expect(registry.explain(100,'claude',{}, {capabilityBlocks:blocked}).candidates.find(c=>c.name==='b')?.eligible).toBe(false);
    rows.b.capabilities[0].fingerprint='same';await service.inventory(chat,true);expect((await service.blocked(chat)).b).toBeUndefined();
  });
  it('routes actual turns only to accounts satisfying the task requirements', async () => {
    const state=mkdtempSync(join(tmpdir(),'chat-route-')),registry=AccountRegistry.init(join(state,'accounts.json'),[{name:'a',configDir:'/cfg/a'},{name:'b',configDir:'/cfg/b'}]);
    const used:string[]=[];
    const result=await runSession({registry,log:new EventLog(join(state,'events.jsonl')),sessionId:'chat-fixture',cwd:state,prompt:'Continue the proposal',accountEligibility:async()=>({a:['Required tool skill:docs: unavailable']}),startTurnFn:opts=>{
      used.push(opts.configDir);return {kill:()=>{},interrupt:()=>{},pid:1,done:Promise.resolve().then(()=>{opts.onEvent({type:'result',subtype:'success',is_error:false,result:'saved'});return {code:0,signal:null};})};
    }});
    expect(result.status).toBe('completed');expect(used).toEqual(['/cfg/b']);
  });
});
