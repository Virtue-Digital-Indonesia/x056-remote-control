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
| 2. Membership and dispatch | Next |
| 3. Integration UI | Pending |
| 4. Memory scope and sharing | Pending |
| 5. File sources | Pending |
| 6. Release preparation | Pending |

No new production migration or deployment is authorized by this implementation request. Use isolated state for write tests. Continue until the requested implementation and local acceptance are complete; retain any remaining live-provider checks explicitly.

## Stage 1 evidence

The separate registry implements whole Work associations, individual overrides, explicit Standalone, reference links, per-conversation generations, and durable mutation receipts. Preview hashes include execution topology, so a new conversation invalidates stale review. Archive resolves effective primary members only.

Migration reports distinguish legacy production from first-build state. Reviewed mappings preserve original execution records and file/note/source identities. The registry retains ownership overrides for the later memory and file integration stages. Ambiguous notes require explicit ownership choices. Archived and empty first-build Projects have fixtures.

The recovery inventory now includes the Space registry, migration record, and retained extraction directory. Snapshot restoration preserves mapping receipts and extraction bytes. The new context resolver path separates `spaceId` from the original Work execution; runtime integration follows in Stage 2.

Validation: 23 tests passed across the new registry/migration fixtures and existing recovery/memory tests. Typecheck passed. No production state changed.
