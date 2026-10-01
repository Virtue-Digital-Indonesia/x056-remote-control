import SwiftUI

/// Across every project: what waits on you, and what is running.
struct ActivityView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        let questions = app.questions.values.sorted { $0.at > $1.at }
        let running = app.running.compactMap { app.locate($0) }.sorted { $0.conversation.recency > $1.conversation.recency }
        let background = app.background.subtracting(app.running).compactMap { app.locate($0) }
        List {
            if !app.approvals.isEmpty {
                Section {
                    ForEach(app.approvals) { ApprovalRow(approval: $0) }
                } header: {
                    Text("Waiting for your approval")
                } footer: {
                    Text("A conversation asked to message another one.")
                }
            }
            if !questions.isEmpty {
                Section("Asked you something") {
                    ForEach(questions, id: \.sessionId) { q in
                        NavigationLink(value: Route.conversation(projectId: q.projectId, sessionId: q.sessionId)) {
                            QuestionRow(question: q)
                        }
                    }
                }
            }
            if !running.isEmpty {
                Section("Working now") {
                    ForEach(running, id: \.conversation.sessionId) { item in
                        link(item.project, item.conversation)
                    }
                }
            }
            if !background.isEmpty {
                Section("Working in the background") {
                    ForEach(background, id: \.conversation.sessionId) { item in
                        link(item.project, item.conversation)
                    }
                }
            }
        }
        .overlay {
            if app.approvals.isEmpty && questions.isEmpty && running.isEmpty && background.isEmpty {
                ContentUnavailableView("All quiet", systemImage: "checkmark.circle", description: Text("Nothing is running and nothing waits on you."))
            }
        }
        .refreshable { await app.refreshAll() }
        .navigationTitle("Activity")
    }

    private func link(_ project: Project, _ conversation: Conversation) -> some View {
        NavigationLink(value: Route.conversation(projectId: project.id, sessionId: conversation.sessionId)) {
            ConversationRow(conversation: conversation, projectId: project.id, showProject: true)
        }
        .swipeActions(edge: .trailing) {
            Button("Stop", systemImage: "stop.fill", role: .destructive) {
                Task { await app.stop(projectId: project.id, sessionId: conversation.sessionId) }
            }
        }
    }
}

struct QuestionRow: View {
    @Environment(AppModel.self) private var app
    let question: PendingQuestion

    var body: some View {
        let place = app.locate(question.sessionId)
        VStack(alignment: .leading, spacing: 6) {
            Text(question.parts.count > 1 ? "\(question.parts.count) questions" : question.question)
                .lineLimit(3)
            Text(place.map { "\($0.project.name), \($0.conversation.title)" } ?? "A conversation")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
    }
}

/// One `send_message` waiting for a person, decided in place.
struct ApprovalRow: View {
    @Environment(AppModel.self) private var app
    let approval: McpApproval
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(approval.sender?.conversationTitle ?? approval.sender?.projectName ?? "A conversation")
                Image(systemName: "arrow.right").foregroundStyle(.secondary).imageScale(.small)
                Text(approval.targetLabel ?? approval.projectName ?? "a project")
            }
            .font(.subheadline.weight(.semibold))
            .lineLimit(1)
            Text(approval.message)
                .font(.callout)
                .lineLimit(8)
                .textSelection(.enabled)
            if let review = approval.contextReview {
                Label(review.reason ?? "Approving also changes this project's shared context.", systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack(spacing: 10) {
                Button("Deny", role: .destructive) { Task { await decide(false) } }
                    .buttonStyle(.glass)
                Spacer()
                Button("Approve") { Task { await decide(true) } }
                    .buttonStyle(.glassProminent)
            }
            .disabled(busy)
        }
        .padding(.vertical, 4)
    }

    private func decide(_ approve: Bool) async {
        busy = true
        defer { busy = false }
        do {
            try await app.decide(approval, approve: approve)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
