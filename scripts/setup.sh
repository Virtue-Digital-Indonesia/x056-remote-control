#!/usr/bin/env bash
#
# First-run setup wizard for x056-remote-control.
#   - creates .env (from .env.example) and a strong X056_TOKEN if missing
#   - logs in your two Claude accounts (interactive `claude /login`)
#   - verifies they're DIFFERENT accounts (failover is pointless otherwise)
#   - wires the shared transcript tree and writes state/accounts.json
#
# Prereqs: node + npm, the `claude` CLI on PATH, and `npm ci` already run.
# Re-runnable: skips steps that are already done.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# 1. .env
if [ ! -f .env ]; then
  cp .env.example .env
  say "Created .env from .env.example."
  echo "  Edit the paths in .env (X056_WORKSPACE_ROOT, X056_ACCOUNT_*_DIR, X056_PANEL_PATH, X056_RP_ID),"
  echo "  then run this script again."
  exit 0
fi
set -a; . ./.env; set +a

# 2. token
if [ -z "${X056_TOKEN:-}" ]; then
  TOK="$(openssl rand -hex 32)"
  if grep -q '^X056_TOKEN=' .env; then
    tmp="$(mktemp)"; sed "s|^X056_TOKEN=.*|X056_TOKEN=${TOK}|" .env > "$tmp" && mv "$tmp" .env
  else
    printf 'X056_TOKEN=%s\n' "$TOK" >> .env
  fi
  X056_TOKEN="$TOK"
  say "Generated X056_TOKEN into .env."
fi

A="${X056_ACCOUNT_A_DIR:-$HOME/.claude-x056-a}"
B="${X056_ACCOUNT_B_DIR:-$HOME/.claude-x056-b}"

# 3. logins
command -v claude >/dev/null || { echo "ERROR: the 'claude' CLI is not on PATH — install Claude Code first."; exit 1; }
for d in "$A" "$B"; do
  mkdir -p "$d"
  if [ -f "$d/.credentials.json" ]; then
    echo "Already logged in: $d"
  else
    say "Logging in the account for: $d"
    echo "  A login prompt (browser/code) will appear. Use a DIFFERENT Claude account than the other dir."
    CLAUDE_CONFIG_DIR="$d" claude /login
  fi
done

# 4. verify DISTINCT accounts
say "Verifying the two accounts are different…"
python3 - "$A" "$B" <<'PY'
import json, sys, urllib.request
emails = []
for d in sys.argv[1:3]:
    tok = json.load(open(d + '/.credentials.json'))['claudeAiOauth']['accessToken']
    req = urllib.request.Request('https://api.anthropic.com/api/oauth/profile',
        headers={'Authorization': 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20'})
    emails.append(json.load(urllib.request.urlopen(req, timeout=20))['account']['email'])
print(f"  account a: {emails[0]}\n  account b: {emails[1]}")
if emails[0] == emails[1]:
    sys.exit("ERROR: both config dirs are logged into the SAME account — failover needs two.")
PY

# 5. one shared transcript tree so a resumed session survives an account switch
mkdir -p "$A/projects"
if [ -e "$B/projects" ] && [ ! -L "$B/projects" ]; then
  cp -a --update=none "$B/projects/." "$A/projects/" 2>/dev/null || true
  rm -rf "$B/projects"
fi
[ -e "$B/projects" ] || ln -s "$A/projects" "$B/projects"

# 6. write state/accounts.json
export X056_ACCOUNT_A_DIR="$A" X056_ACCOUNT_B_DIR="$B"
npm run x056 -- init
npm run x056 -- status

say "Setup OK."
echo "  Start it:   docker compose up -d   (then point your reverse proxy/TLS at 127.0.0.1:4056)"
