#!/usr/bin/env bash
# Host-side deploy actuator. Runs from cron every minute (see install-deployer.sh).
# The gateway container can only REQUEST a deploy by touching .deploy/requested
# in the bind-mounted repo; this script (outside the container) performs the
# one fixed action: build the new image, then swap the container.
#
# Split build from swap: BUILD always (it doesn't touch the running container),
# but prefer to SWAP only when no turn is running so an in-flight turn isn't
# killed. HOWEVER, with parallel projects there may be no global-idle moment for
# a long time, which starves the swap forever. So bound the wait: if the request
# has been pending longer than MAX_DEFER, swap anyway — killed turns are
# recoverable (orphan-resume cards + autopilot auto-resume on the new container).
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$DIR/.deploy/requested"
LOG="$DIR/.deploy/last.log"
STATUS="$DIR/.deploy/status.json"
MAX_DEFER=180   # seconds; brief idle-catch window, then swap even if busy

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
  # 2. Prefer to swap at idle; but don't let parallel projects starve it forever.
  age=$(( $(date +%s) - $(stat -c %Y "$FLAG" 2>/dev/null || echo 0) ))
  if busy; then
    if [ "$age" -lt "$MAX_DEFER" ]; then
      echo "built OK; a turn is running — deferring swap (${age}s/${MAX_DEFER}s)"
      exit 0
    fi
    echo "built OK; deploy pending ${age}s (> ${MAX_DEFER}s) — swapping despite active turns; they resume on the new container"
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
