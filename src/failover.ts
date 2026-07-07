import type { AccountRegistry } from './accounts.js';
import { classifyEvent } from './detector.js';
import type { EventLog } from './eventlog.js';
import { startTurn } from './turn.js';
import type { TurnHandle } from './turn.js';
import type { RawEvent, Verdict } from './types.js';

export const CONTINUE_PROMPT =
  'Continue exactly where you left off. If your last action was a command or edit that may have partially applied, verify its actual effect before re-running anything with side effects.';

export interface SessionResult {
  status: 'completed' | 'parked' | 'failed';
  finalAccount?: string;
  parkedUntil?: number;
  failovers: number;
  resultText?: string;
  reason?: string;
}

export interface RunSessionOptions {
  registry: AccountRegistry;
  log: EventLog;
  sessionId: string;
  cwd: string;
  prompt: string;
  resume?: boolean;
  startTurnFn?: typeof startTurn;
  now?: () => number;
  maxFailoversPerHour?: number;
  claudePath?: string;
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  tap?: (e: RawEvent) => void;
  forceSwitchSignal?: boolean;
  drainTimeoutMs?: number;
  interruptGraceMs?: number;
  /** Hands the caller per-run controls so multiple concurrent runs can be
   *  driven individually (the process-wide SIGUSR1 path can't distinguish
   *  between them). Called once, synchronously, before the first turn. */
  control?: (c: RunControl) => void;
}

export interface RunControl {
  forceSwitch: () => void;
  abort: () => void;
}

// A limit signal without a reset time (synthetic transcript entry, result 429)
// means "the CLI gave up on a 429" but not when it clears — bench for 30m and
// re-check, rather than assuming a full 5h window and over-benching.
const LIMIT_NO_RESET_FALLBACK = 30 * 60;
const FORCED_COOLDOWN = 30 * 60;

export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  const { registry, log, sessionId, cwd } = opts;
  const startTurnFn = opts.startTurnFn ?? startTurn;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxPerHour = opts.maxFailoversPerHour ?? 3;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
  const graceMs = opts.interruptGraceMs ?? 10_000;
  const failoverTimes: number[] = [];

  let mode: 'new' | 'resume' = opts.resume ? 'resume' : 'new';
  let prompt = opts.prompt;
  let forceSwitchRequested = false;
  let currentHandle: TurnHandle | undefined;
  const onSigusr1 = () => {
    forceSwitchRequested = true;
  };
  const onTerminate = () => {
    currentHandle?.kill();
    process.exit(130);
  };
  if (opts.forceSwitchSignal !== false) {
    process.on('SIGUSR1', onSigusr1);
    process.on('SIGTERM', onTerminate);
    process.on('SIGINT', onTerminate);
  }
  opts.control?.({
    forceSwitch: () => {
      forceSwitchRequested = true;
    },
    abort: () => {
      currentHandle?.kill();
    },
  });

  try {
    for (;;) {
      const account = registry.pickActive(now());
      if (!account) {
        const until = registry.earliestReset();
        log.append({ type: 'parked', sessionId, until });
        return { status: 'parked', parkedUntil: until, failovers: failoverTimes.length };
      }
      // Announce which account this turn runs on so the UI can show it live.
      log.append({ type: 'turn_started', sessionId, account: account.name });

      const state = {
        limited: null as Verdict | null,
        forced: false,
        resultText: undefined as string | undefined,
        resultOk: false,
        drainTimer: null as NodeJS.Timeout | null,
        graceTimer: null as NodeJS.Timeout | null,
        killRequested: false,
        interruptRequested: false,
      };

      let handle: TurnHandle | undefined;
      // D7 hardening: some CLI builds can wedge and ignore SIGINT. Once we've asked for a
      // drain-interrupt on a forced switch, arm a one-shot grace-kill so the switch always
      // completes even if interrupt() never actually stops the child.
      const armGraceKill = () => {
        if (state.graceTimer === null) {
          state.graceTimer = setTimeout(() => {
            handle?.kill();
          }, graceMs);
        }
      };
      const processEvent = (e: RawEvent) => {
        try { opts.tap?.(e); } catch { /* tap must never affect detection */ }
        const v = classifyEvent(e);
        if (v.kind === 'limited' && !state.limited && !state.forced) {
          state.limited = v;
          log.append({ type: 'limit_detected', sessionId, account: account.name, source: v.source, resetsAt: v.resetsAt ?? null });
          state.killRequested = true;
          handle?.kill();
          return;
        }
        if (v.kind === 'warning') {
          log.append({ type: 'quota_warning', sessionId, account: account.name, resetsAt: v.resetsAt ?? null });
        }
        if (e.type === 'result' && e.is_error === false) {
          state.resultOk = true;
          state.resultText = typeof e.result === 'string' ? e.result : undefined;
        }
        // forced switch: drain until a tool-result-bearing user event or the result event (D7)
        if (forceSwitchRequested && !state.forced && !state.limited && (e.type === 'user' || e.type === 'result')) {
          state.forced = true;
          log.append({ type: 'forced_switch', sessionId, account: account.name });
          state.interruptRequested = true;
          handle?.interrupt();
          armGraceKill();
        }
      };

      handle = startTurnFn({
        claudePath: opts.claudePath,
        configDir: account.configDir,
        cwd,
        sessionId,
        mode,
        prompt,
        model: opts.model,
        effort: opts.effort,
        appendSystemPrompt: opts.appendSystemPrompt,
        onEvent: (e) => processEvent(e),
      });
      currentHandle = handle;

      // The first scripted/streamed event can fire synchronously inside startTurnFn(...),
      // before `handle` is assigned above — processEvent records the request via the
      // state flags instead of calling handle.kill()/interrupt() directly. Apply it now
      // that `handle` definitely exists.
      if (state.killRequested) {
        handle.kill();
      } else if (state.interruptRequested) {
        handle.interrupt();
      }

      // forced-switch hard timeout: if requested but nothing drainable arrives, interrupt anyway
      const drainWatch = setInterval(() => {
        if (forceSwitchRequested && !state.forced && !state.limited && state.drainTimer === null) {
          state.drainTimer = setTimeout(() => {
            if (!state.forced && !state.limited) {
              state.forced = true;
              log.append({ type: 'forced_switch_timeout', sessionId, account: account.name });
              state.interruptRequested = true;
              handle?.interrupt();
              armGraceKill();
            }
          }, drainTimeoutMs);
        }
      }, 100);

      const exit = await handle.done;
      clearInterval(drainWatch);
      if (state.drainTimer) clearTimeout(state.drainTimer);
      if (state.graceTimer) clearTimeout(state.graceTimer);

      if (!state.limited && !state.forced) {
        if (state.resultOk) {
          log.append({ type: 'turn_completed', sessionId, account: account.name });
          return { status: 'completed', finalAccount: account.name, failovers: failoverTimes.length, resultText: state.resultText };
        }
        const reason = exit.spawnError ?? (exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`);
        log.append({
          type: 'turn_failed',
          sessionId,
          account: account.name,
          code: exit.code,
          signal: exit.signal,
          spawnError: exit.spawnError ?? null,
        });
        return { status: 'failed', finalAccount: account.name, failovers: failoverTimes.length, reason };
      }

      // failover path (limit or forced)
      // A force request that lost the race to a rate-limit verdict is moot — the
      // session is switching anyway — so clear it unconditionally to avoid a stale
      // flag triggering a spurious forced interrupt on the next account.
      forceSwitchRequested = false;
      if (state.limited) {
        // A real resetsAt came from Anthropic (rate_limit_event); its absence
        // means the verdict came from a path that never carries one (a bare 429
        // result or a synthetic error message) — mark that cooldown as our own
        // estimate, not a fact, so the UI doesn't present a guess as a countdown.
        const hasRealReset = state.limited.resetsAt != null;
        registry.markLimited(account.name, state.limited.resetsAt ?? now() + LIMIT_NO_RESET_FALLBACK, !hasRealReset);
      } else {
        // A forced switch is never backed by an Anthropic-reported reset time.
        registry.markLimited(account.name, now() + FORCED_COOLDOWN, true);
      }
      failoverTimes.push(now());
      const recent = failoverTimes.filter((t) => t > now() - 3600);
      if (recent.length > maxPerHour) {
        log.append({ type: 'flap_guard_tripped', sessionId });
        return { status: 'failed', failovers: failoverTimes.length };
      }
      log.append({ type: 'failover', sessionId, from: account.name });
      mode = 'resume';
      prompt = CONTINUE_PROMPT;
    }
  } finally {
    if (opts.forceSwitchSignal !== false) {
      process.off('SIGUSR1', onSigusr1);
      process.off('SIGTERM', onTerminate);
      process.off('SIGINT', onTerminate);
    }
  }
}
