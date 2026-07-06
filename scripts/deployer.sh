#!/usr/bin/env bash
# Host-side deploy actuator. Runs from cron every minute (see install-deployer.sh).
# The gateway container can only REQUEST a deploy by touching .deploy/requested
# in the bind-mounted repo; this script (outside the container) performs the
# one fixed action: build the new image, then swap the container.
#
# Split build from swap: BUILD always (it doesn't touch the running container),
# but SWAP only when no turn is running — so the idle window a deploy needs is
# seconds (recreate) not minutes (build). Without this, the control session
# driving the deploy is ~always mid-turn and starves the swap forever.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$DIR/.deploy/requested"
LOG="$DIR/.deploy/last.log"
STATUS="$DIR/.deploy/status.json"

[ -f "$FLAG" ] || exit 0
mkdir -p "$DIR/.deploy"

busy() {
  local token
  token=$(grep -oP 'X056_TOKEN=\K.*' "$DIR/.env" 2>/dev/null || true)
  [ -n "$token" ] || return 1
  curl -fsS -m 5 -H "Authorization: Bearer $token" localhost:4056/api/sessions 2>/dev/null | grep -q '"running":true'
}

{
  echo "=== tick $(date -Is) commit $(git -C "$DIR" rev-parse --short HEAD) ==="
  # 1. Build ahead of time — safe while a turn runs; only creates a new image.
  if ! docker compose --project-directory "$DIR" build; then
    rm -f "$FLAG"
    printf '{"status":"build_failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "build FAILED — flag cleared"
    exit 0
  fi
  # 2. Swap only when idle, so an in-flight turn is never killed. Keep the flag
  #    and retry next tick otherwise — the built image is cached, so the swap is
  #    near-instant once a gap appears.
  if busy; then
    echo "built OK; a turn is running — deferring swap"
    exit 0
  fi
  if docker compose --project-directory "$DIR" up -d; then
    rm -f "$FLAG"
    printf '{"status":"ok","commit":"%s","ts":"%s"}\n' "$(git -C "$DIR" rev-parse --short HEAD)" "$(date -Is)" > "$STATUS"
    echo "deploy OK"
  else
    rm -f "$FLAG"
    printf '{"status":"failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "swap FAILED — see above"
  fi
} >> "$LOG" 2>&1
