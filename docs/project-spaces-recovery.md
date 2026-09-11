# Project spaces recovery

Keep compatible code when disabling Project spaces after new writes. An older file-store binary cannot read schema 2. Restoring an old database over current state would discard later files, memory, and queued work.

The feature starts disabled. `X056_PROJECT_SPACES_ENABLED=1` enables the hierarchy. Keep `X056_CHAT_ENABLED=1` for Chat. Production must serve `/app/server/public/panel.html` from its built image.

## Before enabling

Run the read-only report against the intended state directory:

```sh
node --import tsx scripts/project-spaces-recovery.ts report /path/to/state
```

The report lists registry counts, invalid parents, missing workspaces, broken references, and file, memory, queue, and artifact issues. A Project without Work setup is valid. An existing Work conversation still needs its original workspace.

Resolve reported repairs without discarding retained records. Membership is never inferred from names or directories. Startup adds missing registry revisions and migrates file ownership fields without changing execution IDs.

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
| Registry | Project and conversation identities, memberships, revisions, and defaults |
| Files | File catalog, versions, retained artifact blobs, managed Chat files, and Project file directories |
| Memory | Entries, revisions, sources, relationships, settings, preferences, and dispatch audits |
| Pending work | Queues, autopilots, scheduled jobs, questions, and delivery receipts |
| Routing | Account metadata, conversation selections, routing history, tool requirements, and handoff journals |

Provider credential directories, external Work repositories, and provider transcript stores are outside this snapshot. Preserve them through the existing host backup process. Symlinks are copied as links. The command does not make a public export or print record contents.

## Rollback after new writes

Prefer disabling `X056_PROJECT_SPACES_ENABLED` with the current compatible build. Shared records remain stored. Standalone Chat and existing Work identities remain available. Inherited memory and new shared-file execution access stop until the feature is enabled again.

If a full state restore is required, first stop writers and snapshot the latest state. Keep that snapshot and the current directory. Restore into a new location:

```sh
node --import tsx scripts/project-spaces-recovery.ts restore /path/to/snapshot /path/to/new-restore
```

Restore verifies the manifest before copying. It refuses an existing destination. Registry working directories retain their original absolute paths. Inspect the restored records, then arrange the maintenance cutover back to those paths. Do not run a second gateway against the same accounts and directories while validating the restore.

Startup fences old file checkouts by execution attempt. It reconciles pending membership and archive operations before resuming automation. Moved queues require context review. Restoring an archived Project does not resume its queues or scheduled jobs.

## Interrupted handoffs

A handoff journal joins idempotent target creation, exact-version file copies, and the existing delivery ledger. Retrying the same request reuses the target. A durable queued item reconciles an interrupted receipt.

If delivery is uncertain and no queued item proves its state, the gateway does not resend. Inspect Message delivery and the target conversation before choosing the next action. Keep the original request ID and stored brief during that review.

## Rehearsal evidence

`test/project-spaces-recovery.test.ts` covers WAL backup, later writes, restoration at the original state path, feature disable, broken-reference reports, and damaged snapshot refusal. It preserves original bytes, new approved memory, and queued text.

`test/project-handoffs.test.ts` covers interruption before enqueue, interruption after queue persistence, ambiguous dispatch, and replay with exact memory and file versions. These use isolated state. They do not verify a production swap.
