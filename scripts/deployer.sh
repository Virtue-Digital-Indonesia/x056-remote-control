#!/usr/bin/env bash
# Host-side deploy actuator. Runs from cron every minute (see install-deployer.sh).
# The gateway container can only REQUEST a deploy by touching .deploy/requested
# in the bind-mounted repo; this script (outside the container) performs the
# one fixed action: docker compose up -d --build — and only when no session is
# running, so it never kills an in-flight turn.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$DIR/.deploy/requested"
LOG="$DIR/.deploy/last.log"
STATUS="$DIR/.deploy/status.json"

[ -f "$FLAG" ] || exit 0

# Never interrupt a running session — retry on the next tick instead.
TOKEN=$(grep -oP 'X056_TOKEN=\K.*' "$DIR/.env" 2>/dev/null || true)
if [ -n "$TOKEN" ]; then
  if curl -fsS -m 5 -H "Authorization: Bearer $TOKEN" localhost:4056/api/sessions 2>/dev/null | grep -q '"running":true'; then
    exit 0
  fi
fi

mkdir -p "$DIR/.deploy"
{
  echo "=== deploy $(date -Is) at commit $(git -C "$DIR" rev-parse --short HEAD) ==="
  if docker compose --project-directory "$DIR" up -d --build; then
    rm -f "$FLAG"
    printf '{"status":"ok","commit":"%s","ts":"%s"}\n' "$(git -C "$DIR" rev-parse --short HEAD)" "$(date -Is)" > "$STATUS"
    echo "deploy OK"
  else
    rm -f "$FLAG" # don't loop forever on a broken build; status records the failure
    printf '{"status":"failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "deploy FAILED — see above"
  fi
} >> "$LOG" 2>&1
