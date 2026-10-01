import SwiftUI

struct ProjectsView: View {
    @Environment(AppModel.self) private var app
    @State private var showSettings = false

    var body: some View {
        let sorted = app.projects.sorted { app.lastActivity($0) > app.lastActivity($1) }
        let work = sorted.filter { !$0.isChat }
        let chats = sorted.filter(\.isChat)
        List {
            if case .failed(let message) = app.connection {
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            if !work.isEmpty {
                // A header only tells projects from chats; alone it repeats the title.
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
            } else if app.projects.isEmpty {
                ContentUnavailableView("No projects yet", systemImage: "folder", description: Text("Create one in the panel. It shows up here."))
            }
        }
        .refreshable { await app.refreshAll() }
        .navigationTitle("Projects")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            }
        }
        .sheet(isPresented: $showSettings) { SettingsView() }
    }
}

struct ProjectRow: View {
    @Environment(AppModel.self) private var app
    let project: Project

    var body: some View {
        let convs = project.conversations ?? []
        let state = WorkState.strongest(convs.map { WorkState.of($0.sessionId, in: app) })
        let last = app.lastActivity(project)
        NavigationLink(value: Route.project(project.id)) {
            HStack(spacing: 12) {
                ProjectTile(isChat: project.isChat)
                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .lineLimit(1)
                    Text(last > 0 ? "\(project.providerLabel), \(last.relativeFromMillis)" : project.providerLabel)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                StateSymbol(state: state)
            }
        }
        .contextMenu {
            if let url = app.panelURL(projectId: project.id, sessionId: nil, isChat: project.isChat) {
                Link(destination: url) { Label("Open in the panel", systemImage: "safari") }
            }
            Button("New conversation", systemImage: "square.and.pencil") {
                app.path.append(.project(project.id))
                app.path.append(.draft(projectId: project.id, id: UUID()))
            }
        }
    }
}
