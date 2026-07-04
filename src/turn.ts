import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RawEvent } from './types.js';

export interface TurnExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: string;
}

export interface TurnHandle {
  kill(): void;
  interrupt(): void;
  done: Promise<TurnExit>;
}

export interface TurnOptions {
  claudePath?: string;
  configDir: string;
  cwd: string;
  sessionId: string;
  mode: 'new' | 'resume';
  prompt: string;
  onEvent: (e: RawEvent) => void;
}

export function startTurn(opts: TurnOptions): TurnHandle {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(opts.mode === 'new' ? ['--session-id', opts.sessionId] : ['--resume', opts.sessionId]),
    opts.prompt,
  ];
  const child = spawn(opts.claudePath ?? 'claude', args, {
    cwd: opts.cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim().startsWith('{')) return;
    try {
      opts.onEvent(JSON.parse(line) as RawEvent);
    } catch {
      // partial/garbled line — ignore
    }
  });

  const done = new Promise<TurnExit>((resolve) => {
    child.on('error', (err) => resolve({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  return {
    kill: () => child.kill('SIGKILL'),
    interrupt: () => child.kill('SIGINT'),
    done,
  };
}
