# X056 Remote Control — Cross-Account Failover Design

Date: 2026-07-04 · Status: **approved** (user, 2026-07-04) · Verified against: Claude Code v2.1.201 on this server

## 1. Problem

One continuous Claude Code session on a project must survive a Claude Max usage-limit hit by failing over to a second Max account: same conversation history, no manual re-auth, no parallel session, no fresh start. Anthropic's hosted Remote Control does not offer this; this project self-hosts the equivalent plus failover.

## 2. Verified foundations

All facts below were tested live on this server on 2026-07-04 (CLI v2.1.201) unless marked otherwise.

| # | Fact | Evidence |
|---|------|----------|
| F1 | `--resume <session-id>` is purely local file replay; no server-side session state. A fresh `CLAUDE_CONFIG_DIR` containing only `.credentials.json` + a symlinked `projects/` resumed a session created elsewhere. | Live test ("CROSSDIR_OK"); CLI self-created `.claude.json` in the bare dir |
| F2 | stream-json emits `rate_limit_event` with `rate_limit_info: {status, resetsAt (epoch), rateLimitType: "five_hour"\|…, overageStatus, isUsingOverage}` on API responses; `result` events carry `api_error_status`. | Live probe capture |
| F3 | A real limit hit is recorded in the transcript as a synthetic assistant entry: top-level `"error":"rate_limit"`, `"apiErrorStatus":429`, `"isApiErrorMessage":true`, `"model":"<synthetic>"`; human text like "You've hit your session limit · resets 8:20pm (Asia/Jakarta)". | Real entry in local history, 2026-07-03, v2.1.199 |
| F4 | On 429 the CLI retries internally (~10 attempts, exponential backoff), emitting `system`/`api_retry` events with `error_status: 429`, `error: "rate_limit"`, `attempt`, `retry_delay_ms`. | Docs (Headless mode); GitHub #46959 |
| F5 | SIGKILL mid-tool-call leaves a dangling `tool_use` at the transcript tail (each jsonl line atomic — never corrupts); `--resume` repairs automatically and the model continues coherently. Residual risk: model believes an interrupted command never ran (duplicate side-effect risk). | Live kill/resume experiment |
| F6 | `GET https://api.anthropic.com/api/oauth/usage` with an account's OAuth Bearer token returns `five_hour`/`seven_day` `{utilization %, resets_at ISO}` plus model-scoped weekly limits and severity — works for idle accounts. | Live call against account A |
| F7 | In `-p` mode a non-allowed tool is auto-denied (denial recorded as `tool_result` + `permission_denials` in result event); the turn ends cleanly, never hangs. | Live experiment |
| F8 | `overloaded_error` is server congestion, not quota (68 occurrences in local history). Never a failover trigger. | Local history scan |
| F9 | Agent SDK supports `env` (per-account `CLAUDE_CONFIG_DIR`) and `pathToClaudeCodeExecutable` (use system CLI); `canUseTool` callback verified for programmatic approvals. `--permission-prompt-tool` does **not** exist in the current CLI. | Docs research, 2026-07-04 |

## 3. Decisions

- **D1 — Supervisor + headless CLI per turn.** A Node/TS supervisor owns the conversation; each turn spawns `claude -p [--session-id <sid> | --resume <sid>] --output-format stream-json --verbose` with `env.CLAUDE_CONFIG_DIR` set to the active account's dir. Rejected: Agent SDK for v1 (extra abstraction where raw events must be observable; F9 keeps it open as the v2 migration path) and auth-swapping `ANTHROPIC_BASE_URL` proxy (brittle across CLI updates, fights token refresh, ToS-gray).
- **D2 — Continuity via dedicated config-dir pair + shared projects tree.** `~/.claude-x056-a` and `~/.claude-x056-b`, each with its own OAuth login; `~/.claude-x056-b/projects → ~/.claude-x056-a/projects` symlink. One canonical transcript store; credentials fully isolated. The user's interactive `~/.claude` is untouched in v1. Rejected: copy-on-failover (drift), single-dir credential hot-swap (CLI rewrites `.claude.json` constantly — race-prone).
- **D3 — Kill-on-first-signal failover.** Per F4 the CLI would burn minutes retrying a quota 429 that cannot succeed. The supervisor terminates the child on the **first** definitive signal — any of: `api_retry` with `error: "rate_limit"`; `rate_limit_event.status == "rejected"`; transcript-tail synthetic entry with `error == "rate_limit"` (belt-and-braces tail watcher). Then: mark account `limited(until)`, flip active account, respawn `--resume <sid>` with the continue prompt (D5). Safe because quota 429s occur at API-request boundaries — prior tool results are already persisted (F5 covers even the hard-kill case).
- **D4 — Permissions: supervised sessions run with `--dangerously-skip-permissions`.** Explicitly requested and accepted by the user (2026-07-04, "I understand the consequences and I'll take full responsibility"); this is a dedicated dev server and runs must not stall unattended. v2 may add an approval queue via SDK `canUseTool` for finer control; F7's deny-and-queue pattern remains the documented fallback if this decision is ever reversed.
- **D5 — Resume prompt.** `Continue exactly where you left off. If your last action was a command or edit that may have partially applied, verify its actual effect before re-running anything with side effects.` Mitigates F5's duplication risk.
- **D6 — Guards.** Max 3 automatic failovers per session per hour (flap protection). Both accounts limited → park session, schedule auto-resume at earliest `resets_at`, notify (existing Telegram notify pipeline). Transient errors (`overloaded_error`, 5xx, non-quota 429) → left to the CLI's own retry; never failover.
- **D7 — Manual force-switch drains first.** Wait for the in-flight `tool_result` (watch stream), then SIGINT; SIGKILL only after a 10 s grace. Limit-triggered switches don't need draining (D3 rationale).

## 4. Architecture (v1)

Plain TypeScript package `supervisor/` — framework-free, structured so v2 can mount it inside NestJS unchanged.

```
┌────────────┐   spawn/env    ┌─────────────────────────┐
│ x056 CLI   │──────────────▶│ FailoverController       │
│ (run/      │               │  session state machine   │
│  status/   │               │  idle→running(A)→switch  │
│  switch/   │               │  →running(B)→parked      │
│  continue) │               └───┬─────────────┬────────┘
└────────────┘                   │             │
                        ┌────────▼───────┐ ┌───▼────────────┐
                        │ TurnRunner     │ │ AccountRegistry│
                        │ spawn claude -p│ │ accounts.json  │
                        │ stream-json →  │ │ a/b state      │
                        │ typed events   │ └───┬────────────┘
                        └────────┬───────┘     │
                        ┌────────▼───────┐ ┌───▼────────────┐
                        │ LimitDetector  │ │ QuotaPoller    │
                        │ F2/F3/F4 rules │ │ /api/oauth/    │
                        └────────────────┘ │ usage per acct │
                                           └────────────────┘
                 EventLog (append-only jsonl) ← all components
```

- **AccountRegistry** — `accounts.json`: `{name, configDir, state: unknown|ok|warning|limited{until}}`; atomic writes (tmp+rename).
- **TurnRunner** — spawns the CLI per turn, line-parses stream-json into typed events; exposes kill/SIGINT; tails the session transcript as the redundant detection channel.
- **LimitDetector** — classifies events → `ok | warning | limited(resetsAt) | transient` per D3/D6 rules.
- **FailoverController** — the state machine; owns failover, guards, parking, resume prompts.
- **QuotaPoller** — `/api/oauth/usage` per account (5-min interval + on demand); on 401, forces token refresh by spawning a one-token haiku turn under that config dir, then re-reads `.credentials.json`. Never logs tokens.
- **EventLog** — append-only jsonl (failovers, quota snapshots, denials, errors); becomes the v2 panel's data source.
- **`x056` CLI harness** — `run "<task>"`, `continue "<msg>"`, `status`, `switch` for v1 operation.

## 5. v1 exit criteria (E2E proof)

1. **Detector unit tests** replaying captured fixtures: the real 2026-07-03 limit entry, the 2026-07-04 probe events, `overloaded_error` negatives.
2. **`fake-claude` replay binary** (emits recorded stream-json incl. a rejected event) → deterministic CI test of the full failover loop without quota cost.
3. **Forced-switch drill** on the real CLI: a multi-step task starts on A, force-switch mid-run, completes on B — one continuous transcript, correct file artifacts.
4. **Live validation** at the next real limit hit: session continues on B within ~60 s with zero user action. (Expected within days given observed usage patterns.)

## 6. Non-goals (v1)

No web UI. No pre-emptive switching (v1.1: switch at turn boundary when active-account utilization ≥ ~90 %, using F6). No more than two accounts. No concurrent multi-session scheduling. No adoption of interactively-started `~/.claude` sessions (v2 candidate).

## 7. v2 outlook

NestJS supervisor service + Next.js control panel over WebSocket: chat stream rendered from supervisor events (browser never touches the claude process — failover is invisible by construction, shown only as a "switching accounts" banner), per-account utilization gauges with reset countdowns (F6), force-switch, failover history. Security for the public-IP server: bearer auth + IP allowlist or Tailscale. SDK migration (F9) to add a `canUseTool` approval queue. Investigate `claude setup-token` long-lived tokens as a possible single-config-dir simplification.

## 8. Risks & open items

- `rate_limit_event.status` enum value `"rejected"` inferred from the API's unified header enum, not observed yet; detector never depends on it alone (D3 has three independent triggers).
- Both accounts weekly-limited → session parked potentially for days; mitigated by notification + parking state being explicit in `status`.
- Refresh-token rotation: dedicated logins per config dir (D2) prevent the supervisor and the interactive `~/.claude` from invalidating each other's credentials.
- `ANTHROPIC_BASE_URL` + OAuth traversal unverified — affects only the optional fault-injection harness, which no exit criterion depends on.
