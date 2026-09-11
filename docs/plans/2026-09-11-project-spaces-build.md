# Project spaces implementation record

Implementation started on 11 September 2026 from `9d8eb82`, on `feature/project-spaces`.

Efran authorized implementation after reading the handoff. The feature remains disabled by default through `X056_PROJECT_SPACES_ENABLED`. Production remains on its built image. No deployment has been requested for this build.

## Current progress

| Stage | State | Evidence and remaining work |
| --- | --- | --- |
| Contracts and migration | Foundation implemented | Optional workspace, validated execution targets, aggregate API, atomic registry writes, revisions, membership receipts, additive migration report. Release backup rehearsal remains. |
| Memory scope | Foundation implemented | Parent inheritance, local isolation, shared eligibility for dispatch and MCP, dispatch audit with membership and source revisions. Project brief and membership UI remain. |
| Project files | Next | Extend the current catalog with ownership, independent lineage, and leases for each execution attempt. |
| Project views | Pending | Real routes, project tabs, preserved drafts, desktop and mobile checks. |
| Membership and defaults | Pending | Complete receipt reconciliation, queue review, settings, archive behavior, effective tool requirements. |
| Handoffs and integrations | Pending | Durable delivery, MCP contracts, exact links, activity and cost aggregation. |
| Release | Pending | All acceptance gates, backup and rollback rehearsal, browser and document checks. |

## Dependency audit

The registry preserves existing IDs, conversations, provider session IDs, and working directories. Internal Chat records remain execution targets. The new `/api/project-spaces` API lists ordinary parents and their member Chats.

Workspace validation covers direct starts, continuations, interactive adoption, provider handoffs, discovery, Chat file access, and relative artifact references. Missing workspaces cannot fall back to the gateway directory. Memory import skips legacy filesystem sources when a Project has no directory.

Direct, queued, scheduled, approved, and resumed messages converge on manager launch. Memory context resolves there once. Account failover receives the same prepared prompt. New scopes come from registry records; request fields cannot override parent membership.

Membership receipts and membership changes share an atomic registry write. Queue and file effects still need restart reconciliation before the membership API becomes available. Registry corruption now fails before any overwrite.

## Checks so far

The first compatibility run passed 835 tests across 73 files. Later memory changes passed 34 focused tests and typecheck. These checks cover the foundation only.

New fixtures cover migration retries, invalid parents, absent workspaces, revision conflicts, feature disable, inherited memory, local isolation, exclusions, budgets, and dispatch snapshots. A simulated account switch checks that an approved memory change cannot alter an already dispatched prompt.

The full plan's 18 acceptance gates remain the release requirements. No live provider task, hierarchy browser workflow, shared document workflow, or rollback rehearsal has passed yet.

## Resume

Read this record and `2026-09-11-project-chat-work-memory.md`. Continue in stage order. Preserve unrelated untracked design directories. Use isolated state for write tests.
