# x056 — Claude Code Remote Control

A self-hosted **remote control for Claude Code** with **automatic failover between two Claude Max accounts**. A supervisor drives headless `claude -p` sessions and, when the active account hits its usage limit, transparently respawns the *same* session under the other account — so one continuous conversation survives the switch. A NestJS gateway + a single-file browser panel expose it anywhere: parallel projects, multiple grouped conversations, live activity, a prompt queue, passkey login, and a mobile PWA.

> Each user runs **their own** two Claude accounts. This is an orchestrator for accounts you own, not a way to share one.

---

## Features

- **Account failover** — a rate-limit on account A resumes the same session on account B, mid-conversation, no lost context.
- **Projects** — add any repo under your workspace as a project; each runs its own turn independently (parallel work across projects).
- **Multiple conversations per project** — grouped under the project in the sidebar, renamable, each its own Claude session you can jump between.
- **Prompt queue** — send a follow-up while a turn is still running; it's queued (editable, cancelable) and sent the moment the turn finishes.
- **Autopilot** — keeps a project working across turns/restarts without you re-prompting it each time.
- **Multi-image upload** — attach one or more screenshots/images to a message.
- **Live activity** — see the current tool call / subagent count / active model + account while a turn runs, for every project (not just the one you're viewing).
- **Session resume** — adopt an existing interactive `claude` session (run outside the panel) into the panel to keep steering it remotely.
- **Passkeys** (WebAuthn) — Face ID / Touch ID login on top of a bootstrap access token.
- **Mobile PWA** — installable to your phone's home screen, with push notifications when a turn needs your input.
- **Isolated Docker-in-Docker** — a project's own `docker`/compose e2e works from inside a session without touching the host daemon.

## How it works (one paragraph)

The gateway spawns `claude -p --output-format stream-json --resume <id>` under a per-account `CLAUDE_CONFIG_DIR`. Both accounts point at **one shared `projects/` transcript tree**, so `--resume <id>` works no matter which account runs. A detector watches the stream for genuine rate-limit rejections and flips the active account. Turns stream to the panel over SSE; state lives in a Docker volume (`state/`).

---

## Using the panel

**Projects & conversations.** The **+** next to "Projects" in the sidebar adds a repo from your workspace. Click a project to switch to it; its conversations list expands underneath (rename with ✎, remove with ×, or start a fresh one with **+ New conversation**). One turn runs per project at a time — a project busy elsewhere shows a spinner in the sidebar and a live strip above the composer, and you can jump straight to it.

**Sending messages.** Type in the composer, pick a model/effort if you want something other than the project's default, optionally attach images (paperclip, or just paste), and hit send (⏎, or ⇧⏎ for a newline). If a turn is already running in that conversation, your message queues instead of erroring — edit or cancel it from the queue bar above the composer any time before it fires.

**Stopping / switching accounts.** The busy indicator (top of the thread) has a **Stop** button for the running turn. The account-usage chip (bottom left) shows both accounts' quota and has a **Force-switch active account** button if you want to move off the current one before it's actually rate-limited.

**Autopilot.** Toggle it (repeat icon) to keep a project working on its current task across multiple turns/restarts, without you having to re-send "continue" each time.

**Notifications.** Enable them (bell icon) to get a push notification when a project asks a question or Autopilot finishes — useful once you close the tab or lock your phone.

**Resuming an existing session.** If you (or a colleague) already have an interactive `claude` session going outside the panel, the history icon lets you adopt it, so you can keep driving it from the browser.

**Passkeys.** Register a device once (key icon) to log in with Face ID / Touch ID afterward instead of the access token.

**Install as an app.** On mobile, "Add to Home Screen" installs the panel as a PWA — full-screen, with the safe-area-aware layout and push notifications.

---

## Deploying your own instance

### Prerequisites

- **Docker + Docker Compose** on a Linux host.
- **Node 20+ and npm** (for the one-time setup CLI).
- The **`claude` CLI** ([Claude Code](https://claude.com/claude-code)) on PATH.
- **Two Claude accounts** (Max recommended) you can log into.
- A **reverse proxy with TLS** (nginx/Caddy) in front — the container binds to `127.0.0.1:4056` only; passkeys and secure cookies require HTTPS.

### Setup

```bash
git clone git@github.com:Virtue-Digital-Indonesia/x056-remote-control.git
cd x056-remote-control
npm ci

cp .env.example .env      # then edit the paths + X056_RP_ID for your host
bash scripts/setup.sh     # generates the token, logs in both accounts, writes config
```

`scripts/setup.sh` is re-runnable and walks you through everything: it generates `X056_TOKEN`, runs `claude /login` for each account dir, checks the two accounts are actually different, wires the shared transcript tree, and writes `state/accounts.json`. See [`.env.example`](.env.example) for every setting.

#### Adding / changing accounts

Accounts are two config dirs, set in `.env` (`X056_ACCOUNT_A_DIR`, `X056_ACCOUNT_B_DIR`). To (re)log an account, just point `CLAUDE_CONFIG_DIR` at its dir and log in, then re-run the wizard:

```bash
CLAUDE_CONFIG_DIR="$X056_ACCOUNT_A_DIR" claude /login
bash scripts/setup.sh
```

### Run

```bash
docker compose up -d
```

Then point your TLS reverse proxy at `127.0.0.1:4056` and set `X056_RP_ID` (in `.env`) to that public hostname. Open the panel, enter the token once, then register a passkey (🔑 in the top bar) for Face ID / Touch ID logins.

### Develop

```bash
npm test          # vitest (serialized)
npm run typecheck # tsc --noEmit
```

The panel (`server/public/panel.html`) is a single file, bind-mount live-served — edits appear on refresh, no rebuild. Backend changes (`server/`, `src/`, `Dockerfile`, `compose.yaml`) need `docker compose up -d --build`.

### Security notes

- `.env`, `state/`, and account credentials are gitignored — **never commit them**.
- The panel is auth-gated: a passkey session cookie **or** the `X056_TOKEN` (fallback). Keep the token secret; rotate it by changing `.env` and recreating the container.
- The container publishes only to loopback; exposure is via your TLS proxy on the domain, not the raw host IP.

## License

Internal tool — see your organization's terms.
