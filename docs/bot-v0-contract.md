# Bot v0: build contract

The owner's personal assistant. It **delegates, reports and monitors**; it does not do the work itself. Owner's answers (2026-10-15):

1. Channel: the web panel + the x056 iOS app only.
2. Autonomy: **everything** without approval.
3. Briefs: **every morning**, and **when something needs the owner**.

## Shape

- The Bot is ONE ordinary Chat (`kind: 'chat'`), created idempotently (`createChat({requestId: 'x056-bot-singleton'})`) when the owner enables it. Claude provider only in v0.
- Singleton record: `state/bot.json`
  ```json
  { "enabled": true, "projectId": "<chat pid>", "sessionId": "<sid>", "briefAt": "07:30", "tz": "Asia/Jakarta", "lastBriefDate": "2026-10-15", "createdAt": 0 }
  ```
- `server/bot.ts` owns it: `BotService` (load/save, `isBotProject(projectId)`, `isBotSession(sessionId)`, `botTarget()`, brief timer, digest buffer, event log).
- **Everything is keyed on the Bot's `projectId`, never on one sessionId.** A Chat can hold several conversations (the owner may open a new one inside it). So:
  - `isBotSession(sid)` = `sid` is a conversation of the Bot project.
  - `botTarget()` = the Bot project's most recently active conversation (fall back to `bot.sessionId`, the first one). The brief and the digest go there.
  - `bot.sessionId` is only the initial conversation; it is refreshed to the newest one whenever `botTarget()` resolves a different one.
  - If `createChat` does not yield a sessionId until the first turn, the enable action must handle it (create the conversation the same way the panel's first message does) — check and report.

## HTTP (panel bearer; NOT exposed as MCP tools)

| route | body | answer |
|---|---|---|
| `GET /api/bot` | - | `{enabled, projectId, sessionId, briefAt, tz, lastBriefDate, url}` (`url` = `/chat/<pid>` or null) |
| `POST /api/bot` | `{enabled?: boolean, briefAt?: 'HH:MM', tz?: IANA}` | same as GET. `enabled: true` creates the Chat if missing (reuses it if it exists and is not deleted). `enabled: false` stops the brief + digest, keeps the Chat. |
| `POST /api/bot/brief` | - | sends today's brief now (manual trigger, for testing) |
| `POST /api/bot/notify` | `{from, title, body, tier?: 'urgent'\|'normal', link?}` | refuses (403) unless `isBotSession(from)`. Emits `bot_notice`. `link` must be a relative path starting with `/` (else dropped). |
| `GET /api/bot/overview?from=<sid>` | - | refuses unless `isBotSession(from)`. Cheap JSON, see "Overview". |

`/api/projects` and `/api/chats` rows for the Bot chat carry `bot: true`.

## Autonomy (the owner chose "everything")

- `conversationSend` (`server/api.controller.ts` ~:835): deliver directly, no approval card, when `bot.enabled && isBotSession(body.from)`. The steer path re-routes through it, so it inherits this.
- Relay checkpoints still apply; the Bot may pass `confirm_relay` itself.
- Delegates, cron, memory are already ungated.

## The Bot's turns

- `launch` (manager): when the conversation is the Bot:
  - `appendSystemPrompt = BOT_SYSTEM_NOTE` — it REPLACES `CONTAINER_SYSTEM_NOTE` (and `X056_HOST_NOTE` is never added). The container note is wrong for the Bot: it says sends wait for approval, says to use its own subagents first (denied here), and teaches ssh/nginx/dind (no Bash here). `BOT_SYSTEM_NOTE` = the x056 MCP / delegate / memory / scheduling / Think-publishing parts of the note, rewritten for the Bot, plus the persona (below). Constant string, so the process identity stays constant and the process is reused.
  - `disallowedTools = BOT_DENIED_TOOLS = ['Bash','Edit','Write','NotebookEdit','Agent','Task','Workflow','mcp__x056__commit_project_file','mcp__x056__commit_chat_file','mcp__x056__add_file_to_project','mcp__x056__import_work_file']` (the owner: it "doesn't do the tasks").
  - Team helper never applied to the Bot (refused in `setHelpers`/`patchHelpers` with a clear error; ignored in launch if somehow set). Advisor and Jev allowed.
  - Provider change and archive of the Bot chat refused.
- `TurnOptions.disallowedTools?: string[]` (src/turn.ts), threaded through `src/failover.ts`, added to BOTH Claude argv builders (one-shot `src/turn.ts`, persistent `src/persistent-transport.ts`) as ONE comma-joined value placed where the variadic option cannot swallow the next argument, and included in `ClaudeTransport.identity`. Codex ignores it.
- `mcpWiringFor` adds `X056_BOT=1` to the Bot's MCP env.

## Persona (inside `BOT_SYSTEM_NOTE`)

- You are the owner's personal assistant on the x056 gateway. You do not do the work yourself: you delegate it, follow it, and report. No shell, no file edits, no subagents.
- Delegate real work to the conversation that owns it (`send_message` to an existing conversation, or a new conversation in the right project), so it shows in the owner's sidebar; use `delegate` for short checks and parallel probes. Your sends are delivered without approval: the owner chose that. Relay checkpoints still apply; confirm only when the exchange is converging.
- Monitor with `status_overview`, `get_activity`, `read_conversation`, `list_delegates`, `list_scheduled`.
- Messages from sender `bot_event` are digests of things that need the owner. **Your reply to a digest is silent: the owner sees it only if you call `notify_user`.** The gateway has already pushed each urgent item on its own; call `notify_user` only when you add something: a decision needed with context, a bundle of related items, or an action you took. Never notify twice for the same thing.
- Messages from sender `bot_brief` are the morning brief: call `status_overview`, then reply with a short brief (what needs the owner first, then what finished, what failed, what is running, account limits), ending with one question about what to delegate today. That reply is pushed.
- Plain, short, no filler. Never paste secrets.

## MCP tools, Bot only (listed only when `X056_BOT=1`)

- `notify_user {title, body, urgent?: boolean, link?}` -> `POST /api/bot/notify`. Push the owner now.
- `status_overview {}` -> `GET /api/bot/overview`.
- Both bridges: `scripts/x056-mcp.mjs` (stdio) and `server/mcp-http.controller.ts` (http) list them only for the Bot. The http bridge has no per-conversation env: it must identify the caller from the request. **First confirm which bridge a Claude turn really uses** (`mcpWiringFor`, `state/mcp/<sid>.json`) and make that one right; the routes re-check `isBotSession(from)` either way.

## Notices

- `bot_notice` in `NOTICE_KINDS`; `noticeFor`: tier `urgent` -> category `needs_you`; else tier `normal`, category `finished`. Title = given title (60 chars), body = given body, link = given link or the Bot chat, id `bot:<at>`, tag `x056-bot-<at>`.
- New sender kinds in `src/message-sender.ts` (+ parser): `bot_event`, `bot_brief`.
  - `originOf`: `bot_event` -> `relay` (its completed turn is quiet), `bot_brief` -> new origin `brief`: a completed brief turn is tier **normal**, category `finished`, body = the cleaned reply (so the morning brief PUSHES even if short).
- Panel labels for both kinds.

## "When something needs me": the digest

- In `emit()` after the notice is attached: if the Bot is enabled, the notice tier is `urgent`, and the event is NOT about the Bot's own conversation (`notice.sessionId !== bot.sessionId`, and for `mcp_approval` the sender is not the Bot) -> push one compact line into `BotDigest`.
- Debounce 60 s from the first buffered line, then ONE queue item to the Bot, sender `{kind: 'bot_event'}`, merged into a `bot_event` item still waiting in the Bot's queue (same pattern as `wakeOrchestrator`).
- Dedupe by `notice.id` (a re-emitted question must not wake the Bot twice; keep the last ~500 ids).
- The hook in `emit()` is wrapped in try/catch: a throw there must never break event delivery.
- Rate cap: at most 6 flushes per rolling hour; excess lines stay buffered and go with the next allowed flush. Buffer capped at 50 lines (oldest dropped, count kept: "and N more").
- The existing urgent pushes are unchanged. The persona tells the Bot not to repeat what was already pushed unless it adds a decision, a bundle or an action it took.

## Morning brief

- `BotService` timer (every 30 s): when local time in `tz` >= `briefAt` and `lastBriefDate !== today` and local time < 12:00 (catch-up window after a swap) -> enqueue the brief prompt to the Bot, sender `{kind: 'bot_brief'}`, set `lastBriefDate` BEFORE enqueuing (no double brief on a crash loop).
- Not a cron.json job, so no AI can cancel it with `cancel_scheduled`.

## Event log + overview

- `BotService` appends every notice of tier `urgent` or `normal` (not about the Bot itself) to `state/bot-events.jsonl` as `{at, kind, tier, category, projectId, sessionId, title, body}` (body cut to 300 chars). Trim to the newest 2000 lines when it passes 4000.
- `GET /api/bot/overview` returns (all cheap, no transcript scans):
  - `now`, `lastBriefDate`
  - `running`: conversations with a gateway turn or background work (title, project, since)
  - `needsYou`: pending questions, pending MCP approvals
  - `recent`: bot-events of the last 24 h (newest first, max 50)
  - `delegates`: active delegates across all orchestrators (orchestrator title, role, status)
  - `scheduled`: cron jobs with `lastResult` failures
  - `accounts`: per-account availability / limit-reset if cheaply known

## Panel

- `/bot` route: if enabled -> go to the Bot chat; else a small "Set up your Bot" card (what it does, brief time field default 07:30, Enable button -> `POST /api/bot {enabled:true, briefAt}`).
- A "Bot" entry in the workspace destinations (sidebar), and the Bot chat pinned at the top of the `/chat` list with a Bot badge.
- Chat header for the Bot: a "Bot" badge, the brief time, and a "Brief me now" action (`POST /api/bot/brief`).

## iOS (source only; cannot be compiled here)

- `Models.swift`: decode optional `bot: Bool?` on the project/chat rows.
- `HomeView`: a pinned "Bot" section at the top when a bot chat exists; tap opens it through the existing `open(projectId:sessionId:)`.

## Loop check (test it)

- Bot sends to X, X's turn fails (urgent), the digest wakes the Bot, the Bot sends to X again: does the relay depth of the Bot's chain advance across that loop? The digest enqueue is not a hop and `bot_event` must NOT clear the chain. Write a test that shows what happens; if depth does not advance, the hourly flush cap is the only brake — report it.

## Known limits (tell the owner)

- "Human-only" switches are advisory against an AI with Bash: every conversation's MCP bridge holds the panel token. Same weakness as the existing global approval mode.
- Denied tools: verify live that a Bot turn cannot run Bash.
- Quiet hours on a device suppress urgent pushes too (existing behaviour).
