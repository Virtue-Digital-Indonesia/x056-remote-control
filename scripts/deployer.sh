#!/usr/bin/env bash
# Host-side deploy actuator. Runs from cron every minute (see install-deployer.sh).
# The gateway container can only REQUEST a deploy by touching .deploy/requested
# in the bind-mounted repo; this script (outside the container) performs the
# one fixed action: build the new image, then swap the container.
#
# Builds may run alongside agents. Swaps wait indefinitely for idle unless an
# operator explicitly authorizes interruption via .deploy/force.
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FLAG="$DIR/.deploy/requested"
FORCE="$DIR/.deploy/force"
LOG="$DIR/.deploy/last.log"
STATUS="$DIR/.deploy/status.json"
# Idle is mandatory unless the operator explicitly supplies a force flag.
IDLE_ONLY=1
[ ! -f "$FORCE" ] || IDLE_ONLY=0
# A durable per-request setting also applies to the regular host cron runner.
[ ! -f "$DIR/.deploy/idle-only" ] || IDLE_ONLY=1

[ -f "$FLAG" ] || exit 0
mkdir -p "$DIR/.deploy"

# A delayed release must not silently deploy later edits from the shared checkout.
release_unchanged() {
  [ ! -f "$DIR/.deploy/revision" ] || {
    [ "$(git -C "$DIR" rev-parse HEAD)" = "$(cat "$DIR/.deploy/revision")" ] &&
      git -C "$DIR" diff --quiet HEAD --
  }
}
if ! release_unchanged; then
  echo "$(date -Is) pinned release changed — request remains pending" >> "$LOG"
  exit 0
fi

# The container always listens on 4056; the published host port may differ on a
# second instance, and this script talks to the host side.
PORT="$(grep -oP '^X056_PORT=\K.*' "$DIR/.env" 2>/dev/null || true)"
PORT="${PORT:-4056}"

token() { grep -oP 'X056_TOKEN=\K.*' "$DIR/.env" 2>/dev/null || true; }

busy() {
  local t; t=$(token)
  if [ "$IDLE_ONLY" = 1 ]; then
    [ -n "$t" ] || return 0 # Unable to check is busy, never permission to swap.
    local snapshot
    snapshot=$(curl -fsS -m 5 -H "Authorization: Bearer $t" "localhost:$PORT/api/sessions" 2>/dev/null) || return 0
    # Persistent providers may outlive their turn. Let them expire naturally.
    if ACTIVITY_JSON="$snapshot" python3 -c '
import json, os, sys
try:
    value = json.loads(os.environ["ACTIVITY_JSON"])
    idle = (value["running"] is False and value["runningProjects"] == []
            and value["backgroundProjects"] == [])
except Exception:
    idle = False
sys.exit(0 if idle else 1)
' 2>/dev/null; then return 1; else return 0; fi
  fi
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
    if [ "$IDLE_ONLY" = 1 ]; then
      echo "workflow check unavailable — idle-only release stays pending"
      return 0
    fi
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
    value = json.loads(os.environ["WF_JSON"])
    runs = value["runs"]
    if not isinstance(runs, list): raise ValueError("missing workflow list")
except Exception:
    print("workflow check FAILED (unparseable)"); sys.exit(0)
if runs:
    head = "; ".join(
        "%s %s/%s" % (r.get("name") or r.get("runId"), r.get("finished"), r.get("started"))
        for r in runs[:4])
    print(head + (" (+%d more)" % (len(runs) - 4) if len(runs) > 4 else ""))
' 2>/dev/null || echo "workflow check FAILED (python error)"
}

# Schema releases opt in to an offline snapshot immediately before the swap.
# The helper runs only the recovery CLI from the new image, never a second server.
PREVIOUS_CONTAINER=""
resume_previous() {
  if [ -n "$PREVIOUS_CONTAINER" ]; then
    docker start "$PREVIOUS_CONTAINER" >/dev/null || echo "previous container could not restart — inspect host Docker"
  fi
}
backup_project_spaces() {
  [ -f "$DIR/.deploy/backup-project-spaces" ] || return 0
  [ "$IDLE_ONLY" = 1 ] || { echo "Project backup requires an idle-only request"; return 1; }
  local container image backup_dir
  container=$(docker compose --project-directory "$DIR" ps -q x056)
  [ -n "$container" ] || { echo "No running gateway to snapshot"; return 1; }
  image=$(docker compose --project-directory "$DIR" config --format json | python3 -c \
    'import json,sys; c=json.load(sys.stdin); print(c["services"]["x056"].get("image") or c["name"]+"-x056")') || return 1
  [ -n "$image" ] || return 1
  # Check again immediately before stopping writers; build and inspection may be slow.
  if [ -n "$(live_workflows)" ] || busy; then
    echo "activity changed before backup — idle-only release stays pending"
    return 1
  fi
  backup_dir="$DIR/.deploy/backups/project-spaces-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -m 700 "$backup_dir" || return 1
  git -C "$DIR" rev-parse HEAD > "$backup_dir/revision" || return 1
  docker inspect "$container" --format '{{.Image}}' > "$backup_dir/previous-image" || return 1
  PREVIOUS_CONTAINER="$container"
  docker stop --time 30 "$container" || return 1
  docker run --rm --network none --volumes-from "$container" \
    --mount "type=bind,src=$backup_dir,dst=/release-backup" \
    --entrypoint node "$image" --import tsx scripts/project-spaces-recovery.ts \
    backup /app/state /release-backup/state --offline || return 1
  printf '%s\n' "$backup_dir" > "$DIR/.deploy/last-backup"
  echo "offline Project snapshot saved: $backup_dir"
}
trap resume_previous EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

{
  echo "=== tick $(date -Is) commit $(git -C "$DIR" rev-parse --short HEAD) ==="
  # 1. Build ahead of time — safe while a turn runs; only creates a new image.
  export X056_BUILD_REVISION="$(git -C "$DIR" rev-parse HEAD)"
  # The host's resolver flaps between an upstream and a VPN nameserver, and
  # BuildKit's registry metadata lookup is the one step that notices: three
  # releases in a row died on "failed to resolve source metadata" while the
  # daemon itself could pull. That lookup is worth a few more tries.
  build_ok=0
  for attempt in 1 2 3 4; do
    if docker compose --project-directory "$DIR" build; then build_ok=1; break; fi
    echo "build attempt $attempt failed; retrying in 20s"
    sleep 20
  done
  if [ "$build_ok" != 1 ]; then
    rm -f "$FLAG" "$FORCE"
    printf '{"status":"build_failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "build FAILED — flag cleared"
    exit 0
  fi

  age=$(( $(date +%s) - $(stat -c %Y "$FLAG" 2>/dev/null || echo 0) ))

  # 2. A live fan-out blocks the swap outright — no MAX_DEFER escape hatch.
  if [ -f "$FORCE" ] && [ "$IDLE_ONLY" != 1 ]; then
    echo "note: .deploy/force present — swapping even if workflows are live"
  else
    wf=$(live_workflows)
    if [ -n "$wf" ]; then
      echo "built OK; workflow runs still live — NOT swapping (pending ${age}s): $wf"
      echo "  (touch .deploy/force to override)"
      exit 0
    fi
  fi

  # 3. Only explicit interruption authorization permits swapping during a turn.
  if busy; then
    if [ "$IDLE_ONLY" = 1 ]; then
      echo "built OK; provider activity remains or cannot be checked — idle-only release stays pending"
      exit 0
    fi
    echo "explicit .deploy/force authorization — swapping despite active turns"
  fi

  if ! release_unchanged; then
    echo "pinned release changed during build — NOT swapping"
    exit 0
  fi
  if ! backup_project_spaces; then
    echo "backup not completed — release remains pending"
    exit 0
  fi
  if ! release_unchanged; then
    echo "pinned release changed during backup — NOT swapping"
    exit 0
  fi
  # Idle-only updates target this gateway; never recreate its Docker sidecar.
  swap_args=(up -d)
  if [ "$IDLE_ONLY" = 1 ]; then swap_args+=(--no-deps x056); fi
  if docker compose --project-directory "$DIR" "${swap_args[@]}"; then
    PREVIOUS_CONTAINER=""
    rm -f "$FLAG" "$FORCE"
    rm -f "$DIR/.deploy/backup-project-spaces"
    rm -f "$DIR/.deploy/idle-only"
    rm -f "$DIR/.deploy/revision"
    printf '{"status":"ok","commit":"%s","ts":"%s"}\n' "$(git -C "$DIR" rev-parse --short HEAD)" "$(date -Is)" > "$STATUS"
    echo "deploy OK"
  else
    rm -f "$FLAG" "$FORCE"
    printf '{"status":"failed","ts":"%s"}\n' "$(date -Is)" > "$STATUS"
    echo "swap FAILED — see above"
  fi
} >> "$LOG" 2>&1
