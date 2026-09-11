# Remote Control Chat: implementation plan

**Priority:** reliable file work across accounts, with plugins, MCP, and skills available from the first release.

[Approved UI draft](https://x056.think.val.id/sites/rc-chat-review/) · [Feature list](https://x056.think.val.id/rc-chat-features.md)

Planning baseline: repository commit `8c0e6ae`, inspected 11 September 2026. This document plans implementation; production code has not changed.

## Build recommendation

**Codex · GPT-6 Astra · xhigh effort.** Use one implementation conversation and complete the milestones in order.

The difficult parts are file integrity, interrupted work, account capability differences, and compatibility with existing conversations. That is why I recommend xhigh. OpenAI documents Astra for complex coding and document work, with xhigh available. The effort choice is my assessment of this build. [OpenAI Docs](https://developers.openai.com/api/docs/models/gpt-6-astra)

## Architecture decisions

| Area | Implementation |
| --- | --- |
| Conversation engine | Reuse the existing manager, provider adapters, routing, transcripts, and event stream. |
| Chat identity | Add `Project.kind: project | chat`, defaulting legacy records to `project`. Each Chat has one internal workspace and one conversation. |
| User experience | Present Chat without a project picker. Keep internal workspace IDs for existing APIs, queues, artifacts, and MCP. |
| Storage | Give each Chat a persistent working directory under `state/chats/<chatId>/work`. Account changes retain this directory. |
| File records | Add a transactional file/version catalog. Link published versions to retained artifacts. Working copies remain separate from saved versions. |
| Capabilities | Reuse provider integrations and account provisioning. Add effective capability discovery for the Chat directory and selected account. |
| Serving | Keep working files private to RC. Publish selected deliverables to Think through the existing publishing workflow. |

Allocate Chat and conversation IDs before the first upload. Start the first turn with `resume: false`; later turns resume the recorded provider session.

Only manager-created Chat directories qualify as additional working roots. Do not allow arbitrary paths under the state directory. Separate directories prevent accidental mixing; they are not an OS sandbox.

Generic project APIs must preserve the one-conversation Chat rule. Keep Chat entries discoverable to tools, while filtering them from project-only navigation. Show their costs under Chat.

## Service contracts

| Contract | Behavior |
| --- | --- |
| `POST /api/chats` | Allocate stable workspace and conversation IDs without starting the provider. Accept a request ID for retry. |
| `POST /api/chats/:id/files` | Stream uploads; return committed file/version IDs. |
| `GET /api/chats/:id/files` | List files, version history, and processing status. |
| `POST /api/chats/:id/files/:fileId/versions` | Commit a working copy with an operation ID and expected base version. |
| `GET /api/chats/:id/files/:fileId/versions/:versionId/download` | Stream the exact retained version. |
| Preview/status endpoints | Request or inspect a preview job; serve completed preview artifacts. |
| Message and queue bodies | Add immutable file/version references to existing delivery contracts. |
| Capability endpoint | Return provider/account readiness and effective skills for the Chat directory. |

Scope file and preview events by workspace, conversation, file, and version IDs. Reconnect by fetching persisted state; events notify clients of changes.

Proposed MCP operations: `list_chat_files`, `checkout_chat_file`, `commit_chat_file`, and `preview_chat_file`. Validate caller context and file ownership through the same service.

## Build sequence

### 1. Chat identity and persistent workspace

Extend `server/projects.ts` and `server/manager.ts`; add a small `server/chats.controller.ts` facade.

Implement create/list/open/rename/archive and prepared first-turn startup. Persist the Chat directory, provider, model, effort, and routing choice. Reuse conversation metadata for pins and read status.

Resolve the Chat directory consistently for history, queued turns, automations, MCP, artifacts, and crash recovery. Keep global preferences and explicitly selected references available.

**Gate:** create two Chats, restart RC, and resume each with its original identity and files. Existing project conversations still work.

### 2. File handling and serving

Add `server/file-store.ts` and `server/files.controller.ts`. Use a transactional catalog with explicit schema migrations.

| Record | Required fields |
| --- | --- |
| File | ID, Chat/conversation owner, display name, detected type, latest version, removal state |
| Version | ID, file ID, parent version, hash, byte count, retained artifact ID, source message/account, timestamp |
| Operation | Request ID, base version, state, error, resulting version |
| Preview job | Version ID, converter version, state, output artifact IDs, error |

Upload through a bounded multipart stream. Begin with the existing 50 MiB per-file limit and a 200 MiB batch limit. Align proxy and server limits. Show progress, cancellation, and retry.

Stage bytes, validate type and size, then commit the original as an immutable version. Reconcile retained blobs and catalog records after a crash; never discard referenced bytes. Preserve display names, including Unicode; use generated storage names. Handle duplicate filenames independently.

Messages and queues reference `{fileId, versionId}`. Stop embedding binary data in message JSON or browser drafts. A retry must reuse its upload and message request IDs.

Serve by file/version ID through RC authentication. Support streamed downloads, byte ranges, correct filenames, MIME types, and missing-file responses. Validate the requested conversation association and resolved storage path.

Render text, images, and PDF previews safely. Serve active content as downloads. Apply archive expansion limits before inspecting office files or archives.

**Gate:** queue a message with attachments during another turn. Refresh, retry, then download the exact uploaded bytes without duplication.

### 3. Document inspection, editing, and preview

Package a pinned document toolkit and converter in the runtime image. First prove the tools against representative DOCX fixtures before adopting them.

| Format | First-release behavior |
| --- | --- |
| DOCX | Inspect, create, modify supported structures, save versions, generate PDF/page previews, download |
| PDF | Read and extract content, preview, download; retain the original |
| Images | View and use as references; register generated or modified outputs |
| TXT, Markdown, CSV, JSON | Read, edit, version, preview, download |
| XLSX, PPTX, other files | Upload, retain, download, and pass to available tools; show unsupported preview/edit states explicitly |

Use a working copy for edits. Preserve unaffected document structures. Check tables, styles, numbering, headers, footers, images, and page breaks. Detect unsupported structures before rewriting them.

Add a maintained document skill with inspect/edit/validate/save/preview steps. Expose file listing, working-copy checkout, version commit, and preview status through x056 MCP. Plugin and shell outputs use the same commit path.

Register outputs explicitly; retain transcript scanning as a fallback. A “ready” document card requires a validated saved version. Preview failure must not remove a valid download.

Conversion jobs run outside the HTTP request with bounded resources and persistent status. Reuse previews by version hash and converter version. Recover unfinished jobs after restart.

**Gate:** revise a proposal fixture and download a valid DOCX. Compare its rendered pages and structure against the original. Keep the original downloadable.

### 4. File integrity during account failover

Extend the existing failover lifecycle with file-operation checkpoints. Persist the source version, completed outputs, and pending work.

Validate and atomically publish each saved version. Use operation IDs to avoid duplicate versions after retries. Reject a commit against an outdated base version. Keep incomplete working files out of the saved-version list.

On restart or failover, reconcile unfinished operations before editing again. Fence old run and worker IDs so stale processes cannot publish a version. Show whether RC resumed, retried an interrupted step, or is waiting for capacity.

Archiving retains files. Removing a reference does not delete its source. Restore creates a new version. Deletion must preserve files referenced by other versions, chats, or queued messages.

**Gate:** interrupt editing and conversion at each commit boundary. Resume on another account; verify originals, hashes, version order, and downloads.

### 5. Plugins, MCP, and skills in Chat

Add a **Tools** entry beside the composer. Its panel has Plugins, MCP, and Skills tabs, with search and invocation where supported.

Reuse `server/plugins.ts`, `server/mcp-servers.ts`, and `server/provision.ts`. Resolve effective skills from the actual Chat directory and account. Include user skills, plugin skills, and provider-managed skills where exposed. Preserve provider-native invocation syntax.

Show installed, ready, authorization-needed, unavailable, and account-drift states separately. Installation alone does not prove a tool is usable.

Track capabilities explicitly selected or required for the task. Route failover only to eligible accounts with those capabilities. If none qualifies, show what is missing and wait or let the user change the requirement.

Compare skill versions, enabled state, and supporting scripts across eligible accounts. Synchronize shared skills and supported configuration through existing provisioning. Keep account credentials separate. OAuth-backed connectors may require authorization on the destination account.

Refresh capability discovery before the next turn after configuration changes. Recreate idle provider processes when required; do not interrupt an active turn.

**Gate:** invoke a skill, an MCP tool, and a plugin from Chat. Repeat after failover. Verify that missing authorization produces an actionable state.

### 6. Approved UI and project interactions

Implement the approved layout in the existing presentation layer. Add focused Chat modules beside `server/public/control-room.js`; reuse the current composer and conversation rendering.

Wire the file panel to actual upload, edit, conversion, version, and download states. Include cancel/retry, unsupported-format, no-capacity, and missing-file states. Match desktop and mobile layouts.

Add the `@` conversation picker, source links, and reference removal. Extend MCP discovery to distinguish Chats from projects without hiding either.

Reuse existing message approval policy, delivery IDs, queues, and correlated replies. Render pending, sent, queued, denied, failed, and replied states. Do not resend because a reply is slow.

Retain stop/continue, streaming, tool activity, drafts, search, pins, archives, notifications, and automations. Provider models and effort options come from actual discovery.

**Gate:** complete the proposal workflow through the UI, including a project reference and message exchange.

### 7. Release checks and rollout

Run targeted tests during each milestone. At integration, run `npm run typecheck`, `npm test`, and the relevant browser suites.

Add coverage for file endpoints, document fixtures, interrupted writes, queued attachments, capability-aware failover, and Chat/project navigation. Reuse existing failover, artifact, plugin, MCP, provisioning, and session tests.

Run one real document workflow on each provider, including a controlled same-provider account switch. Check reconnects, download authorization, path traversal, malformed office files, and converter timeouts.

Ship behind a Chat feature flag. Back up registry, catalog, and retained files before migration. Rollback disables Chat and preview workers while retaining data and existing project behavior.

## Completion checklist

- Upload a proposal and references before sending the first message.
- Modify the document, preview it, download it, and reopen an earlier version.
- Continue on another account with conversation, files, and required tools available.
- Restart RC and recover queued messages, file operations, and preview jobs.
- Use plugins, MCP, skills, project references, and messaging from Chat.
- Verify existing project conversations and controls still pass their tests.

## Existing foundations

| Code | Reuse or gap |
| --- | --- |
| `server/api.controller.ts` | Uploads currently become loose files and prompt paths. Add version references while retaining legacy compatibility. |
| `server/workspace-store.ts`, `server/workspace.controller.ts` | Already retain hashed artifacts and serve authenticated downloads. Add file lineage and generated previews. |
| `src/failover.ts`, `server/codex-sessions.ts` | Already resume sessions across same-provider accounts. Add operation recovery and capability eligibility. |
| `server/provision.ts` | Copies skills and provisions integrations. Already reports connectors needing authorization. |
| `src/persistent-codex.ts` | Already discovers skills by working directory. Reuse provider-native behavior. |
| `server/public/panel.html` | Existing busy conversations queue text only. Queued file references are a required change. |

Cross-provider continuation, automatic Desktop import, collaborative document editing, and full spreadsheet/presentation editors remain outside this release.
