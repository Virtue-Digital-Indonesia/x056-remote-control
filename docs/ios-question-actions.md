# iOS: agent actions on question cards (for the Mac session)

The server side ships in the `question-tool` release (see
`docs/question-tools-contract.md`). This note is for the Mac session that
builds the iOS app.

## What already works on the current app, no change needed

- **Cards are unchanged.** They open, close and dismiss through the same events
  and `GET /api/questions`.
- **New fields are ignored safely.** Items carry `id`, events add `byAgent`,
  `edited` and `closedIds`, and `by` stays a string. No Decodable reads them.
- **The "Question dismissed by ..." line shows after a reload.** A history row
  `{role: 'notice', messageId: 'question-action:<id>'}` goes through
  `baseRow`'s `default:` branch as a `.notice`.
- **Server-side visibility is already right.** The server marks these rows as
  always shown (`ownerView` is not `hide`; `botView` is `show`).

## The gap

The live event `question_agent_action` falls through to `default: break` in
`ConversationModel.apply`. Until the next reload, the phone shows the card
vanishing with no line.

## Change (`ios/X056/App/ConversationModel.swift`; applied 2026-10-31, with `session_reset` the same way)

```diff
 struct ChatRow: Identifiable, Equatable {
     /// On an agent turn's reply: who it replies to.
     var replyTo: String?
+    /// The journal's messageId, when a live event must not repeat a history row
+    /// (`question-action:<actionId>`).
+    var messageId: String?
 }

 static func row(_ h: HistoryEntry) -> ChatRow? {
     guard var r = baseRow(h) else { return nil }
+    r.messageId = h.messageId
     r.botView = h.botView
     ...
-    r.ownerHidden = h.ownerView == "hide" && r.role != .error
+    // So is an agent's action on a question card.
+    r.ownerHidden = h.ownerView == "hide" && r.role != .error && !Self.isQuestionAction(h.messageId)
+    if Self.isQuestionAction(h.messageId) { r.botView = "show" }
     ...
 }
+
+static func isQuestionAction(_ id: String?) -> Bool { id?.hasPrefix("question-action:") == true }

 func apply(_ e: GatewayEvent) {
     switch e.kind {
+    case "question_agent_action":
+        // An agent dismissed/answered/edited a question card. The journal keeps the
+        // same row as `question-action:<actionId>`, so a reload matches it.
+        // Never `inTurn`: it shows even inside a hidden agent turn.
+        guard let actionId = d["actionId"]?.string, let text = d["text"]?.string, !text.isEmpty else { break }
+        let mid = "question-action:" + actionId
+        if rows.contains(where: { $0.messageId == mid }) || repeatsTail(.notice, text) { break }
+        var row = ChatRow(role: .notice, text: text)
+        row.messageId = mid
+        row.botView = "show"
+        rows.append(row)
```

## Notes

- **Rendering is reused.** `.notice` already renders as the centered caption
  capsule (`ConversationView.swift` ~380). In the Bot screen it renders as
  `BotNotice`'s `info.circle` caption.
- **Card state stays where it is.** Do not add a case in `AppModel.handle`: a
  card still closes only on `question_answered` / `question_dismissed`.
- **Check on a device.** An agent dismisses a card through `dismiss_question`.
  The card goes away and the line appears live, then again once after
  pull-to-refresh, not twice.
