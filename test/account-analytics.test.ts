import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountAnalytics } from '../src/account-analytics.js';
import { AccountRegistry } from '../src/accounts.js';
import { runSession } from '../src/failover.js';
import { EventLog } from '../src/eventlog.js';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(),'x056-analytics-')); dirs.push(d); return d; };
afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));

describe('account analytics', () => {
  it('attributes failover attempts separately, deduplicates Claude messages, and survives reload', () => {
    const d=dir(), metrics=new AccountAnalytics(d);
    const a=metrics.begin('a','claude');
    const event={type:'assistant', message:{id:'m1',model:'test-model',usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:100}}};
    a.observe(event);a.observe(event);a.finish('interrupted');a.finish('interrupted');
    const b=metrics.begin('b','claude'); b.observe({...event,message:{...event.message,id:'m2'}});b.finish('completed');
    const out=new AccountAnalytics(d).summary();
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({account:'a',attempts:1,interrupted:1,input:10,output:20,cached:100});
    expect(out.rows[1]).toMatchObject({account:'b',attempts:1,completed:1});
    expect(out.dates).toHaveLength(7);
    expect(metrics.summary(30,'codex').rows).toEqual([]);
  });
  it('uses Codex request usage without attributing earlier cumulative history or double counting cache', () => {
    const metrics=new AccountAnalytics(dir()), a=metrics.begin('g','codex','test-gpt');
    const event={type:'thread.tokenUsage.updated',turnId:'t',tokenUsage:{total:{inputTokens:500000,outputTokens:10000},last:{inputTokens:500,outputTokens:60,cachedInputTokens:400}}};
    a.observe(event);a.observe(event);a.observe({...event,tokenUsage:{...event.tokenUsage,total:{inputTokens:500500,outputTokens:10060}}});
    a.finish('completed');
    expect(metrics.summary().rows[0]).toMatchObject({input:200,output:120,cached:800,attempts:1,reported:1});
  });
  it('distinguishes missing token reports from measured zero, and excludes child-agent messages', () => {
    const metrics=new AccountAnalytics(dir()), a=metrics.begin('a','claude');
    a.observe({type:'assistant',parent_tool_use_id:'child',message:{usage:{input_tokens:500}}});a.finish('failed');
    expect(metrics.summary().rows[0]).toMatchObject({attempts:1,failed:1,reported:0,input:0});
  });
});

describe('account routing settings', () => {
  it('persists pause and provider policies without changing authentication or crossing providers', () => {
    const f=join(dir(),'accounts.json');const reg=AccountRegistry.init(f,[{name:'a',configDir:'a'},{name:'b',configDir:'b'},{name:'g',configDir:'g',provider:'codex'}]);
    reg.markOk('a');reg.setPaused('a',true);
    expect(reg.get('a').state.kind).toBe('ok');expect(reg.peekActive(1)?.name).toBe('b');
    expect(()=>reg.setActive('a')).toThrow(/resume/);
    reg.setAutomaticSwitching('claude',false);reg.markLimited('b',5000);
    expect(reg.peekActive(1)).toBeNull();expect(reg.peekActive(1,'codex')?.name).toBe('g');
    const loaded=AccountRegistry.load(f);expect(loaded.get('a').paused).toBe(true);expect(loaded.automaticSwitching('claude')).toBe(false);
    loaded.setPaused('a',false);loaded.setActive('a');expect(loaded.pickActive(1)?.name).toBe('a');
  });
  it('parks a limited turn with auto switching disabled, retaining account attribution', async () => {
    const d=dir(), registry=AccountRegistry.init(join(d,'accounts.json'),[{name:'a',configDir:'a'},{name:'b',configDir:'b'}]);
    registry.setAutomaticSwitching('claude',false);let calls=0;
    const analytics=new AccountAnalytics(d);
    const res=await runSession({registry,analytics,log:new EventLog(join(d,'events.jsonl')),sessionId:'s',cwd:d,prompt:'test',now:()=>1,forceSwitchSignal:false,startTurnFn:o=>{
      calls++;o.onEvent({type:'rate_limit_event',rate_limit_info:{status:'rejected',resetsAt:5000,rateLimitType:'five_hour'}});
      return {kill(){},interrupt(){},done:Promise.resolve({code:0,signal:null})};
    }});
    expect(calls).toBe(1);expect(res).toMatchObject({status:'parked',finalAccount:'a'});expect(registry.get('a').state.kind).toBe('limited');
    expect(analytics.summary().rows[0]).toMatchObject({account:'a',attempts:1});
  });
});
