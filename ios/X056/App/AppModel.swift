import Foundation
import Observation
import UIKit

enum Route: Hashable {
    case project(String)
    case conversation(projectId: String, sessionId: String)
    case draft(projectId: String, id: UUID)
}

enum AppTab: Hashable {
    case home, projects, accounts, search
}

/// An unseen notable event in a conversation (Home's Unread), ranked like
/// the panel's: a question outranks a failure outranks a finished turn.
enum UnreadKind: String, Codable {
    case question, failed, done, unread

    var rank: Double {
        switch self {
        case .question: return 3
        case .failed: return 2
        case .done: return 1.5
        case .unread: return 1
        }
    }
}

enum Connection: Equatable {
    case offline
    case connecting
    case live
    case failed(String)
}

/// App-wide state: who we are talking to, the project tree, and the one global
/// event stream every screen reads from.
@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    private(set) var server: URL?
    private(set) var credential: Credential?
    /// Shown on the sign-in screen after the gateway turned this device away.
    var signInNotice: String?

    var projects: [Project] = []
    var projectsLoaded = false
    var projectsError: String?
    /// Conversations with a gateway turn running.
    var running: Set<String> = []
    /// Conversations whose CLI is working with no turn behind it (the panel's violet).
    var background: Set<String> = []
    var runningAccounts: [String: String] = [:]
    /// Queued messages, by projectId.
    var queues: [String: [QueueItem]] = [:]
    /// The open question per conversation, by sessionId.
    var questions: [String: PendingQuestion] = [:]
    /// Autopilot by conversation (sessionId).
    var autopilot: [String: AutopilotState] = [:]
    /// Whether the gateway takes a standing instruction for autopilot; nil
    /// until asked.
    var autopilotInstructions: Bool?
    var approvals: [McpApproval] = []
    var codexModels: [CodexModel] = []
    var connection: Connection = .offline
    /// Bumped on the `accounts` event; the accounts screen refetches on change.
    var accountsTick = 0

    var tab: AppTab = .home
    /// Each tab's navigation stack; notification taps open into Home.
    var homePath: [Route] = []
    var path: [Route] = []

    /// The fleet, for the Accounts tab and the composer's account chip.
    var accounts: [Account] = []
    var accountsError: String?
    var jevStatus: JevStatus?
    var decisionsStatus: DecisionsStatus?
    /// Per-model default effort (`GET /api/settings`).
    var modelEffortDefaults: [String: String] = [:]
    /// Whether this gateway has Chats and Project spaces switched on.
    var chatsEnabled = false
    var spacesEnabled = false
    /// New-work choices waiting for the draft screen, by draft route id.
    var draftSettings: [UUID: DraftSettings] = [:]
    /// The conversation on screen, so its own notifications don't banner.
    private(set) var visibleSessionId: String?
    private(set) var visibleProjectId: String?

    var pushError: String?

    /// Per conversation ("pid::sid"), this phone only, like the panel's
    /// localStorage: what is unread, unsent drafts, recents dismissed by hand.
    /// Unread as this phone tracks it, for a gateway without shared read state.
    private(set) var localUnread: [String: UnreadKind] = Stored.load("unread") ?? [:]
    /// The gateway's shared read state (`/api/conversations/read-state`), so a
    /// read on the web clears the phone and back. nil: an older gateway.
    var serverRead: [String: ReadItem]?
    private(set) var drafts: [String: String] = Stored.load("drafts") ?? [:]
    private(set) var recentDismissed: Set<String> = Stored.load("recentDismissed") ?? []
    /// Workspace metadata (archived, tags), shared with the panel.
    var conversationMeta: [String: ConversationMeta] = [:]
    /// Events from before this sign-in replay on connect; they are history,
    /// not news, so they do not raise unread.
    @ObservationIgnored private var unreadSince = Date(timeIntervalSince1970: UserDefaults.standard.double(forKey: "unreadSince"))

    @ObservationIgnored private var lastSeq: Int
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var open: [ObjectIdentifier: ConversationModel] = [:]
    @ObservationIgnored private var presenceTask: Task<Void, Never>?
    /// This install's presence id; the gateway keeps one entry per client.
    @ObservationIgnored private let clientId: String = {
        if let id = UserDefaults.standard.string(forKey: "presenceClientId") { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: "presenceClientId")
        return id
    }()

    private init() {
        #if DEBUG
        // UI tests start from the sign-in screen every time.
        if ProcessInfo.processInfo.arguments.contains("-X056ResetState") {
            Keychain.delete("token")
            Keychain.delete("session")
            for key in ["server", "lastSeq", "apnsToken"] { UserDefaults.standard.removeObject(forKey: key) }
        }
        #endif
        server = UserDefaults.standard.string(forKey: "server").flatMap(URL.init(string:))
        credential = Keychain.read("session").map(Credential.session) ?? Keychain.read("token").map(Credential.token)
        lastSeq = UserDefaults.standard.integer(forKey: "lastSeq")
    }

    var client: APIClient? {
        guard let server, let credential else { return nil }
        return APIClient(baseURL: server, credential: credential)
    }

    var isSignedIn: Bool { client != nil }

    // MARK: sign in / out

    /// "x056.rc.val.id", "https://host/", "http://127.0.0.1:8768" → a base URL.
    static func serverURL(_ raw: String) throws -> URL {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host() != nil else { throw APIError(status: 0, message: "That is not a server address.") }
        return url
    }

    func signIn(server raw: String, token: String) async throws {
        let url = try Self.serverURL(raw)
        let cred = Credential.token(token.trimmingCharacters(in: .whitespacesAndNewlines))
        let _: AuthStatus = try await APIClient(baseURL: url, credential: cred).get("/api/auth/status")
        await finishSignIn(url, cred)
    }

    /// Face ID / Touch ID against the gateway's own passkeys.
    func signInWithPasskey(server raw: String) async throws {
        let url = try Self.serverURL(raw)
        let session = try await Passkeys.signIn(baseURL: url)
        await finishSignIn(url, .session(session))
    }

    /// Whether the gateway has any passkey yet. nil: could not tell.
    static func passkeysAvailable(server raw: String) async -> Bool? {
        guard let url = try? serverURL(raw) else { return nil }
        let reply = try? await APIClient(baseURL: url, credential: nil).get("/api/auth/passkey/available", as: PasskeyAvailability.self)
        return reply?.available
    }

    /// Create a passkey for this gateway on this iPhone (needs a signed-in client).
    func addPasskey() async throws {
        guard let client else { return }
        try await Passkeys.register(client: client, label: "iPhone app · \(UIDevice.current.name)")
    }

    private func finishSignIn(_ url: URL, _ cred: Credential) async {
        UserDefaults.standard.set(url.absoluteString, forKey: "server")
        UserDefaults.standard.set(0, forKey: "lastSeq")
        switch cred {
        case .token(let t): Keychain.write("token", t); Keychain.delete("session")
        case .session(let s): Keychain.write("session", s); Keychain.delete("token")
        }
        server = url
        credential = cred
        signInNotice = nil
        lastSeq = 0
        unreadSince = Date()
        UserDefaults.standard.set(unreadSince.timeIntervalSince1970, forKey: "unreadSince")
        connect()
        startPresence()
        await Push.requestAndRegister()
    }

    /// The gateway answered 401: the token changed or the 30-day session ran out.
    func credentialRejected() async {
        guard credential != nil else { return }
        let passkey = credential?.isPasskey ?? false
        await signOut()
        signInNotice = passkey ? "Your session ended. Sign in again with your passkey." : "The gateway no longer accepts that token."
    }

    func signOut() async {
        if let client {
            if let device = Push.deviceToken {
                _ = try? await client.post("/api/push/apns/unregister", ApnsUnregisterBody(token: device))
            }
            // A passkey session is a server-side record: end it there too.
            if credential?.isPasskey == true { _ = try? await client.post("/api/auth/logout", Empty()) }
        }
        disconnect()
        stopPresence()
        Keychain.delete("token")
        Keychain.delete("session")
        credential = nil
        localUnread = [:]
        Stored.save("unread", localUnread)
        serverRead = nil
        projects = []
        projectsLoaded = false
        running = []
        background = []
        queues = [:]
        questions = [:]
        approvals = []
        path = []
    }

    // MARK: lifecycle

    func enterForeground() {
        guard isSignedIn else { return }
        connect()
        startPresence()
    }

    func enterBackground() {
        disconnect()
        stopPresence()
    }

    // MARK: presence

    /// Tell the gateway what is on screen, like an open panel does
    /// (`POST /api/presence`, 30 s TTL). It then skips pushes for the
    /// conversation being read, and while the app is in front, this iPhone is
    /// "the device you are at" and the others stay quiet for non-urgent notices.
    func setVisible(projectId: String?, sessionId: String?) {
        if let projectId, let sessionId { markRead(projectId, sessionId) }
        guard projectId != visibleProjectId || sessionId != visibleSessionId else { return }
        visibleProjectId = projectId
        visibleSessionId = sessionId
        if presenceTask != nil { Task { await postPresence(visible: true) } }
    }

    private func startPresence() {
        presenceTask?.cancel()
        presenceTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.postPresence(visible: true)
                try? await Task.sleep(for: .seconds(15))
            }
        }
    }

    private func stopPresence() {
        presenceTask?.cancel()
        presenceTask = nil
        Task { await postPresence(visible: false) }
    }

    private func postPresence(visible: Bool) async {
        guard let client else { return }
        let body = PresenceBody(clientId: clientId, projectId: visibleProjectId, sessionId: visibleSessionId,
                                visible: visible, endpoint: Push.deviceToken.map { "apns:" + $0.lowercased() })
        // An older gateway has no presence route: nothing to do about it.
        _ = try? await client.post("/api/presence", body)
    }

    // MARK: lookups

    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    func conversation(_ projectId: String, _ sessionId: String) -> Conversation? {
        project(projectId)?.conversations?.first { $0.sessionId == sessionId }
    }

    func queued(_ projectId: String, _ sessionId: String) -> [QueueItem] {
        (queues[projectId] ?? []).filter { $0.sessionId == nil || $0.sessionId == sessionId }
    }

    func isWorking(_ sessionId: String) -> Bool { running.contains(sessionId) || background.contains(sessionId) }

    /// The project and conversation a session id belongs to.
    func locate(_ sessionId: String) -> (project: Project, conversation: Conversation)? {
        for p in projects {
            if let c = p.conversations?.first(where: { $0.sessionId == sessionId }) { return (p, c) }
        }
        return nil
    }

    /// The panel's own link (`manager.conversationUrl`): /chat/<id> for a
    /// chat, /?project=&session= for a project conversation.
    func panelURL(projectId: String, sessionId: String?, isChat: Bool) -> URL? {
        guard let server, var c = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        if isChat { return server.appending(path: "chat/\(projectId)") }
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "project", value: projectId)] + (sessionId.map { [URLQueryItem(name: "session", value: $0)] } ?? [])
        return c.url
    }

    /// Home's badge: unread conversations, open questions, approvals.
    var needsYouCount: Int {
        Set(unread.keys).union(questions.values.map { Self.key($0.projectId, $0.sessionId) }).count + approvals.count
    }

    // MARK: Home state

    nonisolated static func key(_ projectId: String, _ sessionId: String) -> String { projectId + "::" + sessionId }

    /// What is unread: the gateway's shared state when it has one, else
    /// this phone's own. The conversation on screen never counts.
    var unread: [String: UnreadKind] {
        guard let serverRead else { return localUnread }
        let visible = visibleProjectId.flatMap { p in visibleSessionId.map { Self.key(p, $0) } }
        var out: [String: UnreadKind] = [:]
        for (k, v) in serverRead where v.unread == true && k != visible {
            out[k] = UnreadKind(rawValue: v.kind ?? "done") ?? .done
        }
        return out
    }

    /// Local tracking only: with shared state the gateway raises unread itself.
    func raiseUnread(_ projectId: String, _ sessionId: String, _ kind: UnreadKind, at ts: String?) {
        guard serverRead == nil, sessionId != visibleSessionId else { return }
        if let ts, let at = Self.isoDate(ts), at < unreadSince { return }
        let k = Self.key(projectId, sessionId)
        if let cur = localUnread[k], cur.rank > kind.rank { return }
        localUnread[k] = kind
        Stored.save("unread", localUnread)
    }

    func markRead(_ projectId: String, _ sessionId: String) {
        let k = Self.key(projectId, sessionId)
        if serverRead != nil {
            guard serverRead?[k]?.unread == true else { return }
            serverRead?[k]?.unread = false
            serverRead?[k]?.readAt = Date().timeIntervalSince1970 * 1000
            Task { try? await client?.post("/api/conversations/read", ConversationRef(projectId: projectId, sessionId: sessionId)) }
            return
        }
        guard localUnread.removeValue(forKey: k) != nil else { return }
        Stored.save("unread", localUnread)
    }

    func markUnread(_ projectId: String, _ sessionId: String) {
        let k = Self.key(projectId, sessionId)
        if serverRead != nil {
            var item = serverRead?[k] ?? ReadItem()
            item.unread = true
            item.kind = "unread"
            serverRead?[k] = item
            Task { try? await client?.post("/api/conversations/unread", ConversationRef(projectId: projectId, sessionId: sessionId)) }
            return
        }
        localUnread[k] = .unread
        Stored.save("unread", localUnread)
    }

    func markAllRead() {
        if var all = serverRead {
            for k in all.keys where all[k]?.unread == true { all[k]?.unread = false }
            serverRead = all
            Task { try? await client?.post("/api/conversations/read-all", ReadAllBody()) }
            return
        }
        localUnread = [:]
        Stored.save("unread", localUnread)
    }

    /// The gateway's view of one conversation changed (here, on the web, or
    /// because something happened in it).
    func applyReadState(_ projectId: String, _ sessionId: String, _ item: ReadItem) {
        guard serverRead != nil else { return }
        serverRead?[Self.key(projectId, sessionId)] = item
        // On screen here: we are reading it, so say so for the other devices.
        if item.unread == true && projectId == visibleProjectId && sessionId == visibleSessionId {
            markRead(projectId, sessionId)
        }
    }

    func loadReadState() async {
        guard let client else { return }
        do {
            serverRead = try await client.get("/api/conversations/read-state", as: ReadStateReply.self).items
        } catch let e as APIError where e.status == 404 {
            serverRead = nil
        } catch {
            // Keep what we have; the next refresh tries again.
        }
    }

    func draft(_ projectId: String, _ sessionId: String?) -> String {
        drafts[Self.key(projectId, sessionId ?? "")] ?? ""
    }

    func setDraft(_ projectId: String, _ sessionId: String?, _ text: String) {
        let k = Self.key(projectId, sessionId ?? "")
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
        guard drafts[k] != value else { return }
        drafts[k] = value
        Stored.save("drafts", drafts)
    }

    func setRecentDismissed(_ projectId: String, _ sessionId: String, _ dismissed: Bool) {
        let k = Self.key(projectId, sessionId)
        if dismissed { recentDismissed.insert(k) } else { recentDismissed.remove(k) }
        Stored.save("recentDismissed", recentDismissed)
    }

    // MARK: autopilot

    func loadAutopilot() async {
        guard let client, let map = try? await client.get("/api/autopilot", as: [String: AutopilotState].self) else { return }
        autopilot = map
    }

    /// What autopilot last ran with here, or nil. Also learns whether the
    /// gateway takes a standing instruction at all (its route 404s if not).
    func autopilotLast(projectId: String, sessionId: String) async -> AutopilotLast? {
        guard let client else { return nil }
        do {
            let last = try await client.get("/api/autopilot/last", query: ["projectId": projectId, "sessionId": sessionId], as: AutopilotLast.self)
            autopilotInstructions = true
            return last
        } catch let e as APIError where e.status == 404 {
            autopilotInstructions = false
            return nil
        } catch {
            return nil
        }
    }

    func startAutopilot(projectId: String, sessionId: String, count: Int, instruction: String) async throws {
        guard let client else { return }
        let text = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        _ = try await client.post("/api/autopilot", AutopilotBody(projectId: projectId, sessionId: sessionId, count: count, instruction: text.isEmpty ? nil : text))
        await loadAutopilot()
    }

    func setAutopilotInstruction(projectId: String, sessionId: String, instruction: String) async throws {
        guard let client else { return }
        _ = try await client.post("/api/autopilot/instruction", AutopilotInstructionBody(projectId: projectId, sessionId: sessionId, instruction: instruction.trimmingCharacters(in: .whitespacesAndNewlines)))
        await loadAutopilot()
    }

    func stopAutopilot(sessionId: String) async throws {
        guard let client else { return }
        _ = try await client.post("/api/autopilot/stop", SessionOnly(sessionId: sessionId))
        autopilot[sessionId] = nil
        await loadAutopilot()
    }

    // MARK: notification settings for this iPhone

    /// The endpoint the gateway keys this iPhone by, once it has a token.
    var pushEndpoint: String? { Push.deviceToken.map { "apns:" + $0.lowercased() } }

    func pushSettings() async throws -> DeviceSettings? {
        guard let client, let endpoint = pushEndpoint else { return nil }
        return try await client.get("/api/push/settings", query: ["endpoint": endpoint], as: DeviceSettings.self)
    }

    func savePushSettings(_ settings: DeviceSettings) async throws -> DeviceSettings? {
        guard let client, let endpoint = pushEndpoint else { return nil }
        var s = settings
        s.timeZone = TimeZone.current.identifier
        return try await client.post("/api/push/settings", PushSettingsBody(endpoint: endpoint, settings: s), as: DeviceSettings.self)
    }

    func dismissQuestion(_ q: PendingQuestion) async {
        _ = try? await client?.post("/api/questions/dismiss", DismissQuestionBody(projectId: q.projectId, sessionId: q.sessionId, at: q.at))
        questions[q.sessionId] = nil
        markRead(q.projectId, q.sessionId)
    }

    /// Clear a failed or parked outcome without sending anything.
    func dismissOutcome(_ projectId: String, _ sessionId: String) async {
        _ = try? await client?.post("/api/conversations/outcome/dismiss", ConversationRef(projectId: projectId, sessionId: sessionId))
        updateConversation(projectId, sessionId) { $0.lastOutcome = nil }
        markRead(projectId, sessionId)
    }

    func rename(_ projectId: String, _ sessionId: String, to title: String) async throws {
        guard let client else { return }
        let t = String(title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
        guard !t.isEmpty else { return }
        try await client.post("/api/conversations/rename", RenameBody(projectId: projectId, sessionId: sessionId, title: t))
        updateConversation(projectId, sessionId) { $0.title = t }
    }

    func remove(_ projectId: String, _ sessionId: String) async throws {
        guard let client else { return }
        try await client.post("/api/conversations/remove", ConversationRef(projectId: projectId, sessionId: sessionId))
        if let p = projects.firstIndex(where: { $0.id == projectId }) {
            projects[p].conversations?.removeAll { $0.sessionId == sessionId }
        }
    }

    // MARK: accounts, helpers, routing

    func loadAccounts() async {
        guard let client else { return }
        do {
            accounts = try await client.get("/api/accounts", as: [Account].self)
            accountsError = nil
        } catch {
            accountsError = error.localizedDescription
        }
    }

    /// Accounts that can serve a conversation of this provider.
    func pool(_ provider: String) -> [Account] {
        accounts.filter { ($0.provider ?? "claude") == provider }
    }

    /// The picker that runs for a conversation (server/projects.ts
    /// effectiveRouter): what was saved, 'none' for none, and when nothing
    /// was saved, Jev while it is available. The fresh /api/jev/status wins
    /// over the conversation's own snapshot, as on the panel.
    func effectiveRouter(_ h: Helpers, _ conversation: Conversation?) -> String? {
        switch h.router {
        case "none": return nil
        case "jev", "decisions": return h.router
        default:
            if let available = jevStatus?.available { return available ? "jev" : nil }
            return conversation?.effectiveRouter.flatMap { $0.isEmpty ? nil : $0 }
        }
    }

    func setHelpers(_ projectId: String, _ sessionId: String, _ h: Helpers) async throws {
        guard let client else { return }
        let body = HelpersBody(projectId: projectId, sessionId: sessionId, advisor: h.advisor == true, team: h.team == true,
                               router: h.router ?? "", lean: h.lean ?? "medium")
        let reply = try await client.post("/api/conversations/helpers", body, as: HelpersReply.self)
        updateConversation(projectId, sessionId) {
            $0.helpers = reply.helpers ?? h
            $0.decisionMaker = nil
            $0.effectiveRouter = reply.effectiveRouter
        }
    }

    func routingPreview(_ projectId: String, _ sessionId: String) async -> RoutingPreview? {
        try? await client?.get("/api/routing/preview", query: ["projectId": projectId, "sessionId": sessionId], as: RoutingPreview.self)
    }

    /// One-shot preference for this conversation's next turn; nil = automatic.
    func setNextAccount(_ projectId: String, _ sessionId: String, _ account: String?) async throws {
        try await client?.post("/api/routing/conversation", NextAccountBody(projectId: projectId, sessionId: sessionId, nextAccount: account))
    }

    func switchAccountNow(_ projectId: String, _ sessionId: String, _ account: String) async throws {
        try await client?.post("/api/switch", SwitchBody(projectId: projectId, sessionId: sessionId, account: account))
    }

    // MARK: new chat / work

    /// A new Chat; returns where its single conversation lives.
    func newChat(provider: String, model: String, effort: String, account: String?) async throws -> (String, String) {
        guard let client else { throw APIError(status: 0, message: "Not signed in.") }
        let body = NewChatBody(requestId: UUID().uuidString.lowercased(), provider: provider,
                               model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort, account: account)
        let chat = try await client.post("/api/chats", body, as: Project.self)
        await refreshProjects()
        guard let sid = chat.lastSessionId ?? chat.conversations?.first?.sessionId else {
            throw APIError(status: 0, message: "The gateway made the chat but returned no conversation.")
        }
        return (chat.id, sid)
    }

    /// A new Work conversation through project spaces; nil when they are off
    /// (then the first send creates it with `POST /api/sessions`).
    func newWork(projectId: String, provider: String, model: String, effort: String, account: String?) async throws -> (String, String)? {
        guard spacesEnabled, let client else { return nil }
        let body = NewWorkBody(requestId: UUID().uuidString.lowercased(), provider: provider,
                               model: model.isEmpty ? nil : model, effort: effort.isEmpty ? nil : effort, account: account)
        let reply = try await client.post("/api/project-spaces/executions/\(projectId)/work", body, as: NewWorkReply.self)
        await refreshProjects()
        return (reply.projectId, reply.sessionId)
    }

    /// Chats take files by reference: upload first, then send `fileRefs`.
    func uploadChatFiles(_ chatId: String, _ files: [PendingFile]) async throws -> [FileRef] {
        guard let client, !files.isEmpty else { return [] }
        let boundary = "x056-" + UUID().uuidString
        var body = Data()
        for f in files {
            let name = f.name.replacingOccurrences(of: "\"", with: "")
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"files\"; filename=\"\(name)\"\r\nContent-Type: \(f.mime)\r\n\r\n".utf8))
            body.append(f.data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        var req = client.request("POST", "/api/chats/\(chatId)/files", timeout: 120)
        req.httpBody = body
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "x-upload-id")
        let reply: ChatFilesReply = try await client.send(req)
        return reply.files.map { FileRef(fileId: $0.id, versionId: $0.latestVersionId) }
    }

    // MARK: queue

    func editQueued(_ projectId: String, _ id: String, prompt: String? = nil, paused: Bool? = nil, notBefore: Double? = nil) async throws {
        try await client?.post("/api/queue/edit", QueueEditBody(projectId: projectId, id: id, prompt: prompt, paused: paused, notBefore: notBefore))
    }

    /// Move one item; the gateway wants the project's full order back.
    func moveQueued(_ projectId: String, _ id: String, by offset: Int) async throws {
        var ids = (queues[projectId] ?? []).map(\.id)
        guard let i = ids.firstIndex(of: id) else { return }
        let j = min(max(i + offset, 0), ids.count - 1)
        guard i != j else { return }
        ids.swapAt(i, j)
        try await client?.post("/api/queue/reorder", QueueReorderBody(projectId: projectId, ids: ids))
    }

    nonisolated static func isoDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// Epoch ms of a project's newest conversation activity.
    func lastActivity(_ p: Project) -> Double { p.conversations?.map(\.recency).max() ?? 0 }

    func decide(_ approval: McpApproval, approve: Bool) async throws {
        guard let client else { return }
        let body = DecideBody(id: approval.id, approve: approve, reviewedOperationId: approve ? approval.contextReview?.operationId : nil)
        try await client.post("/api/mcp/approvals/decide", body)
        approvals.removeAll { $0.id == approval.id }
    }

    /// Stop a conversation's turn, or interrupt its background work.
    func stop(projectId: String, sessionId: String) async {
        guard let client else { return }
        do {
            try await client.post("/api/sessions/current/stop", ConversationRef(projectId: projectId, sessionId: sessionId))
        } catch let e as APIError where e.status == 409 {
            _ = try? await client.post("/api/conversations/halt", HaltBody(projectId: projectId, sessionId: sessionId, dropQueued: false))
        } catch {}
    }

    // MARK: open conversations receive their events

    func attach(_ model: ConversationModel) { open[ObjectIdentifier(model)] = model }
    func detach(_ model: ConversationModel) { open[ObjectIdentifier(model)] = nil }

    func updateConversation(_ projectId: String, _ sessionId: String, _ change: (inout Conversation) -> Void) {
        guard let p = projects.firstIndex(where: { $0.id == projectId }),
              let c = projects[p].conversations?.firstIndex(where: { $0.sessionId == sessionId }) else { return }
        change(&projects[p].conversations![c])
    }

    // MARK: REST refresh

    func refreshAll() async {
        guard let client else { return }
        async let p: Void = refreshProjects()
        async let a = try? client.get("/api/mcp/approvals", as: [McpApproval].self)
        async let q = try? client.get("/api/questions", as: [PendingQuestion].self)
        async let queue = try? client.get("/api/queue", as: [String: [QueueItem]].self)
        async let models = try? client.get("/api/models", as: ModelsResponse.self)
        async let meta = try? client.get("/api/workspace/metadata", as: [String: ConversationMeta].self)
        async let jev = try? client.get("/api/jev/status", as: JevStatus.self)
        async let decisions = try? client.get("/api/decisions/status", as: DecisionsStatus.self)
        async let settings = try? client.get("/api/settings", as: SettingsReply.self)
        async let chats = try? client.get("/api/chats", as: EnabledReply.self)
        async let spaces = try? client.get("/api/project-spaces", as: EnabledReply.self)
        async let acc: Void = loadAccounts()
        async let reads: Void = loadReadState()
        async let pilots: Void = loadAutopilot()
        _ = await p
        _ = await pilots
        _ = await acc
        _ = await reads
        if let meta = await meta { conversationMeta = meta }
        jevStatus = await jev
        decisionsStatus = await decisions
        if let m = await settings?.modelEffort { modelEffortDefaults = m }
        chatsEnabled = await chats?.enabled ?? false
        spacesEnabled = await spaces?.enabled ?? false
        if let a = await a { approvals = a.filter { $0.status == "pending" } }
        if let q = await q { questions = Dictionary(q.map { ($0.sessionId, $0) }, uniquingKeysWith: { _, new in new }) }
        if let queue = await queue { queues = queue }
        if let codex = await models?.codex { codexModels = codex }
        LiveTurns.shared.reconcile(running: running.union(background), autopilot: Set(autopilot.keys)) { [weak self] pid, sid in
            self?.conversation(pid, sid)?.lastOutcome
        }
    }

    func refreshProjects() async {
        guard let client else { return }
        do {
            let r: ProjectsResponse = try await client.get("/api/projects")
            projects = r.projects.filter { $0.archivedAt == nil }
            running = Set(r.projects.flatMap { $0.runningSessionIds ?? [] })
            background = Set(r.projects.flatMap { $0.backgroundSessionIds ?? [] })
            runningAccounts = r.projects.reduce(into: [:]) { acc, p in acc.merge(p.runningAccounts ?? [:]) { _, new in new } }
            projectsLoaded = true
            projectsError = nil
        } catch let e as APIError where e.status == 401 {
            await credentialRejected()
        } catch {
            projectsError = error.localizedDescription
        }
    }

    /// Coalesce bursts of `projects` events into one refetch.
    private func scheduleProjectsRefresh() {
        refreshTask?.cancel()
        refreshTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            await refreshProjects()
        }
    }

    // MARK: the event stream

    func connect() {
        streamTask?.cancel()
        guard let client else { return }
        connection = .connecting
        streamTask = Task { [weak self] in
            var delay = 1.0
            while !Task.isCancelled {
                guard let self else { return }
                var req = client.request("GET", "/api/sessions/current/stream", query: ["since": String(self.lastSeq)], timeout: 45)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                do {
                    // The server pings every 15 s, so 45 s of silence means a dead link.
                    try await Self.read(req, onOpen: { await self.streamOpened() }, onEvent: { await self.handle($0) })
                } catch is CancellationError {
                    return
                } catch {
                    if Task.isCancelled { return }
                    if let e = error as? APIError, e.status == 401 {
                        self.connection = .failed(e.localizedDescription)
                        await self.credentialRejected()
                        return
                    }
                    self.connection = .failed(error.localizedDescription)
                }
                try? await Task.sleep(for: .seconds(delay))
                delay = min(delay * 2, 15)
            }
        }
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        connection = .offline
    }

    /// Read bytes off the main actor; hop to it once per event. `@concurrent`
    /// keeps that true even where nonisolated async defaults to the caller's actor.
    @concurrent private nonisolated static func read(_ request: URLRequest, onOpen: @Sendable () async -> Void, onEvent: @Sendable (GatewayEvent) async -> Void) async throws {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw APIError(status: status, message: "Event stream: HTTP \(status)") }
        await onOpen()
        var parser = SSEParser()
        let decoder = JSONDecoder()
        for try await byte in bytes {
            guard let ev = parser.feed(byte),
                  let event = try? decoder.decode(GatewayEvent.self, from: Data(ev.data.utf8)) else { continue }
            await onEvent(event)
        }
        throw APIError(status: 0, message: "Event stream closed")
    }

    private func streamOpened() {
        connection = .live
        // Like the panel's onopen: rehydrate whatever the replay buffer can't cover.
        Task {
            await refreshAll()
            for m in open.values { await m.reload() }
        }
    }

    private func handle(_ e: GatewayEvent) {
        if e.seq > lastSeq {
            lastSeq = e.seq
            UserDefaults.standard.set(e.seq, forKey: "lastSeq")
        }
        let d = e.data
        let pid = d["projectId"]?.string
        let sid = d["sessionId"]?.string
        switch e.kind {
        case "turn_state":
            if let sid {
                if d["active"]?.bool == true { running.insert(sid) } else { running.remove(sid) }
            } else if d["active"]?.bool == false {
                scheduleProjectsRefresh() // orphan cleanup: a whole project reset
            }
        case "session_started":
            if let sid {
                running.insert(sid)
                questions[sid] = nil
                if let pid {
                    touch(pid, sid)
                    updateConversation(pid, sid) { $0.lastOutcome = nil }
                }
            }
        case "assistant_text":
            if let pid, let sid { touch(pid, sid) }
        case "session_done", "session_error", "conversation_settled":
            if let sid { running.remove(sid) }
            let pending = d["completionPending"]?.bool == true
            if let pid, let sid, !pending {
                if e.kind == "session_error" {
                    updateConversation(pid, sid) { $0.lastOutcome = Outcome(status: "failed", at: e.ts, reason: d["message"]?.string) }
                } else if let status = d["status"]?.string {
                    updateConversation(pid, sid) { $0.lastOutcome = Outcome(status: status, at: e.ts, reason: d["reason"]?.string) }
                }
            }
            if let pid, let sid {
                let status = d["status"]?.string
                if e.kind == "session_error" || (e.kind == "session_done" && (status == "failed" || status == "parked")) {
                    raiseUnread(pid, sid, .failed, at: e.ts)
                } else if e.kind == "session_done" && status == "stopped" {
                    markRead(pid, sid)
                } else if e.kind == "conversation_settled", d["notificationSuppressed"]?.bool != true, d["notice"]?["tier"]?.string != "none" {
                    raiseUnread(pid, sid, .done, at: e.ts)
                }
            }
        case "cron_failed":
            if let pid, let sid { raiseUnread(pid, sid, .failed, at: e.ts) }
        case "delegate_report":
            if let pid, let sid, d["notice"]?["tier"]?.string == "urgent" { raiseUnread(pid, sid, .question, at: e.ts) }
        case "background_state":
            if let sid {
                if d["active"]?.bool == true { background.insert(sid) } else { background.remove(sid) }
            }
        case "question":
            if let q = d.decode(PendingQuestion.self) {
                questions[q.sessionId] = q
                raiseUnread(q.projectId, q.sessionId, .question, at: e.ts)
            }
        case "question_dismissed":
            if let sid { questions[sid] = nil }
            if let pid, let sid { markRead(pid, sid) }
        case "queue":
            if let pid, let items = d["items"]?.decode([QueueItem].self) { queues[pid] = items }
        case "mcp_approval":
            if let a = d.decode(McpApproval.self) {
                approvals.removeAll { $0.id == a.id }
                if a.status == "pending" { approvals.append(a) }
            }
        case "conversation":
            if let pid, let convs = d["conversations"]?.decode([Conversation].self) { mergeConversations(pid, convs) }
        case "projects", "project_removed":
            scheduleProjectsRefresh()
        case "accounts":
            accountsTick += 1
        case "read_state":
            if let pid, let sid, let item = d.decode(ReadItem.self) { applyReadState(pid, sid, item) }
        case "autopilot":
            // Steps, pauses, stops and the end of a run all arrive here; the
            // status is small, so read it whole rather than patch it.
            if let sid, d["active"]?.bool == true, var ap = autopilot[sid] {
                if let r = d["remaining"]?.number { ap.remaining = Int(r) }
                if let c = d["count"]?.number { ap.count = Int(c) }
                if let i = d["instruction"]?.string { ap.instruction = i }
                ap.paused = nil
                autopilot[sid] = ap
            }
            Task { await loadAutopilot() }
        default:
            break
        }
        if let sid {
            for m in open.values where m.sessionId == sid { m.apply(e) }
            LiveTurns.shared.apply(e, autopilot: autopilot[sid])
        }
    }

    private func touch(_ projectId: String, _ sessionId: String) {
        updateConversation(projectId, sessionId) { $0.lastMessageAt = Date().timeIntervalSince1970 * 1000 }
    }

    /// The SSE `conversation` list lacks `lastMessageAt` and sometimes `provider`;
    /// keep what we had.
    private func mergeConversations(_ projectId: String, _ convs: [Conversation]) {
        guard let i = projects.firstIndex(where: { $0.id == projectId }) else {
            scheduleProjectsRefresh()
            return
        }
        let old = Dictionary((projects[i].conversations ?? []).map { ($0.sessionId, $0) }, uniquingKeysWith: { a, _ in a })
        let fallback = projects[i].providerName
        projects[i].conversations = convs.map { c in
            var c = c
            c.lastMessageAt = c.lastMessageAt ?? old[c.sessionId]?.lastMessageAt
            c.provider = c.provider ?? old[c.sessionId]?.provider ?? fallback
            return c
        }
    }

    // MARK: push

    func registerDevice(_ token: String) async {
        guard let client else { return }
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        do {
            try await client.post("/api/push/apns/register", ApnsRegisterBody(token: token, env: env, name: UIDevice.current.name))
            pushError = nil
        } catch {
            pushError = error.localizedDescription
        }
    }

    /// Route a notification tap to its conversation.
    /// `x056://conversation?projectId=…&sessionId=…`, from a Live Activity.
    func open(_ url: URL) {
        guard url.scheme == "x056", url.host() == "conversation",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              let pid = items.first(where: { $0.name == "projectId" })?.value else { return }
        open(projectId: pid, sessionId: items.first(where: { $0.name == "sessionId" })?.value)
    }

    func open(projectId: String, sessionId: String?) {
        guard !projectId.isEmpty else { return }
        tab = .home
        homePath = [sessionId.map { .conversation(projectId: projectId, sessionId: $0) } ?? .project(projectId)]
    }

    /// A reply typed into a notification. Runs while the app may be in the background.
    func replyFromNotification(projectId: String, sessionId: String, text: String) async {
        guard let client, !text.isEmpty else { return }
        // Launched cold into the background: learn the conversation's model first,
        // or the reply would run on the Auto model instead of the one it was on.
        if !projectsLoaded { await refreshProjects() }
        let provider = conversation(projectId, sessionId)?.provider ?? project(projectId)?.providerName
        let saved = conversation(projectId, sessionId)
        let body = SendBody(
            prompt: text, projectId: projectId, sessionId: sessionId,
            model: ModelCatalog.effectiveModel(saved?.model, provider: provider ?? "claude"),
            effort: saved?.effort.flatMap { $0.isEmpty ? nil : $0 },
            requestId: UUID().uuidString.lowercased())
        _ = try? await client.post("/api/sessions/current/messages", body, as: SendReply.self)
    }
}

/// Small JSON values in UserDefaults.
enum Stored {
    static func load<T: Decodable>(_ key: String) -> T? {
        UserDefaults.standard.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    static func save<T: Encodable>(_ key: String, _ value: T) {
        UserDefaults.standard.set(try? JSONEncoder().encode(value), forKey: key)
    }
}
