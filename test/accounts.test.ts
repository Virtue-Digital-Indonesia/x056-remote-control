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
});
