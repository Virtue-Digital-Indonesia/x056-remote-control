import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountRegistry } from '../src/accounts.js';
import { EventLog } from '../src/eventlog.js';

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'x056-')), 'accounts.json');
}

describe('AccountRegistry', () => {
  const specs = [
    { name: 'a', configDir: '/home/efran/.claude-x056-a' },
    { name: 'b', configDir: '/home/efran/.claude-x056-b' },
  ];

  it('init + load round-trips and picks the active account', () => {
    const file = freshFile();
    AccountRegistry.init(file, specs);
    const reg = AccountRegistry.load(file);
    expect(reg.pickActive(1000)?.name).toBe('a');
  });

  it('saves a nickname without changing routing, state, or the stable account key', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markOk('a');
    reg.setLabel('a', '  Personal workspace  ');
    const reloaded = AccountRegistry.load(file);
    expect(reloaded.get('a')).toMatchObject({ name: 'a', label: 'Personal workspace', state: { kind: 'ok' } });
    expect(reloaded.peekActive(1000)?.name).toBe('a');
    reloaded.setLabel('a', '');
    expect(AccountRegistry.load(file).get('a').label).toBeUndefined();
  });

  it('rejects invalid nicknames without changing persisted account data', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.setLabel('a', 'Work');
    for (const bad of ['x'.repeat(81), 'Work\u0000account', 'Work\naccount']) expect(() => reg.setLabel('a', bad)).toThrow();
    expect(() => reg.setLabel('missing', 'Work')).toThrow('unknown account');
    expect(AccountRegistry.load(file).get('a').label).toBe('Work');
  });

  it('markLimited fails over pickActive to the other account and persists', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000);
    expect(reg.pickActive(1000)?.name).toBe('b');
    const reloaded = AccountRegistry.load(file);
    expect(reloaded.get('a').state).toEqual({ kind: 'limited', until: 5000 });
  });

  it('markLimited records whether the reset time is estimated (our guess) vs a real reported time', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000); // no third arg — a real Anthropic-reported reset time
    expect(reg.get('a').state).toEqual({ kind: 'limited', until: 5000 });
    reg.markLimited('b', 6000, true); // our own cooldown guess
    expect(reg.get('b').state).toEqual({ kind: 'limited', until: 6000, estimated: true });
  });

  it('a limited account becomes usable again after its reset time', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000);
    reg.setActive('a');
    expect(reg.pickActive(6000)?.name).toBe('a');
  });

  it('returns null and earliestReset when both accounts are limited', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markLimited('a', 5000);
    reg.markLimited('b', 3000);
    expect(reg.pickActive(1000)).toBeNull();
    expect(reg.earliestReset()).toBe(3000);
  });

  it('load without file throws a setup hint', () => {
    expect(() => AccountRegistry.load(freshFile())).toThrow(/setup/i);
  });

  it('markOk sets state and persists across load', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markOk('a');
    expect(reg.get('a').state).toEqual({ kind: 'ok' });
    const reloaded = AccountRegistry.load(file);
    expect(reloaded.get('a').state).toEqual({ kind: 'ok' });
  });

  it('markUnauthenticated persists and makes the account unusable regardless of time (no reset to wait out)', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.setActive('a');
    reg.markUnauthenticated('a');
    expect(reg.get('a').state).toEqual({ kind: 'unauthenticated' });
    const reloaded = AccountRegistry.load(file);
    expect(reloaded.get('a').state).toEqual({ kind: 'unauthenticated' });
    // pickActive skips it at any point in time, exactly like a still-limited account
    expect(reg.pickActive(0)?.name).toBe('b');
    expect(reg.pickActive(1e15)?.name).toBe('b');
    // re-authenticating (markOk) makes it selectable again
    reg.markOk('a');
    reg.setActive('a');
    expect(reg.pickActive(0)?.name).toBe('a');
  });

  it('earliestReset falls back to now (not Infinity) when every account is unauthenticated', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.markUnauthenticated('a');
    reg.markUnauthenticated('b');
    expect(reg.pickActive(1000)).toBeNull();
    expect(Number.isFinite(reg.earliestReset())).toBe(true);
  });

  it("get('nope') throws unknown account error", () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    expect(() => reg.get('nope')).toThrow(/unknown account/);
  });

  it('mutating get() result does not change registry state', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    const acct = reg.get('a');
    acct.state = { kind: 'limited', until: 9999 };
    expect(reg.get('a').state).toEqual({ kind: 'unknown' });
    const reloaded = AccountRegistry.load(file);
    expect(reloaded.get('a').state).toEqual({ kind: 'unknown' });
  });

  it('mutating list() result does not change registry state', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    const accounts = reg.list();
    accounts[0].state = { kind: 'limited', until: 9999 };
    expect(reg.get('a').state).toEqual({ kind: 'unknown' });
  });

  it('add appends a third account and persists', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.add('c', '/cfg/c');
    expect(reg.list().map((a) => a.name)).toEqual(['a', 'b', 'c']);
    expect(AccountRegistry.load(file).get('c')).toEqual({ name: 'c', configDir: '/cfg/c', provider: 'claude', state: { kind: 'unknown' } });
    expect(() => reg.add('c', '/cfg/c2')).toThrow(/already exists/);
  });

  it('remove drops an account, repoints active off it, and refuses the last one', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    reg.add('c', '/cfg/c');
    reg.setActive('b');
    reg.remove('b'); // active was b → repoints to first remaining (a)
    expect(reg.list().map((a) => a.name)).toEqual(['a', 'c']);
    expect(reg.activeName()).toBe('a');
    reg.remove('c');
    expect(() => reg.remove('a')).toThrow(/last account/);
    expect(() => reg.remove('nope')).toThrow(/unknown account/); // (only reachable while >1, but still guarded)
  });

  it('peekActive reports who runs next WITHOUT mutating the active pointer, across N accounts', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, [...specs, { name: 'c', configDir: '/cfg/c' }]);
    reg.markLimited('a', 5000);
    reg.markLimited('b', 5000);
    // a (active) and b are limited; peek should skip to the usable c…
    expect(reg.peekActive(1000)?.name).toBe('c');
    // …but WITHOUT moving the active pointer (unlike pickActive).
    expect(reg.activeName()).toBe('a');
    expect(AccountRegistry.load(file).activeName()).toBe('a');
    // all limited → null
    reg.markLimited('c', 5000);
    expect(reg.peekActive(1000)).toBeNull();
  });

  it('has() reflects membership', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, specs);
    expect(reg.has('a')).toBe(true);
    expect(reg.has('z')).toBe(false);
  });

  it('never fails over across providers: a limited claude account does NOT hand off to a codex account', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, [
      { name: 'ca', configDir: '/cfg/ca', provider: 'claude' },
      { name: 'cb', configDir: '/cfg/cb', provider: 'claude' },
      { name: 'xa', configDir: '/cfg/xa', provider: 'codex' },
    ]);
    reg.markLimited('ca', 5000);
    reg.markLimited('cb', 5000);
    // Both claude accounts limited — the codex account is NOT a valid fallback.
    expect(reg.pickActive(1000, 'claude')).toBeNull();
    // …and the codex pool is independently usable.
    expect(reg.pickActive(1000, 'codex')?.name).toBe('xa');
  });

  it('keeps a separate active pointer per provider', () => {
    const file = freshFile();
    const reg = AccountRegistry.init(file, [
      { name: 'ca', configDir: '/cfg/ca', provider: 'claude' },
      { name: 'xa', configDir: '/cfg/xa', provider: 'codex' },
      { name: 'xb', configDir: '/cfg/xb', provider: 'codex' },
    ]);
    reg.setActive('xb'); // move the CODEX pointer
    expect(reg.activeName('codex')).toBe('xb');
    expect(reg.activeName('claude')).toBe('ca'); // claude pointer untouched
    expect(AccountRegistry.load(file).activeName('codex')).toBe('xb'); // persists
  });

  it('migrates a legacy single-`active` file into a claude provider pointer', () => {
    const file = freshFile();
    // Hand-write the OLD on-disk shape (pre-multi-provider): a bare `active`
    // string and accounts with no `provider` field.
    writeFileSync(file, JSON.stringify({
      active: 'b',
      accounts: [
        { name: 'a', configDir: '/cfg/a', state: { kind: 'ok' } },
        { name: 'b', configDir: '/cfg/b', state: { kind: 'ok' } },
      ],
    }));
    const reg = AccountRegistry.load(file);
    expect(reg.get('a').provider).toBe('claude'); // back-filled
    expect(reg.activeName('claude')).toBe('b'); // legacy `active` became the claude pointer
    // …and re-saving drops the legacy field.
    reg.markOk('a');
    expect(JSON.parse(readFileSync(file, 'utf8')).active).toBeUndefined();
  });
});

describe('EventLog', () => {
  it('appends timestamped jsonl lines and reads them back', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'x056-')), 'nested', 'events.jsonl');
    const log = new EventLog(file);
    log.append({ type: 'failover', from: 'a' });
    log.append({ type: 'parked' });
    const rows = log.read();
    expect(rows).toHaveLength(2);
    expect(rows[0].type).toBe('failover');
    expect(typeof rows[0].ts).toBe('string');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('read() on a file that was never written returns empty array', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'x056-')), 'events.jsonl');
    const log = new EventLog(file);
    expect(log.read()).toEqual([]);
  });
});

describe('provider routing policies', () => {
  function fleet() {
    return AccountRegistry.init(freshFile(),[{name:'a',configDir:'a'},{name:'b',configDir:'b'},{name:'c',configDir:'c'},{name:'g',configDir:'g',provider:'codex'}]);
  }
  it('follows priority and skips paused, limited, and unauthenticated accounts', () => {
    const reg=fleet();reg.setRouting('claude','priority',['c','b','a']);
    expect(reg.pickActive(1)?.name).toBe('c');reg.markLimited('c',100);
    expect(reg.pickActive(1)?.name).toBe('b');reg.setPaused('b',true);
    expect(reg.pickActive(1)?.name).toBe('a');reg.markUnauthenticated('a');
    expect(reg.pickActive(1)).toBeNull();expect(reg.pickActive(101)?.name).toBe('c');expect(reg.pickActive(1,'codex')?.name).toBe('g');
  });
  it('rotates once per selection, keeps previews read-only, and consumes manual override once', () => {
    const reg=fleet();reg.setRouting('claude','round-robin',['a','b','c']);
    expect(reg.peekActive(1)?.name).toBe('a');expect(reg.peekActive(1)?.name).toBe('a');
    expect(reg.pickActive(1)?.name).toBe('a');expect(reg.pickActive(1)?.name).toBe('b');
    reg.setActive('a');expect(reg.peekActive(1)?.name).toBe('a');expect(reg.pickActive(1)?.name).toBe('a');
    expect(reg.pickActive(1)?.name).toBe('b');reg.markLimited('c',100);expect(reg.pickActive(1)?.name).toBe('a');
  });
  it('chooses fewest active turns and breaks ties by priority', () => {
    const reg=fleet();reg.setRouting('claude','least-busy',['c','b','a']);
    expect(reg.pickActive(1,'claude',{a:2,b:1,c:3})?.name).toBe('b');
    expect(reg.pickActive(1,'claude',{a:1,b:1,c:1})?.name).toBe('c');
    reg.setPaused('c',true);expect(reg.pickActive(1,'claude',{a:0,b:0})?.name).toBe('b');
  });
  it('waits for the selected account even when another is free; validates complete provider order', () => {
    const reg=fleet();reg.setRouting('claude','wait',['a','b','c']);reg.markLimited('a',100);
    expect(reg.pickActive(1)).toBeNull();expect(reg.pickActive(101)?.name).toBe('a');
    for(const order of [['a','a','c'],['a','b'],['a','b','g']]) expect(()=>reg.setRouting('claude','priority',order)).toThrow();
    expect(reg.routingPolicy('claude')).toEqual({strategy:'wait',order:['a','b','c']});
  });
});
