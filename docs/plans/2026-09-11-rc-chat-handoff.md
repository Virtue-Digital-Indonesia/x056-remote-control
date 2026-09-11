# RC Chat: handoff before compaction

## Resume here

Read `docs/plans/2026-09-11-rc-chat-implementation.md`, then inspect the current working tree before building. Complete its seven milestones in order.

Implementation has started. Read `2026-09-11-rc-chat-build.md` for the current build, verification, and rollout state.
Further changes belong in the isolated `feature/rc-chat` checkout.
Efran withdrew deployment authorization after the panel was restored. No deployment request was sent.

Recommended builder: **Codex · GPT-6 Astra · xhigh effort**. Do not spawn subagents unless the user or applicable instructions authorize them.

## User requirements

- Add free-form Chat alongside the existing project workspace. No project selection required.
- Keep provider, model, effort, and account controls, plus existing conversation features.
- File handling, modification, preview, versioning, and serving are the top priority.
- Plugins, MCP, and skills must be available in Chat from the first release.
- Read, reference, and message project conversations. Preserve the existing messaging policy and correlated replies.

Primary use case: continue a proposal DOCX task across available accounts without losing the conversation or saved files. Bring the original document and relevant Desktop context into RC. Automatic Desktop import is outside v1.

The user approved the UI draft with “looks good.” Match that draft. Keep progress updates and final replies short.

## Saved deliverables

| Item | Location |
| --- | --- |
| Implementation plan | `docs/plans/2026-09-11-rc-chat-implementation.md` |
| Published plan | https://x056.think.val.id/rc-chat-implementation-plan.md |
| Approved interactive draft | https://x056.think.val.id/sites/rc-chat-review/ |
| Draft source | `design/rc-chat-review/` |
| Original feature list | https://x056.think.val.id/rc-chat-features.md |

The implementation plan adds the user's latest file/tool requirements. It takes precedence over the original feature list.

The draft uses sample data. Its account switches, messages, and project interactions are simulated. DOCX downloads contain sample content. Desktop/mobile interactions and published links were checked successfully.

## Planned architecture

Use `Project.kind: project | chat`, defaulting legacy records to `project`. Each Chat gets one internal workspace and conversation. Reuse IDs, manager, adapters, routing, transcripts, queues, and MCP.

Allocate IDs before uploads. Persist working files under `state/chats/<chatId>/work`. Permit only manager-created Chat roots. Separate directories do not constitute an OS sandbox.

Use a transactional file/version catalog, immutable retained versions, authenticated streaming downloads, and persistent preview jobs. Messages and queues carry file/version references. Fence stale workers; reconcile interrupted operations before retrying.

Check required plugins, MCP connections, skills, and connector authorization before account failover. Keep credentials separate. Switching providers requires a future context handoff; same-provider account switching already exists.

## Code findings

| Code | Finding |
| --- | --- |
| `server/api.controller.ts` | Base64 uploads become loose files under `state/uploads`; 50 MiB file limit. |
| `server/main.ts` | JSON parser limit is 160 MB. New uploads need a bounded streaming route. |
| `server/workspace-store.ts` | Retains hashed artifact copies; no document lineage or preview conversion workflow. |
| `server/workspace.controller.ts` | Authenticated artifact downloads already exist. |
| `server/manager.ts`, `server/projects.ts` | Sessions currently require a project and its directory. |
| `src/failover.ts`, `server/codex-sessions.ts` | Same-provider failover and shared session storage already exist. |
| `server/plugins.ts`, `server/mcp-servers.ts` | Replicate configuration across provider accounts and report drift. |
| `server/provision.ts` | Provisions skills/integrations and reports authorization gaps. |
| `src/persistent-codex.ts` | Discovers skills using the working directory. |
| `server/public/panel.html` | Busy conversations currently queue text only, leaving attachments behind. |

## Build and verification

Milestones: Chat identity → files/serving → document toolkit/previews → failover integrity → tools/capabilities → approved UI/project interactions → release checks.

Use fixtures for document fidelity and failure recovery. Run targeted tests, then typecheck, unit tests, and relevant browser suites. Verify a real document workflow on each provider before claiming completion.

Repository baseline: `8c0e6ae`. Plan and draft files are currently untracked. Other untracked design directories belong to unrelated work; preserve them. No production files were changed during planning.

Use isolated development infrastructure. Local Docker targets dind, not the host. Gateway deployment uses the host actuator; do not deploy it with local Docker.

## Think publishing notes

Read `https://x056.think.val.id/help` before publishing. Use native Markdown for reading deliverables and `/sites/<slug>/` for interactive drafts.

The trusted `ssh valbox` path worked for uploads and verification. Never print credentials. Native upload rejects an existing filename with HTTP 409. Use a new filename for revised documents.

Site bundles rejected DOCX assets. Upload DOCX separately through `/upload`, then link to its returned URL. No preview servers or SSH proxy sessions remain running.
