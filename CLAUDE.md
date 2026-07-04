# X056 Remote Control

Self-hosted Claude Code "remote control" with automatic failover between two Claude Max accounts: a supervisor drives headless `claude -p --output-format stream-json` sessions and, when the active account hits its usage limit, respawns `claude -p --resume <session-id>` under the other account's `CLAUDE_CONFIG_DIR` (shared `projects/` tree), so one continuous session survives the switch.

## Session rules

- **Markdown uploads:** whenever you create or modify any `.md` file during a session, upload it so the rendered version can be read, and share the returned URL:

  ```bash
  curl -F "file=@<filename>.md" https://x056.think.val.id/upload
  ```
