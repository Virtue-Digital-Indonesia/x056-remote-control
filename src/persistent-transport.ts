import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { RawEvent } from './types.js';
import type { TurnOptions } from './turn.js';

/**
 * The wire-format-specific half of a persistent session.
 *
 * `PersistentTurns` owns everything that is the SAME for every CLI -- one
 * process per conversation, eviction, the working/idle distinction, steering
 * accounting, failover-safe teardown. What differs per CLI is only: how to
 * spawn it, what bytes start a turn, what bytes steer or interrupt one, and
 * how to read its stdout back into the events the provider adapter already
 * understands. That is this interface.
 *
 * Claude speaks `--input-format stream-json`: a user message is one JSON line,
 * a turn ends at `result`. Codex speaks JSON-RPC over `codex app-server`: a
 * thread must be opened (or resumed) before the first `turn/start`, a turn
 * ends at `turn/completed`, and its notifications are translated into the
 * `codex exec --json` shapes the codex adapter was written against, so
 * classify/toActivity/resultText need no second implementation.
 */
export interface TransportState {
  /** Bytes the CLI has sent that do not yet end in a newline. */
  buf: string;
  /** Anything the transport needs to remember per process. */
  ext: Record<string, unknown>;
}

export interface Ingested {
  /** Adapter-shaped events to forward, in order. */
  events: RawEvent[];
  /** This line ended the turn in flight. */
  turnEnded: boolean;
  /** The handshake just finished; a deferred first prompt may now be sent. */
  readyNow?: boolean;
}

/** Short stable digest, for keying on a long system prompt. */
export const hashText = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12);

export interface Transport {
  readonly id: 'claude' | 'codex';
  /**
   * What makes a running process reusable for a turn. Everything fixed at
   * spawn belongs here and nothing else: a turn that differs in a spawn-time
   * setting keys to a different entry and gets a fresh process, while one that
   * differs only in a per-turn setting reuses the process it has.
   *
   * Claude bakes model and effort into argv, so they are identity. Codex sends
   * them on every `turn/start`, so they are NOT -- and keying on them anyway
   * opened a second app-server on the same thread when the effort changed,
   * which the first still held: "thread already has an active writer".
   *
   * The conversation is `conversationId`, never `sessionId`: for Codex the
   * latter is the gateway's id on the first turn and the thread id after, so
   * a key built on it never matched the first turn's process again.
   */
  identity(o: TurnOptions): string;
  /** Process to spawn for this conversation. */
  spawnSpec(o: TurnOptions): { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  /**
   * Called once, right after spawn, with a writer. A transport that needs a
   * handshake before it can accept a prompt (Codex: initialize, then open or
   * resume the thread) sends it here and reports NOT ready; `userMessage` is
   * then deferred until `ingest` flips `ready`.
   */
  open(st: TransportState, o: TurnOptions, write: (line: string) => void): { ready: boolean };
  /** The line that starts a turn with this prompt, given the process is ready. */
  userMessage(st: TransportState, o: TurnOptions, text: string): string;
  /** The line that steers text into the turn in flight. With NO turn in flight
   *  (background work) a steer is a fresh turn -- the pool counts its result. */
  steerMessage(st: TransportState, text: string, turnInFlight: boolean): string | null;
  /** The line that interrupts the turn in flight. */
  interruptMessage(st: TransportState): string;
  /** One stdout line in; adapter events and a turn-ended flag out. May flip st.ext.ready. */
  ingest(st: TransportState, line: string): Ingested;
}

/** Claude: `claude -p --input-format stream-json --output-format stream-json`. */
export class ClaudeTransport implements Transport {
  readonly id = 'claude' as const;

  identity(o: TurnOptions): string {
    return [o.configDir, o.conversationId ?? o.sessionId, o.model ?? '', o.effort ?? '', o.mcp?.configPath ?? '', hashText(o.appendSystemPrompt ?? '')].join('\0');
  }

  spawnSpec(o: TurnOptions) {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      ...(o.appendSystemPrompt ? ['--append-system-prompt', o.appendSystemPrompt] : []),
      ...(o.mcp ? ['--mcp-config', o.mcp.configPath] : []),
      ...(o.model ? ['--model', o.model] : []),
      ...(o.effort ? ['--effort', o.effort] : []),
      ...(o.mode === 'new' ? ['--session-id', o.sessionId] : ['--resume', o.sessionId]),
    ];
    return { bin: o.claudePath ?? o.binPath ?? 'claude', args, env: { ...process.env, CLAUDE_CONFIG_DIR: o.configDir } };
  }

  open(st: TransportState): { ready: boolean } { st.ext.ready = true; return { ready: true }; }

  userMessage(_st: TransportState, _o: TurnOptions, text: string): string {
    return JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  /** Verified against CLI 2.1.258: a second user line mid-turn reaches the model inside that turn. */
  steerMessage(st: TransportState, text: string): string { return this.userMessage(st, undefined as never, text); }

  interruptMessage(): string {
    return JSON.stringify({ type: 'control_request', request_id: `x056-int-${Date.now()}`, request: { subtype: 'interrupt' } });
  }

  ingest(_st: TransportState, line: string): Ingested {
    let e: RawEvent;
    try { e = JSON.parse(line) as RawEvent; } catch { return { events: [], turnEnded: false }; }
    // A control_response answers our interrupt; protocol, not session content.
    if (e.type === 'control_response') return { events: [], turnEnded: false };
    return { events: [e], turnEnded: e.type === 'result' };
  }
}

export type { ChildProcess };
