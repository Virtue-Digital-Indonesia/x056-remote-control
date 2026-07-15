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
  /** Legacy override for the Claude binary path (kept for existing callers). */
  claudePath?: string;
  /** Generic override for the CLI binary path (used by any adapter). */
  binPath?: string;
  configDir: string;
  cwd: string;
  sessionId: string;
  mode: 'new' | 'resume';
  prompt: string;
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  /** The gateway's MCP bridge (scripts/x056-mcp.mjs), giving the session tools
   *  to read/message OTHER conversations and projects through the gateway. Each
   *  adapter wires it its own way: claude takes a --mcp-config file, codex takes
   *  -c mcp_servers.* overrides built from the command/args/env pieces. */
  mcp?: { configPath: string; command: string; args: string[]; env: Record<string, string> };
  onEvent: (e: RawEvent) => void;
}

/**
 * Spawn a CLI that streams NDJSON on stdout, parsing each `{...}` line into a
 * RawEvent. The spawn + line-parse + exit plumbing is identical across agent
 * CLIs (claude, codex) — only the argv and the per-account env var differ — so
 * each provider adapter builds those and delegates the rest here.
 */
export function spawnJsonlTurn(
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  onEvent: (e: RawEvent) => void,
): TurnHandle {
  // detached:true puts the turn in its OWN process group so kill() can take out
  // the whole tree. This matters for codex: its `codex` entrypoint is a Node
  // wrapper that spawns the real native binary as a child and forwards
  // SIGINT/SIGTERM/SIGHUP — but SIGKILL is uncatchable, so SIGKILLing just the
  // wrapper ORPHANED the native process, which kept running the task (observed
  // live: a "stopped" turn still executing minutes later with PPID 1). Claude
  // is a single process either way, so group-kill only widens the blast to its
  // own tool subprocesses — exactly what "stop this turn" should kill anyway.
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'inherit'], detached: true });

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim().startsWith('{')) return;
    try {
      onEvent(JSON.parse(line) as RawEvent);
    } catch {
      // partial/garbled line — ignore
    }
  });

  const done = new Promise<TurnExit>((resolve) => {
    child.on('error', (err) => resolve({ code: null, signal: null, spawnError: err.message }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const killGroup = (): void => {
    // Negative pid = the whole process group (wrapper + native + running tools).
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
    catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  };

  return {
    kill: killGroup,
    // Interrupt stays targeted at the entry process: claude handles SIGINT
    // itself, and codex's wrapper forwards it — a group-wide SIGINT would
    // double-deliver to the native binary (second SIGINT = force quit in many
    // CLIs), breaking the graceful drain semantics this exists for.
    interrupt: () => { try { child.kill('SIGINT'); } catch { /* already gone */ } },
    done,
  };
}

export function startTurn(opts: TurnOptions): TurnHandle {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(opts.appendSystemPrompt ? ['--append-system-prompt', opts.appendSystemPrompt] : []),
    // Extra MCP config MERGES with the session's own servers (no --strict-mcp-config).
    ...(opts.mcp ? ['--mcp-config', opts.mcp.configPath] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.effort ? ['--effort', opts.effort] : []),
    ...(opts.mode === 'new' ? ['--session-id', opts.sessionId] : ['--resume', opts.sessionId]),
    // `--` ends option parsing so a prompt beginning with '-' (e.g. a markdown
    // bullet list) is taken as the positional prompt, not an unknown flag.
    '--',
    opts.prompt,
  ];
  return spawnJsonlTurn(
    opts.claudePath ?? opts.binPath ?? 'claude',
    args,
    opts.cwd,
    { ...process.env, CLAUDE_CONFIG_DIR: opts.configDir },
    opts.onEvent,
  );
}
