import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quotaLimit } from '../src/account-availability.js';
import { AccountRegistry } from '../src/accounts.js';

describe('quota-aware account availability', () => {
  const now = Math.floor(Date.now()/1000);
  const reading = (quota: unknown) => ({at: now*1000, quota});
  it('uses exact provider scales and the last exhausted account-wide reset', () => {
    expect(quotaLimit('codex', reading({windows:[{utilization:0.9999,resetsAt:now+100}]}),now)).toBeNull();
    expect(quotaLimit('codex', reading({windows:[{utilization:1,resetsAt:now+100},{utilization:1,resetsAt:new Date((now+500)*1000).toISOString()}]}),now)).toEqual({kind:'limited',until:now+500});
    expect(quotaLimit('claude', reading({fiveHour:{utilization:100,resetsAt:now+100},weeklyScoped:[{utilization:100,resetsAt:now+900}]}),now)).toEqual({kind:'limited',until:now+100});
    expect(quotaLimit('claude', reading({fiveHour:{utilization:99},weeklyScoped:[{utilization:100,resetsAt:now+900}]}),now)).toBeNull();
  });
  it('expires cached exhausted windows, with a bounded cooldown when reset is missing', () => {
    expect(quotaLimit('codex',reading({windows:[{utilization:1,resetsAt:now}]}),now)).toBeNull();
    expect(quotaLimit('codex',reading({windows:[{utilization:1}]}),now)).toEqual({kind:'limited',until:now+300,estimated:true});
    expect(quotaLimit('codex',{at:(now-301)*1000,quota:{windows:[{utilization:1}]}},now)).toBeNull();
    expect(quotaLimit('codex',reading({windows:[null,{utilization:NaN}]}),now)).toBeNull();
  });
  it('excludes quota-exhausted accounts across routing strategies and resumes after reset', () => {
    const dir=mkdtempSync(join(tmpdir(),'x056-availability-'));
    const registry=AccountRegistry.init(join(dir,'accounts.json'),[{name:'a',configDir:dir,provider:'codex'},{name:'b',configDir:dir,provider:'codex'}]);
    registry.markOk('a');registry.markOk('b');
    writeFileSync(join(dir,'quota-cache.json'),JSON.stringify({a:reading({windows:[{utilization:1,resetsAt:now+500}]})}));
    for(const strategy of ['sticky','priority','round-robin','least-busy'] as const){
      registry.setRouting('codex',strategy,['a','b']);
      expect(registry.peekActive(now,'codex')?.name).toBe('b');
    }
    registry.setRouting('codex','wait',['a','b']);
    expect(registry.peekActive(now,'codex')).toBeNull();
    expect(registry.earliestReset('codex')).toBe(now+500);
    expect(registry.peekActive(now+501,'codex')?.name).toBe('a');
    expect(registry.get('a').state).toEqual({kind:'ok'}); // polling never overwrites CLI verdicts
    registry.overrideLimit('a');
    expect(registry.peekActive(now,'codex')?.name).toBe('a');
    writeFileSync(join(dir,'quota-cache.json'),JSON.stringify({a:{at:Date.now()+1000,quota:{windows:[{utilization:1,resetsAt:now+500}]}}}));
    expect(registry.peekActive(now,'codex')).toBeNull();
    registry.markUnauthenticated('a');
    registry.overrideLimit('a');
    expect(registry.effectiveState('a',now)).toEqual({kind:'unauthenticated'});
  });
});
