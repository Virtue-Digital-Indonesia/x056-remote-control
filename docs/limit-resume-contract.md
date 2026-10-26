# Usage-limit auto-continue: build contract (2026-10-27)

Efran, via Bot (2026-10-26): "Fix the session/weekly limit auto-continue. It has been unreliable for a while." Conversations stopped at "You've hit your session limit · resets …" and did not continue after the reset.

## What actually happened (forensics, 2026-10-26)

All three reported stops have the same cause. In each one, the limit was hit **out of turn**: the gateway's turn had already ended (`result`), then a background agent woke the model, and either the agent or the woken main reply got a 429. Every event after a turn's `result` goes to the pool's idle sink (`src/persistent.ts` ~512: "deliberately does NOT reach the failover classifier"). From there it goes to `observeIdle` / `tapToEvents` in `server/manager.ts`, and nothing there classifies it. So none of these happened:

- the account was never `markLimited`
- no failover ran
- nothing was parked or scheduled

`onSettled` then emitted a normal "finished" `conversation_settled` with the limit text as the reply. Another account was eligible every time.

- **Signature audit** e3c3f8d4, 05:31Z, account l. The background agent "Multibox end-to-end integration test" died with a 429. Its failed `<task-notification>` woke the main thread, whose reply was the synthetic `"You've hit your session limit · resets 8:30am (UTC)"` (`error: "rate_limit"`).
- **CI** 92356202, 11:02Z, account l. Same shape, agent "Contract analysis phase 1 web", "resets 1:30pm (UTC)".
- **CI** 92356202, 13:18Z, account p. The main thread itself, working out of turn after a finished agent woke it, got the synthetic 429 `"resets 3:10pm (UTC)"`. No subagent was involved.

The same pattern shows up in at least five more places on 2026-10-26. `events.jsonl` has 222 `limit_detected` events but only 24 `parked`; the last park was 2026-10-05.

Second-order bugs, in scope:

1. A parked turn (in turn, every account out) is never resumed by anything, and the park does not survive a restart.
2. A parked turn drains the queue straight into another park.
3. A delegate drops its idle events (`onIdleEvent: () => {}`), and its parked turn is mapped to `failed` -> `blocked`.
4. No reset-text parser exists. A limit without a structured `resetsAt` benches the account for a 30-minute guess, which is wrong for weekly limits.
5. `AccountRegistry.earliestReset` returns times in the past.
6. **Held-process trap.** `PersistentTurns.startTurn` runs a new turn on the conversation's ACTIVE process, whatever account that process is on (`activeProcess`, a guard against two writers on one transcript). `runSession` marks the account it ROUTED to. So a continue turn routed to m, landing on l's still-working process, gets a 429 and benches the healthy m.

## Rules

### R1. Reset-time parser (`src/detector.ts`)

`parseLimitReset(text: string, at: number): { until: number; kind: LimitKind } | null`

- `at` is epoch seconds of the MESSAGE: the entry's `timestamp` when present, else now.
- `until` is epoch seconds.
- `LimitKind = 'session' | 'weekly' | 'model' | 'unknown'`:
  - `/weekly/i` gives `weekly`
  - `/session|5-hour|five-hour/i` gives `session`
  - `/(opus|sonnet|fable|haiku)[^·]*limit/i` gives `model`
  - anything else gives `unknown`

Formats, each optionally followed by ` (IANA zone)`. The default zone is UTC: the CLI prints the zone it uses, and this container runs UTC.

- `resets 8:30am`, `resets 3pm`, `resets 15:10`
- `resets Oct 30, 9am`, `resets Oct 30 at 9:30am`, `resets October 30, 9am`
- `resets in 3 hours`, `resets in 45 minutes`, `resets in 2h 10m`
- ISO 8601

Resolution:

- **A time with no date** resolves to the first occurrence of that wall time in that zone at or after `at - 60`.
- **A date with no year** resolves to the first occurrence at or after `at - 86400`.
- **The roll-forward is relative to the message time, NEVER to now.** If `until <= now` when the caller acts, the limit has already reset. Act immediately; never push it to tomorrow. That would be the "past reset ignored" bug in another form.
- An unknown zone falls back to UTC.
- Anything unparseable returns `null`.

When the detector classifies the synthetic limit message (`error: 'rate_limit'`) or a 429 result, it sets `resetsAt` from the text when the event has no structured reset, and it sets `limitKind`.

### R2. One reset per limit (`src/failover.ts`)

- A structured `resetsAt` (from `rate_limit_event`) wins. When the same turn also produced a text reset, take the LATER of the two.
- The later-of-two rule is a guess. One live case suggests a weekly limit's `resetsAt` may be the 5-hour window. Mark this with a comment.
- `estimated` stays true only for the 30-minute fallback.

### R3. `earliestReset` returns only the future

Ignore an `until <= now`. If no reset is in the future, return `undefined`; callers then use `now + LIMIT_NO_RESET_FALLBACK` as an estimate.

### R4. Out-of-turn limits are classified (both providers, through the adapter's classifier)

Every idle event of a conversation's process is run through the adapter's classifier. On the first `limited` verdict of a wake (deduplicate: the CLI writes the limit text twice):

1. Mark the PROCESS's account limited (account = the process's configDir), with `until` from R1/R2. Log `limit_detected {sessionId, account, until, kind, outOfTurn: true}` to `events.jsonl`.
2. Collect the background tasks the limit killed. These are `task_notification`s since the last turn with status `failed`/`killed` and text matching `rate_limit|429|hit your .*limit`, and they come from the same idle stream. Keep each one's description/summary and task id.
3. Destroy that process once the woken reply's `result` arrives, or 5 s after detection, whichever is first. That way the continue turn routes to an eligible account and spawns fresh with `--resume`. This fixes the held-process trap. Its remaining background tasks are on the limited account and would 429 at their next API call anyway.
4. Do not emit the ordinary "finished" settle quoting the limit text, and do not start the recap turn. Emit `limit_continue {projectId, sessionId, account, until, kind, failedTasks, continueAt}` instead. Its notice is quiet (bell + dot, no push) when continuing now. It is `normal` (one push, "Paused by a usage limit until HH:MM; continues automatically") when it has to wait.
5. Hand it to the resume scheduler (R6) as `kind: 'continue'`. It fires NOW if `registry.explain` finds an eligible account, else at `until`.

The continue message is sent with sender kind `limit_resume`. It is a new kind: not an agent kind, so it stays visible in the owner view and the Bot view. Text:

```
[Usage limit: account <l> hit its <session|weekly> limit at <HH:MM WIB> (resets <HH:MM WIB / Mon D HH:MM WIB>). This continues on another account.]
Continue where you left off.
These background agents were stopped by the limit and did not finish; re-run them if they are still needed:
- "<description>" (<task id>)
```

Drop the last two lines when no task died.

### R5. Parked turns resume, and the queue waits

When `runSession` returns `parked`:

- Persist a resume record (R6). `kind` is `'resend'` when that run never started a turn on any process (no `turn_started` before the park). The record then keeps the original prompt, sender, model, effort and attachments, and resends them as they were. Otherwise `kind` is `'continue'`, with the R4 text and no failed tasks.
- `until` = `earliestReset` (R3), else `now + 30 min`, estimated.
- Do NOT drain the queue after a park. It drains after the resumed turn, as after any turn.
- If autopilot paused itself because of the park, the resume un-pauses autopilot instead of sending a continue.
- The parked notice: when a resume is scheduled, the tier is `normal`, not urgent, and the text says when it continues. The owner does not have to act.

### R6. Resume scheduler (new, `server/limit-resume.ts`)

- Records: `<stateDir>/limit-resume.json`, `{ id, projectId, sessionId, provider, kind: 'continue'|'resend'|'autopilot'|'delegate', until, estimated, createdAt, attempts, text?, prompt?, sender?, model?, effort?, attachments?, delegate?: {parentSessionId, delegateId} }`. One record per conversation (or per delegate); a newer one replaces it.
- The file is loaded at boot, so a deploy keeps them. A record whose `until` has passed fires at boot.
- Tick every 30 s. A record fires at `until + 60 s`, or at once when it was created with an eligible account.
- When it fires:
  - If no account is eligible, it re-parks: new `until`, `attempts++`.
  - After 6 attempts it stops and sends ONE normal notice: "Auto-continue gave up after 6 tries".
- It is cleared without firing when:
  - a human-origin turn started in that conversation after `createdAt`
  - the operator stopped the conversation (a stop clears its record)
  - the conversation was archived or deleted
  - a pending question exists (the owner is the next step)
- Loop brake: at most 3 auto-continues per conversation without a human message in between. The 4th is not sent; one normal notice says so.
- Delivery goes through the ordinary send path, so a busy conversation queues it.
- Log `limit_resume_scheduled`, `limit_resume_fired`, `limit_resume_skipped {reason}` and `limit_resume_gave_up` to `events.jsonl`.
- Panel and API: none required. `GET /api/limit-resume` (read-only list) is welcome.

### R7. Delegates

- A delegate's idle events go through the same R4 classifier. On a limit: mark the account, destroy the delegate's process, schedule a `delegate` record that sends a `delegate_followup` with the continue text.
- A parked delegate turn is NOT gated `blocked`, and the orchestrator is not woken. It gets a `delegate` record (`continue`/`resend` as in R5), and its roster status says `waiting_for_reset` until it fires.

### R8. Unchanged

- In-turn limit failover.
- The flap guard.
- Codex turn-level classification.
- The `wait` routing strategy.
- Owner-view rules, other than the new `limit_resume` sender kind, which is visible.

## Tests (each case gets one)

Use the real shapes. Fixtures are the transcript lines below, trimmed to the fields the code reads:

- T2 = `/home/efran/.claude-x056-a/projects/-app-state-chats-6e2271ca-e851-401f-a339-ef14a45797a3-work/e3c3f8d4-9259-4f1b-83ba-d069ef6adb9d.jsonl` lines 20047–20050
- T1 = `/home/efran/.claude-x056-a/projects/-home-efran-remote-development-obscura/92356202-61c3-48cc-85f5-94adec974dfb.jsonl` lines 20199–20202 and 20447

Cases:

1. The parser: every format; Asia/Jakarta; a date-less weekly string with a year rollover; a past reset (message 05:31 "resets 8:30am (UTC)", now 09:00) gives `until` 08:30 today, which is in the past, so it acts at once.
2. A weekly limit gets the parsed date, not 30 min; session and weekly are handled the same way.
3. `earliestReset` ignores the past.
4. An out-of-turn limit after a failed background agent (T2 fixture):
   - the process's account is marked
   - the process is destroyed
   - a continue is queued that names the dead agent
   - there is no "finished" settle and no recap
5. An out-of-turn limit on the main thread with no subagent (T1:20447): continue without an agent list.
6. Held-process trap: after R4 the continue does not land on the limited process, and the healthy account is not benched.
7. Park with no eligible account: the record is persisted and fires after `until`. It survives a new manager or scheduler instance reading the file. A human turn in between clears it. A resend keeps the original prompt.
8. The queue is not drained into a second park.
9. Delegates: an idle limit gives a follow-up; a parked delegate gets a `delegate` record, not `blocked`.
10. Loop brake: the 4th continue without a human message is not sent.
