# Codex `exec --json` event schema — capture notes

Reverse-engineered from **codex-cli 0.144.3** to drive OpenAI's `codex` as a
second provider behind the `ProviderAdapter` seam (`src/adapters/codex.ts`).
Sources: `codex exec --help` / `codex exec resume --help`, a live
**unauthenticated** `codex exec --json` run, and serde type tags in the shipped
native binary. Marked ✅ = verified, ⚠️ = still needs an authenticated run.

## How this was captured (reproducible, no auth needed)

```bash
npm install @openai/codex@0.144.3 --no-save --prefix /tmp/codex-probe
export PATH="/tmp/codex-probe/node_modules/.bin:$PATH"
codex exec --help ; codex exec resume --help          # flag surface
CODEX_HOME=/tmp/empty codex exec --json \
  --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox "hi"   # real events (401s)
# schema tags baked into the binary:
BIN=/tmp/codex-probe/node_modules/@openai/codex-linux-x64/vendor/*/bin/codex
strings "$BIN" | grep -oE "(thread|turn|item)\.[a-z]+"
```

## Stream shape ✅

Flat JSON, one event per line, **dotted `type` names** (no `{id,msg}` envelope):

| `type` | meaning | key fields |
|---|---|---|
| `thread.started` | session opens | **`thread_id`** ← the session id |
| `turn.started` | a turn begins | |
| `item.started` / `item.updated` / `item.completed` | a tool/message item | `item.{id,type,…}` |
| `turn.completed` | ✅ terminal **success** | `rate_limits` (usage) ⚠️ |
| `turn.failed` | ✅ terminal **failure** | `error.{message, code}` |
| `thread.failed` | thread-level failure | `error` |
| `error` (top-level) | **transient** reconnect chatter | `message` |

### Item types (`item.type`) ✅ names / ⚠️ some fields
`agent_message` (text ⚠️), `reasoning`, `command_execution`
(`command, cwd, exit_code, status, aggregated_output`), `file_change`
(`changes`), `mcp_tool_call`, `web_search`, `todo_list`, `error` (`message`).

### `turn.failed` reason codes ✅
`usage_limit_exceeded` ← **the ChatGPT-plan limit**, `context_window_exceeded`,
`session_budget_exceeded`, `server_overloaded`, `internal_server_error`,
`http_connection_failed`, `response_stream_connection_failed`,
`thread_rollback_failed`, `other`.

## The two questions this pause answered

1. **Session-id mapping** — Codex assigns its own id (unlike Claude's
   `--session-id`); it's `thread.started.thread_id`. `captureSessionId(e)` reads
   it; Phase 4's manager must record it on a NEW turn to later resume.
2. **Resume for failover** — `codex exec resume <SESSION_ID> <prompt>` continues
   a thread, and **`--json` + `--dangerously-bypass-approvals-and-sandbox`
   work on `resume` too** ✅, so a resumed turn streams identically. Whether the
   *same thread resumes cleanly under a different `CODEX_HOME`* is the one thing
   only a two-account authed run can prove.

## argv the adapter builds ✅

```
new:    codex exec [--json --dangerously-bypass-approvals-and-sandbox
                    --skip-git-repo-check -m MODEL -c model_reasoning_effort="E"] PROMPT
resume: codex exec resume SESSION_ID [same flags] PROMPT
env:    CODEX_HOME=<account config dir>
```

## Still needs an AUTHENTICATED capture ⚠️

Run once with a logged-in ChatGPT account and save the stream:

```bash
CODEX_HOME=<authed dir> codex exec --json --skip-git-repo-check \
  --dangerously-bypass-approvals-and-sandbox "list this repo's files then stop" \
  > /tmp/codex-authed.jsonl
```

to confirm: the `agent_message` **text field name**; whether `item.started`
fires for commands (or only `item.completed`); the **`rate_limits`** object —
presence, which event, field casing (`used_percent` vs `usedPercent`,
`resets_in_seconds`); and the exact `turn.failed.error` **code field** (`code`
vs `type`). The adapter reads all of these defensively, so filling them in is a
few-line correction, not a rewrite.
