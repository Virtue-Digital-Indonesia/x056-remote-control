import SwiftUI

/// Choices for a conversation the first message will create (Work without
/// project spaces), handed from the sheet to the draft screen.
struct DraftSettings: Hashable {
    var model = ""
    var effort = ""
    var account: String?
}

/// New Chat, or new Work in a project: provider, model, effort, account.
struct NewConversationSheet: View {
    enum Kind: Hashable { case chat, work }

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    /// A repository to start work in.
    var initialProject: String?
    /// A Project (space) to start in.
    var initialSpace: String?
    var onCreated: (Route) -> Void = { _ in }

    @State private var kind: Kind = .chat
    /// The repository work runs in.
    @State private var projectId: String?
    /// The Project (space) it belongs to; nil = none.
    @State private var spaceId: String?
    @State private var provider = "codex"
    @State private var model = ""
    @State private var effort = ""
    @State private var account: String?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let spaced = app.spacesEnabled && !app.spaces.isEmpty
        let workProjects = (spaced ? app.repos(inSpace: spaceId) : app.projects.filter { !$0.isChat })
            .sorted { app.lastActivity($0) > app.lastActivity($1) }
        // Any repository can take a Project's work, as in the panel: its own
        // first, then the rest (a new Project has none of its own yet).
        let otherRepos = spaced && spaceId != nil
            ? app.repos(inSpace: nil).filter { r in !workProjects.contains { $0.id == r.id } }.sorted { app.lastActivity($0) > app.lastActivity($1) }
            : []
        let fixedProvider = kind == .work && !app.spacesEnabled
        let providerNow = fixedProvider ? (app.project(projectId ?? "")?.providerName ?? provider) : provider
        let models = ModelCatalog.models(provider: providerNow, codex: app.codexModels)
        let efforts = ModelCatalog.efforts(provider: providerNow, model: model, codex: app.codexModels)
        NavigationStack {
            Form {
                if app.chatsEnabled {
                    Picker("Start", selection: $kind) {
                        Label("Chat", systemImage: "bubble.left.and.text.bubble.right").tag(Kind.chat)
                        Label("Work", systemImage: "folder").tag(Kind.work)
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }
                if let error {
                    // At the top: below the form it was off screen.
                    Section { Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red) }
                }
                if spaced {
                    Section {
                        Picker("Project", selection: $spaceId) {
                            Text("None").tag(String?.none)
                            ForEach(app.spaces) { s in Text(s.name).tag(Optional(s.id)) }
                        }
                        if kind == .work {
                            Picker("Repository", selection: $projectId) {
                                if projectId == nil { Text("Choose one").tag(String?.none) }
                                Section { ForEach(workProjects) { p in Text(p.name).tag(Optional(p.id)) } }
                                if !otherRepos.isEmpty {
                                    Section(workProjects.isEmpty ? "Repositories" : "Other repositories") {
                                        ForEach(otherRepos) { p in Text(p.name).tag(Optional(p.id)) }
                                    }
                                }
                            }
                        }
                    } footer: {
                        if spaceId == nil {
                            Text("It belongs to no project, like Unassigned work in the panel.")
                        } else if kind == .work && workProjects.isEmpty {
                            Text("This project has no repository yet. Choose the one the work runs in; the conversation shows in this project.")
                        } else {
                            Text("It shows in this project on the phone and in the panel.")
                        }
                    }
                } else if kind == .work {
                    Section("Project") {
                        Picker("Project", selection: $projectId) {
                            ForEach(workProjects) { p in Text(p.name).tag(Optional(p.id)) }
                        }
                    }
                }
                Section {
                    if fixedProvider {
                        LabeledContent("Provider", value: providerNow == "codex" ? "ChatGPT" : "Claude")
                    } else {
                        Picker("Provider", selection: $provider) {
                            Text("ChatGPT").tag("codex")
                            Text("Claude").tag("claude")
                        }
                        .pickerStyle(.segmented)
                    }
                    Picker("Model", selection: $model) {
                        ForEach(models, id: \.self) { Text($0.label).tag($0.value) }
                    }
                    Picker("Effort", selection: $effort) {
                        ForEach(efforts, id: \.self) { Text(ModelCatalog.effortLabel($0)).tag($0) }
                    }
                } footer: {
                    if fixedProvider { Text("New work uses the project's provider.") }
                }
                Section {
                    Picker("Account", selection: $account) {
                        Text("Automatic").tag(String?.none)
                        ForEach(app.pool(providerNow)) { a in
                            Text(a.title + (a.isAvailable ? "" : " (\(a.level))")).tag(Optional(a.name))
                        }
                    }
                } footer: {
                    Text(kind == .chat ? "The chat is named from your first message." : "Automatic routing picks the account; a chosen one stays with this conversation.")
                }
            }
            .navigationTitle(kind == .chat ? "New chat" : "New work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if busy {
                        ProgressView()
                    } else {
                        Button("Create") { Task { await create(provider: providerNow) } }
                            .disabled(kind == .work && projectId == nil)
                    }
                }
            }
            .onChange(of: provider) { model = ""; effort = "" }
            .onChange(of: spaceId) {
                // The Project's default repository, else keep one it lists,
                // else its first; with none of its own, the person chooses.
                let repos = app.repos(inSpace: spaceId).sorted { app.lastActivity($0) > app.lastActivity($1) }
                if let def = spaceId.flatMap({ app.space($0)?.defaultWorkProjectId }), app.project(def) != nil {
                    projectId = def
                } else if !repos.contains(where: { $0.id == projectId }) {
                    projectId = repos.first?.id
                }
            }
            .onChange(of: kind) { model = ""; effort = "" }
            // New work starts on its repository's provider, as in the panel.
            .onChange(of: projectId) { if spaced, let p = projectId.flatMap(app.project) { provider = p.providerName } }
            .onAppear {
                if let initialSpace {
                    spaceId = initialSpace
                    projectId = app.space(initialSpace)?.defaultWorkProjectId ?? workProjects.first?.id
                    if !app.chatsEnabled { kind = .work }
                } else if let initialProject {
                    kind = .work
                    projectId = initialProject
                    // Work from a repository belongs where the repository does.
                    if spaced { spaceId = app.defaultSpace(forRepo: initialProject) }
                } else if !app.chatsEnabled {
                    kind = .work
                }
                if projectId == nil { projectId = workProjects.first?.id }
                if spaced, kind == .work, let p = projectId.flatMap(app.project) { provider = p.providerName }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func create(provider: String) async {
        busy = true
        defer { busy = false }
        do {
            switch kind {
            case .chat:
                let (pid, sid) = try await app.newChat(provider: provider, model: model, effort: effort, account: account, spaceId: spaceId)
                finish(.conversation(projectId: pid, sessionId: sid))
            case .work:
                guard let projectId else { return }
                if let (pid, sid) = try await app.newWork(projectId: projectId, provider: provider, model: model, effort: effort, account: account, spaceId: spaceId) {
                    finish(.conversation(projectId: pid, sessionId: sid))
                } else {
                    let id = UUID()
                    app.draftSettings[id] = DraftSettings(model: model, effort: effort, account: account)
                    finish(.draft(projectId: projectId, id: id))
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func finish(_ route: Route) {
        dismiss()
        onCreated(route)
    }
}
