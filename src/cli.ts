import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AccountRegistry } from './accounts.js';
import { EventLog } from './eventlog.js';
import { runSession } from './failover.js';
import { fetchUsage } from './quota.js';
import type { RawEvent } from './types.js';

const STATE_DIR = join(process.cwd(), 'state');
const ACCOUNTS = join(STATE_DIR, 'accounts.json');
const STATE = join(STATE_DIR, 'state.json');
const PIDFILE = join(STATE_DIR, 'x056.pid');
const LOG = join(STATE_DIR, 'events.jsonl');

function printEvent(e: RawEvent): void {
  if (e.type === 'assistant') {
    const msg = e.message as { content?: { type: string; text?: string }[] } | undefined;
    for (const block of msg?.content ?? []) {
      if (block.type === 'text' && block.text) process.stdout.write(`\n${block.text}\n`);
    }
  }
}

function loadState(): { lastSessionId?: string } {
  return existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as { lastSessionId?: string }) : {};
}

async function main(): Promise<number> {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [command, arg] = positionals;

  if (command === 'init') {
    mkdirSync(STATE_DIR, { recursive: true });
    AccountRegistry.init(ACCOUNTS, [
      { name: 'a', configDir: join(homedir(), '.claude-x056-a') },
      { name: 'b', configDir: join(homedir(), '.claude-x056-b') },
    ]);
    console.log(`wrote ${ACCOUNTS}`);
    return 0;
  }

  if (command === 'status') {
    const registry = AccountRegistry.load(ACCOUNTS);
    for (const acct of registry.list()) {
      let quota = '';
      try {
        const u = await fetchUsage(acct.configDir);
        quota = `5h ${u.fiveHour.utilization}% (resets ${u.fiveHour.resetsAt}) · 7d ${u.sevenDay.utilization}%`;
      } catch (err) {
        quota = `quota: unavailable (${(err as Error).message})`;
      }
      console.log(`${acct.name}  ${JSON.stringify(acct.state)}  ${quota}`);
    }
    return 0;
  }

  if (command === 'switch') {
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
    process.kill(pid, 'SIGUSR1');
    console.log(`sent SIGUSR1 to ${pid}`);
    return 0;
  }

  if (command === 'run' || command === 'continue') {
    if (!arg) {
      console.error(`usage: x056 ${command} "<text>"`);
      return 2;
    }
    const registry = AccountRegistry.load(ACCOUNTS);
    const log = new EventLog(LOG);
    const resume = command === 'continue';
    const sessionId = resume
      ? (loadState().lastSessionId ?? (() => { throw new Error('no previous session — use run'); })())
      : randomUUID();
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ lastSessionId: sessionId }));
    writeFileSync(PIDFILE, String(process.pid));

    const res = await runSession({
      registry, log, sessionId,
      cwd: process.cwd(), prompt: arg, resume,
      claudePath: process.env.X056_CLAUDE_PATH,
      tap: printEvent,
    });
    console.log(`\n[x056] ${res.status} · account=${res.finalAccount ?? '-'} · failovers=${res.failovers}` +
      (res.parkedUntil ? ` · parked until ${new Date(res.parkedUntil * 1000).toISOString()}` : ''));
    if (res.resultText) console.log(res.resultText);
    return res.status === 'completed' ? 0 : res.status === 'parked' ? 3 : 1;
  }

  console.error('usage: x056 <init|run|continue|status|switch> [text]');
  return 2;
}

process.exit(await main());
