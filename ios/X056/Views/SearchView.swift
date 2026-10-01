import SwiftUI

/// Find a conversation by title, across every project.
struct SearchView: View {
    @Environment(AppModel.self) private var app
    @State private var query = ""

    var body: some View {
        let q = query.trimmingCharacters(in: .whitespaces)
        let all = app.projects.flatMap { p in (p.conversations ?? []).map { (project: p, conversation: $0) } }
        let hits = q.isEmpty
            ? Array(all.sorted { $0.conversation.recency > $1.conversation.recency }.prefix(25))
            : all.filter { $0.conversation.title.localizedCaseInsensitiveContains(q) || $0.project.name.localizedCaseInsensitiveContains(q) }
                .sorted { $0.conversation.recency > $1.conversation.recency }
        List {
            Section(q.isEmpty ? "Recent" : "Conversations") {
                ForEach(hits, id: \.conversation.sessionId) { item in
                    NavigationLink(value: Route.conversation(projectId: item.project.id, sessionId: item.conversation.sessionId)) {
                        ConversationRow(conversation: item.conversation, projectId: item.project.id, showProject: true)
                    }
                }
            }
        }
        .overlay {
            if !q.isEmpty && hits.isEmpty {
                ContentUnavailableView.search(text: q)
            }
        }
        .searchable(text: $query, prompt: "Conversations and projects")
        .navigationTitle("Search")
    }
}
