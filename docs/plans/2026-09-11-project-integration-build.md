# Project integration implementation record

Efran authorized implementation after the blueprint review. Work starts from `1a78806` on `feature/project-integration`. The latest user instruction supersedes the blueprint's planning-only status.

The published blueprint matches the repository source: `c0ac8124ec80462595d71e12646e2d87ebec615194f9912891561aa6d34accf2`. It numbers implementation stages 1 through 6. Stage 0 is the requested baseline and dependency audit, recorded here.

## Stage 0

Production remains on `efdd213`; no deployment request is pending. Its panel uses the built image. The new build stays behind `X056_PROJECT_SPACES_ENABLED`. Unrelated design directories are preserved.

| Dependency | Required change |
| --- | --- |
| Execution registry | Keep existing IDs, sessions, cwd, account selections, and draft keys. Space ownership moves into its own registry. |
| Context resolver | Resolve individual Work overrides and whole-Work defaults separately from execution identity. Preserve standalone overrides. |
| Dispatch and queues | Membership reconciliation must target exact conversations. Re-check asynchronous capability results before queue removal. |
| Automations | Current pause callbacks accept project IDs. Add exact-session targeting and review of schedules without a fixed session. |
| Files | Preserve catalog identities and immutable blobs. Resolve typed owners and fence changed execution membership without fencing siblings. |
| Memory | Preserve original Work/Chat scopes and legacy sharing recipients. Add explicit Space owners, typed grants, and turn references. |
| Source ingestion | Existing ingestion indexes bounded whole-source text. Add durable extraction, passages, version locators, and unchanged-text provenance updates. |
| Handoffs | Replace implicit parent cwd with an explicit Work execution target. Retain creation, copy, and delivery receipts. |
| UI and totals | Group by effective conversation membership. References cannot change execution or duplicate costs. |
| Migration | Handle production and first-build state separately. Ambiguous old memory ownership needs an explicit migration mapping. |

Baseline checks passed before runtime edits: 866 tests across 79 files in 169.34 seconds, plus typecheck. Stage 1 adds registry/contracts and isolated migration fixtures, then integrates them in stage order.

## Progress

| Stage | State |
| --- | --- |
| 0. Baseline and dependency audit | Complete; 866 baseline tests and typecheck passed |
| 1. Contracts and migration | Complete foundation; 23 focused checks and typecheck passed |
| 2. Membership and dispatch | Complete; focused dispatch, file, recovery, and MCP checks passed |
| 3. Integration UI | Complete; two browser workflows, 24 focused tests, and typecheck passed |
| 4. Memory scope and sharing | Next |
| 5. File sources | Pending |
| 6. Release preparation | Pending |

No new production migration or deployment is authorized by this implementation request. Use isolated state for write tests. Continue until the requested implementation and local acceptance are complete; retain any remaining live-provider checks explicitly.

## Stage 1 evidence

The separate registry implements whole Work associations, individual overrides, explicit Standalone, reference links, per-conversation generations, and durable mutation receipts. Preview hashes include execution topology, so a new conversation invalidates stale review. Archive resolves effective primary members only.

Migration reports distinguish legacy production from first-build state. Reviewed mappings preserve original execution records and file/note/source identities. The registry retains ownership overrides for the later memory and file integration stages. Ambiguous notes require explicit ownership choices. Archived and empty first-build Projects have fixtures.

The recovery inventory now includes the Space registry, migration record, and retained extraction directory. Snapshot restoration preserves mapping receipts and extraction bytes. The new context resolver path separates `spaceId` from the original Work execution; runtime integration follows in Stage 2.

Validation: 23 tests passed across the new registry/migration fixtures and existing recovery/memory tests. Typecheck passed. No production state changed.

## Stage 2 evidence

The manager now resolves membership per conversation. Reviewed operations retain queued text and attachments, pause affected autopilots and schedules, and invalidate only affected file leases. Previews reject changed queues, automations, membership, or execution topology. Unrelated active siblings remain usable.

Whole Work associations include future conversations while retaining overrides. Durable creation intent preserves the requested Space and account after interruption. Retries reuse the original conversation without moving it back after a later membership change. Work always uses its original execution directory.

Pending message approvals now survive restart. A context change requires a matching operator review before approval or schedule resumption. Unfinished membership receipts block affected dispatch until reconciliation completes. Handoff preparation selects and retains an actual Work project.

Validation covered 158 tests across 12 focused files, including the existing manager and MCP bridge tests. Typecheck passed. Recovery checks exposed a missing Space owner check for retained file artifacts; that check now distinguishes owner records from executions. Shared DOCX editing, exact-version downloads, sibling file leases, and handoff retry tests passed.

Memory ownership and source eligibility remain Stage 4 work. UI integration follows in Stage 3. No production state or deployment actuator changed.

## Stage 3 evidence

Projects now display separate Work groups, individual members, and reference links. Add existing searches Chats, Work conversations, or whole repositories. The review shows affected conversations, retained exceptions, queues, approvals, and file access changes. The Work overview offers creation of a Project from its repository.

New Work and handoffs show the target repository. Work overview routes use `/work/:projectId`; conversation routes retain their existing execution IDs. Per-conversation context annotations survive project reloads and conversation updates. Project defaults no longer replace omitted choices with undefined values.

Two isolated browser workflows passed. They cover membership precedence, references, multiple repositories, uploads, file attachment, retained drafts, settings, grouped reference search, inherited Tools, handoffs, Back/Forward, refresh, direct sign-in, and mobile layout. Browser probes collected no JavaScript errors. The fixture uses temporary state and fake providers.

The checks found a missing overview route and a view-close action that changed its URL. Both are fixed. A final focused run passed 24 tests, including requirement changes during asynchronous tool discovery. Typecheck and script syntax checks passed.

The original memory and cost browser checks will be extended after their Stage 4 and Stage 6 integration. No production panel, state, or deployment changed.
