import SwiftUI

/// One CLI-style line of a transcript, as the panel's terminal view draws it.
struct TranscriptLine: Identifiable, Hashable, Sendable {
    enum Kind: String, Sendable { case user, text, think, tool, result, err, sys, meta, advisor }
    let id: String
    let kind: Kind
    let glyph: String
    let text: String
    /// The entry's byte offset, to fetch it whole.
    let offset: Int
    var truncated = false
    /// Model and tokens, on an assistant entry's last line.
    var tag: String?

    var quiet: Bool { kind == .sys || kind == .meta }
}

/// Raw transcript entries to lines, for both providers. A port of
/// `claudeLines` / `codexLines` in server/public/terminal.js.
enum Transcript {
    nonisolated static func lines(_ entry: RawPage.Entry, provider: String?) -> [TranscriptLine] {
        var out: [(TranscriptLine.Kind, String, String)] = []
        var tag: String?
        let l = entry.line
        func add(_ k: TranscriptLine.Kind, _ g: String, _ t: String) { out.append((k, g, t)) }
        if provider == "codex" {
            let p = l["payload"] ?? .null
            let type = p["type"]?.string ?? ""
            switch l["type"]?.string {
            case "response_item":
                if type == "message" {
                    let role = p["role"]?.string ?? ""
                    let text = (p["content"]?.array ?? []).map { $0["text"]?.string ?? $0["input_text"]?.string ?? "" }.joined()
                    switch role {
                    case "user": add(.user, "❯", text)
                    case "assistant": add(.text, "●", text)
                    default: add(.meta, "·", role + ": " + text)
                    }
                } else if type == "reasoning" {
                    let sum = (p["summary"]?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: " ")
                    add(.think, "✻", sum.isEmpty ? "reasoning (encrypted)" : "reasoning · " + sum)
                } else if type.hasSuffix("_output") {
                    let text = resultText(p["output"])
                    add(.result, "⎿", text.isEmpty ? "(no output)" : text)
                } else if type.hasSuffix("call") {
                    add(.tool, "●", (p["name"]?.string ?? type) + "(" + compact(p["arguments"] ?? p["input"] ?? p["action"]) + ")")
                } else {
                    add(.meta, "·", type.isEmpty ? "item" : type)
                }
            case "event_msg":
                switch type {
                case "task_started": add(.sys, "·", "turn started")
                case "task_complete": add(.sys, "✓", "turn complete")
                case "error": add(.err, "✗", p["message"]?.string ?? "error")
                case "token_count":
                    if let u = p["info"]?["last_token_usage"] {
                        add(.meta, "·", "tokens · in \(num(u["input_tokens"])) · out \(num(u["output_tokens"]))")
                    } else { add(.meta, "·", type) }
                default: add(.meta, "·", type.isEmpty ? "event" : type)
                }
            case "turn_context":
                let parts = [p["model"]?.string, p["effort"]?.string ?? p["reasoning_effort"]?.string].compactMap { $0 }
                add(.sys, "·", "turn · " + parts.joined(separator: " · "))
            default:
                add(.meta, "·", l["type"]?.string ?? "entry")
            }
        } else {
            let type = l["type"]?.string ?? ""
            if type == "user" || type == "assistant" {
                let user = type == "user"
                let msg = l["message"] ?? .null
                if let s = msg["content"]?.string {
                    add(user ? .user : .text, user ? "❯" : "●", s)
                } else {
                    for b in msg["content"]?.array ?? [] {
                        switch b["type"]?.string {
                        case "text": add(user ? .user : .text, user ? "❯" : "●", b["text"]?.string ?? "")
                        case "thinking":
                            let t = b["thinking"]?.string ?? ""
                            add(.think, "✻", t.isEmpty ? "thinking (not shown by the API)" : "thinking · " + t)
                        case "redacted_thinking": add(.think, "✻", "thinking (redacted)")
                        case "tool_use": add(.tool, "●", (b["name"]?.string ?? "tool") + "(" + compact(b["input"]) + ")")
                        case "tool_result":
                            let text = resultText(b["content"])
                            add(b["is_error"]?.bool == true ? .err : .result, "⎿", text.isEmpty ? "(no output)" : text)
                        case "server_tool_use":
                            let name = b["name"]?.string ?? "tool"
                            add(name == "advisor" ? .advisor : .tool, "◈", name == "advisor" ? "Advising…" : name + "(" + compact(b["input"]) + ")")
                        case "advisor_tool_result": add(.advisor, "⎿", "advisor reviewed")
                        case "image": add(.meta, "▣", "image")
                        default: add(.meta, "·", b["type"]?.string ?? "block")
                        }
                    }
                }
                if !user, let u = msg["usage"] {
                    let model = (msg["model"]?.string ?? "").replacingOccurrences(of: "claude-", with: "")
                    tag = "\(model) · in \(num(u["input_tokens"])) · out \(num(u["output_tokens"]))"
                }
            } else if type == "system" {
                let sub = l["subtype"]?.string.map { " " + $0 } ?? ""
                let content = l["content"]?.string.map { ": " + $0 } ?? ""
                add(.sys, "·", "system" + sub + content)
            } else if type == "queue-operation" {
                add(.meta, "·", "queue " + (l["operation"]?.string ?? ""))
            } else {
                add(.meta, "·", type.isEmpty ? "entry" : type)
            }
        }
        return out.enumerated().map { i, x in
            TranscriptLine(id: "\(entry.at).\(i)", kind: x.0, glyph: x.1, text: x.2, offset: entry.at,
                           truncated: entry.truncated == true, tag: i == out.count - 1 ? tag : nil)
        }
    }

    /// A tool call's arguments in one short line: the field that says what it
    /// does (command, path, query...), else the JSON.
    nonisolated static func compact(_ v: JSONValue?) -> String {
        guard var v else { return "" }
        if case .string(let s) = v {
            guard let data = s.data(using: .utf8), let parsed = try? JSONDecoder().decode(JSONValue.self, from: data) else { return head(s) }
            v = parsed
        }
        guard case .object = v else { return head(describe(v)) }
        for key in ["command", "cmd", "file_path", "path", "pattern", "url", "query", "description", "prompt"] {
            if let pick = v[key] {
                if let a = pick.array { return head(a.map(describe).joined(separator: " ")) }
                return head(describe(pick))
            }
        }
        return head(describe(v))
    }

    nonisolated static func resultText(_ c: JSONValue?) -> String {
        guard let c else { return "" }
        switch c {
        case .string(let s):
            if let data = s.data(using: .utf8), let j = try? JSONDecoder().decode(JSONValue.self, from: data), let o = j["output"]?.string { return o }
            return s
        case .array(let a):
            return a.map { $0["text"]?.string ?? ($0["type"]?.string == "image" ? "[image]" : "") }.joined(separator: "\n")
        case .object:
            return c["output"]?.string ?? describe(c)
        default:
            return describe(c)
        }
    }

    nonisolated static func describe(_ v: JSONValue) -> String {
        switch v {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return String(b)
        case .null: return "null"
        default:
            let enc = JSONEncoder()
            enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            return (try? enc.encode(v)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
        }
    }

    private nonisolated static func head(_ s: String, _ n: Int = 160) -> String {
        let one = s.replacingOccurrences(of: "\n", with: " ")
        return one.count > n ? String(one.prefix(n)) + "…" : one
    }

    private nonisolated static func num(_ v: JSONValue?) -> String {
        guard let n = v?.number else { return "0" }
        return n >= 1000 ? String(format: "%.1fk", n / 1000) : String(Int(n))
    }
}

/// The conversation's own transcript, CLI-style: every prompt, tool call and
/// its output, error and system line. Shows what a turn actually did, which
/// the chat's step labels do not.
struct TranscriptView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let sessionId: String
    var title: String = "Transcript"

    @State private var lines: [TranscriptLine] = []
    @State private var provider: String?
    @State private var start = 0
    @State private var end = 0
    @State private var done = true
    @State private var loading = true
    @State private var loadingOlder = false
    @State private var error: String?
    @State private var showQuiet = false
    @State private var expanded: Set<String> = []
    @State private var position = ScrollPosition(edge: .bottom)

    private var visible: [TranscriptLine] { showQuiet ? lines : lines.filter { !$0.quiet } }
    private var lastError: TranscriptLine? { lines.last { $0.kind == .err } }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if !done {
                        Button {
                            Task { await loadOlder() }
                        } label: {
                            if loadingOlder { ProgressView() } else { Text("Show earlier lines") }
                        }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, 6)
                    }
                    ForEach(visible) { line in
                        TranscriptRow(line: line, expanded: expanded.contains(line.id), projectId: projectId, sessionId: sessionId) {
                            if expanded.contains(line.id) { expanded.remove(line.id) } else { expanded.insert(line.id) }
                        }
                        .id(line.id)
                    }
                }
                .scrollTargetLayout()
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
            }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .background(Color(white: 0.07))
            .overlay {
                if loading && lines.isEmpty {
                    ProgressView()
                } else if let error, lines.isEmpty {
                    ContentUnavailableView("Couldn't load the transcript", systemImage: "terminal", description: Text(error))
                } else if lines.isEmpty {
                    ContentUnavailableView("No transcript yet", systemImage: "terminal", description: Text("It starts with the first turn."))
                }
            }
            .navigationTitle(title)
            .navigationSubtitle(provider == "codex" ? "ChatGPT · Codex rollout" : "Claude Code transcript")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu("Options", systemImage: "line.3.horizontal.decrease") {
                        Toggle("Show system lines", systemImage: "gearshape", isOn: $showQuiet)
                        if let lastError {
                            Button("Jump to the last error", systemImage: "exclamationmark.triangle") {
                                expanded.insert(lastError.id)
                                withAnimation { position.scrollTo(id: lastError.id, anchor: .center) }
                            }
                        }
                        Button("Jump to the end", systemImage: "arrow.down.to.line") {
                            withAnimation { position.scrollTo(edge: .bottom) }
                        }
                    }
                }
            }
            .task { await follow() }
        }
        .environment(\.colorScheme, .dark)
    }

    /// The newest page, then whatever is appended, every 2 s while open.
    private func follow() async {
        guard let client = app.client else { return }
        do {
            let page = try await client.get("/api/conversations/raw-page", query: ["projectId": projectId, "sessionId": sessionId, "limit": "300"], as: RawPage.self)
            apply(page, older: false)
            position.scrollTo(edge: .bottom)
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled,
                  let page = try? await client.get("/api/conversations/raw-page", query: ["projectId": projectId, "sessionId": sessionId, "after": String(end), "limit": "500"], as: RawPage.self),
                  !page.entries.isEmpty else { continue }
            let atEnd = lines.last.map { last in visible.last?.id == last.id } ?? true
            apply(page, older: false)
            if atEnd { withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) } }
        }
    }

    private func loadOlder() async {
        guard let client = app.client, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        let anchor = visible.first?.id
        if let page = try? await client.get("/api/conversations/raw-page", query: ["projectId": projectId, "sessionId": sessionId, "before": String(start), "limit": "300"], as: RawPage.self) {
            apply(page, older: true)
            if let anchor { position.scrollTo(id: anchor, anchor: .top) }
        }
    }

    private func apply(_ page: RawPage, older: Bool) {
        provider = page.provider ?? provider
        let new = page.entries.flatMap { Transcript.lines($0, provider: page.provider) }
        if older {
            lines = new + lines
            start = page.start
            done = page.done
        } else if lines.isEmpty {
            lines = new
            start = page.start
            end = page.end
            done = page.done
        } else {
            lines += new
            end = page.end
        }
    }
}

struct TranscriptRow: View {
    @Environment(AppModel.self) private var app
    let line: TranscriptLine
    let expanded: Bool
    let projectId: String
    let sessionId: String
    let toggle: () -> Void
    @State private var full: String?

    private var color: Color {
        switch line.kind {
        case .user: return Palette.clay
        case .text: return .primary
        case .think: return .secondary
        case .tool: return .cyan
        case .result: return Color(white: 0.62)
        case .err: return .red
        case .sys, .meta: return Color(white: 0.45)
        case .advisor: return RoleColor.advisor
        }
    }

    /// Output is long; it shows a few lines until opened.
    private var limit: Int? {
        if expanded { return nil }
        switch line.kind {
        case .result, .think: return 4
        case .err: return 8
        default: return 12
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(line.glyph)
                    .foregroundStyle(color)
                    .frame(width: 14, alignment: .center)
                Text(line.text)
                    .foregroundStyle(color)
                    .italic(line.kind == .think)
                    .lineLimit(limit)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let tag = line.tag {
                Text(tag)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Color(white: 0.4))
                    .padding(.leading, 22)
            }
            if expanded, line.truncated {
                if let full {
                    Text(full)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Color(white: 0.7))
                        .textSelection(.enabled)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(white: 0.12), in: .rect(cornerRadius: 8))
                } else {
                    Button("Load the whole entry") { Task { await loadFull() } }
                        .font(.caption)
                        .padding(.leading, 22)
                }
            }
        }
        .font(.system(.footnote, design: .monospaced))
        .padding(.vertical, line.kind == .user ? 6 : 1)
        .contentShape(.rect)
        .onTapGesture { withAnimation(.snappy) { toggle() } }
        .contextMenu {
            Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = line.text }
        }
    }

    private func loadFull() async {
        guard let client = app.client else { return }
        if let entry = try? await client.get("/api/conversations/raw-entry", query: ["projectId": projectId, "sessionId": sessionId, "offset": String(line.offset)], as: JSONValue.self) {
            let enc = JSONEncoder()
            enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
            full = (try? enc.encode(entry)).flatMap { String(data: $0, encoding: .utf8) }
        }
    }
}
