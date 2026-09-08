# MCP output contracts

The 28 advertised actions now declare output schemas and return matching `structuredContent` over HTTP and stdio.
MCP server version is `2.1.0`.
Existing text blocks remain unchanged.
Both representations come from one handler execution.

The contracts follow the gateway controllers and stores, plus the deployed MemoryKnowledge handlers.
Fields in discovery describe types; they contain no live records, credentials, or source code.
Only referenced memory definitions appear in each schema.

| Actions | Structured result |
| --- | --- |
| `list_projects` | `projects` array |
| `list_conversations` | `conversations` array, with optional model, effort and creation time |
| `read_conversation` | `messages` array of user and assistant rows |
| `send_message` | `delivery` with mode, status and the fields available for that outcome |
| `list_queued` | Filtered `messages` array, sorted by queue time |
| `cancel_queued`, `edit_queued` | Project, message ID and API acknowledgment |
| `stop_conversation` | Project, session, stopped flag and dropped count |
| `message_self` | Queue ID and remaining self-message allowance |
| `schedule_task`, `pause_scheduled` | `job` object |
| `list_scheduled`, `cancel_scheduled` | Jobs and default timezone; cancellation ID and acknowledgment |
| Six `code_*` actions | Service text and error flag |
| `wiki_search`, `wiki_read` | Search results, links and count; page items or explicit missing-page records |
| `save_memory` | Shared-memory save receipt and review status |
| `memory_search`, `memory_read` | Search results; entry, revisions, relationships and source evidence |
| `memory_propose`, `memory_update`, `memory_link` | Entry envelope; relationships envelope |
| `memory_context` | Context text, selection, budget, preferences and history |

Send outcomes distinguish pending, expired, denied, failed, queued, sent, reply and reply timeout.
Denial and expiry remain business outcomes.
Thrown errors retain `isError: true` and their original text, with an `error` string envelope.
Unavailable queue and schedule targets retain a null provider.

Validation uses strict Ajv compilation and disposable gateway fixtures.
Fixtures cover every action, including mutations, review, cancellation, nulls and polling.
The release verifier checks live discovery and read-only calls using an existing gateway bearer token:

```sh
node scripts/verify-mcp-output.mjs https://x056.rc.val.id
```

It prints validation summaries, without printing returned records or credentials.
It does not exercise the ChatGPT client's OAuth refresh flow.

Production belongs to this checkout's host-side deploy actuator on valbox.
A release must preserve its state volume, environment and live panel mount.
This task waits for active turns, background provider sessions and workflows to finish before requesting a swap.
It does not use the actuator's forced restart timeout.
The task's `.deploy/release.json` records commit, tests, deployed version, verification and rollback image.
