# Daily-Driver Build Plan (synthesis of 11 confirmed designs)

Full per-feature specs: `designs-2026-07-06.json` (11 designs, all feasibility **confirmed**, produced by parallel design agents reading the real code; two live-verified against claude 2.1.201).

## Reconciled event vocabulary (all carry `projectId`)
- `activity` — **extended** with optional `detail` (stdout/stderr excerpt, Edit/Write line-diff, error), capped payload; same kind feeds tool rows AND ultracode subagent view.
- `turn_interrupted` — shared by Stop button and queue's "interrupt & send now"; panel suppresses the following `session_done{failed}` banner.
- `question {text, options[]?}` — emitted at turn end when the model asked (ASK convention + trailing-? heuristic); panel renders an answer card; reply goes through the normal continue path (context preserved via resume).
- `queue_update {queued[]}`, `conversation_updated/selected`, `turn_auto_resumed / turn_resume_abandoned`, `plan_proposed`; `session_started` gains `{ultracode, permissionMode}`.

## Endpoints (no collisions)
POST `/api/interrupt` {projectId?} · GET `/api/commands?projectId` · GET `/api/notify/config` · conversation CRUD + POST `/api/conversations/current` · send bodies gain `permissionMode?`, `ultracode?`; messages endpoint returns `{queued:true,position}` when busy instead of 409.

## Key verified facts
- **Ultracode**: `CLAUDE_CODE_EFFORT_LEVEL=ultracode` env on the spawned process (live-verified). Composes with existing subagent activity view. Org-policy may restrict xhigh — surface the error.
- **Answer-questions**: persistent-stdin single-process exists but is fragile; chosen design detects questions at turn boundaries and answers via resume — full context, no process gymnastics (live-verified flow).
- **Auto-resume**: in-flight marker file per project, cleared in `.finally()`; SIGTERM exit(130) skips clearing → marker present ⇔ ungraceful death. One resume attempt max (poison-turn guard), `turn_resume_abandoned` otherwise.
- **projects.json v2**: `conversations[] + currentConversationId` with v1 migration (lastSessionId → first conversation). Land BEFORE queue/auto-resume (both reference conversation state).

## Build phases (each independently deployable)
1. **See + control** ← start here: activity `detail` + expandable rows; Stop button (`turn_interrupted`). Biggest pain first.
2. **Threads**: projects.json v2 multi-conversation (sidebar nesting, titles from first prompt) + per-project queue with cancel / interrupt-and-send.
3. **Ask + tell**: question cards; browser notifications (+Telegram config probe).
4. **Power**: ultracode toggle; permission-mode selector + retry; slash commands (`/clear` UI-local; `/compact` passthrough; custom commands via GET /api/commands).
5. **Polish + resilience**: copy buttons, mobile hamburger layout; auto-resume-on-restart.

## Cross-feature risks to respect while building
- History reload drops tool-detail rows (transcript has no activity) — acceptable; live turns keep them.
- Notification replay-dup guard (arm after SSE replay settles).
- Queue drains through the same launch path as auto-resume — serialize per project (run map already guarantees one turn per project).
