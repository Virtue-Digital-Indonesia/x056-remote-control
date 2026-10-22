# Owner view in every conversation: build contract (2026-10-22)

Efran, via Bot: "I also want it for normal conversation, if for me or needs me then show, else hide by default." This extends the 545836f Bot owner view to every normal (non-Bot) conversation. The Bot chat keeps its own rule, unchanged (`server/bot-view.ts`, `test/fixtures/bot-view-table.json`).

## The rule

- **Agent turn**: a turn whose trigger (a non-steered user row) has `sender.kind` in `conversation | mcp | delegate | automation`, EXCEPT a self-send (`sender.sessionId` equals the conversation's own sessionId: `message_self`, a continuation). Everything else is an owner turn: no sender (the owner), `autopilot`, `recap`, `advisor`, anything unknown.
- An agent turn is **hidden by default**: its trigger, tools, notices and replies. It is **shown whole** when the turn is marked for the owner: its reply (any assistant message in it, or a woken reply after it) contains `<<<FOR_OWNER>>>` on its own line, or an ASK block.
- **Keep rows** always show: `role: 'error'` banners, an owner steer (steered user row with no agent sender), the question card (panel/iOS; not a history row).
- An **agent steer** (steered user row, agent sender) inside an owner turn hides itself only; inside an agent turn it follows the turn.
- Nothing else changes in normal chats: system rows, relay checkpoints and sysline notices in owner turns stay as today.
- Shared table: `test/fixtures/owner-view-table.json` (server unit test and panel browser test both run it).

## The fact: one per turn, recorded by the server

- Marker: `FOR_OWNER = '<<<FOR_OWNER>>>'` in `src/question.ts`, `hasForOwner(text)`. Stripped from every displayed text, everywhere `<<<RESOLVED>>>` is: `stripAsk`/`stripResolved` (src/question.ts), `replyExcerpt` (server/notices.ts), panel `nodeMsg`, `server/memory-sources.ts`.
- Store: `server/owner-view.ts` `OwnerViewStore`, file `<stateDir>/owner-view/<sessionId>.json` = `{ [triggerMessageId]: { reason: 'marker' | 'ask', at: epochMs } }` (newest 500 kept). `markShown(sessionId, messageId, reason)`, `shown(sessionId): Set<string>`.
- Key: the trigger's `sender.messageId` (every agent turn has one, both providers).
- When:
  1. During the turn: any raw `assistant_text` (before `stripAsk`, in `tapToEvents`) with the marker or an ASK sets the run's reason.
  2. At `session_done`: the run's reason, else `hasForOwner(resultText)` / `parseQuestion(resultText)`.
  3. At `conversation_settled` with a woken reply (`woken: true`): the woken text is checked again; a turn that was hidden becomes shown and the server emits `owner_view`.
- Only non-Bot projects, only agent turns.

## Events and fields

- `session_done` (and the `conversation_settled` built from it) for an agent turn: `triggerMessageId`, and `ownerHidden: true` (not marked) or `forOwner: true` (marked).
- `owner_view` `{projectId, sessionId, messageId, shown: true, reason}`: a woken reply marked an already-finished turn.
- History rows (`conversations/history`, `history-page`) of non-Bot projects: a trigger row of a marked agent turn gets `forOwner: true`; every row gets `ownerView: 'show' | 'hide'`; rows of agent turns get `ownerTurn: 'agent'` and `ownerSender` (the trigger's sender label: conversationTitle, else projectName, else a kind label). A page that starts mid-turn looks back (like `botInitialTurn`) for the trigger's kind, messageId and sender.

## Unread and push

- A completed agent turn with `ownerHidden: true`: notice tier `none` (no push, no bell, no dot), and read-state does not mark the conversation unread.
- A shown agent turn: as today (tier quiet, bell and dot; its question card is urgent as today).
- A failed agent turn: as today (its error banner shows; urgent).

## Telling the agents

- One sentence in the container system note (constant: process identity).
- One per-turn line on every agent turn of a non-Bot conversation, inserted with `withTeamLine` and stripped by `stripTeamLine` (`TEAM_LINE` regex): `[Hidden from the owner: the owner does not see this turn or your reply unless you mark it. If your reply is for the owner or needs them (for example it reports finished work they asked for), put <<<FOR_OWNER>>> on its own line, or end with an ASK block for a decision.]`

## Panel

- `rc-chat.js` runs an owner mode on every non-Bot conversation (the Bot chat keeps its mode). Live: the trigger row's sender kind and session decide the turn; `session_done {forOwner}` and `owner_view` set `data-for-owner` on the trigger row (matched by its source messageId) and re-walk. History: `forOwner` on trigger rows; `ownerView` on rows before the first user row.
- Each run of hidden rows gets one inline real button before it: "N hidden messages" (and "from <sender>" when one sender). Clicking it reveals every hidden row of the conversation, dimmed, agent replies labelled "reply to <sender>", with a "Showing hidden messages · Hide" pill above the composer. It resets when the conversation changes. The walker, the `#chat` MutationObserver, `loadHistory` dedupe, `loadOlder` prepend and `showQuestion`/`clearQuestion` ignore the inline buttons.

## iOS

- ONE patch, `docs/ios-owner-view.patch`, rebased on main's `ios/` (the old one no longer applies: 3 of 6 files fail), keeping the old patch's Bot changes and its human-turn gate on question clearing, and adding the rule for every conversation: filter on `ownerView` for history rows, the live rule from `session_started` sender kind + `session_done`/`owner_view`, a "Show N hidden messages" item in More (generalising `SystemHistoryToggle`), dimmed rows labelled "reply to <sender>". Acceptance: `git apply --check` clean on main.

## Edge cases (told to Bot)

- Turns from before the release have no record: old agent turns, answered ASKs included, collapse behind Show.
- Approval mode: an approved send keeps its agent sender, so it is hidden by default.
- Bot relays of Efran's own requests are agent turns: hidden unless the reply is marked.
