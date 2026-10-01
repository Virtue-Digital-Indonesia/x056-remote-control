import SwiftUI

/// The panel's Home: pick up a conversation or start something new.
/// Groups, in the panel's order and with its rules (control-room.js
/// renderBoard): Unread, Needs attention, In progress, Drafts, Recent.
struct HomeView: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""
    @State private var recentLimit = 10
    @State private var showDismissed = false
    @State private var showNew = false
    @State private var renaming: HomeItem?
    @State private var newTitle = ""

    /// The panel's defaults: the past 7 days, at most 20.
    private let recentDays = 7.0
    private let recentMax = 20

    var body: some View {
        let items = HomeItem.all(in: app).filter(matches)
        let unread = items.filter(\.unread)
        let attention = items.filter { !$0.unread && $0.status.needsAttention }
        let progress = items.filter { !$0.unread && $0.status.inProgress }
        let drafts = items.filter { $0.draft && !$0.unread && $0.status.settled }
        let recentAll = items.filter { !$0.draft && !$0.unread && $0.status.settled && (!$0.dismissed || !query.isEmpty || showDismissed) }
        let cutoff = Date().timeIntervalSince1970 * 1000 - recentDays * 86_400_000
        let recent = query.isEmpty ? Array(recentAll.filter { $0.recentActivity >= cutoff }.prefix(recentMax)) : recentAll
        let dismissedCount = items.filter { $0.dismissed && !$0.draft && !$0.unread && $0.status.settled }.count
        List {
            if !app.approvals.isEmpty && query.isEmpty {
                Section {
                    ForEach(app.approvals) { ApprovalRow(approval: $0) }
                } header: {
                    header("Waiting for your approval", app.approvals.count)
                }
            }
            group("Unread", unread)
            group("Needs attention", attention)
            group("In progress", progress)
            group("Drafts", drafts)
            if !recent.isEmpty || dismissedCount > 0 {
                Section {
                    ForEach(recent.prefix(recentLimit)) { row($0) }
                    if recent.count > recentLimit {
                        Button("Show \(min(20, recent.count - recentLimit)) more") { recentLimit += 20 }
                    }
                    if query.isEmpty && dismissedCount > 0 {
                        Button(showDismissed ? "Hide dismissed (\(dismissedCount))" : "Show dismissed (\(dismissedCount))") { showDismissed.toggle() }
                            .foregroundStyle(.secondary)
                    }
                } header: {
                    header("Recent conversations", recent.count)
                }
            }
        }
        .overlay {
            if items.isEmpty && app.projectsLoaded {
                if query.isEmpty {
                    ContentUnavailableView {
                        Label("Nothing here yet", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("Start a chat, or open a project to run work in it.")
                    } actions: {
                        Button("New chat") { showNew = true }.buttonStyle(.glassProminent)
                    }
                } else {
                    ContentUnavailableView.search(text: query)
                }
            } else if !app.projectsLoaded {
                ProgressView()
            }
        }
        .searchable(text: $query, prompt: "Search conversations")
        .onChange(of: query) { recentLimit = 10 }
        .refreshable { await app.refreshAll() }
        .navigationTitle("Home")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New", systemImage: "square.and.pencil") { showNew = true }
            }
            if !app.unread.isEmpty {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Mark all as read", systemImage: "envelope.open") { app.markAllRead() }
                }
            }
        }
        .sheet(isPresented: $showNew) {
            NewConversationSheet { route in app.homePath.append(route) }
        }
        .alert("Rename conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Rename") {
                if let r = renaming { Task { try? await app.rename(r.project.id, r.conversation.sessionId, to: newTitle) } }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func matches(_ item: HomeItem) -> Bool {
        let q = query.lowercased()
        guard !q.isEmpty else { return true }
        let tags = item.meta?.tags?.joined(separator: " ") ?? ""
        return "\(item.conversation.title) \(item.project.name) \(tags)".lowercased().contains(q)
    }

    private func header(_ title: String, _ count: Int) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text("\(count)").monospacedDigit()
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ rows: [HomeItem]) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows) { row($0) }
            } header: {
                header(title, rows.count)
            }
        }
    }

    private func row(_ item: HomeItem) -> some View {
        let pid = item.project.id, sid = item.conversation.sessionId
        return NavigationLink(value: Route.conversation(projectId: pid, sessionId: sid)) {
            HomeRow(item: item)
        }
        .swipeActions(edge: .leading) {
            if item.unread {
                Button("Read", systemImage: "envelope.open") { app.markRead(pid, sid) }.tint(.blue)
            } else {
                Button("Unread", systemImage: "envelope.badge") { app.markUnread(pid, sid) }.tint(.blue)
            }
        }
        .swipeActions(edge: .trailing) {
            switch item.status {
            case .running, .background:
                Button("Stop", systemImage: "stop.fill", role: .destructive) { Task { await app.stop(projectId: pid, sessionId: sid) } }
            case .question:
                if let q = app.questions[sid] {
                    Button("Dismiss", systemImage: "xmark") { Task { await app.dismissQuestion(q) } }.tint(.orange)
                }
            case .failed, .parked:
                Button("Dismiss", systemImage: "xmark") { Task { await app.dismissOutcome(pid, sid) } }.tint(.orange)
            case .finished, .idle:
                if !item.draft {
                    Button(item.dismissed ? "Restore" : "Dismiss", systemImage: item.dismissed ? "arrow.uturn.backward" : "eye.slash") {
                        app.setRecentDismissed(pid, sid, !item.dismissed)
                    }
                    .tint(.gray)
                }
            }
        }
        .contextMenu {
            Button(item.unread ? "Mark as read" : "Mark as unread", systemImage: item.unread ? "envelope.open" : "envelope.badge") {
                item.unread ? app.markRead(pid, sid) : app.markUnread(pid, sid)
            }
            Button("Rename", systemImage: "pencil") {
                newTitle = item.conversation.title
                renaming = item
            }
            Button("Copy conversation ID", systemImage: "number") { UIPasteboard.general.string = sid }
            if let url = app.panelURL(projectId: pid, sessionId: sid, isChat: item.project.isChat) {
                Link(destination: url) { Label("Open in the panel", systemImage: "safari") }
            }
            if item.status.inProgress {
                Button("Stop", systemImage: "stop.fill", role: .destructive) { Task { await app.stop(projectId: pid, sessionId: sid) } }
            } else {
                Button("Remove from the panel", systemImage: "trash", role: .destructive) { Task { try? await app.remove(pid, sid) } }
            }
        }
    }
}

/// One conversation as Home sees it.
struct HomeItem: Identifiable {
    let project: Project
    let conversation: Conversation
    let status: ConvStatus
    let unread: Bool
    let draft: Bool
    let dismissed: Bool
    let meta: ConversationMeta?

    var id: String { AppModel.key(project.id, conversation.sessionId) }
    /// Epoch ms of the last message; 0 when unknown.
    var time: Double { conversation.lastMessageAt ?? 0 }
    var recentActivity: Double { conversation.lastMessageAt ?? conversation.createdAt ?? 0 }

    @MainActor
    static func all(in app: AppModel) -> [HomeItem] {
        var out: [HomeItem] = []
        for p in app.projects {
            for c in p.conversations ?? [] {
                let k = AppModel.key(p.id, c.sessionId)
                let meta = app.conversationMeta[k]
                if meta?.archived == true { continue }
                out.append(HomeItem(
                    project: p, conversation: c,
                    status: ConvStatus.of(p.id, c, in: app),
                    unread: app.unread[k] != nil,
                    draft: !app.draft(p.id, c.sessionId).isEmpty,
                    dismissed: app.recentDismissed.contains(k),
                    meta: meta))
            }
        }
        // Newest message first; conversations with none keep their order.
        return out.enumerated().sorted { l, r in
            l.element.time != r.element.time ? l.element.time > r.element.time : l.offset < r.offset
        }.map(\.element)
    }
}

/// The panel's conversation statuses (control-room.js cards()).
enum ConvStatus {
    case question, running, background, failed, parked, finished, idle

    @MainActor
    static func of(_ projectId: String, _ c: Conversation, in app: AppModel) -> ConvStatus {
        let sid = c.sessionId
        if app.questions[sid] != nil { return .question }
        if app.running.contains(sid) { return .running }
        if app.background.contains(sid) { return .background }
        let flag = app.unread[AppModel.key(projectId, sid)]
        switch c.lastOutcome?.status {
        case "failed": return .failed
        case "parked": return .parked
        case "completed": return .finished
        case nil: return flag == .failed ? .failed : flag == .done ? .finished : .idle
        default: return .idle
        }
    }

    var needsAttention: Bool { self == .question || self == .failed || self == .parked }
    var inProgress: Bool { self == .running || self == .background }
    var settled: Bool { self == .finished || self == .idle }

    var label: String {
        switch self {
        case .question: return "Needs input"
        case .running: return "Running"
        case .background: return "Background work"
        case .failed: return "Failed"
        case .parked: return "Parked"
        case .finished: return "Finished"
        case .idle: return "Idle"
        }
    }

    var color: Color {
        switch self {
        case .question: return .orange
        case .running: return Palette.ok
        case .background: return .purple
        case .failed: return .red
        case .parked: return Palette.warn
        case .finished, .idle: return .secondary
        }
    }
}

struct HomeRow: View {
    let item: HomeItem

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle()
                .fill(item.status.color)
                .frame(width: 9, height: 9)
                .padding(.top, 6)
                .opacity(item.status == .idle ? 0.5 : 1)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.conversation.title.isEmpty ? "Conversation" : item.conversation.title)
                        .fontWeight(item.unread ? .semibold : .regular)
                        .lineLimit(2)
                    if item.draft {
                        Text("Draft")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .foregroundStyle(Palette.clay)
                            .background(Palette.clayWeak, in: .capsule)
                    }
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let tags = item.meta?.tags, !tags.isEmpty {
                    Text(tags.joined(separator: ", "))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 4) {
                HStack(spacing: 5) {
                    if item.unread {
                        Circle().fill(.blue).frame(width: 7, height: 7).accessibilityLabel("Unread")
                    }
                    Text(item.time > 0 ? item.time.relativeFromMillis : "")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(item.status.label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(item.status.color)
            }
        }
        .padding(.vertical, 2)
    }

    private var subtitle: String {
        let kind = item.project.isChat ? "Chat" : "Work"
        let place = item.project.isChat ? kind : "\(item.project.name), \(kind)"
        let provider = (item.conversation.provider ?? item.project.providerName) == "codex" ? "ChatGPT" : "Claude"
        return "\(place), \(provider)"
    }
}
