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
| 4. Memory scope and sharing | Complete; scope, grant, reference, handoff, MCP, and browser checks passed |
| 5. File sources | Complete; document extraction, citations, access, restart, and browser checks passed |
| 6. Release preparation | Complete; full tests, document checks, browser checks, and recovery rehearsal passed |

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

## Stage 4 evidence

Memory now distinguishes Space ownership from original Work, Chat, and conversation scopes. Association inherits Space notes without promoting repository notes or sibling transcripts. The operator's Space source view filters exact member conversations. Agent reads require their own eligibility check.

Typed grants support reviewed sharing and revocation. A note grant exposes its approved text without granting the whole source document. Reads retain version and grant metadata. Derived proposals retain source grant dependencies. Imported grants remain inactive until review.

Selected references bind exact revisions and deliberate retrieval exceptions to the next message's request ID. Draft refresh, queueing, and account retries retain that ID. Dispatch and failover validate the snapshot against current membership, references, exclusions, and grants. A revoked handoff dependency keeps its queued text for review.

The Memory UI now supports Space owners, sharing recipients, revoke actions, source sharing, and searching other Projects for message references. Existing settings and exclusions still apply. A selected reference cannot override an unconfirmed note or excluded source.

Validation covered 84 tests across seven focused files, including both providers, MCP output contracts, handoffs, and exact-session dispatch. Typecheck and script syntax checks passed. The isolated browser workflow passed sharing, revocation, deliberate turn exceptions, mobile layout, draft refresh, and message binding. No JavaScript errors occurred.

Document passage indexing and source uploads follow in Stage 5. No production panel, state, or deployment changed.

## Stage 5 evidence

Saved DOCX, PDF, Markdown, and text files now become versioned memory sources. Durable extraction jobs retain limits, progress, attempts, errors, and cancellation state. Cache keys include original bytes, format, extractor code, and options. Separate owners retain separate source identities and grants.

The worker indexes full passages with headings, paragraphs, table cells, lines, and PDF pages. Original bytes remain in the file catalog. Empty extraction fails visibly; scanned PDFs report Needs OCR. Unsupported formats remain downloadable. Updates retain the active version until extraction completes. Restart and cancellation fence stale workers.

Notes and passages share the existing token and item limits. Search applies access checks before ranking and pagination. Context previews, history, and tool reads expose exact citations. Tool read audits retain passage locators. Previous citations resolve their original saved version after updates.

Memory Sources now supports upload, saved-file selection, progress, cancellation, retry, update, sharing, and removal. Files offers Add to memory and identifies retained source dependencies. Upload alone creates no confirmed facts. Derived notes require review after source changes.

Validation included 55 tests across document, sharing, MCP, and migration fixtures in the final focused run. Earlier focused runs also covered existing file editing and memory contracts. Six Python document checks passed. Typecheck and script syntax checks passed. The browser workflow exercised actual DOCX uploads, cited previews, original downloads, sharing, version updates, saved-file selection, and mobile layout without JavaScript errors.

Stage 6 will validate recovery after these new writes, compatible feature disable, aggregation, and the full regression suite. No production state or deployment changed.

## Stage 6 evidence

Reviewed file mappings now move catalog ownership without changing file IDs, versions, or original bytes. Per-file aliases preserve old download links. Original Work keeps its own file bank. Migration fingerprints include grants, references, source jobs, passages, leases, and operation receipts. A document source and its original file require matching ownership.

Feature transitions retain durable receipts. Disabling Project spaces pauses inherited-context queues, autopilots, schedules, and approvals. Queue review remains available while disabled and uses the queued message's own reference set. Re-enabling requires review again. Work links remain usable while the hierarchy is disabled.

Archiving original Work pauses its own conversations across every Project association. Member Chats and secondary references remain independent. Restoring Work leaves retained queues paused. Removal refuses identities still used by saved files, memory, or citations.

Cost groups use exact primary conversations. The UI labels their lifetime usage under current membership. Reference links contribute no duplicate totals. New dispatch records retain execution and Space attribution. Synchronous reads share one registry snapshot within each query; no cached scope survives an asynchronous boundary.

The recovery report checks typed owners, file aliases, source versions, locators, jobs, grants, references, and handoff dependencies. Startup blocks dispatch when retained relationships need repair. The backup rehearsal preserved later writes through SQLite WAL snapshots. It retained a separate newer snapshot and rejected stale leases after restore.

Final validation passed 920 tests across 84 files, plus typecheck and all 10 Python document checks. Eleven browser workflows cover the original and revised interfaces. Each workflow uses fresh temporary state and records JavaScript errors. The browser checks found no JavaScript errors. Extra focused checks cover sessionless approval review after Work archive.

The complete build remains on `feature/project-integration`. No production state, deployment actuator, or live-served panel was changed. Live-provider and production swap verification remain separate from this build.

## Acceptance record

These fixtures passed with the revised implementation. Browser fixtures use simulated providers and isolated state.

| Gate | Evidence |
| --- | --- |
| 1. Legacy Work resumes | Manager, routing, provider session, and exact-session dispatch tests |
| 2. Whole Work association | Registry and dispatch tests; integration browser |
| 3. Individual Work association | Dispatch tests preserve sibling queues, tools, schedules, and leases |
| 4. Chat association | Integration and Chat browsers retain files, drafts, uploads, history, and links |
| 5. Inherit versus Standalone | Registry, dispatch, and integration browser checks |
| 6. Secondary references | Registry and cost tests; grouped reference browser checks |
| 7. Bulk race | Queue edits, new conversations, and changed schedules invalidate preview |
| 8. Interrupted membership | Dispatch restart and migration receipt tests |
| 9. Queues and automations | Exact targets, approvals, schedules, feature disable, and reviewed restart tests |
| 10. Multiple repositories | Handoff and integration browser checks select an actual Work directory |
| 11. Defaults and tools | Capability and dispatch tests cover actual account/cwd and requirement changes |
| 12. Local memory isolation | Project memory, sharing, and provider integration tests |
| 13. Shared retrieval | Sharing tests and browser; MCP source output contracts |
| 14. Deliberate turn exception | Sharing browser and tests bind references to a message request |
| 15. Revocation | Snapshot, queued handoff, reference removal, and read-access tests |
| 16. Preview and failover | Both providers, one context budget, exact revisions, and simulated account limits |
| 17. Document upload | Real DOCX/PDF/Markdown/text extraction; browser upload and byte checks |
| 18. Document coverage | Tables, headings, boundaries, large sources, scans, limits, and empty extraction |
| 19. Source restart/update | Durable worker, cancellation, retry, deduplication, and stale-publication tests |
| 20. File ownership | Shared-file tests and browser deny writes through read grants |
| 21. Concurrent shared files | Exact execution leases, membership changes, stale attempts, and conflicts |
| 22. Derived memory | Upload creates no confirmed facts; source updates retain old citations and require review |
| 23. Handoffs and messaging | Exact targets, retained versions, idempotent delivery, approvals, and hop-limit tests |
| 24. Navigation/mobile | Eleven browser workflows include refresh, sign-in, notifications, drafts, and mobile |
| 25. Archive and totals | Work/Space archive tests, exact cost groups, and release surface browser |
| 26. Migrations and rollback | Production/first-build fixtures, aliases, WAL backup, later writes, and compatible disable |

## Reproducing the checks

```sh
npm test
npm run typecheck
X056_DOCUMENT_TEST_OUTPUT=/tmp/project-document-checks /opt/rc-documents/bin/python -m unittest discover -s test/documents -p 'test_*.py'
node scripts/check-project-integration-browsers.cjs
```

The browser runner starts and stops only its own fixture processes. It never connects to production. The [review document](2026-09-11-project-integration-review.md) includes screenshots and release limits.
