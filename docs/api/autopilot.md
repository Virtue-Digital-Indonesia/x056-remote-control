# Autopilot standing instruction

Autopilot is armed per conversation. All routes use the gateway's existing authentication.

`POST /api/autopilot` accepts `{projectId, sessionId, count, prompt?, stopPhrase?, instruction?}` and returns `{ok:true}`. Count is the initial continuation budget, clamped to 1–500. The optional instruction is trimmed and capped at 4000 characters; an empty instruction means none.

Each continuation preserves the default or custom base prompt, keeps the completion guidance for the selected stop phrase, and appends the instruction as:

```text
<base prompt, including stop guidance>

Standing instruction from the user:
<instruction, preserving internal line breaks>
```

Custom prompts receive the completion guidance when they do not already contain it. The default stop phrase is `AUTOPILOT_DONE`. Continuation timers and startup recovery read the current instruction at send time.

`POST /api/autopilot/instruction` accepts `{projectId, sessionId, instruction}` and returns `{ok:true}`. It changes an armed entry, including a paused one, while retaining `count`, `remaining`, `paused`, and `pauseReason`. It returns 409 if that conversation has no armed entry. `instruction` must be a string; use `""` to clear it.

`GET /api/autopilot` returns entries keyed by `sessionId`:

```json
{
  "session-id": {
    "projectId": "project-id",
    "remaining": 8,
    "count": 20,
    "instruction": "Follow docs/plan.md"
  }
}
```

`instruction` is omitted when empty. Paused entries also include `paused:true` and `pauseReason`. Active `autopilot` live events include `projectId`, `sessionId`, `active:true`, `remaining`, `count`, and `instruction`; the event instruction is `""` when cleared.

`GET /api/autopilot/last?projectId=<id>&sessionId=<id>` returns `{count?, instruction?}`, or `{}` when nothing is stored. The last count and instruction survive manual stops, completion, budget exhaustion, and gateway restarts. Re-enabling clients can prefill these settings and submit them explicitly. This route ships with the instruction routes so a 404 can identify an older gateway.

Autopilot messages retain the instruction and sender attribution in both providers' history. The panel shows a collapsed continuation with the instruction in its summary and full text when expanded. The repeated standing instruction is excluded from the model picker's `previousRequest` context.
