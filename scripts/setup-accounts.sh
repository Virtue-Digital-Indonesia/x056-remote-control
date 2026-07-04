#!/usr/bin/env bash
set -euo pipefail
A="$HOME/.claude-x056-a"; B="$HOME/.claude-x056-b"
for d in "$A" "$B"; do
  [ -f "$d/.credentials.json" ] || { echo "MISSING login: CLAUDE_CONFIG_DIR=$d claude /login"; exit 1; }
done
# The two dirs must hold DIFFERENT accounts or failover is pointless.
python3 - "$A" "$B" <<'EOF'
import json, sys, urllib.request
emails = []
for d in sys.argv[1:3]:
    tok = json.load(open(d + '/.credentials.json'))['claudeAiOauth']['accessToken']
    req = urllib.request.Request('https://api.anthropic.com/api/oauth/profile', headers={
        'Authorization': 'Bearer ' + tok, 'anthropic-beta': 'oauth-2025-04-20'})
    emails.append(json.load(urllib.request.urlopen(req, timeout=20))['account']['email'])
print(f"account a: {emails[0]}\naccount b: {emails[1]}")
if emails[0] == emails[1]:
    sys.exit("ERROR: both config dirs are logged into the SAME account")
EOF
mkdir -p "$A/projects"
# D2: one canonical transcript tree, account B reads/writes A's
if [ ! -e "$B/projects" ]; then ln -s "$A/projects" "$B/projects"; fi
[ "$(readlink -f "$B/projects")" = "$(readlink -f "$A/projects")" ] || { echo "B projects is not the shared tree"; exit 1; }
npm run x056 -- init
npm run x056 -- status
echo "setup OK"
