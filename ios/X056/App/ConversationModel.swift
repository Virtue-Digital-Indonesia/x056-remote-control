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
    /// Who sent a user row (`bot_event`, `bot_brief`, `advisor`, ...); nil for a person.
    var senderKind: String?
    /// Sent from this phone, not yet seen in the stream.
    var pending = false
    var failed = false
    var requestId: String?
    /// An action whose tool call has not returned.
    var inFlight = false
    var toolUseId: String?
    var card: ChatCard?
    /// The Bot's chat: the server's "show" / "hide" for this row, and "brief"
    /// on the last reply of a morning-brief turn.
    var botView: String?
    var botLabel: String?
    /// The Bot spoke to the owner on purpose; `needsYou` says it wants an answer.
    var ownerMessage = false
    var needsYou = false
    /// A turn another conversation, a delegate or a schedule started, which the
    /// owner did not ask for: folded away until "Show hidden messages", unless
    /// the turn was marked for the owner.
    var ownerHidden = false
    /// The messageId of the message that started this row's turn (an agent's).
    var turnId: String?
    /// On an agent turn's reply: who it replies to.
    var replyTo: String?
    /// The journal's messageId, where a live line must not repeat its history
    /// row (`question-action:<id>`, `session-reset:<id>`).
    var messageId: String?
}

/// The Bot chat keeps quiet by default. This is the panel's rule, row for
/// row (rc-chat.js botRowVisibility / botRowKind, whose comment is the spec):
/// a turn starts at each user row and takes its sender kind; "keep" rows (an
/// error, "Bot needs you:") always show; "system" rows (a relay checkpoint,
/// "Bot status:") always hide; a digest turn (`bot_event`) hides everything;
/// a morning-brief turn (`bot_brief`) shows only its last reply, as the
/// brief; an advisor turn hides only its trigger; anything else shows.
enum BotHistory {
    /// The turn kinds that are the gateway or a helper talking to the Bot.
    static let turnKinds: Set<String> = ["bot_event", "bot_brief", "advisor"]
    /// Queue items the person never needs to see waiting.
    static let quietQueue: Set<String> = ["bot_event", "bot_brief"]

    enum RowKind { case keep, system, trigger, reply, tool, other }
    /// A row that is not plainly shown: hidden until "Show system messages",
    /// or the morning brief.
    enum State { case show, hide, brief }

    static func kind(_ r: ChatRow) -> RowKind {
        if r.role == .error { return .keep }
        if r.role == .notice {
            if r.text.hasPrefix("Bot needs you:") { return .keep }
            if r.text.hasPrefix("Bot status:") { return .system }
        }
        if r.role == .user { return .trigger }
        if isCheckpoint(r.text) { return .system }
        switch r.role {
        case .assistant: return .reply
        case .action: return .tool
        default: return .other
        }
    }

    /// `lastReply` matters only in a brief turn: earlier replies are the
    /// Bot's commentary before its tools.
    static func visibility(_ kind: RowKind, turn: String, lastReply: Bool = true) -> State {
        switch kind {
        case .keep: return .show
        case .system: return .hide
        default: break
        }
        switch turn {
        case "bot_event": return .hide
        case "bot_brief": return kind == .reply && lastReply ? .brief : .hide
        case "advisor": return kind == .trigger ? .hide : .show
        default: return .show
        }
    }

    /// Every row that is not plainly shown, by id.
    static func states(_ rows: [ChatRow]) -> [UUID: State] {
        var out: [UUID: State] = [:]
        var turn = ""
        var brief: UUID?
        for r in rows {
            let k = kind(r)
            if k == .trigger {
                if let b = brief { out[b] = .brief }
                brief = nil
                turn = turnKinds.contains(r.senderKind ?? "") ? r.senderKind ?? "" : ""
            }
            if turn == "bot_brief", k == .reply {
                // A newer reply makes the one before it commentary.
                if let b = brief { out[b] = visibility(.reply, turn: turn, lastReply: false) }
                brief = r.id
                continue
            }
            let v = visibility(k, turn: turn)
            if v != .show { out[r.id] = v }
        }
        if let b = brief { out[b] = .brief }
        return out
    }

    /// "Not sent yet (relay checkpoint): ...": the gateway holding a send.
    /// Only the start counts, so a long reply is not scanned.
    static func isCheckpoint(_ text: String) -> Bool {
        let head = text.prefix(48)
        guard let first = head.first, "NnRr".contains(first) else { return false }
        return head.range(of: #"^(?:Not sent yet(?: \(relay checkpoint\))?[:.]|Relay checkpoint[:.])"#, options: [.regularExpression, .caseInsensitive]) != nil
    }
}

/// What the list draws: a row, or a run of consecutive tool calls folded together.
enum DisplayItem: Identifiable, Equatable {
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

    /// Start a Live Activity when this phone sends. Off for the Bot: its
    /// answers take seconds, and the Lock Screen is for long work.
    var liveActivity = true

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
    var isBot: Bool { project?.isBot ?? false }
    /// The Bot's system rows, folded away until asked for (BotHistory).
    var showSystemHistory = false
    /// How each of the Bot's rows shows; empty elsewhere. The gateway's own
    /// `botView` decides where a row has one (history); the port in
    /// BotHistory covers the rows that arrived live. An agent turn the live
    /// rule hid stays hidden.
    var botStates: [UUID: BotHistory.State] {
        guard isBot else { return [:] }
        let local = BotHistory.states(rows)
        var out: [UUID: BotHistory.State] = [:]
        for r in rows {
            if r.ownerHidden {
                out[r.id] = .hide
            } else if let v = r.botView {
                if v == "hide" { out[r.id] = .hide } else if r.botLabel == "brief" { out[r.id] = .brief }
            } else if let s = local[r.id] {
                out[r.id] = s
            }
        }
        return out
    }
    /// The rows folded away until "Show hidden messages": the Bot's
    /// `botStates`, in any other conversation the agent turns the owner did
    /// not ask for.
    var hiddenIDs: Set<UUID> {
        if isBot { return Set(botStates.filter { $0.value == .hide }.keys) }
        return Set(rows.filter(\.ownerHidden).map(\.id))
    }
    /// How many messages that is (tool calls are not counted).
    var hiddenCount: Int {
        let ids = hiddenIDs
        return ids.isEmpty ? 0 : rows.filter { ids.contains($0.id) && $0.role != .action }.count
    }
    /// The turn the live stream is in: its trigger's messageId, whether the
    /// owner sees it, and who started it. Nil outside an agent turn.
    @ObservationIgnored private var liveTurn: (id: String?, sender: String?)?
    var queued: [QueueItem] { sessionId.map { app.queued(projectId, $0) } ?? [] }
    var model: String { sessionId == nil ? draftModel : (conversation?.model ?? "") }
    var effort: String { sessionId == nil ? draftEffort : (conversation?.effort ?? "") }
    var helpers: Helpers { conversation?.effectiveHelpers ?? Helpers() }
    /// The picker that runs: Jev by default unless "Your choice" was saved.
    var router: String? { app.effectiveRouter(helpers, conversation) }
    var routerOn: Bool { router != nil }
    var isChat: Bool { project?.isChat ?? false }

    /// The newest Jev / Decisions pick in this conversation.
    var latestPick: JevDecision? {
        for r in rows.reversed() { if case .decision(let d) = r.card { return d } }
        return nil
    }

    var items: [DisplayItem] {
        var out: [DisplayItem] = []
        var run: [ChatRow] = []
        let hidden = showSystemHistory ? [] : hiddenIDs
        for r in rows where !hidden.contains(r.id) {
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
            rows = Self.rows(page.rows)
            restoreLiveTurn()
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
        let next = Self.keepingIDs(Self.rows(page.rows), from: rows.filter { !$0.pending && !$0.failed }) + unsent
        if next != rows { rows = next }
        restoreLiveTurn()
        cursor = page.cursor
        done = page.done ?? true
    }

    func loadOlder() async {
        guard let sessionId, let client = app.client, let cursor, !done, !loadingOlder else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let page = try await client.get("/api/conversations/history-page", query: ["projectId": projectId, "sessionId": sessionId, "limit": "60", "before": String(cursor)], as: HistoryPage.self)
            rows = Self.rows(page.rows) + rows
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

    /// A page of history as rows. The gateway marks each row's `ownerView`;
    /// the trigger's messageId is carried down the turn, so a later
    /// `owner_view` / `session_done` can show the whole turn.
    static func rows(_ entries: [HistoryEntry]) -> [ChatRow] {
        var out: [ChatRow] = []
        var turn: String?
        for h in entries {
            guard var r = row(h) else { continue }
            if h.role == "user", h.steered != true {
                turn = h.ownerTurn == "agent" ? h.sender?.messageId : nil
            }
            if r.ownerHidden || r.replyTo != nil { r.turnId = turn }
            out.append(r)
        }
        return out
    }

    static func row(_ h: HistoryEntry) -> ChatRow? {
        guard var r = baseRow(h) else { return nil }
        r.messageId = h.messageId
        r.botView = h.botView
        r.botLabel = h.botLabel
        r.ownerMessage = h.ownerMessage == true
        r.needsYou = h.needsYou == true
        // An error banner is always shown, whatever the turn, and so is an
        // agent's edit or close of a question card.
        let questionAction = Self.isQuestionAction(h.messageId)
        r.ownerHidden = h.ownerView == "hide" && r.role != .error && !questionAction
        if questionAction { r.botView = "show" }
        if h.ownerTurn == "agent", r.role == .assistant { r.replyTo = h.ownerSender }
        return r
    }

    static func isQuestionAction(_ id: String?) -> Bool { id?.hasPrefix("question-action:") == true }

    private static func baseRow(_ h: HistoryEntry) -> ChatRow? {
        let text = h.text ?? ""
        let sender = h.sender.flatMap(senderLabel)
        switch h.role {
        case "user": return ChatRow(role: .user, text: text, attachments: h.attachments ?? [], sender: sender, senderKind: h.sender?.kind)
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

    /// Who started an agent's turn, for "reply to ...".
    static func ownerSenderName(_ s: Sender) -> String {
        s.conversationTitle ?? s.projectName ?? senderLabel(s)?.replacingOccurrences(of: "From ", with: "") ?? "another conversation"
    }

    /// The senders whose turns the owner did not ask for.
    static let agentKinds: Set<String> = ["conversation", "mcp", "delegate", "automation"]

    /// A row the live stream adds to the turn it is in: hidden when that turn is.
    private func inTurn(_ row: ChatRow) -> ChatRow {
        guard let t = liveTurn else { return row }
        var r = row
        r.ownerHidden = true
        r.turnId = t.id
        if r.role == .assistant { r.replyTo = t.sender }
        return r
    }

    /// Opened mid-turn: when the running turn was started by an agent (the last
    /// real user row is a hidden trigger), the rest of it stays hidden too.
    private func restoreLiveTurn() {
        guard isRunning, liveTurn == nil,
              let t = rows.last(where: { $0.role == .user && !($0.ownerHidden && $0.turnId == nil) }),
              t.ownerHidden, let id = t.turnId else { return }
        liveTurn = (id, t.sender?.replacingOccurrences(of: "From ", with: ""))
    }

    /// The turn `id` is for the owner after all: show its rows.
    private func showTurn(_ id: String) {
        for i in rows.indices where rows[i].turnId == id && rows[i].ownerHidden { rows[i].ownerHidden = false }
        if liveTurn?.id == id { liveTurn = nil }
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
            let from = d["sender"]?.decode(Sender.self)
            // An agent's message (not this conversation talking to itself) starts
            // a turn the owner does not see unless it is marked for them.
            var hidden = false
            if let from, let kind = from.kind, Self.agentKinds.contains(kind), from.sessionId != sessionId {
                liveTurn = (from.messageId, Self.ownerSenderName(from))
                hidden = true
            } else {
                liveTurn = nil
            }
            if let i = rows.firstIndex(where: { $0.pending && ($0.requestId == reqId || $0.text == text) }) ?? (hidden ? nil : rows.firstIndex(where: \.pending)) {
                rows[i].pending = false
            } else if !repeatsTail(.user, text) {
                let attachments = d["attachments"]?.decode([AttachmentRef].self) ?? []
                var row = ChatRow(role: .user, text: text, attachments: attachments, sender: from.flatMap(Self.senderLabel), senderKind: from?.kind)
                if hidden { row = inTurn(row) }
                rows.append(row)
            }
        case "bot_notice":
            // The journal keeps it as this same text, so a reload matches it.
            let n = d["notice"]
            let needsYou = n?["tier"]?.string == "urgent" || n?["category"]?.string == "needs_you" || d["tier"]?.string == "urgent"
            let text = (needsYou ? "Bot needs you: " : "Bot status: ") + (d["title"]?.string ?? "Bot") + "\n" + (d["body"]?.string ?? "")
            if !repeatsTail(.notice, text) { rows.append(ChatRow(role: .notice, text: text)) }
        case "assistant_text":
            if let text = d["text"]?.string, !text.isEmpty, !repeatsTail(.assistant, text) {
                rows.append(inTurn(ChatRow(role: .assistant, text: text)))
            }
        case "bot_message":
            // The Bot wrote to the owner (an FYI; a needs-you one also arrives
            // as a question).
            if let text = d["text"]?.string, !text.isEmpty, !repeatsTail(.assistant, text) {
                var row = ChatRow(role: .assistant, text: text)
                row.ownerMessage = true
                row.needsYou = d["needsYou"]?.bool == true
                rows.append(row)
            }
        case "question_agent_action":
            // An agent edited, dismissed or answered a question card. Never
            // `inTurn`: it shows even inside a hidden agent turn. The card
            // itself still closes only on question_answered / _dismissed.
            if let id = d["actionId"]?.string, let text = d["text"]?.string, !text.isEmpty {
                var row = ChatRow(role: .notice, text: text)
                row.botView = "show"
                appendLine(row, messageId: "question-action:" + id)
            }
        case "session_reset":
            // The transcript was gone, so the conversation went on in a fresh session.
            if let id = d["newSessionId"]?.string, let text = d["text"]?.string, !text.isEmpty {
                appendLine(ChatRow(role: .notice, text: text), messageId: "session-reset:" + id)
            }
        case "owner_view":
            // A woken reply marked an already finished turn for the owner.
            if d["shown"]?.bool != false, let id = d["messageId"]?.string { showTurn(id) }
        case "active_model":
            activeModel = d["model"]?.string ?? activeModel
        case "activity":
            guard let a = d.decode(ActivityEvent.self), a.parentToolUseId == nil else { return }
            let label = a.label ?? a.tool ?? "Tool"
            if let i = rows.lastIndex(where: { $0.toolUseId == a.toolUseId }) {
                rows[i].inFlight = a.status == "start"
                if a.status == "error" { rows[i].failed = true }
            } else {
                rows.append(inTurn(ChatRow(role: .action, text: label, detail: a.detail, failed: a.status == "error", inFlight: a.status == "start", toolUseId: a.toolUseId)))
            }
            activity = a.status == "start" ? label : nil
        case "jev_decision":
            if let dec = d.decode(JevDecision.self) {
                rows.append(inTurn(ChatRow(role: .card, text: dec.noteLine, card: .decision(dec))))
            }
        case "advisor_call":
            if d["phase"]?.string == "done", let row = Self.card(d, fallback: "") { rows.append(inTurn(row)) }
        case "advisor_consult":
            if let row = Self.card(d, fallback: "") { rows.append(inTurn(row)) }
        case "delegate_report":
            if let role = d["role"]?.string {
                rows.append(ChatRow(role: .card, text: d["text"]?.string ?? "", card: .delegate(role: role, gate: d["gate"]?.string, text: d["text"]?.string ?? "")))
            }
        case "session_done", "conversation_settled":
            activity = nil
            for i in rows.indices where rows[i].inFlight { rows[i].inFlight = false }
            if d["forOwner"]?.bool == true, let id = d["triggerMessageId"]?.string { showTurn(id) }
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

    /// A line the journal keeps under `messageId`, so a reload matches it.
    private func appendLine(_ row: ChatRow, messageId: String) {
        guard !rows.contains(where: { $0.messageId == messageId }), !repeatsTail(row.role, row.text) else { return }
        var row = row
        row.messageId = messageId
        rows.append(row)
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
    /// `answering`: the open question card's `at`, when this is its answer.
    func send(_ text: String, files: [PendingFile], mode: SendMode = .send, answering: String? = nil) async {
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
            body.answersQuestionAt = answering
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
            } else if LiveTurns.enabled, liveActivity {
                followOnLockScreen()
            }
        } catch {
            markFailed(rowId, error.localizedDescription)
        }
    }

    /// This conversation's turn on the Lock Screen and in the Dynamic Island.
    func followOnLockScreen() {
        guard let sessionId else { return }
        // Steps since the last prompt, for a turn that is already running.
        let since = rows.lastIndex { $0.role == .user } ?? -1
        let steps = rows.indices.filter { $0 > since && rows[$0].role == .action }.count
        LiveTurns.shared.follow(projectId: projectId, sessionId: sessionId,
                                title: conversation?.title ?? "New conversation",
                                project: project?.name ?? "x056", provider: provider,
                                steps: isRunning ? steps : 0, activity: isRunning ? activity : nil,
                                autopilot: app.autopilot[sessionId])
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
