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
    var initialProject: String?
    var onCreated: (Route) -> Void = { _ in }

    @State private var kind: Kind = .chat
    @State private var projectId: String?
    @State private var provider = "codex"
    @State private var model = ""
    @State private var effort = ""
    @State private var account: String?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        let workProjects = app.projects.filter { !$0.isChat }.sorted { app.lastActivity($0) > app.lastActivity($1) }
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
                if kind == .work {
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
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
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
            .onChange(of: kind) { model = ""; effort = "" }
            .onAppear {
                if let initialProject {
                    kind = .work
                    projectId = initialProject
                } else if !app.chatsEnabled {
                    kind = .work
                }
                if projectId == nil { projectId = workProjects.first?.id }
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
                let (pid, sid) = try await app.newChat(provider: provider, model: model, effort: effort, account: account)
                finish(.conversation(projectId: pid, sessionId: sid))
            case .work:
                guard let projectId else { return }
                if let (pid, sid) = try await app.newWork(projectId: projectId, provider: provider, model: model, effort: effort, account: account) {
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
