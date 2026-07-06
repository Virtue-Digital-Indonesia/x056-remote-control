# X056 Remote Control

Self-hosted Claude Code "remote control" with automatic failover between two Claude Max accounts: a supervisor drives headless `claude -p --output-format stream-json` sessions and, when the active account hits its usage limit, respawns `claude -p --resume <session-id>` under the other account's `CLAUDE_CONFIG_DIR` (shared `projects/` tree), so one continuous session survives the switch. A NestJS gateway (`server/`) + vanilla panel (`server/public/panel.html`) expose it in the browser, with parallel projects, session adoption, and live activity.

## YOU ARE (PROBABLY) RUNNING INSIDE THE DEPLOYED CONTAINER

Sessions started through the panel run **inside the Docker container** this repo deploys. That changes how you must work:

- **No docker CLI, no docker socket.** You cannot build, restart, or inspect containers. Do not try; do not ask for the socket (it would be root-equivalent on the host).
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

## Session rules

- **Markdown uploads:** whenever you create or modify any `.md` file during a session, upload it so the rendered version can be read, and share the returned URL:

  ```bash
  curl -F "file=@<filename>.md" https://x056.think.val.id/upload
  ```
