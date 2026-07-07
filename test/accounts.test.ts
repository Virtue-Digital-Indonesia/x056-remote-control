import { mkdtempSync, readFileSync } from 'node:fs';
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
