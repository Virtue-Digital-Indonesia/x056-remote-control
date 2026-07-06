import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    const msg = e.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? msg.content : [];
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text) process.stdout.write(`\n${text}\n`);
      }
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
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
        console.error(`stale pidfile — no such process ${pid}`);
        rmSync(PIDFILE, { force: true });
        return 2;
      }
      throw err;
    }
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (existsSync(cmdlinePath)) {
      const cmdline = readFileSync(cmdlinePath, 'utf8');
      if (!cmdline.includes('cli.ts') && !cmdline.includes('x056')) {
        console.error(`pid ${pid} does not look like an x056 process — refusing to signal`);
        return 2;
      }
    }
    process.kill(pid, 'SIGUSR1');
    console.log(`sent SIGUSR1 to ${pid}`);
    return 0;
  }

  if (command === 'adopt') {
    if (!arg) {
      console.error('usage: x056 adopt <session-id>   (run from the session\'s project directory)');
      return 2;
    }
    const registry = AccountRegistry.load(ACCOUNTS);
    const cwd = process.cwd();
    const munged = cwd.replace(/[/.]/g, '-');
    const fromDir = process.env.X056_ADOPT_FROM ?? join(homedir(), '.claude');
    const src = join(fromDir, 'projects', munged, `${arg}.jsonl`);
    if (!existsSync(src)) {
      console.error(`no transcript at ${src}`);
      return 2;
    }
    const dstDir = join(registry.list()[0].configDir, 'projects', munged);
    mkdirSync(dstDir, { recursive: true });
    copyFileSync(src, join(dstDir, `${arg}.jsonl`));
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE, JSON.stringify({ lastSessionId: arg, cwd }));
    console.log(`adopted ${arg} into ${dstDir}`);
    // Best-effort: point a running gateway at it too (token from ./.env if present)
    const envFile = join(cwd, '.env');
    if (existsSync(envFile)) {
      const token = /X056_TOKEN=(.+)/.exec(readFileSync(envFile, 'utf8'))?.[1]?.trim();
      if (token) {
        const port = process.env.X056_PORT ?? '4056';
        try {
          const res = await fetch(`http://localhost:${port}/api/sessions/current`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: arg, cwd }),
          });
          console.log(res.ok ? 'gateway updated — session is now current in the panel' : `gateway not updated (HTTP ${res.status})`);
        } catch {
          console.log('gateway not reachable — it will pick the session up via state.json if you point it manually');
        }
      }
    }
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
    let sessionId: string;
    if (resume) {
      const lastSessionId = loadState().lastSessionId;
      if (!lastSessionId) {
        console.error('no previous session — use run first');
        return 2;
      }
      sessionId = lastSessionId;
    } else {
      sessionId = randomUUID();
    }
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(PIDFILE, String(process.pid));

    let stateSaved = resume; // continue: already correct on disk
    const saveStateOnce = () => {
      if (!stateSaved) {
        writeFileSync(STATE, JSON.stringify({ lastSessionId: sessionId }));
        stateSaved = true;
      }
    };

    try {
      const res = await runSession({
        registry, log, sessionId,
        cwd: process.cwd(), prompt: arg, resume,
        claudePath: process.env.X056_CLAUDE_PATH,
        tap: (e) => {
          saveStateOnce();
          printEvent(e);
        },
      });
      console.log(`\n[x056] ${res.status} · account=${res.finalAccount ?? '-'} · failovers=${res.failovers}` +
        (res.parkedUntil ? ` · parked until ${new Date(res.parkedUntil * 1000).toISOString()}` : '') +
        (res.status === 'failed' && res.reason ? ` · reason=${res.reason}` : ''));
      if (res.resultText) console.log(res.resultText);
      return res.status === 'completed' ? 0 : res.status === 'parked' ? 3 : 1;
    } finally {
      rmSync(PIDFILE, { force: true });
    }
  }

  console.error('usage: x056 <init|run|continue|status|switch|adopt> [text|session-id]');
  return 2;
}

process.exit(await main());
