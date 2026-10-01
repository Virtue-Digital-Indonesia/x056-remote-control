import Foundation
import Observation
import UIKit

enum Route: Hashable {
    case project(String)
    case conversation(projectId: String, sessionId: String)
    case draft(projectId: String, id: UUID)
}

enum AppTab: Hashable {
    case projects, activity, accounts, search
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
    var approvals: [McpApproval] = []
    var codexModels: [CodexModel] = []
    var connection: Connection = .offline
    /// Bumped on the `accounts` event; the accounts screen refetches on change.
    var accountsTick = 0

    var tab: AppTab = .projects
    /// The Projects tab's stack; notification taps write it.
    var path: [Route] = []
    /// The conversation on screen, so its own notifications don't banner.
    private(set) var visibleSessionId: String?
    private(set) var visibleProjectId: String?

    var pushError: String?

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

    /// Questions and approvals: the Activity tab's badge.
    var needsYouCount: Int { questions.count + approvals.count }

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
        _ = await p
        if let a = await a { approvals = a.filter { $0.status == "pending" } }
        if let q = await q { questions = Dictionary(q.map { ($0.sessionId, $0) }, uniquingKeysWith: { _, new in new }) }
        if let queue = await queue { queues = queue }
        if let codex = await models?.codex { codexModels = codex }
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
                if let pid { touch(pid, sid) }
            }
        case "assistant_text":
            if let pid, let sid { touch(pid, sid) }
        case "session_done", "session_error", "conversation_settled":
            if let sid { running.remove(sid) }
            if let pid, let sid, let status = d["status"]?.string, e.kind != "session_error" {
                updateConversation(pid, sid) { $0.lastOutcome = Outcome(status: status, at: e.ts, reason: d["reason"]?.string) }
            }
        case "background_state":
            if let sid {
                if d["active"]?.bool == true { background.insert(sid) } else { background.remove(sid) }
            }
        case "question":
            if let q = d.decode(PendingQuestion.self) { questions[q.sessionId] = q }
        case "question_dismissed":
            if let sid { questions[sid] = nil }
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
        default:
            break
        }
        if let sid {
            for m in open.values where m.sessionId == sid { m.apply(e) }
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
    func open(projectId: String, sessionId: String?) {
        guard !projectId.isEmpty else { return }
        tab = .projects
        if let sessionId {
            path = [.project(projectId), .conversation(projectId: projectId, sessionId: sessionId)]
        } else {
            path = [.project(projectId)]
        }
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
