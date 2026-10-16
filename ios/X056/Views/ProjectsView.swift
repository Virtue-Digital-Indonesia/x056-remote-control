import SwiftUI

struct ProjectsView: View {
    @Environment(AppModel.self) private var app
    @State private var showSettings = false

    var body: some View {
        let sorted = app.projects.sorted { app.lastActivity($0) > app.lastActivity($1) }
        let work = sorted.filter { !$0.isChat }
        let spaced = app.spacesEnabled && !app.spaces.isEmpty
        // With Projects (spaces), a chat lives inside its Project; only the
        // chats in none are listed on their own.
        let chats = sorted.filter { p in p.isChat && (!spaced || (p.conversations ?? []).allSatisfy { $0.spaceId == nil }) }
        List {
            if spaced {
                Section("Projects") {
                    ForEach(app.spaces) { SpaceRow(space: $0) }
                    NavigationLink(value: Route.space(nil)) {
                        HStack(spacing: 12) {
                            IconTile(symbol: "tray", color: .gray, size: 34)
                            Text("Not in a project")
                        }
                    }
                }
            }
            if case .failed(let message) = app.connection {
                Section {
                    Label(message, systemImage: "wifi.exclamationmark")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            }
            if !work.isEmpty {
                // A header only tells projects from chats; alone it repeats the title.
                Section(spaced ? "Repositories" : chats.isEmpty ? "" : "Projects") {
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
            // With Projects (spaces) new work is made through the sheet, in
            // its Project; a draft's first send would leave it in none.
            if !app.spacesEnabled {
                Button("New conversation", systemImage: "square.and.pencil") {
                    app.path.append(.project(project.id))
                    app.path.append(.draft(projectId: project.id, id: UUID()))
                }
            }
        }
    }
}

/// A Project (space) in the list: its name, how much is in it, and the
/// strongest state among its conversations.
struct SpaceRow: View {
    @Environment(AppModel.self) private var app
    let space: ProjectSpace

    var body: some View {
        let convs = app.conversations(inSpace: space.id)
        let state = WorkState.strongest(convs.map { WorkState.of($0.conversation.sessionId, in: app) })
        let last = convs.first?.conversation.recency ?? 0
        NavigationLink(value: Route.space(space.id)) {
            HStack(spacing: 12) {
                IconTile(symbol: "square.stack.3d.up.fill", color: Palette.clay, size: 34)
                VStack(alignment: .leading, spacing: 2) {
                    Text(space.name).lineLimit(1)
                    Text(convs.isEmpty ? "Empty" : (convs.count == 1 ? "1 conversation" : "\(convs.count) conversations") + (last > 0 ? ", \(last.relativeFromMillis)" : ""))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                StateSymbol(state: state)
            }
        }
    }
}

/// One Project's conversations (work in any of its repositories, and its
/// chats), or those in none. New conversations started here belong to it.
struct SpaceView: View {
    @Environment(AppModel.self) private var app
    let spaceId: String?
    @State private var showNew = false

    var body: some View {
        let convs = app.conversations(inSpace: spaceId)
        let name = spaceId.flatMap { app.space($0)?.name } ?? "Not in a project"
        List(convs, id: \.conversation.sessionId) { item in
            NavigationLink(value: Route.conversation(projectId: item.projectId, sessionId: item.conversation.sessionId)) {
                ConversationRow(conversation: item.conversation, projectId: item.projectId, showProject: true)
            }
            .swipeActions(edge: .trailing) {
                if app.isWorking(item.conversation.sessionId) {
                    Button("Stop", systemImage: "stop.fill", role: .destructive) {
                        Task { await app.stop(projectId: item.projectId, sessionId: item.conversation.sessionId) }
                    }
                }
            }
        }
        .overlay {
            if convs.isEmpty {
                ContentUnavailableView {
                    Label("No conversations", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(spaceId == nil ? "Work and chats that belong to no project show up here." : "Start one; it belongs to \(name).")
                } actions: {
                    if spaceId != nil {
                        Button("New conversation") { showNew = true }
                            .buttonStyle(.glassProminent)
                    }
                }
            }
        }
        .refreshable { await app.refreshProjects() }
        .sheet(isPresented: $showNew) {
            NewConversationSheet(initialSpace: spaceId) { route in app.path.append(route) }
        }
        .navigationTitle(name)
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("New conversation", systemImage: "square.and.pencil") { showNew = true }
            }
        }
    }
}
