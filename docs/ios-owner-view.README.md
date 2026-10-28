# Applying `ios-owner-view.patch` (for the Mac session)

This container cannot build Swift, so the gateway side ships here and the iOS
side ships as `docs/ios-owner-view.patch`. Apply and build it on the Mac.

## Apply

```bash
git pull                                  # main must include this README
git apply --check docs/ios-owner-view.patch && git apply docs/ios-owner-view.patch
```

The patch is against main's `ios/` tree. `git apply --check` passed on that
tree on 2026-10-28. It touches 7 files under `ios/X056`: Models,
AppModel, ConversationModel, X056App, BotOrb, BotView and ConversationView.
Build and install the app as usual.

## The question-card part (2026-10-28)

The cards vanished from the app because `AppModel` cleared
`questions[sid]` on every `session_started`. Any relay, cron, delegate or
auto-continue turn hid the card until the next refresh.

The gateway now owns the card. A card closes only when:
- the owner answers it on the card, or
- the owner's message is an option's exact text, or
- the owner's message is an "N. question / Answer: x" block, or
- the asking chat writes `<<<RESOLVED>>>` on its own line.

Free-typed owner messages leave it open. So the app must never clear a card
because a turn started. It follows three events:

| event | what the app does |
|---|---|
| `question_answered`, `question_dismissed` | remove the card (the patch adds `question_answered`) |
| `question` | show or replace the card. With `remainder: true` it is what is left of a partly answered batch, under the same `at` |
| `session_started` | nothing about cards |

The patch's `session_started` hunk (around line 107) now only carries a
comment. An earlier version cleared the card when `sender.kind == nil`. **If
you already applied that version,** delete this line from
`ios/X056/App/AppModel.swift` in the `case "session_started":` branch:

```swift
if d["sender"]?.decode(Sender.self)?.kind == nil { questions[sid] = nil }
```

## Card answers

The app's answers need no change:
- "Send answers" sends `N. question\nAnswer: x` blocks.
- An option tap sends the option text.

The gateway recognises both, and closes only the questions answered.
Optionally, send `answersQuestionAt: <card's at>` in the
`/api/sessions/current/messages` body, as the panel does. With it, free text
typed into the card also closes it.

## Optional polish (not in the patch)

The `question` handler calls `raiseUnread(..., .question, ...)`. For a
`remainder: true` event that re-marks a conversation the owner just answered,
so skip `raiseUnread` when `remainder` is true. The gateway already marks
these notices `screenSuppressed`, so they never push.

## Check after building

1. Open a conversation with an open card.
2. Let an agent or cron turn start there. The card stays.
3. Type an unrelated message. The card stays.
4. Answer on the card. It goes.
5. Pull to refresh. The list matches the panel.
