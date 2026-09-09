# MCP output contracts

The 34 advertised actions now declare output schemas and return matching `structuredContent` over HTTP and stdio.
MCP server version is `2.2.0`.
Text blocks remain available alongside structured results.
Both representations come from one handler execution.

The contracts follow the gateway controllers and stores, plus the deployed MemoryKnowledge handlers.
Fields in discovery describe types; they contain no live records, credentials, or source code.
Only referenced memory definitions appear in each schema.

| Actions | Structured result |
| --- | --- |
| `get_activity` | Running conversations, background activity, workflows, questions and observation time |
| `search_conversations` | Filtered conversation page, total and pending date scans |
| `read_reply` | Exact message ID, anchor found flag, reply messages and truncation flag |
| `list_artifacts` | Filtered artifact page with authenticated download paths |
| `register_artifact` | Registered artifact metadata |
| `read_artifact` | Metadata, bounded text or an additional MCP image content block |
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

The bridge validates input schemas before calling the API.
Each tool declares read-only, destructive, idempotency and external-effect hints.
These hints describe behavior; they do not replace authorization checks.

`send_message` returns a server-generated `messageId` in text and structured results.
The ID survives approval, queue persistence and provider dispatch.
`read_reply` finds that ID in the transcript, then returns assistant text before the next user message.
It scans up to ten pages of 500 history rows and returns at most 100 messages or 100,000 characters.
A missing anchor never causes another request’s reply to be returned.
Reply text can still be streaming; it does not prove completion.
Slash commands do not carry the sender marker, so use conversation history for their results.

`get_activity` returns a snapshot, not a deployment lock.
A workflow read failure produces an error rather than an idle result.
The deploy actuator must still check activity at cutover.
Conversation search matches titles, project names and IDs, not transcript text.
An unknown last-message date remains null.

Artifact registration requires exactly one absolute file path, preview URL or test summary.
It uses the library’s existing file checks and retains allowed files.
Test status records the caller’s claim; registration does not run tests.
Reads return supported images up to 2 MB and text up to 64 KB.
Larger images and other document types return metadata with an authenticated download path.
The tool does not fetch preview URLs or publish public sharing links.

Validation uses strict Ajv compilation and disposable gateway fixtures.
Fixtures cover every action, including mutations, review, cancellation, nulls and polling.
The release verifier checks live discovery and read-only calls using an existing gateway bearer token:

```sh
node scripts/verify-mcp-output.mjs https://x056.rc.val.id
```

It prints validation summaries, without printing returned records or credentials.
It does not exercise the ChatGPT client's OAuth refresh flow.

Deployment uses the existing host actuator and requires deployment authorization.
This release has no frontend changes.
