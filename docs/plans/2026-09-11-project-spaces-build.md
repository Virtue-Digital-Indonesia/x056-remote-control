# Project spaces implementation record

Implementation started on 11 September 2026 from `9d8eb82`, on `feature/project-spaces`.

Efran authorized implementation after reading the handoff. The feature remains disabled by default through `X056_PROJECT_SPACES_ENABLED`. Production remains on its built image. No deployment has been requested for this build.

## Current progress

| Stage | State | Evidence and remaining work |
| --- | --- | --- |
| Contracts and migration | Foundation implemented | Optional workspace, validated execution targets, aggregate API, atomic registry writes, revisions, membership receipts, additive migration report. Release backup rehearsal remains. |
| Memory scope | Foundation implemented | Parent inheritance, local isolation, shared eligibility for dispatch and MCP, dispatch audit with membership and source revisions. Project brief review and membership UI are connected. |
| Project files | Foundation implemented | Shared ownership, independent lineage, retained Work output import, execution leases, and compatibility endpoints. Project Files UI is connected; broader recovery rehearsal remains. |
| Project views | Implemented, integration checks continuing | Real Project and Work routes, project tabs, Chat parent filter, file versions and attachment drafts. Desktop, mobile, refresh and direct sign-in passed in an isolated browser. |
| Membership and defaults | Implemented, integration checks continuing | Durable membership/archive receipts reconcile before dispatch. Queues, scheduled jobs and autopilots pause without losing content. Settings apply separate mode defaults and verify inherited tools in the execution directory. Five focused tests passed. |
| Handoffs and integrations | Pending | Durable delivery, MCP contracts, exact links, activity and cost aggregation. |
| Release | Pending | All acceptance gates, backup and rollback rehearsal, browser and document checks. |

## Dependency audit

The registry preserves existing IDs, conversations, provider session IDs, and working directories. Internal Chat records remain execution targets. The new `/api/project-spaces` API lists ordinary parents and their member Chats.

Workspace validation covers direct starts, continuations, interactive adoption, provider handoffs, discovery, Chat file access, and relative artifact references. Missing workspaces cannot fall back to the gateway directory. Memory import skips legacy filesystem sources when a Project has no directory.

Direct, queued, scheduled, approved, and resumed messages converge on manager launch. Memory context resolves there once. Account failover receives the same prepared prompt. New scopes come from registry records; request fields cannot override parent membership.

Membership receipts and membership changes share an atomic registry write. Queue and file effects still need restart reconciliation before the membership API becomes available. Registry corruption now fails before any overwrite.

## Checks so far

The first compatibility run passed 835 tests across 73 files. Later memory changes passed 34 focused tests and typecheck. These checks cover the foundation only.

Shared file checks passed six tests, including a real DOCX edit through Chat and Work followed by a persisted preview. Original bytes stayed unchanged. Existing Chat file checks passed ten tests. MCP checks passed 28 tests and covered all 45 advertised actions. Project file HTTP checks cover uploads without Work setup, authentication, Unicode filenames, ranges, and retry receipts.

The additive file catalog migration is version 2. It retains legacy Chat ownership and version URLs. Project copies reuse immutable blobs but receive independent file and version IDs. Shared write leases record the execution, conversation, attempt, owner, membership revision, and base version. Restart and failed attempts invalidate old leases without invalidating sibling conversations.

New fixtures cover migration retries, invalid parents, absent workspaces, revision conflicts, feature disable, inherited memory, local isolation, exclusions, budgets, and dispatch snapshots. A simulated account switch checks that an approved memory change cannot alter an already dispatched prompt.

The full plan's 18 acceptance gates remain the release requirements. No live provider task, hierarchy browser workflow, or rollback rehearsal has passed yet.

## Resume

Read this record and `2026-09-11-project-chat-work-memory.md`. Continue in stage order. Preserve unrelated untracked design directories. Use isolated state for write tests.

## Project views and membership checkpoint

The isolated browser passed Project creation, upload and preview, member Chat creation, exact-version attachments, draft restoration, context inspection, Work workspace setup, prepared Work creation, direct Work links, mobile layout, and signing in to a Work link. No browser JavaScript errors were reported.

Additional controls now cover reviewing paused messages, removing inaccessible attachments during review, resuming retained autopilots, sharing selected private Chat versions into Project Files, importing retained Work outputs, reviewing a pinned Project brief, and filtering all Chat by parent. These additions still need their expanded browser acceptance checks. Project tool discovery uses the actual Work conversation provider and workspace.

Five membership tests cover retained queues and scheduled jobs, interrupted-operation recovery, background work guards, archive/restore behavior, separate defaults, idempotent Work preparation, and tool availability by execution directory. Typecheck and syntax checks pass. The shared document and memory tests remain part of the final release run.

Handoffs, cost aggregation, backup and rollback rehearsal, and the complete acceptance matrix remain unfinished. Production is unchanged.
