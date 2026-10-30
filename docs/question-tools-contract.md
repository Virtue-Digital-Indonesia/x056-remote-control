# Question cards over MCP: contract

Efran, 2026-10-30: "question box on the web and mobile should be controlled via
MCP instead of interpreting it from the prompt", and "allow the AI agent to
dismiss, answer, and edit question cards".

The pending-question store (`pendingQuestions`, `state/questions.json`) stays
the only source of truth. Panel and iOS keep reading `GET /api/questions` and
the `question` / `question_answered` / `question_dismissed` events, so old
clients keep working.

## Items get stable ids

Every item in a batch gets `id` (8 hex chars, random) when it is created.
Legacy items without one get an id at load, and the file is re-saved.
`questions[]` (and the single-question fields) carry `id` in every event
and in `GET /api/questions`. An edit keeps the id; a partial close keeps
the remaining items' ids and the batch `at`. Tools address an item by
`at` + `id`, and a stale `at` or an unknown id is HTTP 409
`{error: 'question_stale', open: <current batch or null>}`.

## Caller identity

The bridge sends `from` = `X056_SELF_SESSION_ID` (else `X056_RELAY_FROM`).
Mutating routes need `from`. A target conversation defaults to the caller's
own (`X056_SELF_PROJECT_ID` / `_SESSION_ID`). An external `/mcp` client with
no identity can only list.

**Delegates manage no cards.** A delegate's bridge has no `X056_SELF_*` and
sends its orchestrator's session as `from` (`X056_RELAY_FROM`), so the server
would take its mutations as the orchestrator's own. The bridge therefore also
sends `delegateId` (`X056_DELEGATE_ID`) on ask, edit and close, and the server
refuses any of those that carries one: 403 `{error: 'delegate_no_questions',
message: 'Delegates do not manage question cards; put what you need in your
report (NEEDS HUMAN / NEEDS ORCHESTRATOR).'}`. `list_questions` stays allowed.

## Routes

### `POST /api/questions/ask`
Body `{from, projectId, sessionId, questions: [{question, options?: string[]}], replace?: boolean}`
(1-8 questions, question 1-500 chars, 0-12 options of 1-200 chars).
`projectId`/`sessionId` must equal the caller's own conversation (an agent
asks only on its own card), else 403.

- Autopilot armed on that conversation: nothing opens. Record it with
  `recordAutopilotQuestion` (the recap re-asks it). Return `{status: 'recorded_autopilot'}`.
- Bot project and the running turn is not owner-started (`botReply` rule):
  403 `{error: 'bot_use_message_owner'}`.
- Otherwise `addPendingQuestion(pid, sid, q, replace ? 'replace' : 'merge', run?.requestId)`.
  If a gateway run is active, set `run.ownerReason = 'ask'`. With no run but
  an `afterTurns` record (a woken reply), mark the owner-view record just as
  `ownerWoken` does today. Return `{status: 'open', at, questions}`. A merge
  that adds nothing returns the existing batch with `status: 'open'`.

### `POST /api/questions/edit`
Body `{from, projectId, sessionId, at, id, question?, options?, reason}`.
Only the conversation that asked may edit its card (`from` = the target, and
not a delegate). Anyone else gets 403 `{error: 'edit_own_only', message:
'Only the conversation that asked can edit its card; dismiss it or answer it
instead.'}`: a direct store write on another conversation's card would bypass
approval mode and relay checkpoints. It keeps `at` and `id`.
It emits `question` with the full batch plus `{edited: true, remainder: true, by, byAgent, reason}`
(`remainder` keeps notices, read-state and the Bot digest quiet on every
client, old ones included).

### `POST /api/questions/close`
Body `{from, projectId, sessionId, at, ids?: string[], action: 'dismiss' | 'answer', answer?, reason, confirmRelay?}`.
Omitting `ids` means the whole batch. `reason` is required for dismiss (1-300
chars). `answer` is required for answer (1-2000 chars).

- **Dismiss on the caller's own card:** close those items at once (no
  message to self). A partial close uses the `closePendingQuestions` path
  (remainder event); a whole-batch close emits
  `question_dismissed {at, by, byAgent, reason}`. Returns
  `{status: 'dismissed', at, closed, open}`.
- **Dismiss on another conversation's card:** the same at-delivery pattern
  as a cross answer (below). ONE short message goes to the asking
  conversation through the ordinary send: `Your open question was dismissed
  by <caller title>: <reason>` followed by one `- <question>` line per
  dismissed item. The items close at delivery (automatic mode: at once;
  approval mode: on approve, re-checking `at` and ids; if gone, the message
  goes as a plain message with `cardClosed: false, note: 'card already
  closed'`), with the same events as an own dismiss, so the
  `question_agent_action` line appears in the target at close time, before
  the turn the message starts. Same receipt as a cross answer; the relay
  checkpoint 409 passes through and `confirmRelay` sends it.
- **Answer on the caller's own card:** close with the answer recorded:
  `question_answered {at, by, byAgent, answer, ids}` (partial: the remainder event with
  `answered`, `by`, `byAgent`, `answer`). The agent goes on in its own turn.
- **Answer on another conversation's card:** deliver the answer to that
  conversation through the ordinary cross-conversation send
  (`conversationSend`, so approval mode and relay checkpoints apply), as the
  same text the panel sends (`N. <question>\nAnswer: <answer>` per item).
  **The card closes at delivery**, at the same point where `send_message
  {helpers}` is applied: at once in automatic mode, on approve in approval
  mode. Re-check there that the batch is still open with the same `at` and
  the ids still exist. If not, deliver the answer as a plain message and
  put `cardClosed: false, note: 'card already closed'` in the receipt.
  Turn start gains NO new rule: an agent-origin turn still never closes a
  card through `answersQuestionAt`.
  Return the delivery receipt (`sent`/`queued`/`pending_approval`), and
  pass the relay-checkpoint 409 through unchanged. The receipt (cross answer
  and cross dismiss alike): automatic mode `{mode: 'auto', status, sessionId,
  queued, messageId, hopsLeft, hopsUntilCheck, confirmedCheckpoint?,
  cardClosed, note?}`; approval mode `{mode: 'approval', status:
  'pending_approval', approvalId, messageId}`, and `GET
  /api/conversations/send-status` carries `cardClosed` / `note` once approved.
  The close request rides on the `McpApproval` as `closeQuestion {at, ids, by,
  action: 'answer' | 'dismiss', answer?, reason?}` (an approval saved before
  `action` existed is an answer).

`by` stays a STRING on every event: `'agent'` for these, and what it was
before for a human close (`'turn'`, `'steer'`, ...), because older panels and
iOS builds read it as one. The agent itself rides in a new field
`byAgent` = `{kind: 'agent', sessionId: from, projectId, title}` (the
caller's conversation title). Clients that want the name read `byAgent`.

### `GET /api/questions`
Unchanged, items now carry `id`. Accepts `?projectId=&sessionId=` to filter.

## The owner sees every agent edit or close

On each agent edit/dismiss/answer, the target conversation gets ONE system
line, live and on reload, the same way `session_reset` / `identity_held`
lines work today:

- "Question edited by <title>: <reason>"
- "Question dismissed by <title>: <reason>"
- "Question answered by <title>: <answer, cut to 160 chars>"

Event kind `question_agent_action {projectId, sessionId, action, by: 'agent', byAgent, at, ids, actionId, text, reason?, answer?}`,
journalled for reload as `{role: 'notice', messageId: 'question-action:<actionId>', text, ts}`.
Notice tier `quiet` (bell + dot, no push).

**Always visible.** The line is a `keep` row in both owner-view rule sets
(`server/owner-view.ts`, `server/bot-view.ts`, mirrored in
`server/public/rc-chat.js`): a history row whose `messageId` starts with
`question-action:`, and the live node the panel appends for the event
(`data-question-action`), show even inside a hidden agent turn and in the Bot
chat's agent and system turns, like question cards and error banners. The
shared fixtures `test/fixtures/owner-view-table.json` and
`test/fixtures/bot-view-table.json` carry these rows.

## MCP tools (scripts/x056-mcp-tools.mjs)

- `ask_user {questions: [{question, options?}], replace?}`: description says
  call it, then END YOUR TURN; the owner's answer arrives as your next
  message. Refuses without SELF.
- `list_questions {project_id?, session_id?, all?}`: own conversation by default; `all: true` lists every open card.
- `edit_question {at, id, question?, options?, reason, project_id?, session_id?}`: own card only (the description says so).
- `dismiss_question {at, ids?, reason, project_id?, session_id?, confirm_relay?}`: replaces `<<<RESOLVED>>>`.
- `answer_question {at, ids?, answer, project_id?, session_id?, confirm_relay?}`
- Each has an output schema (the import-time check throws without one);
  `dismiss_question`'s covers the delivery receipt fields, as
  `answer_question`'s does. Non-blocking: one request, except
  `answer_question` and `dismiss_question` cross-conversation in approval
  mode, which poll like `send_message` (`waitForApproval`).
- With `X056_DELEGATE_ID` set (a delegate) the bridge adds `delegateId` to
  ask, edit and close bodies; the gateway refuses them (see Caller identity).

## Prompts

`ASK_INSTRUCTIONS` keeps the exact sentinel `〈x056 question protocol〉` and
now teaches: when you genuinely need a decision only the user can make,
call the x056 tool `ask_user` (questions with options), then end your turn.
Also update `openQuestionLine` (close with `dismiss_question` / `answer_question`,
not RESOLVED), `OWNER_HIDDEN_LINE`, BASE_SYSTEM_NOTE (5a), both recap
prompts, and the Bot persona lines that mention ASK.

## Fallback, one release

The `<<<ASK>>>` block parser and `<<<RESOLVED>>>` stay as a fallback and log
`question_fallback {sessionId, kind: 'ask' | 'resolved'}` to events.jsonl
each time they fire, so they can be removed once that count stays near zero. The
trailing-`?` guess (`parseQuestion`, last line ending in `?`) is REMOVED.
That also changes owner-view marking and notice leads; update those fixtures.
