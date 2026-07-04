# Forced-switch drill (spec §5.3)

Proves a real mid-task account switch produces one continuous transcript.

Prereq: `bash scripts/setup-accounts.sh` reports `setup OK` (both accounts logged in, distinct emails, shared projects tree).

1. Terminal 1: `npm run x056 -- run "Create files one.txt through five.txt in /tmp/x056-drill (mkdir it first), one Bash command per file, running: sleep 5 between each. Then list the directory."`
2. Terminal 2, while files are still appearing: `npm run x056 -- switch`
3. Expect in terminal 1: a `forced_switch` event, then the session resuming on account b and completing.
4. Verify:
   - `ls /tmp/x056-drill` shows all five files exactly once (no duplicates — the D5 resume prompt working);
   - `state/events.jsonl` shows `forced_switch` → `failover` → `turn_completed`;
   - the transcript under `~/.claude-x056-a/projects/` for this session contains entries from both runs (account A's turn and account B's resumed turn — one session id, one file).
5. Live-limit validation (spec §5.4) happens opportunistically at the next real 5h limit: expect `limit_detected` with `source: rate_limit_event|api_retry` and automatic continuation on b within ~60 s.
   - While there, capture the raw stream output (the supervisor's turn events) and check whether the synthetic transcript entry (`error: "rate_limit"`) appeared on stdout — that decides whether the spec §8a tail watcher is needed in v1.1.

Notes:
- The supervised config dirs have no user hooks (fresh profiles), so plain `sleep` inside the drill task is fine there.
- v1 has no `--model` plumbing; the drill runs on the account's default model. Keep the task small.
