# Bot owner view: build contract (2026-10-21)

Efran's three requests, relayed by Bot:
1. A two-kind Bot indicator: **FYI** (an unread Bot message) and **Needs me** (a pending question or decision), visible at a glance in the panel sidebar and the iPhone app.
2. A clean Bot chat, owner and Bot only: agent traffic hidden but auditable; when an agent message needs Efran, Bot posts a visible message or asks him.
3. Rename the Bot (a display name in the panel and the app).

## Defaults chosen (Efran may override in this chat)

- **Agent traffic** = turns started by sender kinds `conversation`, `mcp`, `delegate`, `automation` (includes the Bot's own `message_self` and its scheduled tasks). **Visible** = the owner's turns, the morning brief (last reply), recaps, and owner messages.
- **FYI** = a visible Bot bubble he hasn't read. No push.
- **Needs me** = a question card (the existing ASK / question store), pushed as urgent. Several asks merge into one card batch; none is overwritten.
- One toggle (Today > "Show N hidden messages") reveals agent and system rows in place, dimmed, each agent row labelled with its sender. Nothing is deleted.
- Rename lives in Bot settings. It renames the Bot's Chat too (so notification titles follow) and the persona uses the name (the Bot's process restarts once per rename, with its history).

## Server

### Visibility rule, one implementation per client, one spec
- New pure module `server/bot-view.ts`: `botRowView(rows)` annotates Bot-chat history rows with `botView: 'show' | 'hide'`. Same rule as the panel's `botRowVisibility`/`botRowKind` (rc-chat.js), extended:
  - Turn kinds: `bot_event`, `bot_brief`, `advisor`, **`agent`** (sender kinds conversation, mcp, delegate, automation), `''` (human, recap, anything else).
  - **A steered user row never starts a turn.** It hides only itself when it comes from an agent (and shows when it is the owner's).
  - `agent` turn: hide everything except `keep` rows and owner messages.
  - Owner messages (below) are `keep`.
  - Classify notices by `messageId` prefix (`bot-notice:` + urgent flag on the row), never by the text "Bot needs you:" / "Bot status:" (the name can change).
- `GET /api/conversations/history` and `history-page` add `botView` (and keep every row) **only for the Bot's project**. The panel may keep its DOM rule for live rows; iOS filters on `botView`. A shared fixture table test proves server and panel agree.

### Owner messages: `message_owner`
- Bot-only MCP tool `message_owner {text, needs_you?: boolean, options?: string[]}` (scripts/x056-mcp-bot.mjs, listed only with `X056_BOT=1`), route `POST /api/bot/message {from, text, needsYou?, options?}` (refuses unless `isBotSession(from)`).
  - `needs_you` false: FYI. Emits `bot_message` `{projectId, sessionId, id, text, at}`; read-state marks the Bot chat unread `done`. No push.
  - `needs_you` true: adds a pending question for the Bot's session (merged into the `questions` batch when one is already pending), emits `question` as today (urgent push, needs-me).
- **Durable, not journal-only:** the tool call is in the Bot's transcript. The history route turns a `message_owner` tool row of the Bot's project into `{role: 'assistant', ownerMessage: true, needsYou, text, ts, messageId: 'bot-owner:<toolUseId>'}`. The transform is in the route, not the adapter, so `findMessageReply` (what an agent reads back) is unaffected; a test proves an agent never gets an owner message as its reply.
- `notify_user` stays as an alias: `urgent: true` -> `message_owner needs_you`, otherwise FYI.
- Persona (`BOT_SYSTEM_NOTE`): a message from another conversation or agent is answered to THAT agent (the reply is hidden from the owner and returned to the sender). To reach the owner, call `message_owner` (FYI) or `message_owner needs_you` (a decision). Never end an agent-directed reply with an ASK.

### Questions from agent turns
- An ASK in a Bot turn whose origin is not human (agent, digest, brief, recap...) never becomes a question card (extend the `botReply` guard in `manager.ts`).
- A send whose target is the Bot goes with `interactive: false`.

### Read-state and attention
- `read-state.observe` for the Bot's project: `conversation_settled` / `session_done` / `session_error` count only for visible origins (`human`, `brief`, `recap`). Agent/digest turns never mark the Bot unread. `bot_message` marks `done`.
- `question_answered` / `question_dismissed` on the Bot must not wipe an unrelated FYI (needs-me and FYI kept apart).
- **Attention** (one pure function): `{ needsMe: number, fyi: boolean, since?: number }`.
  - `needsMe` = non-stale pending questions of the Bot's session (count of questions in the batch).
  - `fyi` = the Bot chat is unread in read-state for a visible reason (a visible reply, a brief, a recap, an owner message), independent of `needsMe`. The clients show needs-me first when both are set.
  - Exposed on `GET /api/bot`, on the Bot's `/api/projects` row (`botAttention`), and live as a `bot_attention` event whenever it changes (on read_state, question, question_answered, question_dismissed, bot_message).
- The Bot is excluded from generic unread counts that would double it (panel Home already; iOS `needsYouCount`).

### Rename
- `state/bot.json` gains `name` (default `Bot`). `POST /api/bot {name}`: trimmed, 1-40 characters, no control characters or `<>`; renames the Chat project and its conversation title too.
- `GET /api/bot` and the Bot's `/api/projects` row carry `name` / `botName`.
- `BOT_SYSTEM_NOTE` becomes `botSystemNote(name)` ("Your name is <name>.").

### 4. Open questions survive agent messages (added 2026-10-21, all conversations, not only the Bot)
Cause today: `launch()` deletes the session's pending question on EVERY new turn (`manager.ts` ~3724, "Any new turn ... supersedes its unanswered question"), and the panel clears the card on every `session_started`.
- **Only a human turn answers it.** `launch()` drops the pending question only when the turn is human-origin (no sender / owner message, a queued human message, a human steer as today) and then emits `question_answered {by: 'turn'}`. Agent, delegate, cron, digest, brief, recap and advisor turns leave it open.
- **A non-human turn can resolve it, explicitly.** While a question is open, such a turn's message carries one line (stripped wherever prompts are read back, like the team line): `[Open question to the owner, still unanswered: "...". If this message answers it or makes it moot, end your reply with <<<RESOLVED>>> on its own line. Otherwise leave it open.]`. A reply containing `<<<RESOLVED>>>` closes it (`question_answered {by: 'resolved'}`); the marker is stripped from every displayed text, like `<<<ASK`.
- **A new question never drops the old one.** A new ASK while one is open merges into the pending batch (`questions`, deduped by identical text), unless the same reply carried `<<<RESOLVED>>>` (then the new one replaces it). A Bot turn started by an agent still never creates a card (above), but may resolve one.
- Panel and iOS clear the card only on `question_answered` / `question_dismissed` (or a human-origin `session_started`), and re-render the merged batch on a new `question`.
- Test: an agent message arrives while an ASK is pending -> after that turn the ASK is still pending and its card still shows; `<<<RESOLVED>>>` closes it; a second ASK merges into a batch of two; a human message closes it.

## Panel
- Rule: add turn kind `agent` and the steer rule; owner messages render as a Bot bubble with a small "For you" tag (FYI) or "Needs you" tag; live `message_owner` tool events render the same bubble (no tool row).
- Indicator on the sidebar Bot entry, both top-bar Bot buttons (badge over the orb on phones) and the /chat Bot row: **FYI** = a small dot; **Needs me** = a stronger pill with the count (e.g. accent fill, "1"), never violet. `aria-label` says which.
- Toggle label: "Show N hidden messages" / "Hide agent and system messages"; agent rows dimmed and labelled with their sender.
- Rename field in Bot settings; every "Bot" label in the panel reads the name.

## iOS (uncompiled here; built at the next Xcode build)
- Filter Bot history rows on `botView == "hide"` (with a "Show hidden messages" toggle), render `ownerMessage` rows as Bot bubbles with the tag.
- Bot tab `.badge`: needs-me count when > 0, else a dot-like FYI badge; exclude the Bot from `needsYouCount`.
- Tab label, BotView title and accessibility labels use the name.

## Tests and review
- Unit: bot-view rule table (server), message_owner FYI/needs-you/merge, agent never reads an owner message, ASK guard, read-state gating, attention, rename validation.
- Browser (Chromium + WebKit): agent turn hidden, steer inside an owner turn, owner bubble live + reload, indicator both kinds (sidebar, top bar, phone), toggle, rename.
- Screenshots registered as x056 artifacts (full IDs + SHA) and sent to Bot for UI review before any deploy. Deploy only on an explicit go: idle-only, no force.
