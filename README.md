# x056 — Claude Code Remote Control

A self-hosted **remote control for Claude Code** with **automatic failover between two Claude Max accounts**. A supervisor drives headless `claude -p` sessions and, when the active account hits its usage limit, transparently respawns the *same* session under the other account — so one continuous conversation survives the switch. A NestJS gateway + a single-file browser panel expose it anywhere, with parallel projects, multiple grouped conversations, live activity, a prompt queue, passkey login, and a mobile PWA.

> Each user runs **their own** two Claude accounts. This is an orchestrator for accounts you own, not a way to share one.

---

## What you get

- **Account failover** — a rate-limit on account A resumes the same session on account B, mid-conversation.
- **Browser panel** — run/steer sessions from any device; install to your phone's home screen (PWA) with Face ID / Touch ID (passkey) login.
- **Parallel projects** — many repos, each running a turn concurrently.
- **Multiple conversations per project**, grouped and renamable.
- **Prompt queue** (edit/cancel), **autopilot** (keeps working across turns/restarts), **image uploads**, live **activity + model** view, copy buttons, timestamps.
- **Isolated Docker-in-Docker** so a project's own `docker`/compose e2e works without touching the host daemon.

## How it works (one paragraph)

The gateway spawns `claude -p --output-format stream-json --resume <id>` under a per-account `CLAUDE_CONFIG_DIR`. Both accounts point at **one shared `projects/` transcript tree**, so `--resume <id>` works no matter which account runs. A detector watches the stream for genuine rate-limit rejections and flips the active account. Turns stream to the panel over SSE; state lives in a Docker volume (`state/`).

---

## Prerequisites

- **Docker + Docker Compose** on a Linux host.
- **Node 20+ and npm** (for the one-time setup CLI).
- The **`claude` CLI** ([Claude Code](https://claude.com/claude-code)) on PATH.
- **Two Claude accounts** (Max recommended) you can log into.
- A **reverse proxy with TLS** (nginx/Caddy) in front — the container binds to `127.0.0.1:4056` only; passkeys and secure cookies require HTTPS.

## Setup

```bash
git clone git@github.com:Virtue-Digital-Indonesia/x056-remote-control.git
cd x056-remote-control
npm ci

cp .env.example .env      # then edit the paths + X056_RP_ID for your host
bash scripts/setup.sh     # generates the token, logs in both accounts, writes config
```

`scripts/setup.sh` is re-runnable and walks you through everything: it generates `X056_TOKEN`, runs `claude /login` for each account dir, checks the two accounts are actually different, wires the shared transcript tree, and writes `state/accounts.json`. See [`.env.example`](.env.example) for every setting.

### Adding / changing accounts

Accounts are two config dirs, set in `.env` (`X056_ACCOUNT_A_DIR`, `X056_ACCOUNT_B_DIR`). To (re)log an account, just point `CLAUDE_CONFIG_DIR` at its dir and log in, then re-run the wizard:

```bash
CLAUDE_CONFIG_DIR="$X056_ACCOUNT_A_DIR" claude /login
bash scripts/setup.sh
```

## Run

```bash
docker compose up -d
```

Then point your TLS reverse proxy at `127.0.0.1:4056` and set `X056_RP_ID` (in `.env`) to that public hostname. Open the panel, enter the token once, then register a passkey (🔑 in the top bar) for Face ID / Touch ID logins.

## Develop

```bash
npm test          # vitest (serialized)
npm run typecheck # tsc --noEmit
```

The panel (`server/public/panel.html`) is a single file, bind-mount live-served — edits appear on refresh, no rebuild. Backend changes (`server/`, `src/`, `Dockerfile`, `compose.yaml`) need `docker compose up -d --build`.

## Security notes

- `.env`, `state/`, and account credentials are gitignored — **never commit them**.
- The panel is auth-gated: a passkey session cookie **or** the `X056_TOKEN` (fallback). Keep the token secret; rotate it by changing `.env` and recreating the container.
- The container publishes only to loopback; exposure is via your TLS proxy on the domain, not the raw host IP.

## License

Internal tool — see your organization's terms.
