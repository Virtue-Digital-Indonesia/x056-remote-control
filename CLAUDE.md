# X056 Remote Control

Self-hosted Claude Code "remote control" with automatic failover between two Claude Max accounts: a supervisor drives headless `claude -p --output-format stream-json` sessions and, when the active account hits its usage limit, respawns `claude -p --resume <session-id>` under the other account's `CLAUDE_CONFIG_DIR` (shared `projects/` tree), so one continuous session survives the switch. A NestJS gateway (`server/`) + vanilla panel (`server/public/panel.html`) expose it in the browser, with parallel projects, session adoption, and live activity.

## YOU ARE (PROBABLY) RUNNING INSIDE THE DEPLOYED CONTAINER

Sessions started through the panel run **inside the Docker container** this repo deploys. That changes how you must work:

- **`docker` works, but it drives an ISOLATED daemon — not the host's.** The `docker` CLI + `docker compose` in the container point at a dind (Docker-in-Docker) sidecar via `DOCKER_HOST=tcp://dind:2375`, so a project can build images and run its own compose e2e stacks. That daemon is nested and cannot see or touch the **host's** Docker — from inside the container you cannot build/restart/inspect the x056 gateway or any host container, and there is no host socket. (When you genuinely need the host's Docker, use the `ssh valbox` escape hatch below — deliberately.) Two gotchas for a project's compose: (a) **bind mounts** resolve on the dind daemon, which shares the workspace at the same path `/home/efran/remote-development`, so relative mounts under the workspace work — mounts of paths OUTSIDE it won't; (b) **published ports** land on the `dind` host, so reach a service from your session at hostname `dind:<port>` (or run the test as a compose service and use service names), not `localhost`.
- **Deploying the x056 gateway itself is NOT done with `docker` — it goes through the host actuator below.** The dind sidecar is for *projects'* docker needs only; the gateway's own build/swap is the `.deploy/requested` flow.
- **Host escape hatch: `ssh valbox`** (aliases `legacy`, `103.30.246.154`; dedicated key in `state/ssh/`). This reaches the **actual host machine** that runs this gateway, as user `efran`, who is in the `docker` group — so from there you have the host's **real** Docker (all 90+ host containers, every project's stack). Use it for genuine host infra work (freeze/inspect a sibling service, manage another stack). This is NOT a sandbox: never disturb the `x056-remote-control-x056`/`-dind` containers or other projects' containers.
- **Edge nginx (the host's `/etc/nginx/sites-enabled/`) is self-serve via scoped passwordless sudo** — no need to hand this to the user:
  - `sudo nginx -t` — test the current config
  - `sudo systemctl reload nginx` — reload after a change
  - `sudo x056-write-vhost.sh <bare-filename> <<< "$content"` — write ONE vhost file under `sites-enabled/` (the wrapper refuses path traversal / non-bare names, writes atomically, and runs `nginx -t` itself — a change that fails the test is left in place *unreloaded*, not applied)
  - That's the **entire** sudo grant (`/etc/sudoers.d/x056-nginx`) — no blanket root shell, no arbitrary file writes, no other host-OS sudo. Anything outside these three actions (installing a cert, editing `nginx.conf` itself, restarting non-nginx services) still needs the user, same as any other host change.
- **Deployments happen via the host-side actuator** (`scripts/deployer.sh`, cron every minute):
  1. Commit your changes, then `touch .deploy/requested`.
  2. The actuator **builds immediately** (safe while turns run) but **swaps the container only when NO project has a turn running** — including yours. The swap therefore lands *after your turn ends*.
  3. Verify afterwards via `.deploy/status.json` (`{status, commit, ts}`) and `.deploy/last.log`. If status says `build_failed`, read the log, fix, re-touch the flag.
- **The panel needs NO deploy**: `server/public/panel.html` is bind-mount live-served (`X056_PANEL_PATH`) — edits appear on browser refresh. **Backend changes (`server/`, `src/`, `Dockerfile`, `compose.yaml`) need the actuator flow above.**
- **A container swap restarts every session, including you.** Graceful swaps wait for idle so no turn is killed; your session resumes on the user's next message. Ungraceful restarts (crash/reboot) kill in-flight turns — they resume on next message too.
- **Background work now SURVIVES a turn** — the CLI process is kept alive between turns, so `run_in_background` shells, backgrounded agents and `Workflow` keep going and you collect their output on a later turn. Plain subagents were never affected (a Task call runs *inside* the turn). Nothing wakes you when one finishes, and a stop, a failover, a container swap or ~30 min idle still ends it. See "Background work SURVIVES a turn" below.
- Mounts you can see: the failover config dirs (see "Accounts are a fleet" below — `~/.claude-x056-b` is account **b**; `~/.claude-x056-a` is an orphan, the live `a` is `/app/state/accounts/a`), the workspace (`/home/efran/remote-development`), `~/.claude/projects` **read-only** (interactive transcripts, for session adoption), and the `/app/state` volume. The host's `~/.claude` credentials are NOT visible.
- Tests: `npm test` (vitest, serialized files — keep it green), `npm run typecheck`. Both must pass before requesting a deploy.
- **You CAN screenshot** to eyeball UI work: a headless Chromium (Playwright) is baked into the image at `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`. Start the project's dev server, then `node /app/scripts/shot.cjs <url> <out.png> [width] [height]` and Read the PNG. Any project's own Playwright/Puppeteer also finds the browser via that env var. (Requires a container built after this note — if `shot.cjs` says playwright not found, the image predates it; commit + request a deploy.)
- **Toolchains baked into the image** (so any project builds, not just Node): Go (`GOTOOLCHAIN=auto`), Java 17 + Maven (Gradle via each project's `./gradlew`), Python 3 with pip/venv (system Python is PEP-668 externally-managed — always work in a venv), PHP + Composer, plus gcc/make/git/ripgrep/jq. `git push` over SSH works to GitHub, the VPN host `192.168.83.20` (`ssh ocr`), and the gateway host `ssh valbox` (dedicated keys in `state/ssh/`).

## There is a SECOND instance on this host (`/home/efran/x056-devs`)

A dev-facing gateway for employed developers runs beside production on the same
host. You are almost certainly in **production**; do not confuse them.

| | production (you) | dev |
|---|---|---|
| checkout | `/home/efran/remote-development/x056-remote-control` | `/home/efran/x056-devs` |
| compose project | `x056-remote-control` | `x056-devs` |
| host port | 4056 | 4057 |
| domain | `x056.rc.val.id` | `x056.rc-dev.val.id` |
| workspace | `/home/efran/remote-development` | `/home/efran/dev-workspace` |
| accounts | `.claude-x056-b` + state volume | `.claude-devs-{a,b}` |
| deploy lock | `/tmp/x056-deploy.lock` | `/tmp/x056-devs-deploy.lock` |

- **Compose already isolates most of it**: the project name comes from the
  directory, so containers, named volumes (`x056-devs_x056-state`) and the dind
  sidecar are per-instance. `X056_PORT` was the one hardcoded thing and is now a
  variable, defaulting to 4056 so production needs no `.env` change.
- **Three defaults were real leaks** and are overridden in the dev `.env`: the
  workspace root (would have exposed this repo, its `state/`, and every other
  project's `.env`), `X056_INTERACTIVE_PROJECTS` (the owner's `~/.claude`
  transcripts, read-only), and the deploy lock (a fixed name, so either instance
  could block the other's deploys for a minute at a time).
- The dev checkout lives **outside** the shared workspace on purpose — inside
  it, every production session could read its `.env` and token.
- It has **no SSH key** for `ssh valbox` (those live in the per-instance state
  volume) and `X056_HOST_NOTE` is unset, so its sessions are not taught the host
  escape hatch or the nginx sudo.
- Tokens are separate and mutually rejected (verified 401 both directions).

## Code graph (`codegraph` MCP server)

This repo is indexed as a call graph, exposed to every Claude account as the
`codegraph` MCP server. Use it for **"what calls this / what breaks if I change
this"** — questions ripgrep answers only as line numbers you then have to read.

- **Graph id: `cg-t54lyf43`** — every tool needs it as `code_graph_id`, and there
  is no tool that lists graphs, so take it from here.
- Tools: `code_search`, `code_explore`, `code_callers`, `code_callees`,
  `code_impact`, `code_node`, `code_files`, `code_status`.
- It indexes **committed `main`**, not your working tree — uncommitted edits are
  invisible to it. Re-indexes itself every 10 min; force one with
  `POST http://dind:8421/v3/code-graph/sync` (header `x-tdai-service-id: x056`,
  body `{"team_id":"x056","code_graph_id":"cg-t54lyf43"}`).
- Backing service runs on the **dind sidecar** (`x056-codegraph`, port 8421), not
  in this container and not on the host — so it survives gateway deploys. It holds
  no API key and makes no outbound calls. Ops notes: `docs/codegraph.md`.

### Cross-project memory search

The same server also indexes **every project's auto-memory files** as a wiki, so
you can search memories from projects other than the one you're in — the
auto-memory injection only ever gives you the *current* project's.

- **Wiki id: `wiki-h0cbwx1t`** (`wiki_search`, `wiki_read`, `wiki_list`,
  `wiki_graph`). 176 memories across 9 projects.
- Reach for it when a problem smells like one already solved elsewhere —
  deployment, auth, e2e, dind networking. Your own project's memories are
  already in context; this is for the other eight.
- It is a **mirror**, refreshed by `node scripts/codegraph-sync-memories.mjs`
  (idempotent). Edits to memory files do not appear until that runs.
- Search is lexical (BM25 + a distinct-term-match re-rank), not semantic — so
  name things concretely. Two or three specific words beat a sentence.

## Accounts are a fleet — keep them identical

There are **three Claude accounts** (`a`, `b`, `c`) plus a codex one (`d`). Note
that account **b lives at `/home/efran/.claude-x056-b`**, a HOME path — it is
live, not stale. Only `~/.claude-x056-a` is orphaned. Reading plugin state from
the wrong one is an easy and repeated mistake; take the truth from
`/app/state/accounts.json`.

Anything per-account must be applied to **all** of them, or it fires only when
failover happens to land on the right one — which reads as "randomly broken":

- **Plugins / MCP servers** — use the panel or the API, never the `claude` CLI
  directly; `PluginManager` and `McpServerManager` fan out across every account.
- **Opt-in flag files** (e.g. `.i-have-adhd-always`, resolved by hooks through
  `$CLAUDE_CONFIG_DIR`) — `POST /api/accounts/flag {flag, on}`. Note `$HOME/.claude`
  is only the fallback when `CLAUDE_CONFIG_DIR` is unset, which it never is here,
  so touching `~/.claude/...` does nothing.
- **Claude Design** needs a per-account grant, and it is **not** the login you
  would guess. Two different things:
  - `/design-consent` (`POST /api/accounts/design-consent`, or the panel's
    **Grant design access**) is what the `mcp__claude-design__*` tools check.
    Without it every call returns *"the user hasn't granted this — run
    `/design consent`… (it can't be approved automatically in this permission
    mode)"*. That last clause is the trap: turns run with
    `--dangerously-skip-permissions`, so the prompt can never fire and the grant
    must be made out of band. It is non-interactive — a plain `claude -p`.
  - `/design-login` (panel: **Claude Design login**) is design-*system* access
    for `/design-sync`, and is interactive-only, hence the PTY in
    `server/design-login.ts`. It does **not** unlock the MCP tools.
  - The grant is server-side per **claude.ai identity**, and the three accounts
    are three different identities — so each sees its own Design projects, and a
    failover changes which projects `list_projects` returns. Sharing one
    workspace across them means adding the others as project members.
- **A newly onboarded account** is provisioned automatically to the fleet's
  baseline (`server/provision.ts`), design consent included. `GET
  /api/accounts/baseline` shows that baseline and which accounts lag; `POST
  /api/accounts/provision` re-applies it.

## Background work SURVIVES a turn (persistent sessions)

Turns used to be one `claude -p` process each, so "the turn ended" and "the
process died" were the same event — background shells, backgrounded agents and
the `Workflow` tool were destroyed the moment the model stopped talking.
(Ordinary subagents never were: a Task call runs *inside* the turn and blocks
it.)

`src/persistent.ts` keeps **one long-lived process per conversation**, fed a
message per turn over `--input-format stream-json`. A turn now ends at the
`result` event, not at process exit.

- **It slots in without touching failover.** `runSession` drives turns through
  `startTurnFn(opts) -> TurnHandle` and only asks three things of a handle:
  stream events, say when the turn is over, stop it. `PersistentTurns` implements
  that over a shared process, so `src/failover.ts` is unchanged.
- **Failover works because `kill()` really ends the process.** On a usage limit
  the loop kills the handle and re-enters with the next account's configDir,
  finds no live process for that pair, and spawns one with `--resume`. Verified
  against the real CLI: a second process resuming the same id recalls the first
  one's context.
- `interrupt()` sends the CLI's `control_request`/`interrupt` rather than a
  signal — the turn stops, the process lives, and it is usable immediately after.
- **Identity is the whole argv**: configDir, sessionId, model, effort, mcp config
  and system prompt. Anything baked in at spawn cannot be changed for a running
  process, so a different model keys to a different entry and respawns.
- **A turn ending is NOT the process going idle**, and conflating the two killed
  a real session. After `result` a finishing background task wakes the model and
  it keeps working; the pool marked the entry idle, and the next conversation's
  `startTurn` evicted it — SIGKILLing a process 0.6s after its last write.
  Eviction and the TTL now key off `lastOutput` (any stdout, turn or not) with a
  2-minute grace, never off turn recency. If everything is working the pool runs
  over its cap rather than destroying live work.
- **Out-of-turn events reach the panel** via `onIdleEvent`. The turn's `onEvent`
  feeds the failover classifier and must stop at `result` — handing a finished
  turn's classifier a limit verdict is meaningless — but the UI still needs the
  work. Before this, 28 seconds of real work went only to the CLI's own
  transcript and the conversation simply looked dead.
- Bounded: `X056_PERSISTENT_TTL_MS` (30 min without output) and
  `X056_PERSISTENT_MAX` (6 live; was 4, below the number of conversations
  actually in play). Eviction skips anything still **working** and never the
  session whose turn is starting — with no output yet it is LRU's first pick,
  and it killed itself between spawn and first write. A turn whose process dies
  before `runOn` has nothing to resolve it, so it hangs forever and a stop
  cannot clear it: the abort path waits on the same promise.
  `X056_PERSISTENT=off` restores a process per turn. Codex keeps the one-shot
  path — its CLI has no equivalent mode.
- **The UI must show background work, or it reads as dead.** Every busy
  indicator used to key off `SessionManager.runs` — gateway turns — so a
  conversation whose turn had ended but whose process was still driving a
  browser showed no spinner, no Stop, and no strip entry, while its tool calls
  streamed into the view. `PersistentTurns.workingSessions()` reports which
  processes are producing output and whether a turn is behind it; the manager
  turns the not-busy ones into `backgroundSessionIds` / `backgroundProjects`,
  and the panel spins them **violet** (`--bgwork`, its own variable -- `--amber`
  is the warning colour in a dozen other places) to say "working, but not a
  turn"; a running turn outranks it, so a project row carrying both states
  renders accent. Violet because it is the one hue with no other job here, and
  because no yellow survives light mode: bright enough to separate from
  `--accent` puts it under 3:1 on the sidebar, dark enough for contrast puts it
  back beside the accent hue.
  Stop on one calls `interruptSession()` — interrupt, not abort, so the session
  survives and the next message still lands on the same process.
- What still ends background work: an operator stop, a failover, a container
  swap, or the idle TTL. **Nothing wakes the model when a background task
  finishes** — it collects the output on its next turn.

## Subagents have their own transcripts

A Task/Agent call does **not** inline its work into the parent transcript. The
CLI writes each subagent a complete transcript of its own:

```
<configDir>/projects/<projectDir>/<sessionId>/subagents/
    agent-<agentId>.jsonl        full transcript, same entry shapes as a session
    agent-<agentId>.meta.json    {agentType, description, toolUseId, spawnDepth}
```

- So a per-subagent view is a **second file read with the same pager**
  (`readFilePage`) — nothing is reconstructed from the event stream, and a
  finished turn reads exactly like a running one.
- `toolUseId` ties a subagent back to the Task call in the parent; `spawnDepth`
  is 1 for one the conversation spawned, 2+ for one another subagent spawned.
- `src/adapters/subagents.ts` lists and reads them; the panel's ✨ topbar button
  opens "Cost & subagents", and each row opens its own shell. `agentId` is matched
  against the directory listing before use — it arrives from a query string, and
  pasting it into a path would let `../` escape the session.
- **Status comes from a Task's `tool_result`, not from mtime.** A `tool_use` and
  its later `tool_result` bracket the subagent, so a missing result means it
  never came back — running if the turn is live, stopped if it is not. Guessing
  from file mtime calls a subagent that is thinking hard "finished".
- **A nested subagent's result is in its SPAWNER's transcript, not the parent's**,
  and nesting is the common case: a real security scan here produced 90
  subagents, 80 of them depth 2 or 3. Reading only the parent reported all 80 as
  never having returned. The endpoint merges the Task records from the parent AND
  every subagent — the same scan already needed for per-subagent usage, so it
  costs no extra reads — which also yields `spawnedBy`.

## Workflow runs have their own island (`src/adapters/workflows.ts`)

A `Workflow` call writes its agents beside the session in a directory per RUN,
using the **same file shapes as an ordinary subagent** — so nothing about
reading them is new:

```
<configDir>/projects/<projectDir>/<sessionId>/subagents/workflows/wf_<runId>/
    journal.jsonl              {type:'started'|'result', key, agentId, result}
    agent-<agentId>.jsonl      full transcript, identical shape to a subagent's
    agent-<agentId>.meta.json  {agentType, spawnDepth}
<configDir>/projects/<projectDir>/<sessionId>/workflows/scripts/<name>-wf_<runId>.js
```

- Because the agent files are byte-identical to a plain subagent's,
  `readFilePage` opens one unchanged and the cost scanner already prices them.
- **`label` and `phase` are NOT persisted.** Checked against a run that used
  both: neither the journal nor the meta file carries them. So a run shows the
  phases it DECLARED — read out of the script's `meta` literal, which the tool
  requires to be pure, so it is pattern-matched rather than evaluated — and each
  agent is named by the head of its own prompt (`cachedBrief`).
- **Progress is the journal**, not mtime: `started` minus `result` per agentId.
- **But liveness is NOT the journal.** It only gains a line when an agent STARTS
  or RETURNS, and the run directory's mtime only moves when a file is added, so
  three agents each thinking for ten minutes touch neither — a working run read
  as long-stalled and the island hid it. The agents' own transcripts are the
  heartbeat; they are stat'd only for a run that is still incomplete.
- **Incomplete is not the same as running.** A swap, a stop or a crash leaves a
  run short of its agents forever, and "0 / 4 agents · running" on a run that
  died hours ago is the same phantom-busy lie the conversation strip was fixed
  for. A run counts as live only if it is also moving (5 min).
- The accounts share one `projects/` tree, so every run is reachable through
  every configDir — dedupe by runId or one run lists three times.
- It **floats** over the chat rather than taking a column: a run is glanced at
  and dismissed, and permanently narrowing the conversation costs more than it
  gives. Because it covers content it opens on its own only while a run is
  MOVING; a finished one stays behind the topbar button (its own `#i-fanout`
  icon — `#i-repeat` is autopilot's).
- `runId` and `agentId` both arrive from a query string and are matched against
  the directory listing before reaching a path.

## Token cost (`server/transcript-stats.ts`)

Every assistant entry carries `message.usage` and `message.model`, so what a
conversation or a subagent spent is **recorded, not estimated**. One incremental
pass collects both that and the Task outcomes above.

- **Scanning is incremental and cached** (`state/transcript-stats.json`, keyed by
  path, holding a byte offset + running totals). Transcripts here reach 627MB;
  re-reading one per request is not an option.
- Totals are for the **whole file**, always read from byte 0. A 627MB transcript
  takes 10.3s at ~61MB/s, which cannot happen inside one request, so it is read
  in **budgeted pieces that resume**: each call does bounded work, reports
  `partial`, and picks up where it stopped. Poll and the figure converges to the
  exact number (27 calls, ~350ms each, for the 627MB one). The panel says
  "still reading: 24.0 MB of 627.0 MB" rather than presenting a fraction as a
  total. `usage/all` sizes each read to the time it has left, so a chunk begun
  with 30ms remaining cannot overshoot the budget.
- The cache is **versioned** (`CACHE_VERSION`). v1 entries began mid-file under
  an older tail cap, so their totals are not whole-file numbers and are
  discarded rather than shown as if they were.
- Dollars are **API list price for the same work**, not what Max billed (it is a
  flat subscription). An unpriced model is NAMED rather than blanking the figure;
  `<synthetic>` carries no tokens and is skipped.

## Conversations messaging each other is BOUNDED

`send_message` lets one conversation drive another, which is also how two of them
get stuck: A asks B to debug something, B reports back, A asks a follow-up, and
neither can see that the pair is going nowhere. Both brakes are enforced in the
gateway, not asked for in a prompt.

- **Relay depth** (`SessionManager.RELAY_HOP_LIMIT`, 6). Every AI→AI send belongs
  to a chain; each hop increments its depth, and past the cap `deliverMcpMessage`
  throws `RelayLimitError` (HTTP 409) and nothing is sent. Depth follows the
  CHAIN, not the pair, so routing through a third conversation does not dodge it.
  `send_message` reports the hops left on every send, so a caller can wrap up
  before it is cut off.
- **Only a human resets it.** A panel message clears the chain
  (`clearRelayChain`). Stopping a conversation does NOT — otherwise an exhausted
  pair could halt each other to buy another round. In **approval** mode the
  operator is the reset: an approved send is human-origin, so the count starts
  over and the cap never fires on an exchange they are waving through.
- **`stop_conversation`** aborts a conversation's turn AND drops its queue —
  stopping the turn alone just lets the queue drain into a new one. Ungated,
  unlike a send: a brake that waits for a human is not a brake, and the worst it
  can do is end a turn early. It hands back no hops.
- **`message_self`** has its own separate bound (`SELF_QUEUE_LIMIT`, 5), reset by
  any message the conversation did not send itself.

Both counters are in memory. A restart re-earns them, deliberately.

## Scheduled tasks (cron)

A conversation can schedule a prompt to be sent on a repeating schedule, via the
`schedule_task` / `list_scheduled` / `pause_scheduled` / `cancel_scheduled` MCP
tools; the panel's ⋯ → **Scheduled tasks** lists, pauses and deletes them.

- **`once: true` for anything meant to happen one time.** Written as plain cron,
  "deploy at 3am tonight" is `0 3 * * *` — a job that fires *every* night, and
  the surprise lands a day after everyone stopped thinking about it. A one-shot
  deletes itself after it runs; if its delivery FAILS it is disabled instead, so
  the reason stays visible and it cannot fire unattended a day later.
- **Times are Asia/Jakarta by default, not UTC** — this container runs UTC, so a
  job stores an IANA zone and is matched against the wall clock in it. Override
  per job with `tz`.
- 5-field cron (`minute hour day-of-month month day-of-week`). Both day fields
  restricted means OR, as in standard cron.
- Delivery goes through the same path a cross-conversation send uses, so a job
  firing at a busy conversation queues behind the running turn.
- Jobs live in `state/cron.json` and survive restarts and deploys.

## Session rules

- **Markdown uploads:** whenever you create or modify any `.md` file during a session, upload it so the rendered version can be read, and share the returned URL:

  ```bash
  curl -F "file=@<filename>.md" https://x056.think.val.id/upload
  ```
