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
#
# A live WORKFLOW is different and blocks the swap with NO timeout. A killed turn
# resumes on the new container; a killed workflow's agents are gone, and someone
# has to notice and resume it by run id. One swap took out two runs mid-flight
# and neither conversation knew why it had stopped.
#
# This cannot wedge deploys forever: "live" means incomplete AND written to
# within the last 5 minutes, so a run that dies stops blocking on its own. To
# override deliberately, `touch .deploy/force` beside the request.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$DIR/.deploy/requested"
FORCE="$DIR/.deploy/force"
LOG="$DIR/.deploy/last.log"
STATUS="$DIR/.deploy/status.json"
MAX_DEFER=180   # seconds; brief idle-catch window, then swap even if a TURN runs

[ -f "$FLAG" ] || exit 0
mkdir -p "$DIR/.deploy"

# The container always listens on 4056; the published host port may differ on a
# second instance, and this script talks to the host side.
PORT="$(grep -oP '^X056_PORT=\K.*' "$DIR/.env" 2>/dev/null || true)"
PORT="${PORT:-4056}"

token() { grep -oP 'X056_TOKEN=\K.*' "$DIR/.env" 2>/dev/null || true; }

busy() {
  local t; t=$(token)
  [ -n "$t" ] || return 1
  curl -fsS -m 5 -H "Authorization: Bearer $t" "localhost:$PORT/api/sessions" 2>/dev/null | grep -q '"running":true'
}

# Echo a one-line summary of live workflow runs, or nothing at all when idle.
# A FAILED query echoes a sentinel rather than staying silent: "cannot tell"
# must never read as "nothing running", or an unreachable gateway would
# green-light exactly the swap this is here to prevent.
live_workflows() {
  local t out
  t=$(token)
  [ -n "$t" ] || { echo "no token - cannot check workflows"; return 0; }
  # Distinguish "this build has no such endpoint" from "the gateway is down".
  # Without that, installing this script before the endpoint ships would block
  # every deploy forever -- including the one that ships the endpoint.
  local code
  code=$(curl -s -o /tmp/x056-wf.$$ -w '%{http_code}' -m 10 \
    -H "Authorization: Bearer $t" "localhost:$PORT/api/workflows/live" 2>/dev/null || echo 000)
  out=$(cat /tmp/x056-wf.$$ 2>/dev/null || true); rm -f /tmp/x056-wf.$$
  if [ "$code" = "404" ]; then
    echo >&2 "note: gateway predates /api/workflows/live — not blocking on workflows"
    return 0
  fi
  if [ "$code" != "200" ]; then
    echo "workflow check FAILED (http $code)"
    return 0
  fi
  WF_JSON="$out" python3 -c '
import json, os, sys
try:
    runs = (json.loads(os.environ["WF_JSON"]).get("runs") or [])
except Exception:
    print("workflow check FAILED (unparseable)"); sys.exit(0)
if runs:
    head = "; ".join(
        "%s %s/%s" % (r.get("name") or r.get("runId"), r.get("finished"), r.get("started"))
        for r in runs[:4])
    print(head + (" (+%d more)" % (len(runs) - 4) if len(runs) > 4 else ""))
' 2>/dev/null || echo "workflow check FAILED (python error)"
}

{
  echo "=== tick $(date -Is) commit $(git -C "$DIR" rev-parse --short HEAD) ==="
  # 1. Build ahead of time — safe while a turn runs; only creates a new image.
  if ! docker compose --project-directory "$DIR" build; then
    rm -f "$FLAG" "$FORCE"
    printf '{"status":"build_failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "build FAILED — flag cleared"
    exit 0
  fi

  age=$(( $(date +%s) - $(stat -c %Y "$FLAG" 2>/dev/null || echo 0) ))

  # 2. A live fan-out blocks the swap outright — no MAX_DEFER escape hatch.
  if [ -f "$FORCE" ]; then
    echo "note: .deploy/force present — swapping even if workflows are live"
  else
    wf=$(live_workflows)
    if [ -n "$wf" ]; then
      echo "built OK; workflow runs still live — NOT swapping (pending ${age}s): $wf"
      echo "  (touch .deploy/force to override)"
      exit 0
    fi
  fi

  # 3. A running TURN only defers briefly: it resumes on the new container.
  if busy; then
    if [ "$age" -lt "$MAX_DEFER" ]; then
      echo "built OK; a turn is running — deferring swap (${age}s/${MAX_DEFER}s)"
      exit 0
    fi
    echo "built OK; deploy pending ${age}s (> ${MAX_DEFER}s) — swapping despite active turns; they resume on the new container"
  fi

  if docker compose --project-directory "$DIR" up -d; then
    rm -f "$FLAG" "$FORCE"
    printf '{"status":"ok","commit":"%s","ts":"%s"}\n' "$(git -C "$DIR" rev-parse --short HEAD)" "$(date -Is)" > "$STATUS"
    echo "deploy OK"
  else
    rm -f "$FLAG" "$FORCE"
    printf '{"status":"failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "swap FAILED — see above"
  fi
} >> "$LOG" 2>&1
