# Project spaces: build handoff

**Later planning update:** the first build is recorded at `492dc57` on `feature/project-spaces`. Read the [Project integration and file memory blueprint](2026-09-11-project-integration-memory-blueprint.md) for the revised design. It covers whole Work projects, individual conversations, cross-project memory, and uploaded sources. Efran requested planning only for this revision. The original handoff below is historical.

Prepared 11 September 2026 for compaction. Repository: `/home/efran/remote-development/x056-remote-control`.

The RC Chat release is complete. The Project / Chat / Work / Files / Memory implementation is planned but has not started. The latest request prepares this handoff; it does not start implementation or request another deployment.

Read the full [implementation plan](https://x056.think.val.id/rc-project-chat-work-memory-plan-20260911.md) before building. Its repository source is `docs/plans/2026-09-11-project-chat-work-memory.md`. That document contains seven stages and 18 acceptance gates. This handoff preserves the starting state and critical constraints; it does not replace the plan.

## Resume instruction

After compaction, Efran can send:

> Read `docs/plans/2026-09-11-project-spaces-handoff.md` and the linked implementation plan. Begin implementation in stage order. Re-check current code dependencies first. Preserve existing Chat and Work behavior, prioritize files, and keep the hierarchy behind its feature flag until acceptance passes.

Use **Codex / GPT-6 Astra / Extra high (`xhigh`)**. The prior review verified this model and effort in RC's catalog. The recommendation reflects the migration, scope, and recovery work. See the plan for its official model reference.

Compacting now separates completed release work from the next build. Official OpenAI documentation describes `/compact` as reducing conversation context while retaining key details. The saved files provide a durable implementation reference. [Official OpenAI documentation](https://learn.chatgpt.com/docs/developer-commands?surface=cli)

## Verified starting state

| Item | State at handoff |
| --- | --- |
| Branch | `main`; tracked files clean before this handoff |
| Deployed revision | `efdd2137832e9da89de9bf5cb9c3ceef9cf4fdc3` |
| Original Chat release | `8b6a061`: files, account continuity, tools, conversation references |
| Navigation refinement | `22efa11`: dedicated Chat URLs, improved dialogs, project-grouped references |
| Sidebar correction | `887cff0`: three UI files only |
| Plan commit | `efdd213`: implementation plan only |
| Live verification | Passed at `2026-09-11T03:54:27.265Z` |
| Deployment request | No pending `requested`, `revision`, `force`, or `idle-only` files at handoff |

Evidence: `.deploy/sidebar-live-efdd213.json`. It records matching revision, unchanged backend fingerprint, health, routes, built-image panel, sidebar styling, icon, desktop/mobile navigation, and no JavaScript errors. The verifier is `.deploy/verify-sidebar-efdd213.cjs`. These checks establish the current release, not the future hierarchy.

The sidebar uses shared `.cr-primary-nav :is(button,a)` styling and the existing `#i-chat` symbol. Keep the real `/chat` and `/chat/:chatId` links. Preserve the deployed dialogs and grouped reference picker.

The prior behavioral release passed 829 tests, typecheck, document checks, and browser workflows. The sidebar-only patch passed syntax, diff, and focused browser checks. It did not rerun the full suite. The new build needs fresh tests for its own changes.

Unrelated untracked directories under `design/panel-drafts/` belong to other work. Preserve them and stage only this task's files. Re-check repository state after resuming; other sessions may have advanced it.

## Product requirements to carry forward

Efran wants to continue document tasks across accounts when an account reaches its limit. File handling, modification, retention, serving, and previews are the top priority. Keep provider, model, effort, account, plugin, MCP, and skill controls available.

Project becomes the shared home with **Chat / Work / Files / Memory** tabs. Standalone Chat remains available. A Project may have Chat and Files before a Work workspace exists. The first release supports one Work workspace per Project.

Reuse existing project identities, memory storage, file catalog, artifact storage, queues, delivery records, and capability discovery. Preserve Chat and Work session IDs, directories, histories, original files, version URLs, drafts, and account selections.

Project membership must not grant Chat access to the Work directory or merge provider transcripts. Defer multiple repositories per Project, moving existing Work conversations, automatic Desktop import, native cross-provider resume, and a new task system.

## Constraints that must survive compaction

| Area | Required behavior |
| --- | --- |
| Parent identity | Reuse ordinary Projects. Add optional Chat `parentProjectId` and `membershipRevision`; preserve execution identities. |
| Work directory | Audit every assumption that `Project.cwd` exists. Require a validated runnable workspace before Work launch. Never default to the gateway directory. |
| MCP identities | Existing `projectId` means execution target. Add explicit parent fields without silently changing old tool semantics. |
| Local memory | Old Chat-local memory stays local after a move. Sharing with the parent is a separate operation. |
| Shared memory | Reuse reviewed memory and a pinned `project-brief`. Parent inheritance works even when cross-project retrieval is disabled. |
| Context selection | Apply exclusions before pins. Preserve approval, expiry, provider, and source rules. Deduplicate within one total budget. |
| Dispatch snapshot | Resolve scope on the server. Record exact memory revisions and membership once at dispatch; retain that snapshot through same-provider failover. |
| File lineage | Adding a private file to a Project creates an independent lineage from a selected saved version. Preserve provenance and immutable bytes. |
| Concurrent edits | Require expected base versions and idempotent operations. Conflicts must not overwrite another saved version. |
| Write fencing | Scope shared-file leases to execution and run attempt, owner, membership, and base version. One failed conversation must not invalidate a sibling's valid checkout. |
| Membership changes | Move only while idle. Retain queued messages but require review of changed context before dispatch. Revalidate shared-file access. |
| Historical context | Earlier injected memory remains in provider history after a move. Disclose this and offer a fresh linked conversation. |
| Tool eligibility | Discover using the actual execution directory and account. Verify requirements at dispatch and failover. Work-only skills do not become ready in Chat. |
| Handoffs | Carry an editable brief, selected sources, and exact file versions. Retries reuse one target and one initial message. |
| Messaging | Preserve human approval, sender attribution, correlated replies, cancellation, and hop limits. |
| Recovery | Use durable operations across JSON and SQLite stores. Take WAL-safe backups; rehearse rollback after new writes. |

Retain downloads when preview or editing fails. Keep supported formats explicit, including DOCX fidelity limits. File uploads may support memory proposals; they do not confirm memory automatically.

## Build sequence and source map

Before changing code, audit `cwd`, `projectId`, and context-resolution dependencies against current HEAD. Include direct sends, queues, schedules, approvals, handoffs, and resumed turns. Read the full plan's acceptance matrix.

| Stage | Primary starting points |
| --- | --- |
| 1. Contracts and migration | `server/projects.ts`, `server/manager.ts`; aggregate API contracts, optional workspace, revisions, migration fixtures |
| 2. Scope resolver | `server/memory-store.ts`, `server/memory.controller.ts`, `server/memory-sources.ts`, `src/memory-context.ts`, manager dispatch |
| 3. Project files | `server/file-store.ts`, `server/files.controller.ts`, `server/workspace-store.ts`, `server/documents.ts`, MCP file tools |
| 4. Project views | `server/main.ts`, `server/public/panel.html`, `control-room.*`, `rc-chat.*`; project tabs and stable anchors |
| 5. Membership and defaults | Settings, capabilities, queues, archive/restore, mode-specific defaults |
| 6. Handoffs and integrations | Delivery records, messaging, MCP schemas, activity, costs, notifications |
| 7. Release | Full suite, typecheck, browser workflows, migration rehearsal, rollback evidence, authorized live verification |

Keep the feature behind `X056_PROJECT_SPACES_ENABLED`. Existing Chats remain standalone during migration. Do not infer membership from names, directories, or references. Prefer feature disable with compatible code when rolling back after new writes.

Use isolated state for write tests. Existing checks include `test/browser/rc-chat.cjs`, `test/browser/rc-chat-navigation.cjs`, and `test/documents/test_documents.py`. Run `npm test` and `npm run typecheck` for the completed behavioral build. Add meaningful coverage for all 18 acceptance gates.

Do not create real production test conversations or messages without task authorization. Production browser probes should remain read-only. Preserve drafts and uploads through navigation, refresh, sign-in, Back/Forward, and mobile layouts.

## Runtime and release notes

Production uses `X056_CHAT_ENABLED=1` and `X056_PANEL_PATH=/app/server/public/panel.html`. Keep the panel served from the built image. Earlier workspace-served edits broke panel startup before matching backend routes were deployed.

Local Docker controls an isolated dind daemon. Gateway deployment uses the host actuator: commit, pin `.deploy/revision`, then request through `.deploy/requested`. Inspect `.deploy/status.json` and `.deploy/last.log`. Use `ssh valbox` for necessary host inspection.

Efran authorized the completed releases and explicitly allowed terminating conversations holding their deployment, including the verifier. That resolved the earlier idle-only holds. Those old plan restrictions are stale. This handoff requests no new swap; follow Efran's applicable deployment instructions for the future release.

A verifier must not hold its own authorized swap indefinitely. When needed, use a durable gateway one-off schedule that survives container replacement. Verify its registration. After swapping, verify revision, health, authenticated feature APIs, assets, built-image panel path, and browser startup.

Playwright is available at `/usr/local/lib/node_modules/playwright`. Read the token from `process.env.X056_TOKEN`; set browser storage key `x056_token` without printing it. Keep secrets out of scripts, logs, and published evidence.

No build agents or deployment verification jobs remain open for this task. Current instructions require explicit authorization before spawning subagents. Maintain one owner for schema and context contracts.

## Document references

The full plan was reviewed twice against registry, memory, file epochs, manager routing, queues, and original requirements. Its source baseline was `22efa11`; later commits only changed sidebar presentation and added the plan.

Verified plan source SHA256:

```text
77011b1053563c32018e6be17d54c28bcb7b1da871009cf6e34140ed0530e923
```

Think serves rendered Markdown at the public URL and original bytes at the same URL plus `/raw`. Publish future plans and evidence there as native Markdown. Read `https://x056.think.val.id/help` for current upload instructions.

The older `docs/plans/2026-09-11-rc-chat-handoff.md` describes the already completed Chat build. Use it only as background. Start the new build from this handoff and the Project / Chat / Work / Memory plan.
