# X056 Remote Control

Self-hosted Claude Code "remote control" with automatic failover between two Claude Max accounts: a supervisor drives headless `claude -p --output-format stream-json` sessions and, when the active account hits its usage limit, respawns `claude -p --resume <session-id>` under the other account's `CLAUDE_CONFIG_DIR` (shared `projects/` tree), so one continuous session survives the switch. A NestJS gateway (`server/`) + vanilla panel (`server/public/panel.html`) expose it in the browser, with parallel projects, session adoption, and live activity.

## Publishing outputs

- Finished shareable outputs belong on `https://x056.think.val.id`. Treat `/panel-drafts/` as preview/staging only.
- Think has two publishing modes. Read `https://x056.think.val.id/help` for the current commands and supported formats.
- **Native document is the default:** use it for reports, recaps, plans, runbooks, evidence write-ups, and other reading-first deliverables. Upload the original Markdown plus referenced images or media. Mermaid diagrams and rich Markdown render inside Reading room.
- Do not convert an ordinary reading deliverable into hand-written HTML.
- **Custom experience is the exception:** use `/sites/<slug>/` when the output genuinely requires custom HTML, CSS, JavaScript, or interactive behavior. Upload the complete bundle with `index.html` and its assets.
- Verify the returned URL. Use the configured upload credential or trusted valbox bypass, and never print or embed secrets in commands, logs, source, or memory.

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
  2. The actuator **builds immediately** (safe while turns run; skipped when
     the image for this exact tree -- HEAD, uncommitted diff, untracked list --
     is already built, `.deploy/built-key`), then **swaps only when the gateway
     is idle**: no running turn, no background work, no live workflow. It
     re-checks every 5 s for 45 s inside each cron tick
     (`X056_DEPLOY_POLL_EVERY` / `_WINDOW`; each poll counts at least 1 s, so
     an interval of 0 cannot loop forever), so an idle gateway swaps within
     seconds. **`touch .deploy/force` swaps despite running turns** (they resume
     on the new container) and is honoured within one poll even mid-wait.
     A live **workflow run** blocks it with **no timeout**, because a killed
     workflow does not resume — its agents are gone and someone has to notice
     and relaunch it by run id. `GET /api/workflows/live` is what the actuator
     asks; "live" means incomplete AND written to within 5 minutes, so a crashed
     run stops blocking on its own. `touch .deploy/force` to override.
  3. Verify afterwards via `.deploy/status.json` (`{status, commit, ts}`) and `.deploy/last.log`. If status says `build_failed`, read the log, fix, re-touch the flag.
- **The panel needs a deploy too now.** Production's `X056_PANEL_PATH` is `/app/server/public/panel.html`, the copy baked into the image, so a `panel.html` or `server/public/*` edit reaches the browser only after the actuator flow above -- the same as backend changes (`server/`, `src/`, `Dockerfile`, `compose.yaml`). (It used to point at this checkout and serve edits live.)
- **A container swap restarts every session, including you.** Graceful swaps wait for idle so no turn is killed; your session resumes on the user's next message. Ungraceful restarts (crash/reboot) kill in-flight turns — they resume on next message too.
- **Background work now SURVIVES a turn** — the CLI process is kept alive between turns, so `run_in_background` shells, backgrounded agents and `Workflow` keep going and you collect their output on a later turn. Plain subagents were never affected (a Task call runs *inside* the turn). Nothing wakes you when one finishes, and a stop, a failover, a container swap or ~30 min idle still ends it. See "Background work SURVIVES a turn" below.
- Mounts you can see: the failover config dirs (see "Accounts are a fleet" below — `~/.claude-x056-b` is account **b**; `~/.claude-x056-a` is an orphan, the live `a` is `/app/state/accounts/a`), the workspace (`/home/efran/remote-development`), `~/.claude/projects` **read-only** (interactive transcripts, for session adoption), and the `/app/state` volume. The host's `~/.claude` credentials are NOT visible.
- Tests: `npm test` (vitest, serialized files — keep it green), `npm run typecheck`. Both must pass before requesting a deploy. **Inside the container, run the suite with the gateway's own env unset** -- `env $(env | grep -oE '^X056_[A-Z_]+' | sed 's/^/-u /') npm test` -- or `X056_PROJECT_SPACES_ENABLED`/`X056_CHAT_ENABLED` and friends leak into the fixtures and ~9 manager/chat/routing tests fail with "Project membership is being reconciled" or "Conversation unavailable". Those are not regressions; the same tests pass with the vars unset.
- Browser tests (`test/browser/<name>.cjs`) run against a fixture gateway: `X056_TEST_PORT=<port> node --import tsx test/browser/fixture.ts`, wait for `/api/projects` to answer, then `node test/browser/<name>.cjs http://127.0.0.1:<port>`.
- **You CAN screenshot** to eyeball UI work: a headless Chromium (Playwright) is baked into the image at `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`. Start the project's dev server, then `node /app/scripts/shot.cjs <url> <out.png> [width] [height]` and Read the PNG. Any project's own Playwright/Puppeteer also finds the browser via that env var. (Requires a container built after this note — if `shot.cjs` says playwright not found, the image predates it; commit + request a deploy.)
- **Toolchains baked into the image** (so any project builds, not just Node): Go (`GOTOOLCHAIN=auto`), Java 17 + Maven (Gradle via each project's `./gradlew`), Python 3 with pip/venv (system Python is PEP-668 externally-managed — always work in a venv), PHP + Composer, plus gcc/make/git/ripgrep/jq. `git push` over SSH works to GitHub, the VPN host `192.168.83.20` (`ssh ocr`), and the gateway host `ssh valbox` (dedicated keys in `state/ssh/`).

## Composer: the quiet pill (2026-09-30)

The owner chose draft D ("quiet until you type" + "one pill"). At rest the
composer is one line with send and a faded caption of model · effort ·
helpers; focus, text, files, a saved draft or an open menu open it into the
pill: `+` (attach, template, reference), the helpers chip, ONE chip holding
the two native `#model` / `#effort` selects (kept native on purpose: phones
get the OS picker and tests use `selectOption`), send. While a turn runs an
empty box's send is Stop; with content it is Steer + Queue. Status, account
chip and delivery dot share the quiet line under it. All element ids are
unchanged. Tests that touch the hidden controls must click `#prompt` first.
Collapse on blur checks `relatedTarget` and holds on pointerdown, so a tap on
send never lands on a moved button.

**Formatting shortcuts (2026-10-01)**, ⌘ on a Mac and Ctrl elsewhere, never
Alt, so AltGr still types: ⌘B bold, ⌘I italic, ⌘U underline, ⌘⇧C inline
code, ⌘⇧X code block, ⌘⇧9 quote, ⌘⇧- rule, ⌘⇧8 bullets, ⌘⇧7 numbers.
Each one toggles: press it again to remove the format. The transforms and the
key table live in `server/public/composer-format.js`, which is pure, unit
tested and served from the fixed static list. One table drives the handler,
the `+` menu's "Formatting shortcuts" sheet, the help dialog and the
screen-reader hint. The box stays a plain textarea holding Markdown source:
contenteditable would break the padded list display, IME and the draft and
send paths. So each action is ONE native `insertText`, and Ctrl/⌘Z undoes it
in one step. Underline has no Markdown syntax, so it is `<u>…</u>`, and the
chat renderer lets exactly a bare `<u>` through and nothing else. The handler
calls `stopPropagation`, because the document handler would also read ⌘⇧8 as
"jump to project 8". The model and effort popovers are ⌥M / ⌥E, untouched.
**Live styling (2026-10-01):** the textarea's text is transparent over a
mirror (`#promptHighlight`) with the same metrics, drawn from the pure
tokenizer in `composer-format.js`; markers stay visible but faint, and every
style keeps character widths (faux bold via text-shadow, no font-weight or
monospace, quote bar and code tint drawn as backgrounds), so the caret lines
up (measured within 0.05 px). Your sent bubble renders the same Markdown.
Playwright proves that the page receives these keys. It cannot prove that a
browser won't take one first, such as ⌘⇧C (Firefox inspector) or ⌘⇧- (zoom).

**Live Markdown in the box (2026-10-01)**: the textarea's text is
transparent and `#promptHighlight` behind it paints the same characters,
classed by `ComposerFormat.highlightLines` (markers faint, quote bar,
code tint, etc.). The textarea stays the only source of truth. Every style is
width-neutral so the native caret and selection land on the mirror's glyphs:
bold is a faux `-webkit-text-stroke`, italic is a tint (a real italic face
changes widths), and there is no size, weight, monospace or padding change.
Kerning and ligatures are off on both layers. The mirror copies the
textarea's computed type and box on each render, catches programmatic
`value` writes through an instance setter, rebuilds only the changed lines,
and hides during IME composition. Measured drift is under 0.1px.

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
- **The compose defaults were the trap, and are now fail-fast.** They pointed at
  the author's own paths, so an instance that merely *forgot* a variable
  silently mounted the other's: its workspace (which holds that instance's
  `.env`, hence `X056_TOKEN` — and both containers run as uid 1001, so 0600 does
  not help), its account dirs (every account's `projects/` is symlinked into ONE
  shared tree, so that is every transcript, writable), and its
  `~/.claude/projects`. `X056_WORKSPACE_ROOT`, `X056_ACCOUNT_{A,B}_DIR`,
  `X056_INTERACTIVE_PROJECTS` and `X056_PANEL_PATH` now use `:?` and refuse to
  start unset. Production pins them explicitly and renders byte-identical.
- The dev instance's workspace is `poc-ahu-ai`, not the whole tree: its devs get
  the OCR worktrees, the chatbot and that programme -- plus **`ahu-codebase`**,
  bind-mounted INSIDE that root at `poc-ahu-ai/ahu-codebase` (on the dev `x056`
  container and its dind, same path) by `/home/efran/x056-devs/compose.override.yaml`.
  Inside the root because `resolveCwd` refuses any project outside
  `X056_WORKSPACE_ROOT`, and widening the root to the whole tree would hand
  devs this repo's `.env`. Compose merges the override on every `up`, so dev
  deploys keep it. On the host that path is an empty directory (the mount only
  exists in the containers); prod's discovery ignores it. The mount includes
  `epasti/pasti-api/.env` (real DB passwords) -- the owner chose to include it.
- **One isolation break is deliberate**: dev's container is attached to
  `x056-remote-control_default` so its `codegraph` MCP server can reach THIS
  instance's knowledge service at `x056-remote-control-dind-1:8421`. Its devs can
  therefore `wiki_search` every project's memories and the code graph. Chosen
  over standing up a second indexer; undo with
  `docker network disconnect x056-remote-control_default x056-devs-x056-1`.

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

The Claude accounts are **`a`, `b`, `f`** and the ChatGPT ones `d`, `e`, `g`, `h`, `j`, `k` (2026-09-29; `accounts.json` is the truth -- this list goes stale). Note
that account **b lives at `/home/efran/.claude-x056-b`**, a HOME path — it is
live, not stale. Only `~/.claude-x056-a` is orphaned. Reading plugin state from
the wrong one is an easy and repeated mistake; take the truth from
`/app/state/accounts.json`.

**Never launch `claude` or `codex` directly against a live account's config dir
for a probe or a check.** Starting the CLI can refresh the OAuth token, and a
refresh rotates the refresh token; a launch that exits or is killed around that
moment can leave the account holding a dead token, and the next start clears it
("OAuth session expired and could not be refreshed"). Account `f` was signed out
this way on 2026-09-29 around a series of short `--advisor` launch checks. Probe
with a scratch config dir, or through the gateway, which owns the accounts.

Anything per-account must be applied to **all** of them, or it fires only when
failover happens to land on the right one — which reads as "randomly broken":

- **Plugins / MCP servers** — use the panel or the API, never the `claude` CLI
  directly; `PluginManager` and `McpServerManager` fan out across every account
  **of a provider**. Codex speaks the same plugin/marketplace format as Claude
  (verified: `codex plugin add code-review@claude-plugins-official` installs
  from the real Claude marketplace), so the same plugin id means the same thing
  on both — but into Codex's own accounts, with `add`/`remove` instead of
  `install`/`uninstall`, and with no enable/disable. The plugins popover has a
  Claude / ChatGPT switch; every plugin route takes `provider`.
- **MCP servers are on Codex too** — `codegraph`, `Obscura`, `midtrans-docs`
  and Context7 (which registers its own server on install) on every Codex
  account, 3/3 synced. Two things are NOT replicable and never will be through
  the gateway: `claude-design` (Anthropic first-party, bound to a Claude
  login), and the **claude.ai connectors** (Valid Recruitment, Canva, ClickUp,
  Gmail, Calendar, Drive, …) — those live in the claude.ai account, not in any
  config dir, and reach only Claude sessions. The gateway's own `x056` server
  is per-turn config on both providers. Codex's `mcp add --url` has no header
  flag, so an authenticated http server is written into `config.toml` directly
  (`[mcp_servers.X.http_headers]`), which `mcp list` and `mcp remove` round-trip.
  **To prove a Codex account's servers load without spending a credit:**
  `codex app-server` → `initialize` → `thread/start` → `mcpServerStatus/list
  {threadId}` returns every server with its tool count and auth status
  (`bearerToken` = the header authenticated; `notLoggedIn` = the server wants
  its own login, as Context7 does; `unsupported` + 0 tools = dead upstream, as
  midtrans-docs is on both providers). It works even when the account's own
  ChatGPT token is revoked, because MCP init does not touch OpenAI auth.
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
- **Skills that get EDITED live in one shared copy: `/app/state/skills/<name>`,
  symlinked from every account's `skills/` on BOTH providers** (Claude reads
  `$CLAUDE_CONFIG_DIR/skills/`, Codex `$CODEX_HOME/skills/`, same SKILL.md
  format -- `skills/list` over `codex app-server` shows them without a turn).
  `writing-style` + `pushback` are installed this way because `/pushback`
  rewrites `rules.json` in place: eight private copies would drift on the
  first complaint. The shared copy is a git repo (the loop commits there).
  Two things bit on install: (1) everything under `/app` inherits
  `"type": "module"` from `/app/package.json`, so the kit's CommonJS scripts
  need a `package.json` with `"type": "commonjs"` in the skill dir; (2) under
  `claude -p` the transcript file does NOT yet hold the final assistant entry
  when the Stop hook fires, so a hook that reads the transcript sees empty text
  and lets everything through -- read `last_assistant_message` from the hook
  input instead (patched in the shared copy, commit a5ed053). Verified live:
  a stiff paragraph on haiku was blocked once, rewritten, and passed 100/100.
- **Hooks are per account** (`<configDir>/settings.json`, NOT `~/.claude`),
  so a kit's `install-hooks.js` cannot be run as-is; merge its snippet into
  every Claude account with the shared absolute path. Codex (0.156.1+) now has
  stable hooks too (PreToolUse, PostToolUse, SessionStart, ...), but this kit
  is not wired into them -- there the SKILL.md instruction is the
  enforcement. `WRITING_STYLE_HOOK=off`
  disables both hooks for a process.
- **A newly onboarded account** is provisioned automatically to the fleet's
  baseline (`server/provision.ts`), design consent included. A shared skill
  is provisioned as the SAME symlink, never a copy. `GET
  /api/accounts/baseline` shows that baseline and which accounts lag; `POST
  /api/accounts/provision` re-applies it.

- **Codex models reach plans at different times, so failover checks.** The
  catalog is server-side, per account AND per `client_version`: GPT-6.1-Sol
  (2026-09-29) was offered only to client >=0.159.0 and only to the Pro
  account (`e`); the Business/ProLite accounts still listed GPT-6-Sol. The
  picker merges every account's `models_cache.json` and drops a model once
  any account offers its successor (`SUCCESSOR` in
  `src/codex-model-policy.ts`; saved `gpt-6-sol` / `gpt-5.6-sol` map forward).
  Each Codex turn then re-checks the account failover actually picked
  (`codexTurnForAccount`, in `SessionManager.turnStarter`): an account without
  the model runs its newest predecessor, effort clamped, and the panel shows a
  `model_fallback` banner. A new model: bump `@openai/codex` in the
  Dockerfile, add it to `SUCCESSOR` and the panel's `LEGACY_MODEL_IDS`, price it
  in `transcript-stats.ts`.

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
- **Identity is what the CLI fixes at spawn, and the transport decides**
  (`Transport.identity`). Claude bakes model and effort into argv, so a
  different model keys to a different entry and respawns. Codex sends model
  and effort on every `turn/start`, so they are NOT identity there -- keying
  on them opened a second app-server on the same thread when the effort was
  changed mid-conversation, and the first still held the rollout: `thread
  already has an active writer`. Both key on configDir, the **conversation
  id** (`TurnOptions.conversationId`, the gateway's own, constant), the MCP
  config and the system prompt. NOT `sessionId`: for Codex that is the
  gateway's id on the first turn and the thread id on every resume, so a key
  built on it never matched the first turn's process again -- every Codex
  conversation collided with itself on its second turn, four times in a row,
  live, while the idle first process sat in the pool holding the thread.
  Steer, interrupt and the working indicator look entries up by the same id.
- **Switching a Claude model and back must not reuse the first process.**
  Model is identity, so sonnet -> opus spawns a second process; opus ->
  sonnet then found the FIRST one by key, whose context never saw the opus
  turns. A process is stale once a sibling of the same conversation started a
  turn after it (`isStale`): it is never reused -- destroyed if idle, moved to
  a `#retired:N` key if still working -- and a new spawn destroys its idle
  siblings (`retireSiblings`). Jev on Auto made this routine.
- **A Codex thread takes ONE writer, so a Codex conversation gets one
  process.** codex 0.159 holds `<CODEX_HOME>/thread-writer-locks/<thread>.lock`
  (an flock) for the life of the app-server that opened the thread. A helper
  toggle changes the identity (team/advisor -> system prompt, `codexConfig`),
  so a new process spawned while the old one, still inside its working grace,
  held the lock: every turn failed in 400 ms with "thread ... already has an
  active writer" (seen live 2026-09-30, twice, 22 s apart). The Codex
  transport is `singleWriter`: before a spawn, every other process of that
  conversation is killed, working or not (an account switch included, where
  the locks are in different homes but the rollout is the same file). A
  killed process can hold its lock for a moment, so a resume refused that way
  is retried (`WRITER_RETRIES` x `WRITER_RETRY_MS`, 5 x 1 s) before it fails.
- **Resume WITHOUT the history, and read the stream in linear time.**
  `thread/resume` puts the thread's whole history in `thread.turns` unless
  `excludeTurns: true` (1.8 MB reply for a 7 MB thread, 4 KB with it); the
  gateway only reads the id. For the 802 MB UAT thread that was hundreds of
  MB on ONE line, and `onData` re-split its growing buffer on every 64 KB
  chunk -- quadratic -- so the gateway spent 94% of its CPU there and every
  request, helper toggles included, took 4-8 s (CPU-profiled live via
  `kill -USR1` + the inspector, 2026-09-30). Every new Codex process on a big
  thread (deploy, helper toggle, failover) re-triggered it. Now resume sends
  `excludeTurns`, and `onData` splits only a chunk that holds a newline, with
  a `StringDecoder` so a multi-byte character across two chunks survives.
- **A failed handshake frees its slot.** A Codex process whose thread could
  not be opened is alive but can never take a prompt; left in the pool it
  swallowed the NEXT turn (parked as `pendingPrompt`, five minutes of
  "working…" with no output). A turn that ends before the process was ever
  ready now destroys the process, so the next turn respawns.
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
  `X056_PERSISTENT=off` restores a process per turn, for BOTH providers.
- **Codex has the same thing, over `codex app-server`.** `codex exec --json`
  has no streaming input, so Codex used to be one process per turn. The app
  server is JSON-RPC on stdio with the primitives the pool needs — `thread/start`,
  `thread/resume {threadId}`, `turn/start`, `turn/steer {expectedTurnId}`,
  `turn/interrupt {turnId}` — verified live on 0.153.4 (thread → turn →
  completed in 3.1s; `thread/resume` picks up a thread `exec` created, with its
  original model). So `PersistentTurns` is one pool over a **`Transport`**
  (`src/persistent-transport.ts`): the Claude one is the old inline code
  verbatim; the Codex one (`src/persistent-codex.ts`) **translates** every
  app-server notification into the flat `exec --json` shape the codex adapter
  was written against, so `classify`/`toActivity`/`captureSessionId` run
  unchanged. The manager runs two pools, one per provider.
  - The Codex handshake can complete **synchronously inside `spawn()`**, before
    `runOn` has attached a sink — events from that window are held and replayed
    once the turn is wired, and a handshake that fails there settles the turn.
    That hold is scoped to the pre-first-turn window only: widening it leaked a
    between-turn Claude event into the next turn's classifier.
  - **Live-verified on 0.153.4, real process, real account:** a `gpt-6-astra`
    turn completes through the pool (6.2s, "OK"); a second turn reuses the same
    process and thread with no re-handshake; `turn/steer` sent 4s into a turn is
    answered *inside* that turn (one `turn.completed`); `turn/interrupt` stops
    a turn in 0.1s as `turn.failed {status:'interrupted'}` (classified
    `irrelevant` — not a limit, so no failover), the process survives, and the
    next turn runs on it. An account that is out of credits fails the turn with
    `turn.failed`, classified as a limit.
- **Codex rollouts live in ONE shared store, or failover cannot resume.**
  Codex files each thread under `$CODEX_HOME/sessions/` and `thread/resume`
  looks it up THERE: an empty home answers `no rollout found for thread id …`
  (verified on 0.153.4, and the converse: a home whose `sessions/` merely
  links to another's resumes that home's threads, preview and all). Claude
  gets this for free from the symlinked `projects/` tree; Codex did not, so a
  limit on `g` re-entered on `h` with a thread `h` had never seen and the turn
  died 300 ms later. `server/codex-sessions.ts` links every Codex account's
  `sessions/` to `state/codex-sessions/` -- at boot for the accounts that
  exist (their rollouts are moved in first; a name already present is the
  same thread and is never overwritten) and again at onboarding, before the
  first turn.
- **A NEW Codex account's first start indexes the whole shared store, and a
  gateway timeout mid-index wedges the account.** codex 0.153 runs a one-time
  "state db backfill" the first time a CODEX_HOME starts; with `sessions/`
  linked to the shared store that is every rollout on the gateway (1.6 GB, 127
  files on 2026-09-17). The gateway's spawn timeouts (15 s for the usage probe,
  30 s for a turn) killed it part-way, which left `backfill_state.status =
  'running'` in the account's `state_5.sqlite` with no process behind it; every
  later start waited 30 s for that phantom and exited 1, so each turn on the
  account failed after exactly 30 s with `error: null` and the panel showed
  "Not checked · Usage temporarily unavailable". Seen live on account `j`,
  and again on `g` after a re-login (2026-09-30): 3.5 GB, 205 threads.
  **The app-server answers nothing, `initialize` included, until the index is
  done** -- measured in a scratch home: 224 s -- and each killed start begins
  it again (`backfill_state = running`, no watermark). `prepareCodexHome`
  (`server/codex-sessions.ts`) holds ONE app-server open until `initialize`
  answers, then closes stdin so it exits on its own; meanwhile the router
  skips the account (`notReadyReason`, "Indexing the shared session store").
  Onboarding runs it, and boot runs it for any home whose newest
  `state_N.sqlite` says the backfill is unfinished (`codexHomeIndexed`), so a
  swap mid-index heals itself. It used to be `codex migrate-rollouts --apply`,
  which on 0.159 is a different migration (legacy sessions to paginated
  history) and never finished this index.
  **A killed start leaves a phantom that blocks every later one**, the
  preparing app-server included: "state db backfill is running ... waiting up
  to 30s" then "timed out waiting for state db backfill ... (status:
  running)", exit 1 (reproduced from g's state in a scratch home -- the first
  boot-time prepare died exactly so). So a home whose index is unfinished gets
  its `state_N.sqlite*` set aside (`setAsideCodexState`, renamed
  `.unfinished-<ts>`, the other sqlite files untouched) before the prepare:
  it has never served a turn, so the file holds only a partial index. The
  likely phantom-maker, the 15 s usage probe (`fetchUsage`, which spawns an
  app-server and kills it), now refuses a home that is indexing.
- **A thread whose first turn died has an id but no history, and used to wedge
  the conversation.** `thread/start` assigns the id at once but writes no
  rollout until a turn runs, so a 401, a limit or a swap on the first turn
  leaves a `providerSessionId` that every later `thread/resume` refuses --
  in 400 ms, with a reason the panel never showed. Seen live across a
  re-login, a failover AND a deploy on one conversation. The transport now
  answers that exact error with a fresh `thread/start`, once: `thread.started`
  carries the NEW id (the manager stores it), a `thread.reset` event is logged
  and the panel says "no saved history for this thread -- started a fresh
  one". With the shared store above, "no rollout found" means no history
  anywhere, so nothing is lost. A second miss is final.
- **codex-cli 0.153.4 rollouts carry the text as ITEMS, not message events.**
  There is no `event_msg/user_message` or `agent_message` any more; the user
  and assistant text are `item_completed` items of type `UserMessage` /
  `AgentMessage` (content parts `text`, or `Text` for the agent). The reader
  handles both shapes, deduped per role, or a reload showed the actions and
  the `task_complete` echo and nothing the user had typed.
- **A failed turn reports the stream's own message, not `exit code 0`.**
  Adapters expose `failureText(e)` (Codex: `error`/`turn.failed`/
  `thread.failed` messages; Claude: an error `result`); `runSession` keeps the
  last one as the reason and in the `turn_failed` log row. A persistent
  process does not exit when a turn fails, so its exit code says nothing.
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

## Helpers: advisor + agent team + a model/effort picker, combinable

`Conversation.helpers` = `{ advisor?, team?, router?: 'jev' | 'decisions' | 'none' }`,
any combination (`POST /api/conversations/helpers`). The older single field
`decisionMaker` is still read through `helpersOf` and dropped on the first
combined save; `POST /api/conversations/decision-maker` still sets it. They
were exclusive until 2026-09-30 because the owner first asked for "only one";
the thread they come from uses them together, and so do we now.

- **Jev is the DEFAULT picker (2026-10-02, owner).** `router` is what the
  user SAVED; absent = not overridden. `effectiveRouter(helpers,
  jevAvailable)` (`server/projects.ts`, beside `helpersOf`) is the one rule:
  `'none'` -> no picker (the panel's "Your choice", saved explicitly, so the
  default never overrides it), `'jev'`/`'decisions'` -> that one, absent ->
  `'jev'` while Jev is available, else none. Available = a key in
  `state/secrets/typesafe.json` AND credits on the gateway's own meter (synced
  balance minus spend since > 0; never synced counts as available),
  `JevService.availability()`, cached 5 s and cleared by a sync or a metered
  call; `GET /api/jev/status` carries `available` + `unavailableReason`
  (`no_key` / `no_credits`). Everything that acts on the picker goes through
  `SessionManager.routerFor`: the turn's pick, the team line, Auto, the agent
  tree (`helpers.router` there is effective, `savedRouter` the saved one),
  the fork backend's preference. Conversation rows (`/api/projects`, the
  `conversation` event), both helpers endpoints and MCP `read_conversation` /
  `list_conversations` / `set_helpers` report `effectiveRouter` (null =
  none) beside the saved `helpers`. The fork layer's EXISTENCE still depends
  on keys only, never credits: it is in the team's system prompt (process
  identity), so running out must not respawn every team conversation. A key
  with no credits and no saved picker turns Auto into the house default
  (`AUTO_MODEL`), never the CLI default: a panel that believed Jev would pick
  sent `''`. The panel marks Jev "default" ("default while credits last") and
  says "Jev unavailable: no credits" under "Your choice". The legacy
  decision-maker endpoint's `none`/`advisor` store `router: 'none'`. iOS reads
  `helpers.router` raw: it treats `'none'` as on and an absent router as off
  (not yet taught the default).

- **Agent team** (`server/team.ts`) is that thread's tree: the main session
  (its own model/effort) plans and decides; **explorer** (reads code,
  read-only), **worker** (bounded edit + tests) and **researcher** (docs,
  read-only) do the legwork at effort **medium** (or what the picker names
  for the turn, below); the advisor is on call if
  on (Claude subagents inherit it); small forks go to the fork layer.
  Nothing is installed into an account. Claude gets the three on argv
  (`--agents` JSON, Opus, part of the process identity so toggling respawns
  with `--resume`); read-only roles use `disallowedTools`, never an allowlist,
  which would also strip the MCP tools. Codex already has built-in `explorer`
  and `worker` roles, so it gets `agents.default_subagent_reasoning_effort =
  "medium"` as thread config (`TurnOptions.codexConfig`, `-c` on the one-shot
  path) and a `default` agent briefed as researcher. Both get the team
  instructions appended to the system prompt. **The brief says WHEN, not just
  how**: a Codex chat with the team on ran a 28-command turn alone
  (2026-09-30), its brief delivered, after 218 solo turns. It now names the
  triggers (unread code -> explorers in parallel, a multi-file change -> a
  worker per part, outside docs -> researcher), says it holds even if earlier
  turns worked alone, and asks for one line naming the spawns (or why none)
  before the first command. Still a prompt: nothing in the gateway forces a
  spawn. **Codex overrides the brief**: 0.159 follows it with its own
  developer message (`<multi_agent_mode>`: "Any earlier instruction enabling
  proactive multi-agent delegation no longer applies. Do not spawn sub-agents
  unless the user ... explicitly ask[s]"), lifted only at effort `ultra` --
  0 spawns in 28 team turns across three chats (2026-10-01). So every Codex
  turn with the team on carries an explicit ask in the USER message
  (`teamTurnLine('codex')`, picker or not): delegate per the brief, or do a
  genuinely small turn (one command, a known one-file edit, a single deploy,
  a direct answer) alone and say why. Claude gets the line only with a pick.
- **With a picker on, it also picks the TEAM's model and effort per turn**
  (2026-09-30): two more questions in the same call (`subagent_model`,
  `subagent_effort`, written whole per lean like the main ones; model only
  when there is a choice), for Jev and OpenAI Decisions alike.
  `applySubagentPolicy` uses the same lean bars, measured from the team's
  own base -- Claude Opus/medium, Codex the main session's model this turn
  at medium -- with no switching gap and no Auto; a missing, off-list, weak
  or (Codex) not-offered pick keeps the base. Candidates: the main pick's
  model list; efforts low/medium/high on Claude, up to xhigh on Codex.
  **The choice rides in the turn's MESSAGE**, one line before the sender
  marker (`[Agent team this turn: ...]`, `teamTurnLine` + `withTeamLine`),
  never in the system prompt, `--agents` or `codexConfig`: those are process
  identity, and a per-turn value there would respawn every turn (Claude
  losing its prompt cache, Codex the kill-then-resume single-writer path).
  Codex's `spawn_agent` takes `model` and `reasoning_effort` per call.
  Claude's Agent tool takes `model` per call but no effort, so `--agents`
  defines each role three times -- `explorer` (medium), `explorer-low`,
  `explorer-high`, same for worker and researcher -- constant JSON, and the
  line names the variant. `stripTeamLine` removes it wherever a prompt is
  read back (history readers, `cleanMemorySource`: titles, memory,
  `previousRequest`). No line when the picker is off or failed: medium, as
  before. The decision row carries `team`; the chat card shows "Team ·
  Sonnet · High", the terminal `team sonnet · high`, the agent tree the
  picked model · effort and "Jev NN%".
- **Fork layer**: the x056 MCP tool `quick_decision {question, options[2-6],
  context}` -> `POST /api/jev/fork` -> Jev (or OpenAI Decisions when that is
  the picker) as ONE choice question. `confidence >= 0.75`
  (`JEV_POLICY.forkSharp`) is **SHARP** (follow it), else **SPLIT** (the main
  model decides). Only for a conversation whose team is on. Never throws: no
  key, a timeout or an off-list answer is a SPLIT with the reason. Logged in
  `state/jev/forks/<sid>.jsonl`, metered in Jev's ledger, live as `jev_fork`,
  shown in the terminal view as `◇ jev · fork · …`. Live-checked 2026-09-30:
  "which file" with the stack trace naming it = SHARP 100% in 434 ms; retry-vs-
  stop and REST-vs-GraphQL = SPLIT; ~$0.000015 per fork.

- **Advisor on Claude** is Claude Code's own advisor tool: the gateway passes
  `--advisor <model>` (one-shot argv and the persistent transport; it is part
  of the process identity, so toggling respawns with `--resume`). The pairing
  is automatic -- verified on 2.1.280 that an Opus advisor on a Fable main
  model is NOT an error, Claude Code warns and runs WITHOUT it, which would
  look "on" while doing nothing -- so Fable mains get `fable`, everything else
  `opus`. The advice comes back ENCRYPTED (`advisor_redacted_result`); only
  that it happened, and its tokens in the turn's `result.modelUsage`, are
  visible. Never use `/advisor` for this: it writes `advisorModel` into the
  account's settings.json and leaks to every conversation on that account.
- **What the user sees**: a helper button in the composer (✦; a pill naming
  what is on, e.g. "Advisor · Team · Jev") opening a menu: Advisor and Agent
  team are checkboxes, then one radio group for model & effort (your choice /
  Jev / OpenAI Decisions); it stays open so several can be set. Each consultation is an advisor card in the
  chat: Claude's is one line ("Reviewed this step" -- the advice itself is
  encrypted), the ChatGPT advisor's shows verdict, advice and what was done
  with it. Live events `advisor_call` (Claude) / `advisor_consult` (ChatGPT);
  on reload they come back as `role: 'advisor'` history rows (Claude's from the
  transcript, ChatGPT's from the conversation journal).
- **Advisor on ChatGPT** is built by the gateway (`server/codex-advisor.ts`),
  because Codex has none. `TurnWatcher` reads the turn's stream for the same
  three moments -- first plan (`turn/plan/updated`, translated into a
  `todo_list` item), the same command failing twice or three failures in a
  row, `turn.completed` -- max 3 per turn. A consultation is `codex exec
  --ephemeral --sandbox read-only --output-schema` on the strongest offered
  model (gpt-6-astra, effort high), from a scratch cwd. **`--ephemeral` is
  load-bearing**: without it every consultation writes a rollout into the
  store all accounts share. Mid-turn "adjust" is steered in (`turn/steer`); a
  post-turn "concern" is ONE queued follow-up from sender kind `advisor`, and
  an advisor-started turn is never reviewed again, so they cannot loop.
  ~9 s and ~14.5k tokens per consultation (mostly Codex's own instructions).
  **With autopilot on** (2026-10-01): each turn's verdict (stop phrase,
  budget, pause on failure) is applied to THAT turn's result after
  `session_done`, even when a queued message drains next, so an advisor
  follow-up cannot hide a stop phrase. Autopilot waits for the turn's
  `done` review (`run.pendingAdvice`, cap `advisorWaitMs` 60 s), so a concern
  is queued and drains before the next step. A step is spent when its prompt
  is SENT, never on a tick that found the conversation busy. A plan/stuck
  steer lands only in the turn that produced it (else `too-late`), and an
  advisor steer is not human: it keeps the relay chain and self-message brake.
- **Jev** (TypeSafe AI's System One model, `server/jev.ts`) picks model and
  effort per turn, both providers: one HTTPS call (~0.3 s, ~$0.00003) inside
  the async run, so sending never waits. Applied to that turn only, never over
  the user's saved choice: effort at >=50% confidence, model at >=60%, and a
  Claude model switch at most every 3 turns (it respawns the process and drops
  the prompt cache; returning to the saved model counts as a switch too).
  **The bars are on Jev's confidence scale**, which runs ~0.15 below its top
  probability (0.54 for a 0.69 pick is typical). The first bars (60/80/90%)
  were written as if it were a probability: over the first 24 live picks the
  model confidence never passed 0.70, so no model ever moved (0/24) and
  effort moved 6 times. Rescaled 2026-09-30. A pick is weighed against what THIS turn runs with
  otherwise -- the saved choice -- never against the previous pick: doing
  that called a 71% "medium" "unchanged" and the turn ran on the saved xhigh
  (seen live 2026-09-30). Staying on a model a pick already moved to is not a
  switch, so it needs only the 50% bar. **Going LOWER needs more**: effort
  below the turn's own >= 65%, a cheaper model >= 65% (`effortDownMin`,
  `modelDownMin`) -- a wrong downgrade costs quality and a human round trip, a
  wrong upgrade only tokens. At 60-65% the live downgrades were a mix of right
  (a scheduled status check -> haiku 59%) and wrong (a feature build ->
  sonnet 60%), which is where the down bar sits.
- **Auto model / Auto effort with a picker on = the picker decides**, with no
  confidence bar (`JevDecisionInput.auto`, `(auto)` in the notes). The panel
  sends Auto as `''` instead of resolving it to its house default (else Jev
  would only ever see Sonnet) and labels it "Jev picks" (short: a phone gives
  each select ~100px); the
  conversation stays saved as Auto. A turn starts from what the last routed
  turn ran on, else the house default (`AUTO_MODEL`: sonnet /
  gpt-5.6-terra), and a failed or missing pick runs on that -- never on the
  CLI's own default, which is the frontier model. The Claude switching gap
  still holds on Auto; the lean still changes the questions. With no picker,
  Auto is unchanged (the panel sends the house default). A conversation that
  used Auto before 2026-09-30 is saved as `sonnet`, because that is what the
  panel sent: reselect Auto on it.
- **Lean** (`helpers.lean`, the Low / Medium / High control under the picker;
  absent = medium): which way the picker errs. It changes only the up/down bars
  (`LEAN_BARS` -- low: effort up 65% / down 45%, model up 75% / down 55%;
  high: effort up 45% / down 75%, model up 50% / down 80%; medium = the bars
  above; no effect on Auto) and swaps both questions for a Low / High
  version written whole (`effortQuestion` / `modelQuestion`: COST EFFICIENCY
  vs BEST RESULT), for Jev and OpenAI Decisions alike. Appending a sentence
  instead contradicted "prefer the cheapest model" and barely moved Jev;
  written whole, live 2026-09-30: High took Opus from 4% to 49% on a
  refactor and 11% to 69% on "yes, go ahead" after a big task; Low took a
  refactor's effort from high 58% to medium 65% but left the big-task
  follow-up at high 90%. With no effort saved (and not on Auto) up and down are
  measured from what the CLI runs with (`baselineEffort`:
  `CLAUDE_DEFAULT_EFFORT` -- opus/Opus 5.5 medium, sonnet/Sonnet 5 and fable
  high, per the model-config docs and the aliases seen in real transcripts;
  Codex: the model's catalog `defaultEffort`), or Low would need the raise
  bar even to pick `low`. A move the ranks cannot place (Fable, an
  unknown Codex slug) keeps the plain 60% bar; the "model stays" rule and the
  Claude switching gap are not relaxed; forks and the delegate gate ignore it;
  Fable is still never a candidate. Kept while the picker is off; the panel
  sends it on every full-set save (else toggling Advisor would wipe it);
  `set_helpers` / `send_message` `helpers` take `lean` too.
- **Jev is told the work in progress** (`decisionContext`, built in code):
  project, who sent the message (user / autopilot / delegate reports / ...),
  the previous request and the tail of the previous reply (cleaned of memory
  preambles, protocol blocks, credentials), and the previous turn's size.
  Measured live 2026-09-30: "yes, fix it" after a 48 min / 212-step task got
  effort medium from the message alone and high (69-80%) with the context;
  "and UTC?" after a one-line answer got haiku 95% / low 98% with it. Each pick is a compact card in the
  chat ("Jev · Opus · Medium · Changed this turn") via the conversation
  journal, so reloads keep it. Slow (3 s), failed or keyless = no change. Candidates:
  haiku/sonnet/opus on Claude (Fable excluded: usage credits), the
  account-advertised models on Codex. Key: `state/secrets/typesafe.json`
  (0600). Decisions: `state/jev/decisions/<sid>.jsonl`.
- **Jev credits**: TypeSafe has NO balance API (every balance-style path 404s
  with the key; the console is Cloudflare-blocked for servers). The gateway
  meters each call from the returned `usage` ($0.042/M input tokens, output
  free) and "left" = balance synced from the console (`POST /api/jev/balance`)
  minus spend since. Synced to $5.00 on 2026-09-29.
- **OpenAI Decisions replaces Jev** (`server/openai-decisions.ts`), same job:
  same two questions, same `applyPolicy`, and it writes into JEV's decision
  store with `backend: 'openai'` (rows without `backend` are Jev) -- shared on
  purpose, so the Claude switching gap counts a switch whichever backend made
  it. Live event is still `jev_decision`; the terminal labels the line
  `decisions ·` and shows tokens, not dollars (no price published).
  **It is PROVISIONAL.** Announced 2026-09-29 as a limited preview; `POST
  https://api.openai.com/v1/decisions` exists (401 "A valid API key is
  required", where a made-up path is 404) but nothing documents the request:
  no docs page, nothing in `llms-full.txt`, nothing in openai@7.24.0 / Python
  3.21.0. So the request is a guess in ONE function (`decisionsRequest`), the
  reply goes through a tolerant reader (`decisionsAnswers`), OpenAI's own
  error message is kept on the decision (a wrong parameter name shows up
  there), and `POST /api/decisions/probe` sends one fixed question and returns
  the raw reply -- run it the moment a key exists and correct the mapping.
  Disabled until `state/secrets/openai.json` (0600) holds `{apiKey, model?,
  endpoint?}`; `GET /api/decisions/status` never returns the key.

## Delegates: an orchestrator's hidden workers (`server/delegates.ts`)

Built 2026-09-30 to replace how the AHU "AI Progress Scoring" chat ran a team:
8 `create_chat` (8 sidebar rows), 74 `send_chat_message` through the approval
gate, 341 `read_reply`/`read_chat`/`chat_status` polls, 108 `sleep`s, and one
orchestrator turn per worker report. The owner chose: no approval (hard limits
only), and Jev gates which reports wake the orchestrator.

- **A delegate is NOT a project conversation.** Nothing in `projects.json`, so
  no sidebar row, strip entry, search hit or notification of its own -- hiding
  one inside `conversations` would have leaked through ~45 listing call sites.
  Roster `state/delegates/<parentSid>.json`, reports
  `state/delegates/<parentSid>.reports.jsonl`, events `delegate-events.jsonl`.
- **Its turns are ordinary `runSession` turns** (accounts, failover, the
  persistent pools via `turnStarter`, the Codex per-account model fallback),
  run by `SessionManager.runDelegateTurn` with x056 tools but no identity of
  its own (so it cannot delegate: one level deep; see below) and
  `delegateInstructions(role)` appended to the
  system prompt: every turn ends in a REPORT whose first line is DONE / NEEDS
  ORCHESTRATOR / NEEDS HUMAN / BLOCKED.
- **While a delegate works, its orchestrator counts as background work**
  (`backgroundSessions`, `providerActivity`): the violet spinner, Stop reaches
  it (`stopTurn` stops every delegate), and the deployer's idle check waits.
- **The gate** (`settleDelegateNow`): rules first -- a failed, stopped or
  interrupted turn is `blocked` without asking anyone -- then one Jev Choice
  (`JevService.choose`, logged in the fork log as `report gate · <role>`):
  done / needs_orchestrator / needs_human / blocked, followed only at >= 75%;
  unsure or no model = needs_orchestrator. `needs_orchestrator` and `blocked`
  wake at once; `done` and `needs_human` wait until no delegate of that
  orchestrator is working, then everything unseen goes over together.
  `needs_human` also sends a push notification.
- **One wake message** (`digest`), sender kind `delegate`, merged into a wake
  still waiting in the orchestrator's queue rather than queued twice. The panel
  shows it collapsed to one line; each report is also its own card (journal
  `delegate_report` -> `role: 'advisor'`, `advisor.delegate`).
- **Limits**: 8 active delegates (`stop_delegate` frees a slot; a follow-up
  revives it with its context), unique roles, and 40 dispatches between two
  human messages (`clearRelayChain` resets it). A follow-up to a working
  delegate queues behind its turn. A restart marks working delegates
  `interrupted` and wakes the orchestrator once (`recoverDelegates`).
- **Tools** (x056 MCP): `delegate`, `delegate_followup`, `list_delegates`,
  `stop_delegate`. The system note ((5b)) gives an ORDER, not a ban: own
  subagents/team and advisor first, delegates for parallel or multi-round
  workers, and `send_message` still for work that belongs to an existing
  conversation or when the user asks -- only "chats as workers" is out.
- **Any conversation's helpers and delegates are visible and steerable over
  MCP**: `read_conversation` returns `helpers` + `delegates`,
  `list_conversations` returns `helpers`, `set_helpers` changes only what it
  names (router `none` clears), `send_message` takes `helpers` for its target
  (applied only if the send is delivered -- in approval mode only on approve;
  a new conversation gets them via `TurnRunOptions.helpers` in `launch`), and
  `list_delegates` / `stop_delegate` take another conversation's ids.
  Starting or instructing delegates stays with their own orchestrator.
- **Delegates have x056 tools too, without an identity**: no `X056_SELF_*`
  (so no delegating, no message_self, no passing as the orchestrator), and
  `X056_RELAY_FROM` = the orchestrator, so their sends count on its relay
  chain instead of starting a fresh, unbounded one. **Panel**: a Delegates bar above the composer
  (status per delegate, open its transcript in the terminal view -- the
  pager takes `delegateId` -- message it directly, stop it, dismiss it).
- **Dismissed (2026-10-02)**: the bar used to keep every delegate that had
  reported, forever ("8 reported", no way out). Roster fields `dismissedAt`
  + `dismissedBy: 'auto' | 'user'`; the record, reports and transcript stay.
  A dismissed delegate is off the bar and its counts, out of the 8-active
  limit and frees its role name (`isActive` = not stopped, not dismissed),
  left out of the digest's "Team now", still in the agent tree (faint,
  "Dismissed"). **Auto rule** (`autoDismissible`): latest report gated
  `done` -- or `needs_orchestrator` with the worker's own first line
  starting DONE (`saysDone`; the gate only chose to wake at once, and live
  5 of 9 finished workers were filed that way) -- handed over (`woke`), the queue item that carried it (`queueId`
  on the report, set by `wakeOrchestrator`) has left the queue, the
  delegate is idle with nothing pending -- checked when an orchestrator
  turn ends (`session_done` not stopped, or `session_error`), serialised
  on `delegateSettling` so a report mid-gate is never taken for an old
  one. needs_human, blocked and a needs_orchestrator report not saying
  DONE never auto-dismiss.
  Boot runs the same rule (`recoverDelegates`; reports from before
  `queueId` count as consumed when no delegate wake is queued). **Revive**:
  any follow-up (MCP, bar, agent tree) clears it, if a slot and its role
  name are free. **By hand**: `POST /api/delegates/dismiss {projectId,
  sessionId, id}` (a working one is stopped first) or `{..., all:
  'finished' | 'all'}`; MCP `stop_delegate {dismiss: true}`; `list_delegates`
  hides dismissed ones unless `include_dismissed`. Panel: a x per row,
  "Dismiss finished" in the bar's head (asks when one waits on you or is
  working), Dismiss in the agent tree's delegate detail.

## Agent tree (`server/public/agent-tree.js`, `server/agent-tree.ts`)

The view of a conversation's whole working setup the owner asked for
("where is the fork layer?" -- it had only been terminal lines): the main
session (model/effort this turn, Jev pick marked), the advisor, the Jev fork
layer, the workers (agent-team subagents / Codex children), delegates,
Workflow runs, and a pipeline log.

- **Two views (2026-09-30, the owner chose draft E of the redesign).** The
  header button (⋯ menu on phones, Activity -> Agent tree, `/agent`) opens a
  **docked outline** to the RIGHT of the chat -- chat and composer stay
  usable, resizable 320-560 px. An indented tree with drawn guide lines, one
  **turn** at a time (stepper "Turn N · now"), running nodes first, an
  "Earlier turns" fold that expands in place. Clicking any node opens ITS
  history in a second column (drill-in with back on narrow frames):
  subagent / Codex child / workflow agent -> Conversation, Brief, Result;
  delegate -> reports, transcript, message box, Stop; advisor -> consultations
  (Claude: calls only, the advice is encrypted); Jev -> forks and picks; main
  -> the conversation's and its agents' cost (what the retired popup showed).
  **Expand** swaps in the old console-style tree over the WHOLE conversation,
  composer hidden too; only that expanded view is exclusive with the terminal
  view -- the docked pane may sit beside it.
- **The owner's four rules** hold in both views: "done" only with a real
  result (see the status contract under Subagents); working first; the
  earlier fold expands; only what was active or used in the turn.
- **Retired with it:** the floating Agents island (`#wfIsland`, `#chatAgents`)
  and the "Cost & subagents" popup (`#subPop`). Chat rows that name a
  subagent still open the agent reader (`openSubShell`).

- **`GET /api/conversations/agent-tree`** does cheap reads only: helpers,
  delegate roster, log TAILS (`tailJsonl`, last 512 KB), turn results, the
  ChatGPT consultations and the Claude advisor call log. The subagent list is
  NOT in it -- that scan does per-file stats and once blocked the event loop
  at a 5 s poll -- the view reads `conversations/subagents` itself, only while
  open and something runs, and keeps this turn's workers (`turnStartedAt`:
  the running turn's start, else the journal's last prompt), folding the rest.
- **`turns`** (last 50, oldest first: `n`, `messageId`, `startedAt`,
  `endedAt`, `prompt`, `running`) come from the conversation journal's
  `user` rows, so both providers and reloads work. A turn ends where the
  next starts; the last one is open while it runs, else ends at the first
  recorded end after it (`session_done` / `session_error` timestamps, kept in
  a `.ends.json` beside the journal because `merge()` hands every journal row
  to the chat), else the latest Claude result or journal row. Slash-command
  turns are not journalled, so they are not turns here. Membership is
  `inTurn(node, turn)`: started before the turn ended, AND running or ended
  (else last written) at or after it began.
- **The delegate report gate is not a fork**: it shares the fork log
  (`report gate · <role>`) and is returned apart as `gates`.
- **Claude's advisor has no checkpoints to light**: it is model-driven and
  its advice is encrypted, so the tree shows calls (logged from the stream's
  `advisor_tool_result` into `state/advisor/<sid>.claude.jsonl` from
  2026-09-30 on, main session only) and says so. The ChatGPT advisor's
  plan / stuck / done are real and lit.

## Terminal view (`server/public/terminal.js`)

A header button swaps the conversation for its own transcript, CLI-style:
prompts, text, thinking, every tool call and result, advisor consultations,
system lines, Jev decisions and ChatGPT-advisor consultations merged in by
time. Click a line for the raw entry. It tails the file every 2 s.
`server/raw-transcript.ts` pages by byte offset (tail / `before` / `after`),
returns only complete lines (a half-written one waits for the next poll),
cuts long strings and inline images, and reads at most 32 MB per page. The
transcript path is cached per conversation: finding a Claude one walks the
whole `projects/` tree.

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
- `src/adapters/subagents.ts` lists and reads them; the Agent tree lists them
  per turn and opens each one's history (the old "Cost & subagents" popup is
  retired). `agentId` is matched
  against the directory listing before use — it arrives from a query string, and
  pasting it into a path would let `../` escape the session.
- **Status comes from a Task's `tool_result`, not from mtime.** A `tool_use` and
  its later `tool_result` bracket the subagent, so a missing result means it
  never came back — running if the turn is live, stopped if it is not. Guessing
  from file mtime calls a subagent that is thinking hard "finished".
- **A background agent's `tool_result` is only its launch ack** ("Async agent
  launched…", `toolUseResult.status: async_launched`), and every one of them
  used to read ✓ done the moment it started. It ends in a later
  `<task-notification>` (`<task-id>` = agentId, `<tool-use-id>`, `<status>`
  completed / failed / killed / stopped / running, `<result>`), written up to
  three times -- a `queue-operation` enqueue, a `queued_command` attachment
  and a `user` message; only those three shapes count, since grep output and
  prose quote the tag too. A `stopped` one may carry no tool-use-id, so the
  ack's agentId is kept to match it. `claudeSubagentStatus`
  (`server/agent-tree.ts`) sets the contract: `running` (the process's
  `subagentRunning` says so, or an async agent not yet notified with a fresh
  transcript -- a finished parent turn is exactly when these keep going),
  `done` (a real result), `failed` (is_error, notification failed/killed),
  `stopped` ("[Request interrupted", notification stopped, or no result and
  not running), `ended` (finished, empty), `unknown`. Rows carry
  `parentAgentId` from a depth >= 2 meta; times stay epoch ms. Verified on
  this repo's own orchestrating transcript: 61 async agents, 58 done at their
  notification (45 s to 24 min after launch), 3 still running.
- **A nested subagent's result is in its SPAWNER's transcript, not the parent's**,
  and nesting is the common case: a real security scan here produced 90
  subagents, 80 of them depth 2 or 3. Reading only the parent reported all 80 as
  never having returned. The endpoint merges the Task records from the parent AND
  every subagent — the same scan already needed for per-subagent usage, so it
  costs no extra reads — which also yields `spawnedBy`.

- **Codex has native sub-agents too, and they are visible the same way.**
  `spawn_agent` gives the child its own rollout whose `session_meta` names the
  parent (`parent_thread_id`, plus `source.subagent.thread_spawn` with depth,
  nickname, role) and ends with `event_msg/task_complete {last_agent_message}`.
  The provider interface has optional `listSubagents` / `subagentStatus` /
  `readSubagentPage`, and the two endpoints dispatch on the adapter, not on
  `adapter.id`. Only the first line of each rollout is read to find children —
  and the WHOLE first line: a real `session_meta` is ~14KB of base_instructions,
  and an 8KB read silently skipped every child until a live check caught it.
  Cost is null on purpose: tokens are recorded, GPT prices are not in the table.
  **Those reads are incremental, and must stay so.** The panel polls the list
  every 5s while a turn runs; a UAT thread with 39 children (359MB of rollouts)
  once cost 41 store scans and a full re-read of every child PER POLL, all
  synchronous, and the gateway's event loop stayed blocked longer than the
  poll interval -- every request hung, verified with a CPU profile. Now a
  session_meta is read once per file for the life of the process, the store is
  scanned once per request (memo cleared on `setImmediate`), and
  `subagentStatus` folds only the bytes appended since its last call.
  `task_complete` is done only with a `last_agent_message`; empty is `ended`,
  and an `event_msg` `error` since `task_started` makes it `failed`.

## Workflow runs (`src/adapters/workflows.ts`)

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
- **Progress is the journal**, not mtime: `started` minus finished per agentId,
  where finished is a `result` OR a `failed` line (`{type:'failed', key,
  agentId}`). Ignoring `failed` left 10 of 15 real runs that had one
  "incomplete" forever. Runs carry `failed` and `live`; agents `failed` and
  `status` (running only while the run is live).
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
- Runs are shown in the **Agent tree** (a "Workflow run" branch whose agents
  open their own history via `workflow-history`). The floating island that
  used to show them was retired on 2026-09-30.
- `runId` and `agentId` both arrive from a query string and are matched against
  the directory listing before reaching a path.

## Token cost (`server/transcript-stats.ts`)

Every assistant entry carries `message.usage` and `message.model`, so what a
conversation or a subagent spent is **recorded, not estimated**. One incremental
pass collects both that and the Task outcomes above.

- **Scanning is incremental and cached** (`transcript_stats` in
  `state/gateway.sqlite`, one row per path, holding a byte offset + running
  totals; only entries that changed are written). Transcripts here reach 627MB;
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
  discarded rather than shown as if they were. v4 (2026-09-30) re-reads
  everything once so the async-agent fold above covers old transcripts.
- Dollars are **API list price for the same work**, not what Max billed (it is a
  flat subscription). An unpriced model is NAMED rather than blanking the figure;
  `<synthetic>` carries no tokens and is skipped.

## Gateway SQLite (`state/gateway.sqlite`)

The busiest whole-file JSON stores moved here (2026-10-01): each used to be
rewritten, and mostly re-parsed, on every change.

| table | was | notes |
|---|---|---|
| `transcript_stats` | `transcript-stats.json` (4.3 MB rewrite per scan) | per-path upsert of changed entries; old `CACHE_VERSION` rows and vanished transcripts dropped at load |
| `routing_history` | `routing-history.json` (2 fsyncs per routing event) | newest 3000 kept |
| `message_receipts` | `message-receipts.json` | 30 days or the newest 5000, whichever is more |
| `artifacts` | `artifacts.json` (re-parsed on every list/add) | `seq` = library order; `removed` stays a soft flag |

- `server/sqlite.ts` is the helper (WAL, `synchronous=NORMAL`, versioned
  migrations, refuses a newer `user_version`); `server/gateway-db.ts` holds ONE
  connection per state dir, which every store fetches per operation (the
  manager builds `RoutingState`/`ArtifactStore` per call). Closed on SIGTERM
  and `onModuleDestroy`; the next access reopens it.
- **Import / rollback rule.** At every open, an old JSON file that is present
  is imported in one transaction (upsert by key, the file wins), then renamed
  `<name>.migrated-<ts>` and kept. Rollback = rename it back and run the
  previous image (writes made since then stay only in the database). A file
  that does not parse at all is LEFT IN PLACE, logged, and not imported: the
  table is used as is. For receipts that means a request id known only to the
  broken file loses its duplicate-send guard. Only the rebuildable stats cache
  is set aside as `.corrupt-<ts>`. `legacy_imports` records each import.
- The offline backup/restore and recovery report (`project-spaces-recovery.ts`)
  include it as a database; the report reads `artifacts` read-only through
  SQLite, plus a legacy `artifacts.json` not yet imported.
- **`projects.json` deliberately stays JSON for now**: the recovery and
  migration tools fingerprint and read it raw, and ~114 call sites go through
  the registry.



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

## Notifications (`server/notices.ts`, 2026-10-01)

Three live days had pushed ~500 "finished - tap to continue" to both phones,
most of them relays and cron, while an approval, a parked turn and a failed
cron job pushed nothing. Now ONE function decides:
`noticeFor(event, ctx) -> { tier, category, title, body, link, tag, id }`.
The manager attaches it to each event as `notice`, so the push, the bell, the
sidebar dots and the desktop fallback all use the same words. Change copy or
tiers THERE, and keep `test/notices.test.ts` in step.

- **Tiers.** `urgent` (pushed even for automated turns): a question, an MCP
  approval while pending, a delegate `needs_human`, a parked turn with no
  reason (every account out) or `waiting_for_reset`, a failed turn (any
  origin but advisor/autopilot, which are `normal`), `cron_failed`.
  `normal`: a turn a HUMAN started that ran >= `LONG_TURN_MS` (45 s), an
  autopilot run's end (one per run, "after N steps"), a parked turn, the
  restart notice. `quiet` (bell + dot, no push): short turns, relays, cron,
  delegate wakes, advisor follow-ups, delegate progress, a failover that
  worked. `none`: stopped turns, autopilot steps, per-conversation
  `turn_orphaned` (collapsed into ONE `restart_interrupted` per boot, id
  `restart:<bootAt>`).
- **Origin** = the sender kind of the turn's request (`originOf`: none ->
  human, automation -> cron, conversation/mcp -> relay, ...), carried with
  `turnStartedAt`/`durationMs` on `session_done`, so it reaches
  `conversation_settled` through the completion gate unchanged.
- **Words.** Title = the conversation title, never "New chat" alone ("New
  chat · {project}"), 60 chars on a word. Body = `{project} · {provider}` on
  its own first line for a Work project, then what happened: duration + the
  cleaned reply (a closing question leads), the failure in plain words, the
  question, the approval preview. Tag `x056-conv-<sid>` (newer replaces
  older) or `x056-urgent-<id>`.
- **Presence.** Safari shows every push, so the gateway decides: the panel
  `POST /api/presence {clientId, projectId, sessionId, visible, endpoint}`
  on change and every 15 s while visible (30 s TTL, `server/presence.ts`).
  Nothing is pushed for a conversation some visible panel is showing; while
  any panel is visible, non-urgent pushes go only to that device.
- **Per device** (`push_settings`, keyed by a hash of the push endpoint):
  "Needs you" always on; "Finished long turns I started" (default on);
  "Automation and background" (default off: relays/cron/delegates stay
  quiet; on: pushed); quiet hours in the device's own zone, urgent included.
  `GET/POST /api/push/settings`, `POST /api/push/test` (this device only).
  Panel: Settings > Notifications (`/settings/notifications`).
- **Sent ids** live in `push_sent` (gateway.sqlite migration 3, 7 days), so
  a deploy does not resend. Pending questions older than 3 days are
  `stale` (still answerable, not counted by the bell); 14 days are purged at
  boot. The tab title shows "(N) " for what needs you; the app badge is the
  bell count.

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
