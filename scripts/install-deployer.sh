#!/usr/bin/env bash
# One-time host-side install: adds an idempotent crontab entry that runs the
# deploy actuator every minute (flock prevents overlap). No sudo needed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LINE="* * * * * /usr/bin/flock -n /tmp/x056-deploy.lock $DIR/scripts/deployer.sh"
( crontab -l 2>/dev/null | grep -vF "$DIR/scripts/deployer.sh" || true; echo "$LINE" ) | crontab -
mkdir -p "$DIR/.deploy"
echo "deployer installed (runs every minute)."
echo "trigger a deploy with:  touch $DIR/.deploy/requested"
echo "watch results in:       $DIR/.deploy/last.log and status.json"
