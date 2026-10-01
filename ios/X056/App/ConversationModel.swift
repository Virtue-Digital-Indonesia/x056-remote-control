import Foundation
import Observation

/// A card in the chat that is not a message: a Jev pick, an advisor
/// consultation, a delegate report.
enum ChatCard: Equatable {
    case decision(JevDecision)
    case advisor(title: String, detail: String?)
    case delegate(role: String, gate: String?, text: String)
}

struct ChatRow: Identifiable, Equatable {
    enum Role { case user, assistant, action, error, notice, card }
    /// Kept across history reloads (`keepingIDs`), so the list keeps its
    /// layout and an open step list stays open.
    var id = UUID()
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
    var card: ChatCard?
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
    enum SendMode { case send, queue, steer }

    let projectId: String
    private(set) var sessionId: String?

    var rows: [ChatRow] = []
    var loading = false
    var loadingOlder = false
    /// Counts sends from this phone; the view follows to the end on each.
    var sendCount = 0
    var loadError: String?
    var done = false
    var sendError: String?
    /// The tool call in progress, for the working line.
    var activity: String?
    /// A supervisor line worth showing above the composer (failover, parked…).
    var banner: String?
    /// The model the running turn's CLI resolved (`active_model`).
    var activeModel: String?
    /// Choices for a conversation not created yet.
    var draftModel = ""
    var draftEffort = ""
    var draftAccount: String?

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
    var isWorking: Bool { isRunning || isBackground }
    var question: PendingQuestion? { sessionId.flatMap { app.questions[$0] } }
    var queued: [QueueItem] { sessionId.map { app.queued(projectId, $0) } ?? [] }
    var model: String { sessionId == nil ? draftModel : (conversation?.model ?? "") }
    var effort: String { sessionId == nil ? draftEffort : (conversation?.effort ?? "") }
    var helpers: Helpers { conversation?.effectiveHelpers ?? Helpers() }
    var routerOn: Bool { helpers.router != nil }
    var isChat: Bool { project?.isChat ?? false }

    /// The newest Jev / Decisions pick in this conversation.
    var latestPick: JevDecision? {
        for r in rows.reversed() { if case .decision(let d) = r.card { return d } }
        return nil
    }

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
        // Fresh ids for every row made the list drop each measured height
        // and guess again: the last message ended under the composer, and
        // scrolling to it sprang back.
        let next = Self.keepingIDs(page.rows.compactMap(Self.row), from: rows.filter { !$0.pending && !$0.failed }) + unsent
        if next != rows { rows = next }
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

    /// A reloaded page's rows take the ids of the rows they repeat, matched
    /// by role, text and detail in order.
    static func keepingIDs(_ fresh: [ChatRow], from old: [ChatRow]) -> [ChatRow] {
        func key(_ r: ChatRow) -> String { "\(r.role)|\(r.text)|\(r.detail ?? "")" }
        var pool: [String: [UUID]] = [:]
        for r in old { pool[key(r), default: []].append(r.id) }
        return fresh.map { r in
            var r = r
            if var ids = pool[key(r)], !ids.isEmpty {
                r.id = ids.removeFirst()
                pool[key(r)] = ids
            }
            return r
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
        case "model": return ChatRow(role: .notice, text: "Model: \(ModelCatalog.displayName(text))")
        case "command": return ChatRow(role: .notice, text: "/\(text)" + (h.args.map { " \($0)" } ?? ""))
        case "summary": return ChatRow(role: .notice, text: "Context compacted")
        case "advisor": return card(h.advisor, fallback: text)
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

    /// A journal row with an `advisor` payload: a Jev pick, a delegate
    /// report, a ChatGPT advisor consult or a Claude advisor call.
    static func card(_ a: JSONValue?, fallback: String) -> ChatRow? {
        guard let a else { return fallback.isEmpty ? nil : ChatRow(role: .notice, text: fallback) }
        if let helper = a["helper"]?.string, var d = a["decision"]?.decode(JevDecision.self) {
            if d.backend == nil && helper == "openai" { d = d.with(backend: "openai") }
            return ChatRow(role: .card, text: fallback, card: .decision(d))
        }
        if let d = a["delegate"], let role = d["role"]?.string {
            return ChatRow(role: .card, text: fallback, card: .delegate(role: role, gate: d["gate"]?.string, text: d["text"]?.string ?? fallback))
        }
        if let verdict = a["verdict"]?.string {
            return ChatRow(role: .card, text: fallback, card: .advisor(title: "Advisor: \(verdictLabel(verdict))", detail: a["advice"]?.string))
        }
        if let status = a["status"]?.string {
            let title = status == "reviewed" ? "Advisor reviewed this step" : status == "declined" ? "Advisor declined to advise" : "Advisor unavailable"
            return ChatRow(role: .card, text: fallback, card: .advisor(title: title, detail: a["error"]?.string))
        }
        return fallback.isEmpty ? nil : ChatRow(role: .notice, text: fallback)
    }

    static func verdictLabel(_ v: String) -> String {
        switch v {
        case "proceed": return "proceed"
        case "looks_good": return "looks good"
        case "adjust": return "adjust"
        case "concern": return "concern"
        default: return v
        }
    }

    // MARK: live events

    func apply(_ e: GatewayEvent) {
        let d = e.data
        switch e.kind {
        case "session_started":
            banner = nil
            activity = nil
            activeModel = d["model"]?.string
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
        case "active_model":
            activeModel = d["model"]?.string ?? activeModel
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
        case "jev_decision":
            if let dec = d.decode(JevDecision.self) {
                rows.append(ChatRow(role: .card, text: dec.noteLine, card: .decision(dec)))
            }
        case "advisor_call":
            if d["phase"]?.string == "done", let row = Self.card(d, fallback: "") { rows.append(row) }
        case "advisor_consult":
            if let row = Self.card(d, fallback: "") { rows.append(row) }
        case "delegate_report":
            if let role = d["role"]?.string {
                rows.append(ChatRow(role: .card, text: d["text"]?.string ?? "", card: .delegate(role: role, gate: d["gate"]?.string, text: d["text"]?.string ?? "")))
            }
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
        case "limit_detected": return "Limit reached on account \(account ?? "?"), switching accounts"
        case "parked": return "Every account is unavailable. The turn is parked."
        case "waiting_for_reset": return "Waiting for an account reset. Stop cancels the wait."
        case "model_fallback": return "Account \(account ?? "?") does not have \(d["from"]?.string ?? "that model") yet, ran on \(d["to"]?.string ?? "an older one")"
        case "auth_required": return "Account \(account ?? "?") needs a fresh sign-in"
        default: return nil
        }
    }

    // MARK: actions

    /// Send, queue for after this turn, or steer into the running turn.
    func send(_ text: String, files: [PendingFile], mode: SendMode = .send) async {
        guard let client = app.client else { return }
        let prompt = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty || !files.isEmpty else { return }
        sendError = nil
        sendCount += 1
        // Steering carries no files; the gateway would queue them anyway.
        if mode == .steer, files.isEmpty, let sessionId {
            await steer(prompt, sessionId: sessionId, client: client)
            return
        }
        let requestId = UUID().uuidString.lowercased()
        rows.append(ChatRow(role: .user, text: prompt.isEmpty ? "Use the attached files." : prompt, pending: true, requestId: requestId))
        let rowId = rows[rows.count - 1].id
        do {
            var body = SendBody(prompt: prompt, projectId: projectId, sessionId: sessionId, requestId: requestId)
            // With Jev or Decisions on, Auto is sent empty so the picker
            // decides; otherwise Auto means the house default model.
            if routerOn && model.isEmpty {
                body.model = ""
                body.effort = ""
            } else {
                body.model = ModelCatalog.effectiveModel(model, provider: provider)
                body.effort = effort.isEmpty ? nil : effort
            }
            if !files.isEmpty {
                if isChat {
                    body.fileRefs = try await app.uploadChatFiles(projectId, files)
                } else {
                    body.attachments = files.map(\.upload)
                }
            }
            let reply: SendReply
            if mode == .queue || mode == .steer {
                reply = try await client.post("/api/queue", body, as: SendReply.self)
            } else if sessionId == nil {
                body.account = draftAccount
                reply = try await client.post("/api/sessions", body, as: SendReply.self)
                if let sid = reply.sessionId {
                    sessionId = sid
                    app.running.insert(sid)
                    app.setVisible(projectId: projectId, sessionId: sid)
                    app.setDraft(projectId, nil, "")
                    await app.refreshProjects()
                }
            } else {
                reply = try await client.post("/api/sessions/current/messages", body, as: SendReply.self)
            }
            if mode != .send || reply.status == "queued" {
                // The queue strip shows it now; the stream adds it when it runs.
                rows.removeAll { $0.id == rowId }
            } else if reply.status == "failed" || reply.status == "cancelled" {
                markFailed(rowId, reply.error ?? "The gateway did not accept the message.")
            }
        } catch {
            markFailed(rowId, error.localizedDescription)
        }
    }

    private func steer(_ prompt: String, sessionId: String, client: APIClient) async {
        do {
            let body = SteerBody(projectId: projectId, sessionId: sessionId, prompt: prompt)
            let reply = try await client.post("/api/steer", body, as: SteerReply.self)
            if reply.steered == true {
                rows.append(ChatRow(role: .user, text: prompt, sender: "Steered into the running turn"))
            } else {
                banner = "No live process to steer, so it was queued instead."
            }
        } catch {
            sendError = error.localizedDescription
        }
    }

    private func markFailed(_ id: UUID, _ message: String) {
        if let i = rows.firstIndex(where: { $0.id == id }) {
            rows[i].pending = false
            rows[i].failed = true
        }
        sendError = message
    }

    /// Stop the turn, or interrupt background work and keep the queue.
    func stop() async {
        guard let sessionId else { return }
        await app.stop(projectId: projectId, sessionId: sessionId)
    }

    func dismissQuestion() async {
        guard let q = question else { return }
        await app.dismissQuestion(q)
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

    func setHelpers(_ h: Helpers) async {
        guard let sessionId else { return }
        do {
            try await app.setHelpers(projectId, sessionId, h)
        } catch {
            sendError = error.localizedDescription
        }
    }
}

extension JevDecision {
    func with(backend: String) -> JevDecision {
        JevDecision(at: at, backend: backend, model: model, effort: effort, pickedModel: pickedModel, pickedEffort: pickedEffort,
                    modelConfidence: modelConfidence, effortConfidence: effortConfidence, notes: notes, lean: lean, auto: auto,
                    baseModel: baseModel, baseEffort: baseEffort, latencyMs: latencyMs, error: error, team: team)
    }
}
