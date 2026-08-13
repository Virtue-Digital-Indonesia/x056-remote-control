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
- **Background work DIES when your turn ends.** Your process is the turn: backgrounded subagents, workflows, or `run_in_background` shells are killed at turn completion. Run long orchestration synchronously within the turn, or don't run it. Never promise "I'll be notified when it finishes."
- Mounts you can see: the two failover config dirs (`~/.claude-x056-a`, `~/.claude-x056-b`), the workspace (`/home/efran/remote-development`), `~/.claude/projects` **read-only** (interactive transcripts, for session adoption), and the `/app/state` volume. The host's `~/.claude` credentials are NOT visible.
- Tests: `npm test` (vitest, serialized files — keep it green), `npm run typecheck`. Both must pass before requesting a deploy.
- **You CAN screenshot** to eyeball UI work: a headless Chromium (Playwright) is baked into the image at `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`. Start the project's dev server, then `node /app/scripts/shot.cjs <url> <out.png> [width] [height]` and Read the PNG. Any project's own Playwright/Puppeteer also finds the browser via that env var. (Requires a container built after this note — if `shot.cjs` says playwright not found, the image predates it; commit + request a deploy.)
- **Toolchains baked into the image** (so any project builds, not just Node): Go (`GOTOOLCHAIN=auto`), Java 17 + Maven (Gradle via each project's `./gradlew`), Python 3 with pip/venv (system Python is PEP-668 externally-managed — always work in a venv), PHP + Composer, plus gcc/make/git/ripgrep/jq. `git push` over SSH works to GitHub, the VPN host `192.168.83.20` (`ssh ocr`), and the gateway host `ssh valbox` (dedicated keys in `state/ssh/`).

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

## Session rules

- **Markdown uploads:** whenever you create or modify any `.md` file during a session, upload it so the rendered version can be read, and share the returned URL:

  ```bash
  curl -F "file=@<filename>.md" https://x056.think.val.id/upload
  ```
