import SwiftUI

struct ConversationsView: View {
    @Environment(AppModel.self) private var app
    let projectId: String
    @State private var showNew = false

    var body: some View {
        let project = app.project(projectId)
        let convs = (project?.conversations ?? []).sorted { $0.recency > $1.recency }
        List(convs) { c in
            NavigationLink(value: Route.conversation(projectId: projectId, sessionId: c.sessionId)) {
                ConversationRow(conversation: c, projectId: projectId)
            }
            .swipeActions(edge: .trailing) {
                if app.isWorking(c.sessionId) {
                    Button("Stop", systemImage: "stop.fill", role: .destructive) {
                        Task { await app.stop(projectId: projectId, sessionId: c.sessionId) }
                    }
                }
            }
            .contextMenu {
                if let url = app.panelURL(projectId: projectId, sessionId: c.sessionId, isChat: project?.isChat ?? false) {
                    Link(destination: url) { Label("Open in the panel", systemImage: "safari") }
                }
                if app.isWorking(c.sessionId) {
                    Button("Stop", systemImage: "stop.fill", role: .destructive) {
                        Task { await app.stop(projectId: projectId, sessionId: c.sessionId) }
                    }
                }
            }
        }
        .overlay {
            if convs.isEmpty {
                ContentUnavailableView {
                    Label("No conversations", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Start one to run a turn in \(project?.name ?? "this project").")
                } actions: {
                    Button("New conversation") { showNew = true }
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .refreshable { await app.refreshProjects() }
        .sheet(isPresented: $showNew) {
            NewConversationSheet(initialProject: projectId) { route in app.path.append(route) }
        }
        .navigationTitle(project?.name ?? "Project")
        .navigationSubtitle(project?.providerLabel ?? "")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New conversation", systemImage: "square.and.pencil") { showNew = true }
            }
        }
    }
}

struct ConversationRow: View {
    @Environment(AppModel.self) private var app
    let conversation: Conversation
    let projectId: String
    var showProject = false

    var body: some View {
        let sid = conversation.sessionId
        let state = WorkState.of(sid, in: app, outcome: conversation.lastOutcome)
        let queued = app.queued(projectId, sid).count
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(conversation.title.isEmpty ? "New conversation" : conversation.title)
                    .lineLimit(2)
                Text(detail(state: state, queued: queued))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            StateSymbol(state: state)
                .padding(.top, 2)
        }
    }

    private func detail(state: WorkState, queued: Int) -> String {
        var parts: [String] = []
        if showProject, let name = app.project(projectId)?.name { parts.append(name) }
        if state == .running, let account = app.runningAccounts[conversation.sessionId] {
            parts.append("Running on account \(account)")
        } else if state == .background {
            parts.append("Working in the background")
        } else if conversation.recency > 0 {
            parts.append(conversation.recency.relativeFromMillis)
        }
        if queued > 0 { parts.append("\(queued) queued") }
        return parts.joined(separator: ", ")
    }
}
