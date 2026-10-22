#!/usr/bin/env bash
# Post-deploy check for the owner view in normal conversations (docs/owner-view-all-contract.md).
# Reads the history and read-state of ONE conversation after a relay turn has run.
#   scripts/owner-view-e2e.sh <projectId> <sessionId> <triggerMessageId>
# Prints the trigger turn's rows with their ownerView and whether the conversation reads unread.
# Uses $X056_TOKEN by reference; never prints it.
set -euo pipefail
pid=$1 sid=$2 mid=$3
base=${X056_URL:-http://127.0.0.1:4056}
auth="Authorization: Bearer $X056_TOKEN"
page=$(curl -s -H "$auth" "$base/api/conversations/history-page?projectId=$pid&sessionId=$sid&limit=60")
echo "$page" | jq -r --arg mid "$mid" '
  .rows as $r
  | ($r | map(.sender.messageId == $mid) | index(true)) as $i
  | if $i == null then "trigger \($mid) not found in the last page" else
      ($r[$i:] | (map(.role == "user" and (.steered | not)) | .[1:] | index(true)) as $n
       | .[0:(if $n == null then length else $n + 1 end)]
       | .[] | "\(.ownerView // "-")\t\(.role)\t\(.forOwner // false)\t\((.text // "")[0:90] | gsub("\n"; " "))")
    end'
curl -s -H "$auth" "$base/api/conversations/read-state" | jq -c --arg k "$pid::$sid" '(.items // .) | if type == "object" then .[$k] // "no entry" else map(select(.projectId == ($k | split("::")[0]) and .sessionId == ($k | split("::")[1]))) end'
