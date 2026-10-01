import Foundation
import Observation

struct ChatRow: Identifiable, Equatable {
    enum Role { case user, assistant, action, error, notice, advisor }
    let id = UUID()
    var role: Role
    var text: String
    var detail: String?
    var attachments: [AttachmentRef] = []
    var sender: String?
    /// Sent from this phone, not yet seen in the stream.
    var pending = false
    var failed = false
    var requestId: String?
    /// An action whose tool call has not returned.
    var inFlight = false
    var toolUseId: String?
}

/// What the list draws: a row, or a run of consecutive tool calls folded together.
enum DisplayItem: Identifiable {
    case row(ChatRow)
    case steps([ChatRow])

    var id: UUID {
        switch self {
        case .row(let r): return r.id
        case .steps(let rs): return rs[0].id
        }
    }
}

@MainActor @Observable
final class ConversationModel {
    let projectId: String
    private(set) var sessionId: String?

    var rows: [ChatRow] = []
    var loading = false
    var loadingOlder = false
    var loadError: String?
    var done = false
    var sendError: String?
    /// The tool call in progress, for the working line.
    var activity: String?
    /// A supervisor line worth showing above the composer (failover, parked…).
    var banner: String?

    /// Model/effort for a conversation not created yet.
    var draftModel = ""
    var draftEffort = ""

    @ObservationIgnored private var cursor: Int?
    @ObservationIgnored let app: AppModel

    init(projectId: String, sessionId: String?, app: AppModel = .shared) {
        self.projectId = projectId
        self.sessionId = sessionId
        self.app = app
    }

    var project: Project? { app.project(projectId) }
    var conversation: Conversation? { sessionId.flatMap { app.conversation(projectId, $0) } }
    var provider: String { conversation?.provider ?? project?.providerName ?? "claude" }
    var isRunning: Bool { sessionId.map { app.running.contains($0) } ?? false }
    var isBackground: Bool { sessionId.map { app.background.contains($0) && !app.running.contains($0) } ?? false }
    var question: PendingQuestion? { sessionId.flatMap { app.questions[$0] } }
    var queued: [QueueItem] { sessionId.map { app.queued(projectId, $0) } ?? [] }
    var model: String { sessionId == nil ? draftModel : (conversation?.model ?? "") }
    var effort: String { sessionId == nil ? draftEffort : (conversation?.effort ?? "") }

    var items: [DisplayItem] {
        var out: [DisplayItem] = []
        var run: [ChatRow] = []
        for r in rows {
            if r.role == .action { run.append(r); continue }
            if !run.isEmpty { out.append(.steps(run)); run = [] }
            out.append(.row(r))
        }
        if !run.isEmpty { out.append(.steps(run)) }
        return out
    }

    // MARK: history

    func load() async {
        guard let sessionId, let client = app.client, rows.isEmpty, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await client.get("/api/conversations/history-page", query: ["projectId": projectId, "sessionId": sessionId, "limit": "80"], as: HistoryPage.self)
            rows = page.rows.compactMap(Self.row)
            cursor = page.cursor
            done = page.done ?? true
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// After a reconnect: the newest page is the truth; events from here on add to it.
    func reload() async {
        guard let sessionId, let client = app.client else { return }
        guard let page = try? await client.get("/api/conversations/history-page", query: ["projectId": projectId, "sessionId": sessionId, "limit": "80"], as: HistoryPage.self) else { return }
        let unsent = rows.filter { $0.pending || $0.failed }
        rows = page.rows.compactMap(Self.row) + unsent
        cursor = page.cursor
        done = page.done ?? true
    }

    func loadOlder() async {
        guard let sessionId, let client = app.client, let cursor, !done, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await client.get("/api/conversations/history-page", query: ["projectId": projectId, "sessionId": sessionId, "limit": "60", "before": String(cursor)], as: HistoryPage.self)
            rows = page.rows.compactMap(Self.row) + rows
            self.cursor = page.cursor
            done = page.done ?? true
        } catch {
            loadError = error.localizedDescription
        }
    }

    static func row(_ h: HistoryEntry) -> ChatRow? {
        let text = h.text ?? ""
        let sender = h.sender.flatMap(senderLabel)
        switch h.role {
        case "user": return ChatRow(role: .user, text: text, attachments: h.attachments ?? [], sender: sender)
        case "assistant": return text.isEmpty ? nil : ChatRow(role: .assistant, text: text)
        case "action": return ChatRow(role: .action, text: text, detail: h.detail)
        case "error": return ChatRow(role: .error, text: text)
        case "model": return ChatRow(role: .notice, text: "Model · \(text)")
        case "command": return ChatRow(role: .notice, text: "/\(text)" + (h.args.map { " \($0)" } ?? ""))
        case "summary": return ChatRow(role: .notice, text: "Context compacted")
        case "advisor": return ChatRow(role: .advisor, text: advisorText(h.advisor, fallback: text))
        default: return text.isEmpty ? nil : ChatRow(role: .notice, text: text)
        }
    }

    static func senderLabel(_ s: Sender) -> String? {
        switch s.kind {
        case "conversation": return "From \(s.conversationTitle ?? s.projectName ?? "another conversation")"
        case "automation": return "Scheduled task"
        case "autopilot": return "Autopilot"
        case "mcp": return "Via MCP"
        case "advisor": return "Advisor"
        case "delegate": return "Delegate reports"
        default: return nil
        }
    }

    static func advisorText(_ a: JSONValue?, fallback: String) -> String {
        guard let a else { return fallback.isEmpty ? "Advisor" : fallback }
        if a["helper"]?.string != nil {
            let model = a["decision"]?["pickedModel"]?.string ?? a["decision"]?["model"]?.string
            let effort = a["decision"]?["pickedEffort"]?.string ?? a["decision"]?["effort"]?.string
            return (["Jev"] + [model, effort].compactMap { $0 }).joined(separator: " · ")
        }
        if let d = a["delegate"], let role = d["role"]?.string {
            return "Delegate \(role) · \(d["gate"]?.string ?? d["status"]?.string ?? "")"
        }
        if let verdict = a["verdict"]?.string {
            let advice = a["advice"]?.string.map { " · \($0)" } ?? ""
            return "Advisor · \(verdict)\(advice)"
        }
        if let status = a["status"]?.string { return "Advisor · \(status)" }
        return fallback.isEmpty ? "Advisor" : fallback
    }

    // MARK: live events

    func apply(_ e: GatewayEvent) {
        let d = e.data
        switch e.kind {
        case "session_started":
            banner = nil
            activity = nil
            let text = d["displayPrompt"]?.string ?? d["prompt"]?.string ?? ""
            let reqId = d["requestId"]?.string
            if let i = rows.firstIndex(where: { $0.pending && ($0.requestId == reqId || $0.text == text) }) ?? rows.firstIndex(where: \.pending) {
                rows[i].pending = false
            } else if !repeatsTail(.user, text) {
                let attachments = d["attachments"]?.decode([AttachmentRef].self) ?? []
                let sender = d["sender"]?.decode(Sender.self).flatMap(Self.senderLabel)
                rows.append(ChatRow(role: .user, text: text, attachments: attachments, sender: sender))
            }
        case "assistant_text":
            if let text = d["text"]?.string, !text.isEmpty, !repeatsTail(.assistant, text) {
                rows.append(ChatRow(role: .assistant, text: text))
            }
        case "activity":
            guard let a = d.decode(ActivityEvent.self), a.parentToolUseId == nil else { return }
            let label = a.label ?? a.tool ?? "Tool"
            if let i = rows.lastIndex(where: { $0.toolUseId == a.toolUseId }) {
                rows[i].inFlight = a.status == "start"
                if a.status == "error" { rows[i].failed = true }
            } else {
                rows.append(ChatRow(role: .action, text: label, detail: a.detail, failed: a.status == "error", inFlight: a.status == "start", toolUseId: a.toolUseId))
            }
            activity = a.status == "start" ? label : nil
        case "session_done", "conversation_settled":
            activity = nil
            for i in rows.indices where rows[i].inFlight { rows[i].inFlight = false }
            let status = d["status"]?.string ?? ""
            if status == "failed" || status == "parked", let reason = d["reason"]?.string, !repeatsTail(.error, reason) {
                rows.append(ChatRow(role: .error, text: reason))
            }
        case "session_error", "message_rejected":
            activity = nil
            if e.kind == "message_rejected", let i = rows.lastIndex(where: \.pending) {
                rows[i].pending = false
                rows[i].failed = true
            }
            if let m = d["message"]?.string, !repeatsTail(.error, m) { rows.append(ChatRow(role: .error, text: m)) }
        case "supervisor":
            banner = Self.supervisorLine(d) ?? banner
        default:
            break
        }
    }

    /// The stream can replay an event the history page already holds.
    private func repeatsTail(_ role: ChatRow.Role, _ text: String) -> Bool {
        rows.suffix(8).contains { $0.role == role && $0.text == text }
    }

    static func supervisorLine(_ d: JSONValue) -> String? {
        let account = d["account"]?.string
        switch d["type"]?.string {
        case "failover": return "Switched account" + (d["from"]?.string.map { " from \($0)" } ?? "")
        case "limit_detected": return "Usage limit on account \(account ?? "?")"
        case "parked", "waiting_for_reset": return "Waiting for a usage reset"
        case "model_fallback": return "Running on \(d["to"]?.string ?? "an older model") on account \(account ?? "?")"
        case "auth_required": return "Account \(account ?? "?") needs a fresh sign-in"
        case "turn_started": return nil
        default: return nil
        }
    }

    // MARK: actions

    func send(_ text: String, images: [Data]) async {
        guard let client = app.client else { return }
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !images.isEmpty else { return }
        sendError = nil
        let requestId = UUID().uuidString.lowercased()
        let uploads = images.enumerated().map { i, data in
            UploadAttachment(name: "photo-\(i + 1).jpg", data: "data:image/jpeg;base64," + data.base64EncodedString())
        }
        rows.append(ChatRow(role: .user, text: prompt.isEmpty ? "Use the attached files." : prompt, pending: true, requestId: requestId))
        let rowId = rows[rows.count - 1].id
        let effortValue = effort.isEmpty ? nil : effort
        var body = SendBody(prompt: prompt, projectId: projectId, sessionId: sessionId,
                            model: ModelCatalog.effectiveModel(model, provider: provider), effort: effortValue,
                            requestId: requestId, attachments: uploads.isEmpty ? nil : uploads)
        do {
            let reply: SendReply
            if sessionId == nil {
                body.sessionId = nil
                reply = try await client.post("/api/sessions", body, as: SendReply.self)
                if let sid = reply.sessionId {
                    sessionId = sid
                    app.running.insert(sid)
                    app.visibleSessionId = sid
                    await app.refreshProjects()
                }
            } else {
                reply = try await client.post("/api/sessions/current/messages", body, as: SendReply.self)
            }
            switch reply.status {
            case "queued":
                // The queue strip shows it now; the stream adds it when it runs.
                rows.removeAll { $0.id == rowId }
            case "failed", "cancelled":
                markFailed(rowId, reply.error ?? "The gateway did not accept the message.")
            default:
                break
            }
        } catch {
            markFailed(rowId, error.localizedDescription)
        }
    }

    private func markFailed(_ id: UUID, _ message: String) {
        if let i = rows.firstIndex(where: { $0.id == id }) {
            rows[i].pending = false
            rows[i].failed = true
        }
        sendError = message
    }

    /// Stop the turn. With no turn running, interrupt background work instead
    /// (the stop route answers 409 there) and keep the queue.
    func stop() async {
        guard let sessionId, let client = app.client else { return }
        do {
            try await client.post("/api/sessions/current/stop", ConversationRef(projectId: projectId, sessionId: sessionId))
        } catch let e as APIError where e.status == 409 {
            _ = try? await client.post("/api/conversations/halt", HaltBody(projectId: projectId, sessionId: sessionId, dropQueued: false))
        } catch {
            sendError = error.localizedDescription
        }
    }

    func dismissQuestion() async {
        guard let q = question, let client = app.client else { return }
        _ = try? await client.post("/api/questions/dismiss", DismissQuestionBody(projectId: q.projectId, sessionId: q.sessionId, at: q.at))
        app.questions[q.sessionId] = nil
    }

    func cancelQueued(_ id: String) async {
        guard let client = app.client else { return }
        _ = try? await client.post("/api/queue/remove", QueueRemoveBody(projectId: projectId, id: id))
        app.queues[projectId]?.removeAll { $0.id == id }
    }

    func setPreferences(model: String, effort: String) async {
        guard let sessionId else {
            draftModel = model
            draftEffort = effort
            return
        }
        guard let client = app.client else { return }
        do {
            try await client.post("/api/conversations/preferences", PreferencesBody(projectId: projectId, sessionId: sessionId, model: model, effort: effort))
            app.updateConversation(projectId, sessionId) { $0.model = model; $0.effort = effort }
        } catch {
            sendError = error.localizedDescription
        }
    }
}
