import SwiftUI

struct ProjectsView: View {
    @Environment(AppModel.self) private var app
    @State private var search = ""
    @State private var showApprovals = false
    @State private var showAccounts = false
    @State private var showSettings = false

    private var filtered: [Project] {
        let q = search.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? app.projects : app.projects.filter { $0.name.localizedCaseInsensitiveContains(q) }
    }

    var body: some View {
        List {
            if case .failed(let message) = app.connection {
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            let work = filtered.filter { !$0.isChat }
            let chats = filtered.filter(\.isChat)
            if !work.isEmpty {
                Section(chats.isEmpty ? "" : "Projects") {
                    ForEach(work) { ProjectRow(project: $0) }
                }
            }
            if !chats.isEmpty {
                Section("Chats") {
                    ForEach(chats) { ProjectRow(project: $0) }
                }
            }
        }
        .overlay {
            if !app.projectsLoaded {
                if let error = app.projectsError {
                    ContentUnavailableView("Can't reach the gateway", systemImage: "network.slash", description: Text(error))
                } else {
                    ProgressView()
                }
            }
        }
        .searchable(text: $search, prompt: "Projects")
        .refreshable { await app.refreshAll() }
        .navigationTitle("x056")
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showAccounts = true } label: { Image(systemName: "gauge.with.dots.needle.50percent") }
                    .accessibilityLabel("Accounts")
                Button { showApprovals = true } label: {
                    Image(systemName: app.approvals.isEmpty ? "checkmark.shield" : "checkmark.shield.fill")
                        .overlay(alignment: .topTrailing) {
                            if !app.approvals.isEmpty {
                                Text("\(app.approvals.count)")
                                    .font(.caption2.bold())
                                    .foregroundStyle(.white)
                                    .padding(3)
                                    .background(.red, in: Circle())
                                    .offset(x: 8, y: -8)
                            }
                        }
                }
                .accessibilityLabel(app.approvals.isEmpty ? "Approvals" : "Approvals, \(app.approvals.count) pending")
            }
        }
        .sheet(isPresented: $showApprovals) { ApprovalsView() }
        .sheet(isPresented: $showAccounts) { AccountsView() }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }
}

struct ProjectRow: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        let convs = project.conversations ?? []
        let ids = Set(convs.map(\.sessionId))
        let running = !ids.isDisjoint(with: app.running)
        let background = !ids.isDisjoint(with: app.background)
        let asking = convs.contains { app.questions[$0.sessionId] != nil }
        let last = convs.map(\.recency).max()
        NavigationLink(value: Route.project(project.id)) {
            HStack(spacing: 10) {
                Image(systemName: project.isChat ? "bubble.left.and.bubble.right" : "folder")
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name).lineLimit(1)
                    HStack(spacing: 6) {
                        Text(project.providerName == "codex" ? "ChatGPT" : "Claude")
                        if let last, last > 0 { Text("· \(last.relativeFromMillis)") }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Spacer()
                if asking {
                    Image(systemName: "questionmark.bubble.fill").foregroundStyle(.orange)
                }
                WorkingIndicator(running: running, background: background && !running)
            }
        }
    }
}
