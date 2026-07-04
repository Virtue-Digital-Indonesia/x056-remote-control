# X056 Gateway — Access Guide

## What this is

The x056 gateway is a self-hosted "remote control" for Claude Code with automatic
failover between two Claude Max accounts. A supervisor process drives headless
`claude -p --output-format stream-json` sessions and, when the active account
hits its usage limit, respawns `claude -p --resume <session-id>` under the
other account's `CLAUDE_CONFIG_DIR` (the two accounts share the same
`projects/` tree), so one continuous session survives the switch. It exposes a
small HTTP API plus a single-page control panel, both protected by a bearer
token, so you can drive Claude Code sessions from a browser or script on any
machine that can reach the host.

It runs as a single Docker Compose service (`x056`) built from the
`Dockerfile` in this repo, listening on port `4056`.

## Running it

Build and start (or rebuild after a code change):

```bash
docker compose up -d --build
```

Check status / logs:

```bash
docker compose ps
docker compose logs -f x056
```

Stop:

```bash
docker compose down
```

## First-time setup: the access token

The gateway refuses to start without `X056_TOKEN` set in the environment.
Generate one into a local `.env` file (never commit this file — it's in
`.gitignore`):

```bash
echo "X056_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d --build
```

Compose reads `.env` automatically and injects `X056_TOKEN` into the
container. Keep the value handy — it's the only credential you need to use
the gateway.

## Using the panel

Browse to `http://<server-ip>:4056/` and paste the token when prompted. The
panel talks to the same API described below, over the same port.

`GET /healthz` is unauthenticated and returns `{"ok":true}` once the process
is up — useful for container healthchecks and quick liveness checks.

## API surface

All `/api/*` routes require the token, either as a bearer header or a `token`
query parameter (handy for the SSE stream, where setting headers is awkward
from a browser `EventSource`):

```
Authorization: Bearer <token>
```
or
```
?token=<token>
```

Examples (replace `$TOKEN` with the value from `.env`):

Start a new session:

```bash
curl -sS -X POST localhost:4056/api/sessions \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "list files in this repo", "cwd": "/home/efran/remote-development/x056-remote-control"}'
```

Continue the current session with another message:

```bash
curl -sS -X POST localhost:4056/api/sessions/current/messages \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt": "now summarize what you found"}'
```

Stream events for the current session (Server-Sent Events):

```bash
curl -N "localhost:4056/api/sessions/current/stream?token=$TOKEN"
```

List known sessions:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" localhost:4056/api/sessions
```

List accounts and their live quota/state:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" localhost:4056/api/accounts
```

Force an account switch (e.g. to test failover, or recover from a stuck
session):

```bash
curl -sS -X POST -H "Authorization: Bearer $TOKEN" localhost:4056/api/switch
```

## State locations

- **Account config dirs** (host paths, bind-mounted read/write into the
  container at the same path): `~/.claude-x056-a` and `~/.claude-x056-b`.
  These hold each Claude Max account's credentials and Claude Code config —
  never `cat` or otherwise print their contents.
- **Session transcripts**: under each account's config dir, e.g.
  `~/.claude-x056-a/projects/...` — since both accounts share the same
  `CLAUDE_CONFIG_DIR`-relative `projects/` layout, a resumed session's
  transcript is visible to whichever account is currently active.
- **Gateway state** (account registry, session bookkeeping): the named Docker
  volume `x056-state`, mounted at `/app/state` in the container. This starts
  empty on a fresh deployment — `/api/accounts` returns a controlled error
  until the setup step that populates `state/accounts.json` has been run.
- **Workspace**: the host's `~/remote-development` tree is bind-mounted at the
  same path inside the container (`X056_WORKSPACE_ROOT`), so sessions can
  operate on real project directories.

## Security

The bearer token is the **only** lock on what is otherwise a plaintext HTTP
port exposed to the network. Treat it like a password: don't commit it,
don't log it, don't share it outside a secure channel. Recommended
hardening for anything beyond a trusted LAN:

- **UFW allowlist** — restrict inbound `4056/tcp` to known source IPs:
  ```bash
  sudo ufw allow from <trusted-ip> to any port 4056 proto tcp
  ```
- **Tailscale** — bind the published port to the host's Tailscale interface
  address instead of all interfaces, so the service is only reachable over
  the tailnet:
  ```yaml
  ports:
    - "100.x.y.z:4056:4056"
  ```

**Token rotation**: edit `.env` with a new value, then re-apply:

```bash
echo "X056_TOKEN=$(openssl rand -hex 32)" > .env
docker compose up -d
```

Compose will recreate the container with the new token; any previously
issued token stops working immediately.
