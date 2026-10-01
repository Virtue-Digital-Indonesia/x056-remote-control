import SwiftUI

struct ConversationsView: View {
    @Environment(AppModel.self) private var app
    let projectId: String

    var body: some View {
        let project = app.project(projectId)
        let convs = (project?.conversations ?? []).sorted { $0.recency > $1.recency }
        List(convs) { c in
            NavigationLink(value: Route.conversation(projectId: projectId, sessionId: c.sessionId)) {
                ConversationRow(conversation: c, projectId: projectId)
            }
        }
        .overlay {
            if convs.isEmpty {
                ContentUnavailableView("No conversations", systemImage: "bubble.left", description: Text("Start one with the compose button."))
            }
        }
        .refreshable { await app.refreshProjects() }
        .navigationTitle(project?.name ?? "Project")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                NavigationLink(value: Route.draft(projectId: projectId, id: UUID())) {
                    Image(systemName: "square.and.pencil")
                }
            }
        }
    }
}

struct ConversationRow: View {
    @Environment(AppModel.self) private var app
    let conversation: Conversation
    let projectId: String

    var body: some View {
        let sid = conversation.sessionId
        let running = app.running.contains(sid)
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title.isEmpty ? "New conversation" : conversation.title)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if conversation.recency > 0 { Text(conversation.recency.relativeFromMillis) }
                    if let account = app.runningAccounts[sid], running { Text("· account \(account)") }
                    let queued = app.queued(projectId, sid).count
                    if queued > 0 { Text("· \(queued) queued") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            if app.questions[sid] != nil {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(.orange)
            } else if conversation.lastOutcome?.status == "failed", !running {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
            }
            WorkingIndicator(running: running, background: app.background.contains(sid) && !running)
        }
    }
}
