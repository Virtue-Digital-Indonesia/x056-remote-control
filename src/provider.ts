import type { TurnHandle, TurnOptions } from './turn.js';
import type { Usage } from './quota.js';
import type { RawEvent, Verdict } from './types.js';

/**
 * A single tool invocation surfaced to the UI. Emitted as `start` when the
 * model calls a tool and `done`/`error` when its result comes back. Subagent
 * spawns are flagged so the panel can render them as a live tree and count
 * "N running tasks". `parentToolUseId` links a tool run to the subagent that
 * issued it. (Lives here, not in server/, because turning a provider's raw
 * stream events into these rows is provider-specific — part of the adapter.)
 */
export interface ActivityEvent {
  toolUseId: string;
  parentToolUseId: string | null;
  tool: string;
  label: string;
  status: 'start' | 'done' | 'error';
  isSubagent: boolean;
}

/** The human-facing identity a login stores in an account's config dir. */
export interface AccountIdentity {
  displayName?: string;
  email?: string;
}

/** One reconstructed line of a past conversation, for reloading it after a
 *  page refresh or a project switch. 'model' is a synthetic marker recording
 *  that the main turn's model changed (text = the model id), derived from the
 *  transcript rather than stored separately. */
export interface HistoryEntry {
  /** 'action' = a tool call reconstructed from the transcript, so the trail of
   *  what the agent DID survives a reload (the live activity rows only ever
   *  existed in browser memory). `text` is the display label. */
  role: 'user' | 'assistant' | 'model' | 'action';
  text: string;
  /** For 'action': the call was a subagent/task spawn (rendered differently). */
  sub?: boolean;
  /** ISO timestamp from the transcript, when present — lets the panel
   *  interleave this with live activity/subagent events by time. */
  ts?: string;
}

/** A model the provider offers for this account, for the composer's picker. */
export interface ProviderModel {
  /** The id handed to the CLI (`-m <slug>`). */
  slug: string;
  /** Display name, e.g. "GPT-5.6-Sol". */
  label: string;
  description?: string;
  /** Reasoning levels this model accepts, when the provider says. */
  efforts?: string[];
  defaultEffort?: string;
}

export type ProviderId = 'claude' | 'codex';

/** The resume nudge sent after a failover. Provider-neutral — an adapter may
 *  override `continuePrompt`, but both current adapters use this. Kept here (a
 *  dependency-free module both failover.ts and the adapters import) so there's a
 *  single source of truth without a circular import between them. */
export const DEFAULT_CONTINUE_PROMPT =
  'Continue exactly where you left off. If your last action was a command or edit that may have partially applied, verify its actual effect before re-running anything with side effects.';

/**
 * The seam between the two agent CLIs this gateway can drive — Anthropic's
 * `claude` and OpenAI's `codex`. `runSession` and the manager orchestrate
 * against this interface, never against a specific binary, so failover, live
 * activity, and quota all work the same regardless of which CLI backs a session.
 *
 * The event-interpreting methods (classify/isResult/.../toActivity) each take
 * that provider's OWN raw stream events — a Claude adapter never sees Codex
 * events and vice versa, because a session runs entirely on one provider (you
 * can't resume a Claude transcript on GPT). Failover pools are per-provider.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Human name for the UI, e.g. "Claude" or "ChatGPT (Codex)". */
  readonly label: string;
  /** The env var that points the CLI at one account's config/home dir
   *  (CLAUDE_CONFIG_DIR for claude, CODEX_HOME for codex). Used by the login
   *  and spawn flows that set up a per-account environment. */
  readonly configEnvVar: string;
  /** The nudge sent when a session resumes on a fresh account after failover. */
  readonly continuePrompt: string;

  /** Spawn one turn. Signature matches turn.ts `startTurn` exactly so tests and
   *  the manager can still inject a stand-in via `startTurnFn`. */
  startTurn(opts: TurnOptions): TurnHandle;

  /** For providers that ASSIGN their own session id (Codex emits a thread id on
   *  `thread.started`) rather than accepting one we dictate (Claude's
   *  --session-id): pull that id off an event so runSession can resume the same
   *  session after a failover. Returns '' for events that don't carry it.
   *  Omit entirely when the provider takes a caller-supplied id. */
  captureSessionId?(e: RawEvent): string;

  // --- event interpretation (each provider's own stream shape) ---
  /** Rate-limit / auth-required / warning classification for one raw event. */
  classify(e: RawEvent): Verdict;
  /** Is this the turn's terminal result event? */
  isResult(e: RawEvent): boolean;
  /** For a result event: did the turn end without error? */
  resultOk(e: RawEvent): boolean;
  /** For a result event: the final assistant text, when the stream carries one. */
  resultText(e: RawEvent): string | undefined;
  /** A safe mid-stream point to interrupt on a forced switch — i.e. a tool round
   *  has just completed, so the transcript is in a resumable state. */
  isDrainBoundary(e: RawEvent): boolean;
  /** Map one raw stream event to zero or more UI activity rows. */
  toActivity(e: RawEvent): ActivityEvent[];
  /** The main-turn model resolved for this event (e.g. "claude-fable-5"), for
   *  the UI's live model indicator — undefined for events that don't carry it or
   *  that come from a subagent. Optional: omit when the provider doesn't surface
   *  a per-event model. */
  activeModel?(e: RawEvent): string | undefined;
  /** Displayable assistant text carried by this event (one entry per chunk),
   *  for streaming into the chat. Empty when the event carries none. */
  assistantText?(e: RawEvent): string[];

  // --- account plumbing ---
  /** Read the human identity a completed login wrote into the config dir. */
  readIdentity(configDir: string): AccountIdentity;
  /** The models this account can actually use, when the provider publishes a
   *  catalog (Codex caches one per account). Omit when the provider has no
   *  discoverable list — the UI then falls back to its own preset options. */
  listModels?(configDir: string): ProviderModel[];
  /** Fetch usage/quota for the account. `undefined` means the provider exposes
   *  no machine-readable usage (the UI then shows no usage bars for it). */
  fetchUsage?(configDir: string): Promise<Usage>;
  /** Reconstruct a past conversation's history from this provider's OWN
   *  transcript storage, for reloading it after a refresh or project switch.
   *  `providerSessionId` is the CLI's own session/thread id (see
   *  captureSessionId) — for Claude that equals the gateway's id; for Codex
   *  it's the assigned thread id, since a rollout is filed under that, not the
   *  gateway's internal conversation key. `configDirs` should be scoped to
   *  accounts of THIS provider — a transcript can only be under one of them.
   *  Omit (or return []) when nothing is found; never throws. */
  readHistory?(configDirs: string[], providerSessionId: string, limit: number): HistoryEntry[];

  /** Paginated history for scroll-back: up to `limit` entries ending just
   *  before the opaque `before` cursor (omit for the newest page), plus the
   *  cursor for the page older than this one. Providers that don't implement it
   *  simply don't support scroll-back — the panel loads the newest page only. */
  readHistoryPage?(configDirs: string[], providerSessionId: string, limit: number, before?: number): {
    rows: HistoryEntry[];
    cursor: number;
    done: boolean;
  };
}
