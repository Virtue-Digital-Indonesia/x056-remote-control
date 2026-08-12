# x056 — Claude Code Remote Control

A self-hosted **remote control for Claude Code** with **automatic failover across two or more Claude Max accounts**. A supervisor drives headless `claude -p` sessions and, when the active account hits its usage limit, transparently respawns the *same* session under the next available account — so one continuous conversation survives the switch. A NestJS gateway + a single-file browser panel expose it anywhere: parallel projects, multiple concurrent conversations, live activity, a prompt queue, passkey login, and a mobile PWA.

> Each user runs **their own** Claude accounts (two or more). This is an orchestrator for accounts you own, not a way to share one.

---

## Features

- **N-account failover** — a rate-limit on the active account resumes the same session on the next available account, mid-conversation, no lost context. **Two or more** accounts; add or remove them from the panel at any time, and see which one the next prompt will use.
- **Projects** — add any repo under your workspace as a project; projects run in parallel.
- **Concurrent conversations per project** — grouped under the project in the sidebar, renamable, each its own Claude session. Different conversations of the same project run **independently and at the same time**, each with its own composer draft and queue.
- **Prompt queue** — send a follow-up while that conversation's turn is running; it's queued (editable, cancelable) and sent the moment that conversation is free.
- **Autopilot** — keeps a project working across turns/restarts without you re-prompting it each time.
- **Attach any file** — drag-and-drop, paste, or pick files of any type (images, PDFs, code, logs, …); Claude reads them from disk with its Read tool.
- **Live activity + notifications** — see the current tool call / subagent count / active model + account per running conversation, plus a sidebar bell when a chat you're not watching finishes, fails, or asks a question.
- **Session resume** — adopt an existing interactive `claude` session (run outside the panel) into the panel to keep steering it remotely.
- **Passkeys** (WebAuthn) — Face ID / Touch ID login on top of a bootstrap access token.
- **Mobile PWA** — installable to your phone's home screen, with push notifications when a turn needs your input.
- **Isolated Docker-in-Docker** — a project's own `docker`/compose e2e works from inside a session without touching the host daemon.

## How it works (one paragraph)

The gateway spawns `claude -p --output-format stream-json --resume <id>` under a per-account `CLAUDE_CONFIG_DIR`. All accounts point at **one shared `projects/` transcript tree**, so `--resume <id>` works no matter which account runs. A detector watches the stream for genuine rate-limit rejections and flips to the next usable account. Turns stream to the panel over SSE, tagged by conversation so parallel work stays isolated; state lives in a Docker volume (`state/`).

---

## Using the panel

**Projects & conversations.** The **+** next to "Projects" in the sidebar adds a repo from your workspace. Click a project to switch to it; its conversations list expands underneath (rename with ✎, remove with ×, or start a fresh one with **+ New conversation**). Conversations run **concurrently** — several conversations of the same project (and other projects) can be working at once; each running one shows its own spinner in the sidebar, and any you're not currently viewing appear in a live strip above the composer, one tap away.

**Sending messages.** Type in the composer, pick a model/effort if you want something other than the project's default, optionally **attach files of any type** (paperclip, paste, or drag-and-drop onto the window), and hit send (⏎, or ⇧⏎ for a newline). Each conversation keeps its **own** unsent draft, so switching chats never carries text over. If *that conversation's* turn is already running, your message queues (edit/cancel it from the queue bar) and sends when it's free; sending to an idle conversation starts immediately, even while a sibling conversation runs.

**Accounts.** The chip at the bottom-left shows the account the next prompt will use ("sends next") and opens the accounts panel: each account's quota, a **"next up"** marker, a **remove** (×) button, **+ Add account** to onboard another (sign in via the link, paste the code back), and **Force-switch active account** to move off the current one before it's rate-limited.

**Stopping.** The busy indicator (above the composer) has a **Stop** button that stops **only the conversation you're viewing** — sibling conversations keep running.

**Autopilot.** Toggle it (repeat icon) to keep a project working on its current task across multiple turns/restarts, without you having to re-send "continue" each time.

**Notifications.** Enable them (bell icon) to get a push notification when a project asks a question or Autopilot finishes — useful once you close the tab or lock your phone.

**Resuming an existing session.** If you (or a colleague) already have an interactive `claude` session going outside the panel, the history icon lets you adopt it, so you can keep driving it from the browser.

**Passkeys.** Register a device once (key icon) to log in with Face ID / Touch ID afterward instead of the access token.

**Theme.** The theme icon (in the ⋯ menu) cycles **follow your device → light → dark**. It follows your device by default, including live changes like a sunset schedule.

**Install as an app.** On mobile, "Add to Home Screen" installs the panel as a PWA — full-screen, with the safe-area-aware layout and push notifications.

### Keyboard shortcuts

Press **⌘/** (Ctrl+/ on Windows/Linux), or the ⌨️ icon in the top bar, to open the in-app shortcuts reference any time. On Windows/Linux, ⌘ is Ctrl and ⌥ is Alt.

| Shortcut | Action |
| --- | --- |
| **⌘K** | Quick switch — fuzzy-jump to any project or conversation |
| **⌘1 … ⌘9** | Jump to the 1st–9th project |
| **⌥N** | New conversation in the current project |
| **⌥M** | Open the model selector |
| **⌥E** | Open the effort selector |
| **⌥U** | Attach a file |
| **Enter** / **⇧Enter** | Send / new line |
| **⌘/** | Show the shortcuts help |
| **Esc** | Close a dialog, menu, or the quick switcher |

---

## Connect from another MCP client

The gateway is itself an **MCP server**, so Claude Desktop, another Claude Code, or
any MCP client can read and drive the conversations running here. It speaks the
standard **Streamable HTTP** transport at `/mcp`:

```
https://<your-host>/mcp
```

Auth is the gateway's own token, either as a header or in the URL — use whichever
your client supports:

```bash
# Claude Code (or anything that can set a header)
claude mcp add --transport http x056 https://<your-host>/mcp \
  --header "Authorization: Bearer $X056_TOKEN"

# clients that can't set headers (paste the URL as-is)
https://<your-host>/mcp?token=<X056_TOKEN>
```

**Claude Desktop / claude.ai connectors** don't accept a token at all — they
require OAuth. The gateway is its own authorization server, so just give them
the bare URL (`https://<your-host>/mcp`): the client registers itself, you get
an approval page, and approving requires being **signed in to the x056 panel in
that browser**. That login is the gate.

Claude Desktop can also run the bridge locally over stdio, in
`claude_desktop_config.json`:

```json
{ "mcpServers": { "x056": {
  "command": "node",
  "args": ["/path/to/x056-remote-control/scripts/x056-mcp.mjs"],
  "env": { "X056_URL": "https://<your-host>", "X056_TOKEN": "<token>" }
} } }
```

`x056-mcp.mjs` imports `x056-mcp-tools.mjs` beside it — keep the pair together
(clone the repo, or copy both), and use Node 18+ for built-in `fetch`.

Tools: `list_projects`, `list_conversations`, `read_conversation`, `send_message`.
Both transports share one implementation, so they always expose the same set.

**`send_message` has two modes**, chosen by you in the MCP servers panel (never
by the calling AI — otherwise the gate would be self-bypassable):

- **Approval** (default) — every cross-conversation send waits for your click.
- **Automatic** — sends are delivered straight away.

Either way, if the target conversation is mid-turn the message goes on **its
queue** and is delivered when that turn ends. A queued message always takes
priority over an autopilot continuation; autopilot resumes once the queue is
empty. See [Cross-conversation messaging](#using-the-panel).

> The token grants full control of the gateway. Prefer the header form where you
> can — a token in a URL tends to end up in proxy logs and browser history.
> `?token=` exists for clients that offer no other way.

---

## Deploying your own instance

### Prerequisites

- **Docker + Docker Compose** on a Linux host.
- **Node 20+ and npm** (for the one-time setup CLI).
- The **`claude` CLI** ([Claude Code](https://claude.com/claude-code)) on PATH.
- **Two or more Claude accounts** (Max recommended) you can log into — failover needs at least two; more accounts extend how long you can run before every account is limited.
- A **reverse proxy with TLS** (nginx/Caddy) in front — the container binds to `127.0.0.1:4056` only; passkeys and secure cookies require HTTPS.

### Setup

```bash
git clone git@github.com:Virtue-Digital-Indonesia/x056-remote-control.git
cd x056-remote-control
npm ci

cp .env.example .env      # then edit the paths + X056_RP_ID for your host
bash scripts/setup.sh     # generates the token, logs in your accounts, writes config
```

`scripts/setup.sh` is re-runnable and walks you through the initial two accounts: it generates `X056_TOKEN`, runs `claude /login` for each account dir, checks they're actually different, wires the shared transcript tree, and writes `state/accounts.json`. See [`.env.example`](.env.example) for every setting.

#### Adding / removing accounts (2, 3, 4, …)

The easiest way to add a **third or fourth** account is right from the panel — no redeploy: open the accounts chip (bottom-left) → **+ Add account** → sign in with the new account via the link → paste the code back. It's stored in the state volume and joins the failover pool immediately. Remove any account there too (× on its card).

To **bootstrap more than two at init time**, set `X056_ACCOUNT_DIRS` in `.env` to a comma-separated list of config dirs (named `a`, `b`, `c`, …) instead of the `X056_ACCOUNT_A_DIR`/`_B_DIR` pair, log each in, and run the wizard. To **re-log** an existing account, point `CLAUDE_CONFIG_DIR` at its dir and `claude /login` again.

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
