import Foundation
import Testing
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

    @Test func mapsHistoryRoles() {
        let decode = { (json: String) in try! JSONDecoder().decode(HistoryEntry.self, from: Data(json.utf8)) }
        #expect(ConversationModel.row(decode(#"{"role":"model","text":"opus"}"#))?.text == "Model · opus")
        #expect(ConversationModel.row(decode(#"{"role":"assistant","text":""}"#)) == nil)
        let user = ConversationModel.row(decode(#"{"role":"user","text":"hi","sender":{"kind":"automation"},"attachments":[{"name":"a.png","type":"image/png","url":"/api/x"}]}"#))
        #expect(user?.sender == "Scheduled task")
        #expect(user?.attachments.first?.isImage == true)
    }
}
