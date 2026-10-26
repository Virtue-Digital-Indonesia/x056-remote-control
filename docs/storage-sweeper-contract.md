# Storage sweeper: build contract (2026-10-27)

Efran, via Bot (2026-10-26): add a storage sweeper for unused data.
- AUTOMATIC deletion only for regenerable data: build and package caches, build outputs, and `node_modules` in finished worktrees.
- NEVER delete chat transcripts, uncommitted source, worktrees whose Git metadata is missing, the UAT detached checkout, uploads, artifacts, rollback images, or running/pinned containers.
- Everything else goes into a dry-run manifest that Efran approves before anything is deleted.
- Log every run and what it reclaimed.

## Facts this design rests on (measured 2026-10-26/27)

- **Disk:** 89% used (833G of 982G). A host session already removed ~42 GB of dependencies and retired 118 broken worktrees, with a recovery snapshot.
  - Its records live in valbox `/home/efran/backups/cleanup-plan-20261026/`.
  - A host cron `disk-guard` already runs `docker builder prune -af`, `image prune -af` and an anonymous `volume prune` on dind every day.
  - So keep dind AUTO minimal.
- **`/app/state/chats/<id>/work`:** ~110 GiB of workspaces (source checkouts, git worktrees, release/evidence trees). Transcripts are NOT there.
- **Live Claude transcripts:** `/home/efran/.claude-x056-a/projects`, the dir CLAUDE.md wrongly calls an orphan. Every account's `projects/` links there. **Protect by realpath, never by name.**
- **Missing-gitdir worktrees:** 169 still present (AHU 82, UAT 57, f422edbe 13, others). Detect at run time: `.git` is a file whose `gitdir:` target does not exist.
  - The likely cause is a `git worktree prune`/`gc` run from the host, where `/app/state/...` does not resolve.
  - **The sweeper never runs `git worktree prune` or `git gc`.** It runs all git commands from the container.
- **UAT detached checkout:** `/app/state/chats/c06d266a-…/work/uat/qol-chatbot/worktree`. Detached HEAD `0cbad69bf1cd`, which no ref contains, with 471 changed lines.
- **Workspace** `/home/efran/remote-development`: 193 worktrees (gitdirs intact), 269 `node_modules` at depth ≤2.
- **Container-local data:** `/tmp` 18G (`go-build*`, `gocache-*`, plus unknown dirs), `~/.cache` 2.5G, `~/go` 2.3G, `~/.local/share/pnpm` 1.1G, `~/.npm` 726M. All of it resets on a deploy swap.
- **dind:**
  - 87 images (all referenced)
  - 128 containers (85 up, 25 `pin-*` in Created state)
  - 81 volumes, 5.47GB reclaimable, including unused Go-cache volumes (`docintel-audit-gocache` 2.0GB, `obs-gocache`, `obs-gomod*`, …)
  - build cache 16kB
  - No `rollback-*` tags on dind. Gateway rollbacks are on the HOST daemon, which the sweeper never touches.

## Scope

- **IN:** `/app/state/chats/*/work/**`, the workspace root `X056_WORKSPACE_ROOT`, container caches (`$HOME/.cache/{go-build,pip}`, `$HOME/.npm/_cacache`, `/tmp/go-build*`, `/tmp/gocache-*`), pnpm stores (via `pnpm store prune` only), and dind via the `docker` CLI.
- **OUT** (never read for deletion):
  - everything else under `/app/state`: accounts, codex-sessions, conversation-journal, events, uploads, artifacts, project-files, chat files, frontend-releases, secrets, every sqlite file
  - the realpath of every account's `projects/`
  - the gateway's own checkout and `.deploy/`
  - the dev instance
  - host Docker
  - `/home/efran/backups`

## Classes

### PROTECTED

Never deleted and never offered for approval. Reported in a `protected` section with sizes, so Efran sees them.

- transcripts (realpaths above), uploads, artifacts, and everything OUT
- a worktree whose Git metadata is missing: its source. Its `node_modules`/caches may only be MANIFEST.
- the UAT checkout: the whole tree, configurable as `protectedPaths` (default contains it)
- any checkout whose HEAD is detached and contained in no ref (branch, tag, remote): the whole tree
- uncommitted source: no dirty or untracked file is ever deleted; a whole-worktree removal requires a clean status
- images tagged `*rollback*`, or any image referenced by a container
- running containers, `pin-*` containers, containers with a restart policy, and containers with mounts holding data (fixtures/DBs)
- any path a live process uses: a container `/proc/*/cwd`, open fds, or a `GOCACHE`/`npm_config_cache` env pointing inside; also any running dind container's bind-mount source
- any path inside a chat whose conversation is running, has background work or queue items, is a cron target, or has a live workflow (asked through an injected callback from the manager)

### AUTO

Regenerable. Runs without approval. Each item is RE-CHECKED immediately before deletion.

- **A1. `node_modules` in a finished worktree.** Search depth ≤4 below the worktree root, including `web/node_modules` and the like; never follow symlinks. A finished worktree means all of these hold:
  - `.git` is a FILE whose gitdir exists (a linked worktree)
  - `git status --porcelain --untracked-files=normal` is empty
  - HEAD is contained in some branch, tag or remote ref
  - a lockfile is present (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock` / `bun.lock*`)
  - idle ≥ 7 days: the gitdir's `index`, `HEAD` and `logs/HEAD`, and every file outside `node_modules`, `.next`, `dist`, `build`, `target`, `.turbo` and `coverage`, are older than 7 days (a bounded `find -newer`, stop at the first hit)
  - nothing PROTECTED applies
- **A2. Pure caches in a finished worktree** (same test as A1): `.next/cache`, `node_modules/.vite`, `node_modules/.vite-temp`, `node_modules/.cache`, `.turbo`, `.parcel-cache`, `.pytest_cache`.
- **A3. Container caches:**
  - `go clean -cache` when no `go` process runs
  - `rm` of `~/.cache/pip`
  - `npm cache clean --force` when no `npm` process runs
  - `/tmp/go-build*` and `/tmp/gocache-*` older than 3 days with no live process referencing them
  - `pnpm store prune` on `/app/state/.pnpm-store` and `~/.local/share/pnpm/store` when no `pnpm` process runs
- **A4. dind:** build cache older than 7 days (`docker builder prune -f --filter until=168h`), and unused volumes (`docker volume ls -f dangling=true`) whose name matches `gocache|gomod|go-cache|go-mod|npm-cache|pnpm-store|pip-cache`. Nothing else in dind is AUTO.

### MANIFEST

A dry run lists these; nothing is removed until Efran approves the items.

- **M1.** `node_modules`/caches in a checkout that is idle ≥ 7 days but not "finished": dirty, missing metadata, no lockfile, or HEAD reachable only from a local branch. Each item carries the reason.
- **M2.** Git-ignored build outputs (`git check-ignore`; never tracked content): `dist`, `build`, `.next` minus its cache, `target`, `out`, `coverage`, in checkouts idle ≥ 14 days.
- **M3.** Whole linked worktrees that are finished (A1) and idle ≥ 30 days, removed with `git worktree remove` run in the container. A locked one is listed with `locked: true` and is unlocked only at execution. A clean worktree whose HEAD is on local refs only is listed as `needsBundle: true` and is NOT executable until a bundle exists. Bundling is out of scope for v1, so these are informational.
- **M4.** dind:
  - exited or created containers with no mounts and not `pin-*`
  - dangling images older than 72h
  - unused anonymous volumes
  - unused named volumes, flagged `mayHoldData: true`
- **M5.** Unknown large `/tmp` dirs in the container: over 500 MB, older than 7 days, no live process.

## Approval: a human gate, not a convention

The manifest is persisted at `<stateDir>/storage-sweeper/manifests/<id>.json`: `{ id, createdAt, digest, items: [{ id, rule, target, bytes, reason, evidence }], protected: [...] }`. An approval names `manifestId`, the exact `digest` and the `itemIds`. Before deleting, each approved item is re-checked; an item whose conditions changed is skipped with a reason. A manifest expires after 7 days.

The approve route must be one an AI session cannot call. Every session has `$X056_TOKEN`, so a bearer-only route is NOT a gate. Find what the panel has that sessions do not:
- a login cookie or session
- WebAuthn/passkey
- the push endpoint of a registered device

Require that. If nothing like it exists, build the smallest real gate. For example: the panel asks for approval, and the gateway sends a one-time 6-digit code by web push to the owner's registered devices; approval needs that code, and sessions cannot read pushes. Document the choice. Also:
- no MCP tool approves
- the routes refuse calls carrying the MCP bridge's session identity
- the agents' system note never mentions the route

## Running

- `server/storage-sweeper.ts`, class `StorageSweeper`, started in `server/app.module.ts` in the same way as `McpOAuth`: `start()` / `stop()`, `unref`, stopped in `onModuleDestroy`.
- Scheduled once a day at 04:00 Asia/Jakarta (`X056_SWEEP_AT=HH:MM`). It runs AUTO and then writes a fresh manifest. `X056_SWEEP=off` disables the schedule.
- Manual: `POST /api/storage/sweep {dryRun?: boolean}` (default `dryRun: true`, which lists AUTO items too without deleting).
- Routes: `GET /api/storage` (status, last 20 runs, the current manifest summary), `GET /api/storage/manifest`, plus the approve route (gated as above).
- One run at a time (a lock file). A `STOP` file in the sweeper dir aborts between items. Each run has a time budget. Use `nice`/`ionice` for `du`/`find`, and a bounded walk; never stat the whole tree twice.
- Deletion: `lstat` (never follow symlinks). The `realpath` must be inside an IN root and outside every PROTECTED realpath; this is checked on every item, at plan time and again at delete time. Use `fs.rm` with `recursive: true` on the real directory only.

## Logging

- `<stateDir>/storage-sweeper/runs.jsonl`: one line per run, `{ runId, trigger: 'scheduled'|'manual'|'approval', mode: 'auto'|'dry-run'|'approved', startedAt, endedAt, items: n, deleted: n, skipped: n, estimatedBytes, reclaimedBytes, df: { before, after } }`.
  - `estimatedBytes` comes from `du`, which overstates because of hardlinks.
  - `reclaimedBytes` is the `df` delta of the filesystems touched.
- `<stateDir>/storage-sweeper/runs/<runId>.json`: per-item receipts `{ rule, target, bytes, action, result, reason?, error? }`.
- `events.jsonl`: `storage_sweep {runId, mode, reclaimedBytes}`.
- A new manifest with ≥ 1 GiB approvable emits `storage_manifest` with a QUIET notice (bell + dot, no push).

## Panel

Settings > Storage (`/settings/storage`), following the existing settings sections:
- last runs: date, mode, reclaimed
- the current manifest grouped by rule, with sizes, reasons, checkboxes and select-all per group
- "Approve selected" (confirm dialog showing the total), then the human gate above
- the protected list, collapsed

Keep it plain, and reuse existing classes.

## Tests

Use temp dirs, real `git` and a mocked `docker`:
- A1: a finished worktree's `node_modules` is removed. A dirty one and one with a fresh file stay out of AUTO (they go to M1).
- Missing gitdir: the source is protected and `node_modules` goes to M1.
- A detached-unreachable HEAD is protected whole; so is a `protectedPaths` entry.
- A symlinked `node_modules` is not followed, and the target outside is untouched.
- A transcript realpath under a root is never touched, even when reached via a symlink.
- Approval: only approved items are deleted, after a re-check; a changed item is skipped; a wrong digest is refused; the session-identity call is refused; the gate's code is required.
- Every run writes `runs.jsonl` and the receipts.
- A process cwd inside a candidate skips it (inject the process lister).

## As built (2026-10-26)

**The gate is a WebAuthn passkey assertion, pinned by key.** A session holds `$X056_TOKEN`, can read `state/webauthn/` (so the login cookie is no gate), and can list, remove and register passkeys with the token alone. What it cannot do is sign with the owner's private key. So:

- `POST /api/storage/approve/options` returns a challenge (user verification required, single use, 5 min) bound to `sha256(manifestId | digest | sorted itemIds)`. `POST /api/storage/approve` needs the signed assertion for exactly that binding. A login challenge cannot approve and a step-up challenge cannot log in.
- Only an **approver** passkey counts. An approver is pinned by credential id AND a fingerprint of its public key (`state/storage-sweeper/approvers.json`). The seed is every passkey registered before 2026-10-26 (the sweeper did not exist then, so no session could have registered one to pass this). Anything else joins only with an assertion from an existing approver (Settings > Storage > Passkeys that can approve).
- Registering a passkey under an id that already exists is refused (it used to replace the key). A session that removes the owner's passkey and re-registers its own key under that id fails the fingerprint.
- No approver = 403 at every step. There is never a token-only fallback.
- Routes also refuse a body carrying the MCP bridge's identity (`from`, `self`, `delegate`). No MCP tool, and no system note, mentions storage.
- Residual: a session with filesystem write could edit `approvers.json` or `credentials.json`. It could equally `rm -rf` anything itself, so this gate keeps the API honest. It is not a sandbox. A session can also *remove* the owner's passkey (denial of service: approvals then fail closed).

**Other choices:**
- `{workspaceRoot}/poc-ahu-ai` is in the default `protectedPaths`. The dev instance works in that tree, and its processes, turns and containers are invisible from this container, so none of the live-use checks could protect them.
- A checkout nested inside a missing-gitdir or detached-unreachable tree is protected too (checked by walking up from each target at plan and delete time).
- M2 and M3 are refused when another repository sits inside (an ignored clone would go with `rm` or `git worktree remove`).
- Execution acts on the re-plan, never on the stored manifest: docker commands are rebuilt from the target, path actions come from the fresh plan.
- Without a readable `accounts.json` nothing runs.
- `storage_sweep` and `storage_manifest` are appended to `events.jsonl` and broadcast. The manifest notice is quiet (category `finished`, so "Automation and background" does not push it).
- A worktree with a fresh file is left out entirely, not listed as M1: M1 requires idle >= 7 days, so the A1 test bullet "fresh -> M1" is read as "fresh -> not AUTO".
