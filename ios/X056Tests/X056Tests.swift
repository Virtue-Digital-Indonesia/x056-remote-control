import Foundation
import Testing
import UIKit
@testable import X056

private func feed(_ parser: inout SSEParser, _ text: String) -> [ServerEvent] {
    text.utf8.compactMap { parser.feed($0) }
}

private func event(_ kind: String, _ data: String, seq: Int = 1) -> GatewayEvent {
    let json = #"{"seq":\#(seq),"ts":"2026-10-01T00:00:00Z","kind":"\#(kind)","data":\#(data)}"#
    return try! JSONDecoder().decode(GatewayEvent.self, from: Data(json.utf8))
}

@Suite struct SSEParserTests {
    @Test func dispatchesOnBlankLineOnly() {
        var p = SSEParser()
        #expect(feed(&p, "id: 7\nevent: queue\ndata: {\"a\":1}\n").isEmpty)
        let out = feed(&p, "\n")
        #expect(out.count == 1)
        #expect(out[0].id == "7")
        #expect(out[0].event == "queue")
        #expect(out[0].data == "{\"a\":1}")
    }

    @Test func ignoresKeepAlivesAndHandlesCRLF() {
        var p = SSEParser()
        #expect(feed(&p, ": ping\n\n").isEmpty)
        let out = feed(&p, "data: one\r\ndata: two\r\n\r\n")
        #expect(out.map(\.data) == ["one\ntwo"])
    }

    @Test func keepsMultibyteTextIntact() {
        var p = SSEParser()
        let out = feed(&p, "data: {\"text\":\"résumé · 日本\"}\n\n")
        #expect(out.first?.data == "{\"text\":\"résumé · 日本\"}")
    }
}

@Suite struct MarkdownTests {
    @Test func splitsCodeHeadingsAndProse() {
        let blocks = MarkdownText.blocks("# Title\nSome **bold** text\n\n```swift\nlet x = 1\n```\nAfter")
        guard blocks.count == 4 else { Issue.record("got \(blocks)"); return }
        if case .heading(let level, let text) = blocks[0] { #expect(level == 1 && text == "Title") } else { Issue.record("heading") }
        if case .prose(let text) = blocks[1] { #expect(text == "Some **bold** text") } else { Issue.record("prose") }
        if case .code(let lang, let code) = blocks[2] { #expect(lang == "swift" && code == "let x = 1") } else { Issue.record("code") }
        if case .prose(let text) = blocks[3] { #expect(text == "After") } else { Issue.record("after") }
    }

    @Test func readsATable() {
        let blocks = MarkdownText.blocks("Before\n\n| Item | Blocker |\n|---|:---:|\n| **Lookup** | Pending \\| waiting |\n| Scan |\nAfter")
        guard blocks.count == 3, case .table(let header, let rows) = blocks[1] else {
            Issue.record("expected prose, table, prose: \(blocks)")
            return
        }
        #expect(header == ["Item", "Blocker"])
        #expect(rows == [["**Lookup**", "Pending | waiting"], ["Scan"]])
    }

    @Test func showsAnUnterminatedFenceWhileStreaming() {
        let blocks = MarkdownText.blocks("```\npartial")
        if case .code(_, let code) = blocks.last { #expect(code == "partial") } else { Issue.record("expected code") }
    }
}

@MainActor @Suite struct ConversationModelTests {
    @Test func confirmsTheOptimisticRowInsteadOfDuplicatingIt() {
        let m = ConversationModel(projectId: "p", sessionId: "s")
        m.rows = [ChatRow(role: .user, text: "hello", pending: true, requestId: "r1")]
        m.apply(event("session_started", #"{"projectId":"p","sessionId":"s","requestId":"r1","displayPrompt":"hello"}"#))
        #expect(m.rows.count == 1)
        #expect(m.rows[0].pending == false)
    }

    @Test func dropsAReplayedAssistantMessage() {
        let m = ConversationModel(projectId: "p", sessionId: "s")
        m.rows = [ChatRow(role: .assistant, text: "Done.")]
        m.apply(event("assistant_text", #"{"projectId":"p","sessionId":"s","text":"Done."}"#))
        m.apply(event("assistant_text", #"{"projectId":"p","sessionId":"s","text":"Next."}"#))
        #expect(m.rows.map(\.text) == ["Done.", "Next."])
    }

    @Test func tracksAToolCallFromStartToDoneAndFoldsTheRun() {
        let m = ConversationModel(projectId: "p", sessionId: "s")
        m.apply(event("activity", #"{"sessionId":"s","toolUseId":"t1","parentToolUseId":null,"tool":"Read","label":"Read a.ts","status":"start","isSubagent":false}"#))
        #expect(m.activity == "Read a.ts")
        m.apply(event("activity", #"{"sessionId":"s","toolUseId":"t1","parentToolUseId":null,"tool":"Read","label":"Read a.ts","status":"done","isSubagent":false}"#))
        m.apply(event("activity", #"{"sessionId":"s","toolUseId":"t2","parentToolUseId":null,"tool":"Edit","label":"Edit b.ts","status":"start","isSubagent":false}"#))
        // A subagent's inner calls stay out of the main thread.
        m.apply(event("activity", #"{"sessionId":"s","toolUseId":"t3","parentToolUseId":"t2","tool":"Read","label":"inner","status":"start","isSubagent":true}"#))
        #expect(m.rows.count == 2)
        #expect(m.rows[0].inFlight == false)
        #expect(m.rows[1].inFlight == true)
        #expect(m.items.count == 1)
        m.apply(event("conversation_settled", #"{"sessionId":"s","status":"completed"}"#))
        #expect(m.rows.allSatisfy { !$0.inFlight })
        #expect(m.activity == nil)
    }

    @Test func aReloadKeepsTheRowsItRepeats() {
        let old = [ChatRow(role: .user, text: "Fix it"), ChatRow(role: .action, text: "Reading a.ts"), ChatRow(role: .assistant, text: "Done.")]
        let fresh = [ChatRow(role: .user, text: "Fix it"), ChatRow(role: .action, text: "Reading a.ts"), ChatRow(role: .assistant, text: "Done."), ChatRow(role: .user, text: "Fix it")]
        let kept = ConversationModel.keepingIDs(fresh, from: old)
        #expect(kept.prefix(3).map(\.id) == old.map(\.id))
        #expect(kept[3].id == fresh[3].id, "a repeat beyond the old rows is a new row")
    }

    @Test func mapsHistoryRoles() {
        let decode = { (json: String) in try! JSONDecoder().decode(HistoryEntry.self, from: Data(json.utf8)) }
        #expect(ConversationModel.row(decode(#"{"role":"model","text":"opus"}"#))?.text == "Model: Opus")
        #expect(ConversationModel.row(decode(#"{"role":"assistant","text":""}"#)) == nil)
        let user = ConversationModel.row(decode(#"{"role":"user","text":"hi","sender":{"kind":"automation"},"attachments":[{"name":"a.png","type":"image/png","url":"/api/x"}]}"#))
        #expect(user?.sender == "Scheduled task")
        #expect(user?.attachments.first?.isImage == true)
    }
}

@Suite struct TranscriptLineTests {
    private func entry(_ json: String, at: Int = 0) -> RawPage.Entry {
        RawPage.Entry(at: at, line: try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)), truncated: nil)
    }

    @Test func readsAClaudeToolCallAndItsFailedResult() {
        let call = Transcript.lines(entry(#"{"type":"assistant","message":{"model":"claude-opus-5-5","usage":{"input_tokens":1200,"output_tokens":40},"content":[{"type":"text","text":"Running the tests."},{"type":"tool_use","name":"Bash","input":{"command":"npm test","description":"Run the suite"}}]}}"#, at: 10), provider: "claude")
        #expect(call.map(\.kind) == [.text, .tool])
        #expect(call[1].text == "Bash(npm test)")
        #expect(call[1].tag == "opus-5-5 · in 1.2k · out 40")
        let result = Transcript.lines(entry(#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":[{"type":"text","text":"2 failed"}]}]}}"#), provider: "claude")
        #expect(result.first?.kind == .err)
        #expect(result.first?.text == "2 failed")
    }

    @Test func readsACodexCallItsOutputAndAnError() {
        let call = Transcript.lines(entry(#"{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"go test ./...\"}"}}"#), provider: "codex")
        #expect(call.first?.kind == .tool)
        #expect(call.first?.text == "exec_command(go test ./...)")
        let output = Transcript.lines(entry(#"{"type":"response_item","payload":{"type":"function_call_output","output":"{\"output\":\"ok  pkg 0.3s\"}"}}"#), provider: "codex")
        #expect(output.first?.text == "ok  pkg 0.3s")
        let error = Transcript.lines(entry(#"{"type":"event_msg","payload":{"type":"error","message":"usage limit reached"}}"#), provider: "codex")
        #expect(error.first?.kind == .err)
        #expect(error.first?.quiet == false)
    }
}

@Suite struct PasskeyPlumbingTests {
    @Test func base64URLRoundTripsWithoutPadding() {
        let bytes = Data([0xfb, 0xff, 0x00, 0x10, 0x3e])
        #expect(bytes.base64URL == "-_8AED4")
        #expect(Data(base64URL: "-_8AED4") == bytes)
        #expect(Data(base64URL: "eDA1Ni11c2Vy").map { String(decoding: $0, as: UTF8.self) } == "x056-user")
    }

    @Test func readsTheSessionCookieTheGatewaySets() {
        let url = URL(string: "https://x056.rc.val.id/api/auth/passkey/auth/verify")!
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Set-Cookie": "x056_session=abc123def; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
        ])!
        #expect(Passkeys.sessionCookie(from: response) == "abc123def")
    }

    @Test func sendsTheRightCredentialAndOrigin() {
        let base = URL(string: "https://x056.rc.val.id")!
        let token = APIClient(baseURL: base, credential: .token("t0k")).request("GET", "/api/projects")
        #expect(token.value(forHTTPHeaderField: "Authorization") == "Bearer t0k")
        #expect(token.value(forHTTPHeaderField: "Cookie") == nil)
        let session = APIClient(baseURL: base, credential: .session("s1d")).request("GET", "/api/projects")
        #expect(session.value(forHTTPHeaderField: "Cookie") == "x056_session=s1d")
        #expect(session.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(session.httpShouldHandleCookies == false)
        #expect(APIClient(baseURL: URL(string: "http://127.0.0.1:8768")!, credential: nil).origin == "http://127.0.0.1:8768")
        #expect(APIClient(baseURL: base, credential: nil).origin == "https://x056.rc.val.id")
    }
}

@MainActor @Suite struct PanelParityTests {
    @Test func namesModelsTheWayThePanelDoes() {
        #expect(ModelCatalog.displayName("claude-opus-5-5-20260901") == "Opus 5.5")
        #expect(ModelCatalog.displayName("sonnet") == "Sonnet")
        #expect(ModelCatalog.displayName("claude-sonnet-5") == "Sonnet 5")
        #expect(ModelCatalog.displayName("gpt-6-astra") == "GPT-6 Astra")
        #expect(ModelCatalog.displayName("gpt-6.1-sol") == "GPT-6.1 Sol")
    }

    @Test func helpersPillMatchesThePanel() {
        #expect(Helpers().summary(router: nil) == "")
        #expect(Helpers(advisor: true, team: true, router: "jev", lean: "high").summary(router: "jev") == "Advisor · Team · Jev · High")
        #expect(Helpers(router: "decisions").summary(router: "decisions") == "Decisions")
        // Jev by default: nothing saved, but the pill names what runs.
        #expect(Helpers(team: true).summary(router: "jev") == "Team · Jev")
        let legacy = try! JSONDecoder().decode(Conversation.self, from: Data(#"{"sessionId":"s","title":"t","decisionMaker":"advisor"}"#.utf8))
        #expect(legacy.effectiveHelpers.advisor == true)
    }

    /// server/projects.ts effectiveRouter: what was saved; 'none' is none;
    /// nothing saved is Jev while available (fresh status first, else the
    /// conversation's snapshot).
    @Test func picksTheRouterThatRunsLikeTheGateway() {
        let app = AppModel.shared
        let saved = app.jevStatus
        defer { app.jevStatus = saved }
        let snapshot = try! JSONDecoder().decode(Conversation.self, from: Data(#"{"sessionId":"s","title":"t","effectiveRouter":"jev"}"#.utf8))
        app.jevStatus = JevStatus(configured: true, estimatedLeft: 1, available: true)
        #expect(app.effectiveRouter(Helpers(), nil) == "jev")
        #expect(app.effectiveRouter(Helpers(router: "none"), snapshot) == nil)
        #expect(app.effectiveRouter(Helpers(router: "decisions"), nil) == "decisions")
        app.jevStatus = JevStatus(configured: true, estimatedLeft: 0, available: false)
        #expect(app.effectiveRouter(Helpers(), snapshot) == nil)
        #expect(app.effectiveRouter(Helpers(router: "jev"), nil) == "jev")
        app.jevStatus = nil
        #expect(app.effectiveRouter(Helpers(), snapshot) == "jev")
        #expect(app.effectiveRouter(Helpers(), nil) == nil)
    }

    @Test func readsJevAndDelegateCardsFromHistory() {
        let decode = { (json: String) in try! JSONDecoder().decode(HistoryEntry.self, from: Data(json.utf8)) }
        let jev = ConversationModel.row(decode(#"{"role":"advisor","text":"model -> opus","advisor":{"helper":"jev","decision":{"model":"opus","effort":"high","notes":["model -> opus"],"latencyMs":300}}}"#))
        guard case .decision(let d) = jev?.card else { Issue.record("expected a decision card"); return }
        #expect(d.ranModel == "opus")
        #expect(d.verdict == "Changed this turn")
        #expect(d.noteLine == "model → opus")
        let kept = try! JSONDecoder().decode(JevDecision.self, from: Data(#"{"baseModel":"sonnet","notes":[]}"#.utf8))
        #expect(kept.verdict == "Kept your choice")
        let report = ConversationModel.row(decode(#"{"role":"advisor","text":"DONE","advisor":{"delegate":{"role":"worker","gate":"needs_human","text":"NEEDS HUMAN: pick a port"}}}"#))
        guard case .delegate(let role, let gate, _) = report?.card else { Issue.record("expected a delegate card"); return }
        #expect(role == "worker" && gate == "needs_human")
    }
}

@MainActor @Suite(.serialized) struct SharedReadStateTests {
    @Test func unreadMirrorsTheGatewayAndSkipsTheScreen() {
        let app = AppModel.shared
        let saved = app.serverRead
        defer { app.serverRead = saved; app.setVisible(projectId: nil, sessionId: nil) }
        app.serverRead = [
            "p::a": ReadItem(unread: true, kind: "question"),
            "p::b": ReadItem(unread: false, kind: nil),
            "p::c": ReadItem(unread: true, kind: "unread"),
        ]
        #expect(app.unread == ["p::a": .question, "p::c": .unread])
        // A web read arrives for c.
        app.applyReadState("p", "c", ReadItem(readAt: 5, unread: false))
        #expect(app.unread["p::c"] == nil)
        // Raising locally is off while the gateway owns read state.
        app.raiseUnread("p", "d", .failed, at: nil)
        #expect(app.unread["p::d"] == nil)
    }
}

@Suite struct MarkdownEditingTests {
    private func press(_ text: String, at cursor: Int? = nil) -> String? {
        let at = cursor ?? text.utf16.count
        guard let e = MarkdownEditing.returnKey(in: text, selection: NSRange(location: at, length: 0)) else { return nil }
        return (text as NSString).replacingCharacters(in: e.range, with: e.text)
    }

    @Test func continuesBulletsNumbersTasksAndQuotes() {
        #expect(press("- milk") == "- milk\n- ")
        #expect(press("  * nested") == "  * nested\n  * ")
        #expect(press("9. nine") == "9. nine\n10. ")
        #expect(press("1) one") == "1) one\n2) ")
        #expect(press("- [x] done") == "- [x] done\n- [ ] ")
        #expect(press("> quoted") == "> quoted\n> ")
    }

    @Test func anEmptyItemEndsTheList() {
        #expect(press("- milk\n- ") == "- milk\n")
        #expect(press("1. one\n2. ") == "1. one\n")
        let e = MarkdownEditing.returnKey(in: "- a\n- ", selection: NSRange(location: 6, length: 0))
        #expect(e?.selection == NSRange(location: 4, length: 0))
    }

    @Test func leavesOrdinaryLinesAlone() {
        #expect(press("plain words") == nil)
        #expect(press("-dash") == nil)
        #expect(press("**bold**") == nil)
        #expect(press("1.5 litres") == nil)
        #expect(press("---") == nil)
        #expect(press("- milk", at: 1) == nil, "the cursor inside the marker is a plain newline")
    }

    @Test func splitsAnItemAndPutsTheCursorAfterTheNewMarker() {
        let e = MarkdownEditing.returnKey(in: "- milk eggs", selection: NSRange(location: 6, length: 0))
        #expect(e.map { ("- milk eggs" as NSString).replacingCharacters(in: $0.range, with: $0.text) } == "- milk\n-  eggs")
        #expect(e?.selection == NSRange(location: 9, length: 0))
    }

    @Test func renumbersTheItemsBelow() {
        #expect(press("1. a\n2. b\n   - sub\n3. c\nafter", at: 4) == "1. a\n2. \n3. b\n   - sub\n4. c\nafter")
    }

    @Test func togglesFormats() {
        func apply(_ mark: String, _ text: String, _ sel: NSRange) -> (String, NSRange) {
            let e = MarkdownEditing.toggle(mark, in: text, selection: sel)
            return ((text as NSString).replacingCharacters(in: e.range, with: e.text), e.selection)
        }
        #expect(apply("**", "make it bold", NSRange(location: 8, length: 4)) == ("make it **bold**", NSRange(location: 10, length: 4)))
        #expect(apply("**", "make it **bold**", NSRange(location: 10, length: 4)) == ("make it bold", NSRange(location: 8, length: 4)))
        #expect(apply("**", "**bold**", NSRange(location: 0, length: 8)) == ("bold", NSRange(location: 0, length: 4)))
        #expect(apply("*", "**bold**", NSRange(location: 2, length: 4)).0 == "***bold***", "italic on bold adds, never strips the bold")
        #expect(apply("*", "***both***", NSRange(location: 3, length: 4)).0 == "**both**")
        #expect(apply("`", "word ", NSRange(location: 0, length: 5)).0 == "`word` ")
        #expect(apply("**", "ab", NSRange(location: 1, length: 0)) == ("a****b", NSRange(location: 3, length: 0)))
    }

    @Test func stylesWhatItShouldAndNothingElse() {
        func styles(_ text: String) -> [(String, MarkdownEditing.Style)] {
            MarkdownEditing.spans(text).map { ((text as NSString).substring(with: $0.range), $0.style) }
        }
        let s = styles("# Plan\n- **bold** and *it* and `x*y*`\nsnake_case_name\n```\n**not bold**\n```")
        #expect(s.contains { $0 == ("Plan", .heading) })
        #expect(s.contains { $0 == ("# ", .marker) })
        #expect(s.contains { $0 == ("- ", .listMarker) })
        #expect(s.contains { $0 == ("**bold**", .bold) })
        #expect(s.contains { $0 == ("*it*", .italic) })
        #expect(s.contains { $0 == ("`x*y*`", .code) })
        #expect(!s.contains { $0 == ("*y*", .italic) }, "nothing is styled inside code")
        #expect(!s.contains { $0.0.contains("case") && $0.1 == .italic }, "snake_case is not italic")
        #expect(s.contains { $0 == ("**not bold**", .codeBlock) })
        #expect(!s.contains { $0 == ("**not bold**", .bold) }, "nothing is styled inside a fence")
    }
}

@Suite struct BotHistoryTests {
    private func row(_ role: ChatRow.Role, _ text: String, from kind: String? = nil) -> ChatRow {
        ChatRow(role: role, text: text, senderKind: kind)
    }

    /// The panel's rule (rc-chat.js botRowVisibility), turn by turn.
    @Test func showsWhatThePanelShows() {
        let rows = [
            row(.user, "Gateway digest", from: "bot_event"),
            row(.assistant, "Quiet digest reply"),
            row(.action, "Used get_activity"),
            row(.user, "Morning brief for 2026-10-22", from: "bot_brief"),
            row(.assistant, "Checking what ran overnight."),
            row(.action, "Used status_overview"),
            row(.assistant, "Good morning: two things need you."),
            row(.user, "Advisor follow-up", from: "advisor"),
            row(.assistant, "Reply to the advisor stays."),
            row(.user, "Save my preference."),
            row(.action, "Used memory_propose"),
            row(.assistant, "Not sent yet (relay checkpoint): confirm to send"),
            row(.assistant, "Saved."),
            row(.notice, "Bot status: Watching\nAll quiet"),
            row(.notice, "Bot needs you: Decide\nShip it?"),
            row(.notice, "Turn stopped."),
            row(.error, "Something failed"),
        ]
        let states = BotHistory.states(rows)
        #expect(rows.filter { states[$0.id] != .hide }.map(\.text) == [
            "Good morning: two things need you.", "Reply to the advisor stays.", "Save my preference.",
            "Used memory_propose", "Saved.", "Bot needs you: Decide\nShip it?", "Turn stopped.", "Something failed",
        ])
        #expect(rows.filter { states[$0.id] == .brief }.map(\.text) == ["Good morning: two things need you."])
    }

    @Test func aBriefStillWritingShowsItsNewestReply() {
        let trigger = row(.user, "Morning brief", from: "bot_brief"), first = row(.assistant, "Checking.")
        #expect(BotHistory.states([trigger, first])[first.id] == .brief)
        let second = row(.assistant, "Here is today.")
        let states = BotHistory.states([trigger, first, second])
        #expect(states[first.id] == .hide && states[second.id] == .brief)
    }

    @Test func knowsACheckpointOnlyAtTheStart() {
        #expect(BotHistory.isCheckpoint("Not sent yet (relay checkpoint): is this converging?"))
        #expect(BotHistory.isCheckpoint("Relay checkpoint: confirm"))
        #expect(BotHistory.isCheckpoint("not sent yet. Waiting"))
        #expect(!BotHistory.isCheckpoint("It was not sent yet: the gateway held it."))
    }
}

@MainActor @Suite struct ComposerStylingTests {
    private func font(_ view: UITextView, at i: Int) -> UIFont? {
        view.textStorage.attribute(.font, at: i, effectiveRange: nil) as? UIFont
    }

    private func type(_ s: String, at i: Int, into view: UITextView) {
        view.textStorage.replaceCharacters(in: NSRange(location: i, length: 0), with: s)
        MarkdownStyler.style(view, edited: NSRange(location: i, length: (s as NSString).length))
    }

    /// A long text restyles only the lines an edit touched, and knows when
    /// those lines sit inside a code fence further up.
    @Test func restylesOnlyTheEditedLinesOfALongText() {
        let view = PasteAwareTextView()
        let head = String(repeating: "A plain line of text in a long message.\n", count: 500)
        view.text = head + "```\ncode\n```\nafter"
        MarkdownStyler.style(view)
        let ns = { view.textStorage.string as NSString }

        let inCode = ns().range(of: "code").location + 4
        type(" **x**", at: inCode, into: view)
        let x = ns().range(of: "**x**").location + 2
        #expect(font(view, at: x)?.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) == true, "inside a fence stays code")
        #expect(font(view, at: x)?.fontDescriptor.symbolicTraits.contains(.traitBold) == false)

        type(" **y**", at: ns().length, into: view)
        #expect(font(view, at: ns().length - 3)?.fontDescriptor.symbolicTraits.contains(.traitBold) == true, "after the fence, bold")

        let clock = ContinuousClock()
        let full = clock.measure { for _ in 0..<20 { MarkdownStyler.style(view) } }
        let part = clock.measure { for _ in 0..<20 { type("z", at: ns().length, into: view) } }
        print("STYLE-TIMING full=\(full / 20) partial=\(part / 20) length=\(ns().length)")
        #expect(part < full, "an edit costs less than the whole text")
    }
}
