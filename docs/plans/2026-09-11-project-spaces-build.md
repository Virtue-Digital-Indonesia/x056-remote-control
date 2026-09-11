# Project spaces implementation record

Project / Chat / Work / Files / Memory is implemented on `feature/project-spaces`. Work started on 11 September 2026 from `9d8eb82`.

The hierarchy remains disabled by default through `X056_PROJECT_SPACES_ENABLED`. Production remains on its built image at `efdd213`. This build has no deployment request. Live provider acceptance and production verification remain release requirements.

The [implementation plan](https://x056.think.val.id/rc-project-chat-work-memory-plan-20260911.md) remains the scope reference. The [recovery runbook](https://x056.think.val.id/project-spaces-recovery-20260911.md) covers enablement, backups, feature disable, and restoration.

## Implementation stages

| Stage | Delivered |
| --- | --- |
| Contracts and migration | Optional Work workspace, validated execution targets, aggregate API, atomic registry writes, revisions, membership receipts, and additive migration reporting |
| Memory scope | Parent inheritance, local isolation, shared eligibility for dispatch and MCP, reviewed brief, and dispatch records with exact revisions |
| Project files | Shared ownership, independent version history, retained Work output import, per-execution write leases, and compatible Chat endpoints |
| Project views | Project tabs, real Project and Work routes, Chat parent filter, file versions, attachment drafts, and desktop/mobile layouts |
| Membership and defaults | Restart reconciliation, retained queues requiring review, paused automations, separate mode defaults, and inherited tool requirements |
| Handoffs and integrations | Durable handoff journal, retry receipts, exact selected versions, parent activity/cost grouping, notification links, and MCP contracts |
| Release preparation | Isolated browser/document checks, migration and rollback rehearsal, recovery commands, and acceptance evidence; live release remains pending |

## Verification

The final runtime commit, `3b31c1c`, passed **866 tests in 79 files** through `npm test` in 162.19 seconds. `npm run typecheck` passed. Four document checks passed using `/opt/rc-documents/bin/python`. The full run includes the populated legacy file catalog recovery test.

Four browser suites passed against a fresh isolated fixture loaded from `1eada0a`:

- `test/browser/project-spaces.cjs`: Project creation, uploads, previews, drafts, workspace setup, direct links, mobile, and direct sign-in.
- `test/browser/project-spaces-workflow.cjs`: reviewed brief, inherited Tools, Chat-to-Work-to-Chat handoffs, costs, queue review, and notification routing.
- `test/browser/rc-chat.cjs`: existing Chat uploads, delivery, reload, versions, downloads, Tools, references, and mobile.
- `test/browser/rc-chat-navigation.cjs`: Chat links, refresh, Back/Forward, drafts, dialogs, and grouped references.

All four collected browser JavaScript errors and reported none. Screenshots are in `project-spaces-evidence/`. The final recovery adjustment changes only the offline backup helper and its test.

The document workflow creates a DOCX, edits it through Chat and Work checkouts, saves both versions, and renders a persistent preview. Original private and Project bytes remain unchanged. Separate document tests exercise the installed conversion and editing toolkit. Provider tests use fake transports, isolated accounts, or simulated failover events; they do not induce a real account limit.

## Acceptance audit

These rows re-check all 18 gates from the plan. “Passed locally” describes the fixtures and checks named here, not production verification.

| Gate | Evidence and status |
| --- | --- |
| 1. Legacy Work | Passed locally: `project-spaces`, existing manager/history tests preserve IDs, directories, selections, and resume behavior. No live provider resume rehearsal. |
| 2. Standalone Chat | Passed locally: both existing Chat browsers; membership tests preserve identity, files, drafts, and standalone access. |
| 3. Project without workspace | Passed locally: API/runtime guards and Project browser permit Chat/Files while blocking Work until setup. |
| 4. Cross-mode memory | Passed locally: `project-memory` checks the same reviewed parent decision in Chat and Work. Browser checks brief review and context inspection. |
| 5. Memory isolation | Passed locally: proposed, expired, excluded, restricted, and superseded entries remain ineligible. Chat-local entries stay local. |
| 6. Inheritance versus sharing | Passed locally: parent context works with cross-project retrieval off; unrelated sharing remains blocked. |
| 7. Move contamination | Passed locally: idle guards, historical-context disclosure, linked fresh Chat, and retained queues requiring review. |
| 8. Context audit | Passed locally: exact entry/source revisions, membership, budget, inclusion reasons, and exclusions use one resolver. |
| 9. Account limit | Simulated checks passed: dispatch snapshots and required tools survive account changes. A real provider limit event remains pending. |
| 10. Concurrent edits | Passed locally: competing versions conflict; a failed execution cannot invalidate a sibling's valid checkout. |
| 11. Recovery | Passed locally: upload retry, preview persistence, stale checkouts, restart, removal, and version restoration retain original bytes. |
| 12. Tools unavailable | Passed locally: actual execution directory/account determine eligibility. Missing requirements retain the queue item for deliberate retry. |
| 13. Handoff retry | Passed locally: crash points reuse one target and one first message. Selected memory and file versions remain exact. |
| 14. Messaging | Passed locally: existing MCP/HTTP delivery, approval, attribution, correlated replies, cancellation, and hop-limit tests remain green. |
| 15. Navigation | Passed locally: direct Chat/Work URLs, refresh, sign-in return, history, notification targets, and anchor destinations. |
| 16. UI consistency | Passed locally: shared sidebar styles/icons, project tabs, dialogs, focus behavior, and mobile overflow checks. |
| 17. Aggregation | Passed locally: cost grouping retains identities without counting a conversation twice. Activity includes paused/background work; archive/restore preserves records. |
| 18. Migration rollback | Passed locally: WAL backups, schema-1 upgrade, retained later-write snapshot, restoration, and compatible feature disable. No old binary was executed. |

## Implementation decisions

Existing Projects retain their IDs and Work conversations. Internal Chat records remain execution targets. Membership does not change directories, provider sessions, file URLs, or draft keys. Ordinary Projects may omit a workspace; every Work launch requires a validated directory.

Memory scope resolves on the server. Parent inheritance works with cross-project retrieval disabled. Existing Chat-local memory remains private after a move. Sharing it requires a separate reviewed operation. Dispatch records the chosen revisions once; same-provider failover uses that prepared prompt.

Project file copies receive independent file/version identities while retaining provenance and immutable blobs. Shared checkouts record execution, conversation, attempt, owner, membership, and base version. Commit validates these fields before and after asynchronous file preparation. Retained Work outputs enter through artifact IDs, not arbitrary repository paths.

Membership and archive changes persist an operation receipt with the registry mutation. Startup reconciles queues, automations, and leases before dispatch. Restoring a Project restores visibility; paused work needs deliberate resumption. Required-tool discovery happens before queue removal, so failed eligibility checks retain the message.

Handoffs persist selected context and reuse creation, file-copy, and delivery receipts. An uncertain dispatch without durable queue evidence never resends automatically. JSON stores use atomic replacement and fsync. A damaged delivery journal refuses sends instead of overwriting receipts.

Recovery uses SQLite backup with committed WAL pages, file hashes, and source-change detection. Opening a closed database can create an empty WAL; only known database WAL files without frames are ignored. Small retained files with similar names remain included. Restore verifies the snapshot before creating a new destination and rejects paths through snapshot symlinks.

## Release boundary

No production conversations, messages, state migration, or provider limit tests were created for acceptance. Production assets remain baked into the image. Unrelated design directories remain untouched.

Before enablement, run the repair report against the intended state and take an offline backup under a release maintenance window. Preserve external provider state and Work repositories through existing host backups. Keep compatible code when disabling the feature after new writes; an older file-store binary cannot read schema 2.

The production swap must use the host actuator under applicable release authorization. Then verify the pinned revision, authenticated feature APIs, health, built-image assets, and browser startup. Live provider/document acceptance completes the remaining release gates.
