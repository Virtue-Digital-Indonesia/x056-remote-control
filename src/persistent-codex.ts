import type { RawEvent } from './types.js';
import type { TurnOptions } from './turn.js';
import { hashText, type Ingested, type Transport, type TransportState } from './persistent-transport.js';

/**
 * Codex over `codex app-server`: JSON-RPC on stdio, one long-lived process per
 * conversation, exactly what `codex exec --json` could not give us.
 *
 * Verified live on codex-cli 0.153.4 (see the audit that led here):
 *   initialize -> thread/start {cwd, model, approvalPolicy:'never',
 *   sandbox:'danger-full-access', config:{mcp_servers}} -> turn/start
 *   {threadId, input:[{type:'text',text}], model, effort} -> notifications
 *   item/started, item/completed, turn/completed -- 3.1s end to end.
 *   thread/resume {threadId} picks up a thread that `codex exec` created, with
 *   its original model. turn/steer {threadId, expectedTurnId, input} and
 *   turn/interrupt {threadId, turnId} are in the v2 schema; a live check of
 *   those two is still owed -- the account was out of credits at the time.
 *
 * TRANSLATION, not a second adapter. Every notification is rewritten into the
 * flat `codex exec --json` shape the codex adapter was written against
 * (`thread.started {thread_id}`, `item.completed {item:{type:'command_execution',
 * exit_code}}`, `turn.completed`, `turn.failed {error}`), so classify(),
 * toActivity(), resultText() and captureSessionId() run unchanged. The one
 * honest cost is naming: app-server is camelCase, exec is snake_case, and the
 * item `type` strings differ -- `mapItem` below is that table.
 */

const RPC_INIT = 1;
const RPC_THREAD = 2;
/** The `thread/start` sent after a `thread/resume` found nothing to resume. */
const RPC_THREAD_FRESH = 3;

/** app-server's answer when the thread id has no rollout under this CODEX_HOME. */
const NO_ROLLOUT_RE = /no rollout found/i;

interface Ext {
  ready?: boolean;
  threadId?: string;
  turnId?: string;
  /** Writer handed to open(); kept so ingest() can send the fallback thread/start. */
  write?: (line: string) => void;
  /** thread/start params for the fallback -- the resume params minus the id. */
  startParams?: Record<string, unknown>;
  /** The thread id a resume was asked for, when this process was opened to resume. */
  resumeTarget?: string;
  /** The fallback was already tried once; a second failure is final. */
  retried?: boolean;
  /** Next JSON-RPC id; turn/start and steer/interrupt requests are tracked. */
  seq?: number;
  /** Which of our request ids are turn/start calls awaiting a turn id. */
  turnStarts?: Set<number>;
  lastOptions?: TurnOptions;
  commands?: Map<number, { kind: string; name: string; args: string; opts: TurnOptions }>;
}

function ext(st: TransportState): Ext { return st.ext as Ext; }
function nextId(x: Ext): number { x.seq = (x.seq ?? 10) + 1; return x.seq; }

const ITEM_TYPES: Record<string, string> = {
  agentMessage: 'agent_message',
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  webSearch: 'web_search',
  userMessage: 'user_message',
  reasoning: 'reasoning',
  plan: 'plan',
  collabAgentToolCall: 'collab_agent_tool_call',
  subAgentActivity: 'sub_agent_activity',
  SubAgentActivity: 'sub_agent_activity',
  imageView: 'view_image',
};

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());

/** app-server ThreadItem (camelCase) -> exec --json item (snake_case). */
export function mapItem(raw: unknown): Record<string, unknown> {
  const it = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(it)) out[snake(k)] = v;
  const t = typeof it.type === 'string' ? it.type : '';
  out.type = ITEM_TYPES[t] ?? snake(t);
  // The adapter's failure test reads `status === 'failed'` and a non-zero
  // `exit_code`; app-server uses the same words, only camelCased. `declined`
  // (approval refused) is a failure for the operator's purposes.
  if (it.status === 'declined') out.status = 'failed';
  if (Array.isArray(it.changes)) {
    out.changes = (it.changes as Record<string, unknown>[]).map((c) => ({
      path: c.path,
      kind: typeof c.kind === 'object' && c.kind ? (c.kind as { type?: unknown }).type : c.kind,
    }));
  }
  return out;
}

export class CodexTransport implements Transport {
  readonly id = 'codex' as const;

  /** Model and effort ride on every turn/start (see userMessage), so a change
   *  in either is served by the process the thread already has. The MCP wiring
   *  and the developer instructions go into thread/start and are fixed. */
  identity(o: TurnOptions): string {
    return [o.configDir, o.conversationId ?? o.sessionId, o.mcp?.configPath ?? '', hashText(o.appendSystemPrompt ?? '')].join('\0');
  }

  spawnSpec(o: TurnOptions) {
    return {
      bin: o.binPath ?? 'codex',
      args: ['app-server'],
      env: { ...process.env, CODEX_HOME: o.configDir },
    };
  }

  /** initialize, then open or resume the thread. Not ready until the thread id is back. */
  open(st: TransportState, o: TurnOptions, write: (line: string) => void): { ready: boolean } {
    const x = ext(st);
    x.lastOptions = o; x.write = write; x.ready = false; x.turnStarts = new Set(); x.commands = new Map();
    write(JSON.stringify({ jsonrpc: '2.0', id: RPC_INIT, method: 'initialize', params: { clientInfo: { name: 'x056', version: '1' } } }));
    const config: Record<string, unknown> = {};
    if (o.mcp) config.mcp_servers = { x056: { command: o.mcp.command, args: o.mcp.args, env: o.mcp.env } };
    const startParams = { cwd: o.cwd, ...(o.model ? { model: o.model } : {}), approvalPolicy: 'never', sandbox: 'danger-full-access', config,
      ...(o.appendSystemPrompt ? { developerInstructions: o.appendSystemPrompt } : {}) };
    const params = o.mode === 'resume'
      ? { ...startParams, threadId: o.sessionId }
      : startParams;
    x.write = write; x.startParams = startParams; x.retried = false;
    x.resumeTarget = o.mode === 'resume' ? o.sessionId : undefined;
    write(JSON.stringify({ jsonrpc: '2.0', id: RPC_THREAD, method: o.mode === 'resume' ? 'thread/resume' : 'thread/start', params }));
    return { ready: false };
  }

  userMessage(st: TransportState, o: TurnOptions, text: string): string {
    const x = ext(st);
    x.lastOptions = o;
    const id = nextId(x);
    const command = /^\/([\w:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (command) {
      const name = command[1].toLowerCase(), args = (command[2] ?? '').trim();
      if (name === 'compact' && !args) {
        x.commands!.set(id, { kind:'compact', name, args, opts:o });
        return JSON.stringify({ jsonrpc:'2.0', id, method:'thread/compact/start', params:{ threadId:x.threadId } });
      }
      if (name === 'review') {
        x.turnStarts!.add(id);
        return JSON.stringify({ jsonrpc:'2.0', id, method:'review/start', params:{ threadId:x.threadId, delivery:'inline', target:args ? {type:'custom',instructions:args} : {type:'uncommittedChanges'} } });
      }
      // Skills are resolved by Codex itself for this account and working dir.
      // An unknown TUI command must never silently become a model instruction.
      x.commands!.set(id, { kind:'skills', name, args, opts:o });
      return JSON.stringify({ jsonrpc:'2.0', id, method:'skills/list', params:{cwds:[o.cwd],forceReload:true} });
    }
    x.turnStarts!.add(id);
    return JSON.stringify({
      jsonrpc: '2.0', id, method: 'turn/start',
      params: {
        threadId: x.threadId,
        input: [{ type: 'text', text }],
        ...(o.model ? { model: o.model } : {}),
        ...(o.effort ? { effort: o.effort } : {}),
      },
    });
  }

  /**
   * Mid-turn: `turn/steer` folds the text into the running turn -- one result.
   * Between turns there is nothing to steer, so it is a new `turn/start`, and
   * the pool counts the result that turn will produce.
   */
  steerMessage(st: TransportState, text: string, turnInFlight: boolean): string | null {
    const x = ext(st);
    if (!x.threadId) return null;
    if (/^\//.test(text.trim()) && x.lastOptions) return turnInFlight ? null : this.userMessage(st, x.lastOptions, text);
    if (turnInFlight && x.turnId) {
      return JSON.stringify({ jsonrpc: '2.0', id: nextId(x), method: 'turn/steer',
        params: { threadId: x.threadId, expectedTurnId: x.turnId, input: [{ type: 'text', text }] } });
    }
    const id = nextId(x); x.turnStarts!.add(id);
    return JSON.stringify({ jsonrpc: '2.0', id, method: 'turn/start', params: { threadId: x.threadId, input: [{ type: 'text', text }] } });
  }

  interruptMessage(st: TransportState): string {
    const x = ext(st);
    return JSON.stringify({ jsonrpc: '2.0', id: nextId(x), method: 'turn/interrupt', params: { threadId: x.threadId, turnId: x.turnId } });
  }

  ingest(st: TransportState, line: string): Ingested {
    const x = ext(st);
    let m: Record<string, unknown>;
    try { m = JSON.parse(line) as Record<string, unknown>; } catch { return { events: [], turnEnded: false }; }
    const id = typeof m.id === 'number' ? m.id : undefined;
    const res = m.result as Record<string, unknown> | undefined;
    const err = m.error as Record<string, unknown> | undefined;

    // ---- responses to our own requests -----------------------------------
    if (id === RPC_INIT) { if (!err) x.write?.(JSON.stringify({jsonrpc:'2.0',method:'initialized'})); return { events: [], turnEnded: false }; }
    if (id === RPC_THREAD || id === RPC_THREAD_FRESH) {
      if (err || !res) {
        const message = String(err?.message ?? 'thread could not be opened');
        // A thread with NOTHING to resume. `thread/start` assigns an id at once
        // but writes no rollout until a turn runs, so a thread whose first turn
        // died (401, limit, a swap) exists only as an id -- and every later
        // resume of it fails in 300 ms, forever. With the accounts sharing one
        // rollout store, "no rollout found" means no history anywhere, so a
        // fresh thread loses nothing; the alternative is a conversation that
        // can never take another message. Tried once: a second miss is real.
        if (id === RPC_THREAD && x.resumeTarget && !x.retried && NO_ROLLOUT_RE.test(message) && x.write && x.startParams) {
          x.retried = true;
          x.write(JSON.stringify({ jsonrpc: '2.0', id: RPC_THREAD_FRESH, method: 'thread/start', params: x.startParams }));
          return { events: [{ type: 'thread.reset', from: x.resumeTarget, message }], turnEnded: false, readyNow: false };
        }
        // `error` carries the text the panel and the failure reason show;
        // `thread.failed` is what classify() reads. Same pair as a failed turn.
        return { events: [{ type: 'error', message }, { type: 'thread.failed', error: { message } }], turnEnded: true, readyNow: false };
      }
      const th = (res.thread ?? {}) as Record<string, unknown>;
      x.threadId = String(th.id ?? '');
      x.ready = true;
      // The exec-shaped event captureSessionId() reads the provider id from --
      // after a fallback this is the NEW id, which the manager stores in place
      // of the one that had no history.
      return { events: [{ type: 'thread.started', thread_id: x.threadId }], turnEnded: false, readyNow: true };
    }
    if (id !== undefined && x.commands?.has(id)) {
      const command = x.commands.get(id)!; x.commands.delete(id);
      const finish = (text: string, failed = false): Ingested => ({
        events: failed ? [{type:'error',message:text},{type:'turn.failed',error:{message:text}}]
          : [{type:'item.completed',item:{type:'agent_message',text}},{type:'turn.completed'}], turnEnded:true,
      });
      if (err || !res) return finish(String(err?.message ?? 'Command failed'), true);
      if (command.kind === 'compact') return { events:[{type:'item.started',item:{type:'mcp_tool_call',id:'compact-'+id,tool:'Compacting context'}}],turnEnded:false };
      if (command.name === 'compact') return finish('Use /compact without arguments. Send any summary instructions as a regular message first.', true);
      const data = Array.isArray(res.data) ? res.data as Record<string, unknown>[] : [];
      const skills = data.flatMap(d => Array.isArray(d.skills) ? d.skills as Record<string, unknown>[] : []).filter(s => s.enabled !== false);
      if (command.name === 'skills' || command.name === 'help') return finish(
        'Panel commands: /compact, /review [instructions], /new, /resume, /model, /status, /cost, /agent, /skills.\n\n' +
        (skills.length ? 'Available skills: ' + skills.map(s => '/' + String(s.name)).join(', ') : 'No enabled skills found for this project.')
      );
      const skill = skills.find(s => s.name === command.name);
      if (!skill || typeof skill.path !== 'string') return finish('Unknown or unavailable command /' + command.name + '. Use /help to see commands and enabled skills.', true);
      const next = nextId(x); x.turnStarts!.add(next);
      x.write?.(JSON.stringify({jsonrpc:'2.0',id:next,method:'turn/start',params:{threadId:x.threadId,
        input:[{type:'skill',name:skill.name,path:skill.path},{type:'text',text:'$'+command.name+(command.args?' '+command.args:'')}],
        ...(command.opts.model?{model:command.opts.model}:{}),...(command.opts.effort?{effort:command.opts.effort}:{})}}));
      return {events:[],turnEnded:false};
    }
    if (id !== undefined && x.turnStarts?.has(id)) {
      x.turnStarts.delete(id);
      if (err || !res) {
        // The turn never started; end it so the caller is not left hanging.
        const message = String(err?.message ?? 'turn/start refused');
        return { events: [{ type: 'error', message }, { type: 'turn.failed', error: { message } }], turnEnded: true };
      }
      x.turnId = String(((res.turn ?? {}) as Record<string, unknown>).id ?? '');
      return { events: [{ type: 'turn.started' }], turnEnded: false };
    }
    if (id !== undefined) return { events: [], turnEnded: false }; // steer/interrupt acks

    // ---- notifications -----------------------------------------------------
    const method = typeof m.method === 'string' ? m.method : '';
    const p = (m.params ?? {}) as Record<string, unknown>;
    switch (method) {
      case 'item/started':
        return { events: [{ type: 'item.started', item: mapItem(p.item) }], turnEnded: false };
      case 'item/completed':
        if ((p.item as Record<string, unknown> | undefined)?.type === 'contextCompaction') return {events:[{type:'item.completed',item:{type:'agent_message',text:'Context compacted.'}}],turnEnded:false};
        return { events: [{ type: 'item.completed', item: mapItem(p.item) }], turnEnded: false };
      case 'turn/started': {
        const t = (p.turn ?? {}) as Record<string, unknown>;
        if (typeof t.id === 'string') x.turnId = t.id;
        return { events: [], turnEnded: false }; // already emitted from the response
      }
      case 'turn/completed': {
        const t = (p.turn ?? {}) as Record<string, unknown>;
        const status = String(t.status ?? 'completed');
        x.turnId = undefined;
        if (status === 'completed') return { events: [{ type: 'turn.completed' }], turnEnded: true };
        const te = (t.error ?? {}) as Record<string, unknown>;
        const message = String(te.message ?? (status === 'interrupted' ? 'turn interrupted' : 'turn failed'));
        // exec --json emits `error` then `turn.failed`; keep both so classify()
        // and the panel see the same thing either way a turn runs.
        return { events: [{ type: 'error', message }, { type: 'turn.failed', error: { message, status } }], turnEnded: true };
      }
      case 'error': {
        const e = (p.error ?? {}) as Record<string, unknown>;
        // willRetry: the CLI is retrying on its own; surface but do not end.
        return { events: [{ type: 'error', message: String(e.message ?? 'error') }], turnEnded: false };
      }
      case 'thread/status/changed':
      case 'account/rateLimits/updated':
      case 'thread/tokenUsage/updated':
        // Pass through under their own names: harmless to classify(), and the
        // rate-limit one is exactly what its near-limit check looks for.
        return { events: [{ type: method.replace(/\//g, '.'), ...p }], turnEnded: false };
      default:
        return { events: [], turnEnded: false }; // deltas, plans, realtime: no exec analogue
    }
  }
}
