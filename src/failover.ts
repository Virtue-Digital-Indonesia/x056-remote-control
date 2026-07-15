import type { AccountRegistry } from './accounts.js';
import { claudeAdapter } from './adapters/claude.js';
import type { EventLog } from './eventlog.js';
import { DEFAULT_CONTINUE_PROMPT } from './provider.js';
import type { ProviderAdapter } from './provider.js';
import type { TurnHandle, TurnOptions } from './turn.js';
import type { RawEvent, Verdict } from './types.js';

/** Re-exported for callers/tests that assert the post-failover resume prompt.
 *  The value a given session actually uses is `adapter.continuePrompt`. */
export const CONTINUE_PROMPT = DEFAULT_CONTINUE_PROMPT;

export interface SessionResult {
  status: 'completed' | 'parked' | 'failed';
  finalAccount?: string;
  parkedUntil?: number;
  failovers: number;
  resultText?: string;
  reason?: string;
  /** The provider's real session id to resume next time. For Claude this equals
   *  the id we dictated; for Codex it's the thread id the CLI assigned and we
   *  captured. Lets the manager store the right id for a later continuation. */
  providerSessionId?: string;
}

export interface RunSessionOptions {
  registry: AccountRegistry;
  log: EventLog;
  sessionId: string;
  cwd: string;
  prompt: string;
  resume?: boolean;
  /** The CLI's own session id to resume (Codex thread id). Only needed for
   *  providers that assign their own id; Claude resumes by `sessionId` directly. */
  providerSessionId?: string;
  /** Which agent CLI backs this session. Defaults to Claude, so every existing
   *  caller and test keeps its current behavior with no change. */
  adapter?: ProviderAdapter;
  startTurnFn?: (opts: TurnOptions) => TurnHandle;
  now?: () => number;
  maxFailoversPerHour?: number;
  claudePath?: string;
  model?: string;
  effort?: string;
  appendSystemPrompt?: string;
  /** The gateway's MCP bridge wiring, passed through to every turn (see
   *  TurnOptions.mcp) so sessions can read/message other conversations. */
  mcp?: TurnOptions['mcp'];
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
  /** Drain the current turn and resume on another account. By default (a legacy
   *  or automatic switch) the account being left is benched for a cooldown; pass
   *  { bench: false } for a user-directed switch to a specific account (the
   *  caller sets which account is active first) so the old one stays available. */
  forceSwitch: (opts?: { bench?: boolean }) => void;
  abort: () => void;
}

// A limit signal without a reset time (synthetic transcript entry, result 429)
// means "the CLI gave up on a 429" but not when it clears — bench for 30m and
// re-check, rather than assuming a full 5h window and over-benching.
const LIMIT_NO_RESET_FALLBACK = 30 * 60;
const FORCED_COOLDOWN = 30 * 60;

export async function runSession(opts: RunSessionOptions): Promise<SessionResult> {
  const { registry, log, sessionId, cwd } = opts;
  const adapter = opts.adapter ?? claudeAdapter;
  const startTurnFn = opts.startTurnFn ?? adapter.startTurn;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const maxPerHour = opts.maxFailoversPerHour ?? 3;
  const drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
  const graceMs = opts.interruptGraceMs ?? 10_000;
  const failoverTimes: number[] = [];

  let mode: 'new' | 'resume' = opts.resume ? 'resume' : 'new';
  let prompt = opts.prompt;
  // The id the CLI actually uses to resume. For Claude it's the id we dictate
  // (opts.sessionId). For a provider that assigns its own (Codex's thread id),
  // we start with what the caller knows — the real id when resuming an existing
  // session, else undefined — and capture the assigned id off the first turn's
  // stream so a failover resumes THE SAME session on the next account.
  let cliSessionId: string | undefined = adapter.captureSessionId
    ? (opts.resume ? (opts.providerSessionId ?? opts.sessionId) : undefined)
    : opts.sessionId;
  let forceSwitchRequested = false;
  let forceBench = true; // whether the account being left is benched on the pending forced switch
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
    forceSwitch: (o) => {
      forceSwitchRequested = true;
      if (o && o.bench === false) forceBench = false;
    },
    abort: () => {
      currentHandle?.kill();
    },
  });

  try {
    for (;;) {
      const account = registry.pickActive(now(), adapter.id);
      if (!account) {
        const until = registry.earliestReset(adapter.id);
        log.append({ type: 'parked', sessionId, until });
        return { status: 'parked', parkedUntil: until, failovers: failoverTimes.length };
      }
      // Announce which account this turn runs on so the UI can show it live.
      log.append({ type: 'turn_started', sessionId, account: account.name });

      const state = {
        limited: null as Verdict | null,
        authRequired: false,
        forced: false,
        resultText: undefined as string | undefined,
        resultOk: false,
        drainTimer: null as NodeJS.Timeout | null,
        graceTimer: null as NodeJS.Timeout | null,
        killRequested: false,
        interruptRequested: false,
        // The last non-empty assistant text chunk streamed so far. Claude's own
        // resultText(e) always has a definitive answer (the `result` event carries
        // it directly); Codex streams its answer as separate agent_message items
        // and has no such single field, so its resultText(e) returns undefined —
        // this is the fallback that fills it in below. Without it, autopilot's
        // stop-phrase check and the question-card detector (both keyed on
        // resultText) silently never fire for Codex at all.
        lastAssistantText: undefined as string | undefined,
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
        // Capture a provider-assigned session id (Codex thread id) as soon as it
        // appears, so a mid-run failover — and later continuations — resume it.
        const captured = adapter.captureSessionId?.(e);
        if (captured) cliSessionId = captured;
        const v = adapter.classify(e);
        if (v.kind === 'limited' && !state.limited && !state.authRequired && !state.forced) {
          state.limited = v;
          log.append({ type: 'limit_detected', sessionId, account: account.name, source: v.source, resetsAt: v.resetsAt ?? null });
          state.killRequested = true;
          handle?.kill();
          return;
        }
        // The CLI's own "Not logged in" synthetic response — this account's stored
        // OAuth session is dead. No point letting the turn continue; end it and
        // fail over like a limit, but there's no reset time — it stays parked until
        // a human re-authenticates it (the UI surfaces a re-login prompt for this).
        if (v.kind === 'auth_required' && !state.limited && !state.authRequired && !state.forced) {
          state.authRequired = true;
          log.append({ type: 'auth_required', sessionId, account: account.name });
          state.killRequested = true;
          handle?.kill();
          return;
        }
        if (v.kind === 'warning') {
          log.append({ type: 'quota_warning', sessionId, account: account.name, resetsAt: v.resetsAt ?? null });
        }
        const texts = adapter.assistantText?.(e);
        if (texts && texts.length) state.lastAssistantText = texts[texts.length - 1];
        if (adapter.isResult(e) && adapter.resultOk(e)) {
          state.resultOk = true;
          state.resultText = adapter.resultText(e) ?? state.lastAssistantText;
        }
        // forced switch: drain until the provider's next resumable boundary (D7)
        if (forceSwitchRequested && !state.forced && !state.limited && !state.authRequired && adapter.isDrainBoundary(e)) {
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
        // On a resume turn, use the provider's real session id (the captured
        // Codex thread id) so it continues the SAME session; on a new turn the
        // provider either takes this id (Claude) or ignores it and assigns its
        // own (Codex).
        sessionId: mode === 'resume' ? (cliSessionId ?? sessionId) : sessionId,
        mode,
        prompt,
        model: opts.model,
        effort: opts.effort,
        appendSystemPrompt: opts.appendSystemPrompt,
        mcp: opts.mcp,
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
        if (forceSwitchRequested && !state.forced && !state.limited && !state.authRequired && state.drainTimer === null) {
          state.drainTimer = setTimeout(() => {
            if (!state.forced && !state.limited && !state.authRequired) {
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

      if (!state.limited && !state.forced && !state.authRequired) {
        if (state.resultOk) {
          log.append({ type: 'turn_completed', sessionId, account: account.name });
          return { status: 'completed', finalAccount: account.name, failovers: failoverTimes.length, resultText: state.resultText, providerSessionId: cliSessionId };
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
        return { status: 'failed', finalAccount: account.name, failovers: failoverTimes.length, reason, providerSessionId: cliSessionId };
      }

      // failover path (limit, auth-required, or forced)
      // A force request that lost the race to a rate-limit verdict is moot — the
      // session is switching anyway — so clear it unconditionally to avoid a stale
      // flag triggering a spurious forced interrupt on the next account.
      forceSwitchRequested = false;
      const bench = forceBench; forceBench = true; // consume; default back to benching
      if (state.limited) {
        // Resolve the reset to an absolute unix time: prefer a provider-reported
        // absolute (Anthropic's rate_limit_event), else convert a relative
        // countdown (Codex's resets_in_seconds) with our OWN clock, else fall
        // back to a 30m guess. Only that last case is a guess, so only it is
        // flagged `estimated` — the UI must not show a guess as a hard countdown.
        const rel = state.limited.resetsInSeconds;
        const until = state.limited.resetsAt ?? (rel != null ? now() + rel : now() + LIMIT_NO_RESET_FALLBACK);
        const hasRealReset = state.limited.resetsAt != null || rel != null;
        registry.markLimited(account.name, until, !hasRealReset);
      } else if (state.authRequired) {
        // No cooldown to wait out — this account is parked until a human
        // re-authenticates it via the UI.
        registry.markUnauthenticated(account.name);
      } else if (bench) {
        // A legacy/automatic forced switch benches the account being left (never
        // backed by an Anthropic-reported reset time). A user-directed switch to a
        // specific account (bench:false) leaves the old one available to return to.
        registry.markLimited(account.name, now() + FORCED_COOLDOWN, true);
      }
      // Count toward the flap guard only for limit-driven or legacy forced rotates;
      // a user-directed targeted switch is intentional, not flapping.
      if (state.limited || state.authRequired || bench) {
        failoverTimes.push(now());
        const recent = failoverTimes.filter((t) => t > now() - 3600);
        if (recent.length > maxPerHour) {
          log.append({ type: 'flap_guard_tripped', sessionId });
          return { status: 'failed', failovers: failoverTimes.length };
        }
      }
      log.append({ type: 'failover', sessionId, from: account.name });
      mode = 'resume';
      prompt = adapter.continuePrompt;
    }
  } finally {
    if (opts.forceSwitchSignal !== false) {
      process.off('SIGUSR1', onSigusr1);
      process.off('SIGTERM', onTerminate);
      process.off('SIGINT', onTerminate);
    }
  }
}
