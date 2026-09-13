#!/usr/bin/env bash
# Host actuator: publication only. Never builds, restarts or stops containers.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REQUEST="$DIR/.deploy/frontend-requested"
[ -f "$REQUEST" ] || exit 0
exec >> "$DIR/.deploy/frontend-last.log" 2>&1
revision=$(cat "$REQUEST")
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid frontend revision'; exit 1; }
container=$(docker compose --project-directory "$DIR" ps -q x056)
[ -n "$container" ] || { echo 'Gateway unavailable; request retained'; exit 1; }
# Snapshot only committed files. The deployed CLI validates source/dependency
# compatibility, checks assets, then switches the pointer atomically.
stage=$(mktemp -d "$DIR/.deploy/frontend-snapshot.XXXXXX")
trap 'rm -rf "$stage"' EXIT
git -C "$DIR" archive "$revision" server src scripts package.json package-lock.json | tar -x -C "$stage"
if docker exec -w /app "$container" node --import tsx scripts/frontend-release.ts publish "$stage" "$revision"; then
  if ! docker exec -e X056_EXPECTED_UI="$revision" "$container" node -e '
    (async()=>{const headers={Authorization:"Bearer "+process.env.X056_TOKEN};const r=await fetch("http://127.0.0.1:4056/api/version",{headers});const v=await r.json();if(!r.ok||v.ui.revision!==process.env.X056_EXPECTED_UI.slice(0,7))throw Error("UI version mismatch");const health=await fetch("http://127.0.0.1:4056/healthz");if(!health.ok)throw Error("Health check failed");})().catch(e=>{console.error(e.message);process.exitCode=1});'; then
    docker exec -w /app "$container" node --import tsx scripts/frontend-release.ts rollback
    printf '{"status":"verification_failed","revision":"%s"}\n' "$revision" > "$DIR/.deploy/frontend-status.json"
    exit 1
  fi
  printf '{"status":"ok","revision":"%s","container":"%s"}\n' "$revision" "$container" > "$DIR/.deploy/frontend-status.json"
  [ "$(cat "$REQUEST" 2>/dev/null)" != "$revision" ] || rm -f "$REQUEST"
else
  printf '{"status":"failed","revision":"%s"}\n' "$revision" > "$DIR/.deploy/frontend-status.json"
  echo 'Frontend publication failed; previous release retained. Request retained for review.'
  exit 1
fi
