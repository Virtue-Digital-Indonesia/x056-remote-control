# Project spaces recovery

Keep compatible code when disabling Project spaces after new writes. The file catalog uses schema 4; memory uses schema 3. Older binaries may reject these schemas. Restoring an old database over current state would discard later files, memory, and queued work.

The feature starts disabled. `X056_PROJECT_SPACES_ENABLED=1` enables the hierarchy. Keep `X056_CHAT_ENABLED=1` for Chat. Production must serve `/app/server/public/panel.html` from its built image.

## Before enabling

Run the read-only report against the intended state directory:

```sh
node --import tsx scripts/project-spaces-recovery.ts report /path/to/state
```

The report lists registry counts, invalid parents, missing workspaces, broken references, and file, memory, queue, and artifact issues. It also checks source versions, passage locators, grants, references, extraction jobs, and owner aliases. A Project without Work setup is valid. An existing Work conversation still needs its original workspace.

Resolve reported repairs without discarding retained records. Membership is never inferred from names or directories. Startup adds compatible schema fields without changing execution IDs. Existing production Work and Chat start unassigned. First-build Space records require explicit migration review.

## Consistent backup

Stop all writers to the state being copied, including gateway turns, background provider processes, uploads, and automation dispatch. Use the host actuator and the operator’s authorization for a production maintenance window. Local Docker controls the development daemon.

After writers stop, choose a new backup directory outside the state directory:

```sh
node --import tsx scripts/project-spaces-recovery.ts backup /path/to/state /path/to/new-backup --offline
```

The backup uses SQLite’s backup API, including committed WAL pages. It checks database integrity and hashes the copied files. A second source inventory rejects a copy if state changed during the operation.

The manifest covers these records:

| Area | Saved data |
| --- | --- |
| Registry | Original executions, separate Spaces, memberships, aliases, migration receipts, defaults, and feature transition receipts |
| Files | File catalog, versions, retained artifact blobs, managed Chat files, and Project file directories |
| Memory | Notes, sources, versions, passages, extraction jobs/cache, grants, turn references, settings, and context audits |
| Pending work | Queues, autopilots, scheduled jobs, questions, and delivery receipts |
| Routing | Account metadata, conversation selections, routing history, tool requirements, and handoff journals |

Provider credential directories, external Work repositories, and provider transcript stores are outside this snapshot. Preserve them through the existing host backup process. Symlinks are copied as links. The command does not make a public export or print record contents.

For an authorized idle release, pin `.deploy/revision` and create `.deploy/idle-only`, `.deploy/backup-project-spaces`, and `.deploy/requested`. Remove any old `.deploy/force` marker. The host actuator builds first and waits for turns, background providers, and workflows to finish. It then stops the idle gateway and takes the offline snapshot before swapping. A failed snapshot restarts the previous container and leaves the request pending. `.deploy/last-backup` records the successful snapshot directory. Keep the environment backup separately so it retains the settings from before feature activation.

## Rollback after new writes

Prefer disabling `X056_PROJECT_SPACES_ENABLED` with the current compatible build. Shared records remain stored. Standalone Chat and existing Work identities remain available. Inherited memory, document retrieval, and Space write access stop until the feature is enabled again. Retained queues, autopilots, approvals, and schedules require context review. The Planner keeps queue review available while disabled. Remove unavailable attachments or references before resuming.

If a full state restore is required, first stop writers and snapshot the latest state. Keep that snapshot and the current directory. Restore into a new location:

```sh
node --import tsx scripts/project-spaces-recovery.ts restore /path/to/snapshot /path/to/new-restore
```

Restore verifies the manifest before copying. It refuses an existing destination. Registry working directories retain their original absolute paths. Inspect the restored records, then arrange the maintenance cutover back to those paths. Do not run a second gateway against the same accounts and directories while validating the restore.

Startup fences old file checkouts by execution attempt. Invalid retained ownership or memory relationships block dispatch until repair. Re-run the migration report after repairing records. Re-enabling the feature requires review again; it never resumes retained work automatically. It reconciles pending membership and archive operations before resuming automation. Moved queues require context review. Restoring an archived Project does not resume its queues or scheduled jobs.

## Reviewed first-build migration

Use the migration report to distinguish original Work identities from first-build Space records. Review each ambiguous note and source owner. A file source must retain the same owner as its original file. Do not infer ownership from names or timestamps.

Migration retains file/version IDs and bytes. Catalog ownership moves only for reviewed file IDs. Per-file aliases preserve old download URLs. Original Work keeps its repository and a separate file bank. New Project routes use the canonical Space ID.

Migration receipts remain pending until file ownership, memory ownership, queues, leases, approvals, and schedules reconcile. Retries reuse the recorded operation. Do not edit its intent after partial application.

## Interrupted handoffs

A handoff journal joins idempotent target creation, exact-version file copies, and the existing delivery ledger. Retrying the same request reuses the target. A durable queued item reconciles an interrupted receipt.

If delivery is uncertain and no queued item proves its state, the gateway does not resend. Inspect Message delivery and the target conversation before choosing the next action. Keep the original request ID and stored brief during that review.

## Rehearsal evidence

`test/project-spaces-recovery.test.ts` covers WAL backup, later writes, restoration at the original state path, feature disable, broken-reference reports, and damaged snapshot refusal. It preserves original bytes, later document versions, source citations, typed grants, reviewed notes, and queued text. A separate newer snapshot preserves writes made after the selected backup.

`test/project-handoffs.test.ts` covers interruption before enqueue, interruption after queue persistence, ambiguous dispatch, and replay with exact memory and file versions. These use isolated state. They do not verify a production swap.

The revised implementation also uses `test/project-space-migration.test.ts` for both migration paths and legacy file aliases. `test/project-integration-dispatch.test.ts` covers exact-session pauses, compatible disable, Work archive, and restart. Browser checks use fresh temporary state for each workflow:

```sh
node scripts/check-project-integration-browsers.cjs
```

Live-provider and production deployment checks remain separate. This runbook grants no production maintenance authorization.
