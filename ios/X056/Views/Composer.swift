import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Everything that floats over the bottom of a conversation, in glass.
/// Back to the newest message, and keep following it.
struct LatestButton: View {
    let working: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label {
                Text("Latest")
            } icon: {
                if working { ProgressView().controlSize(.mini) } else { Image(systemName: "arrow.down") }
            }
        }
        .buttonStyle(.glass)
        .accessibilityHint("Scrolls to the newest message and keeps it in view")
    }
}

struct ComposerArea: View {
    let model: ConversationModel
    /// Folded while reading back through history.
    @Binding var folded: Bool
    var jumpToLatest: () -> Void = {}
    var openAutopilot: () -> Void = {}
    @Environment(AppModel.self) private var app
    @State private var showQueue = false
    /// Typing a message: a question card folds to its header, or with the
    /// keyboard up the two fill the screen and send hides behind the keys.
    @State private var typing = false

    var body: some View {
        VStack(spacing: 0) {
            if folded {
                HStack(spacing: 10) {
                    Spacer()
                    LatestButton(working: model.isWorking, action: jumpToLatest)
                    Button { withAnimation(.snappy) { folded = false } } label: {
                        Label("Write", systemImage: "square.and.pencil")
                    }
                    .buttonStyle(.glass)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            fullArea
                // Still alive while folded (the draft and attached files stay),
                // but taking no room: the history gets the screen.
                .frame(maxHeight: folded ? 0 : nil, alignment: .top)
                .clipped()
                .opacity(folded ? 0 : 1)
                .allowsHitTesting(!folded)
                .accessibilityHidden(folded)
                .environment(\.composerFolded, folded)
        }
        .frame(maxWidth: 800)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .sheet(isPresented: $showQueue) { QueueSheet(model: model) }
    }

    private var fullArea: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 10) {
                if let banner = model.banner {
                    Label(banner, systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .glassEffect(.regular.tint(.orange.opacity(0.18)), in: .rect(cornerRadius: 16, style: .continuous))
                }
                if let error = model.sendError {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .glassEffect(.regular, in: .rect(cornerRadius: 16, style: .continuous))
                }
                if let sid = model.sessionId, let pilot = app.autopilot[sid] {
                    AutopilotBar(state: pilot, working: model.isWorking, open: openAutopilot) {
                        Task { try? await app.stopAutopilot(sessionId: sid) }
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let q = model.question {
                    QuestionCard(question: q, model: model, folded: typing)
                }
                Composer(model: model, showQueue: $showQueue, editing: $typing)
            }
        }
    }
}

struct Composer: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    @Binding var showQueue: Bool
    /// Set while the message box has the keyboard.
    var editing: Binding<Bool>? = nil
    @State private var text = ""
    @State private var files: [PendingFile] = []
    @State private var picks: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showFiles = false
    @State private var showHelpers = false
    @State private var loadedDraft = false

    /// The panel's paste rule: 30 lines or 4000 characters becomes a file.
    private static let longTextChars = 4000
    private static let longTextLines = 30

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    RunChip(model: model)
                    Button { showHelpers = true } label: {
                        let pill = model.helpers.summary(router: model.router)
                        ChipLabel(icon: "sparkles", text: pill.isEmpty ? "Helpers" : pill, active: !pill.isEmpty)
                    }
                    .buttonStyle(.plain)
                    AccountChip(model: model)
                    if !model.queued.isEmpty {
                        Button { showQueue = true } label: {
                            ChipLabel(icon: "tray.full", text: "\(model.queued.count) queued", active: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 2)
            }
            .scrollClipDisabled()
            if !files.isEmpty {
                AttachmentTray(files: $files)
            }
            HStack(alignment: .bottom, spacing: 8) {
                Menu {
                    Button("Photos", systemImage: "photo.on.rectangle") { showPhotos = true }
                    Button("Files", systemImage: "folder") { showFiles = true }
                    Button("Paste", systemImage: "doc.on.clipboard") { pasteFromMenu() }
                } label: {
                    Image(systemName: "plus")
                        .font(.title3.weight(.medium))
                        .frame(width: 44, height: 44)
                }
                .glassEffect(.regular.interactive(), in: .circle)
                .accessibilityLabel("Attach")
                ComposerTextView(text: $text, placeholder: placeholder, longTextLimit: Self.longTextChars, editing: editing) { pasted in
                    files.append(contentsOf: pasted)
                }
                .frame(minHeight: 44)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22, style: .continuous))
                primaryButton(empty: empty)
            }
        }
        .animation(.snappy, value: model.isWorking && empty)
        .photosPicker(isPresented: $showPhotos, selection: $picks, maxSelectionCount: 10, matching: .images)
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { files.append(contentsOf: urls.compactMap(Self.read)) }
        }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for (i, item) in items.enumerated() {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data),
                       let f = PendingFile.photo(img, index: files.count + i + 1) {
                        files.append(f)
                    }
                }
                picks = []
            }
        }
        .onChange(of: text) { _, t in
            if t.split(separator: "\n", omittingEmptySubsequences: false).count >= Self.longTextLines && t.count > 200 && !loadedDraft {
                // A long paste that slipped past the text view (dictation, Scribble).
                files.append(.text(t))
                text = ""
            }
            loadedDraft = false
            app.setDraft(model.projectId, model.sessionId, t)
        }
        .onAppear {
            let draft = app.draft(model.projectId, model.sessionId)
            if text.isEmpty && !draft.isEmpty {
                loadedDraft = true
                text = draft
            }
        }
        .sheet(isPresented: $showHelpers) { HelpersSheet(model: model) }
    }

    private var placeholder: String {
        model.isWorking ? "Queue a message, or steer" : "Message"
    }

    @ViewBuilder
    private func primaryButton(empty: Bool) -> some View {
        if model.isWorking && empty {
            Button {
                Task { await model.stop() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.title3.weight(.semibold))
                    .frame(width: 44, height: 44)
            }
            .glassEffect(.regular.tint((model.isBackground ? Color.purple : Color.red).opacity(0.85)).interactive(), in: .circle)
            .foregroundStyle(.white)
            .accessibilityLabel("Stop")
        } else if model.isWorking {
            // Tap queues for after this turn; hold to steer into it.
            Menu {
                Button("Steer into this turn", systemImage: "arrow.turn.down.right") { submit(.steer) }
                    .disabled(!files.isEmpty)
                Button("Queue for after this turn", systemImage: "tray.and.arrow.down") { submit(.queue) }
            } label: {
                Image(systemName: "tray.and.arrow.down.fill")
                    .font(.title3.weight(.semibold))
                    .frame(width: 44, height: 44)
            } primaryAction: {
                submit(.queue)
            }
            .glassEffect(.regular.tint(Palette.clay).interactive(), in: .circle)
            .foregroundStyle(.white)
            .accessibilityLabel("Queue")
            .accessibilityHint("Hold to steer into the running turn instead")
            .accessibilityIdentifier("send")
        } else {
            Button { submit(.send) } label: {
                Image(systemName: "arrow.up")
                    .font(.title3.weight(.semibold))
                    .frame(width: 44, height: 44)
            }
            .glassEffect(.regular.tint(Palette.clay).interactive(), in: .circle)
            .foregroundStyle(.white)
            .disabled(empty)
            .opacity(empty ? 0.5 : 1)
            .accessibilityLabel("Send")
            .accessibilityIdentifier("send")
        }
    }

    private func submit(_ mode: ConversationModel.SendMode) {
        let t = text
        let f = files
        text = ""
        files = []
        app.setDraft(model.projectId, model.sessionId, "")
        Task { await model.send(t, files: f, mode: mode) }
    }

    /// "Paste" from the + menu: whatever is on the clipboard, as attachments
    /// when it is not short text.
    private func pasteFromMenu() {
        let pb = UIPasteboard.general
        if let images = pb.images, !images.isEmpty {
            files.append(contentsOf: images.enumerated().compactMap { PendingFile.photo($0.element, index: files.count + $0.offset + 1) })
        } else if let s = pb.string {
            if s.count >= Self.longTextChars || s.split(separator: "\n", omittingEmptySubsequences: false).count >= Self.longTextLines {
                files.append(.text(s))
            } else {
                text += s
            }
        }
    }

    private static func read(_ url: URL) -> PendingFile? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)
        return PendingFile(name: url.lastPathComponent, data: data, mime: PendingFile.mime(for: type, fallbackName: url.lastPathComponent))
    }
}

/// A small glass capsule in the composer's control row.
struct ChipLabel: View {
    let icon: String
    let text: String
    var active = false
    var dot: Color?

    var body: some View {
        HStack(spacing: 6) {
            if let dot {
                Circle().fill(dot).frame(width: 7, height: 7)
            } else {
                Image(systemName: icon).imageScale(.small)
            }
            Text(text).lineLimit(1)
            Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.tertiary)
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(active ? AnyShapeStyle(Palette.clay) : AnyShapeStyle(.secondary))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .glassEffect(.regular.interactive(), in: .capsule)
    }
}

/// Model and effort: what the next turn runs with, or "Jev picks". Opens
/// the model and effort sheet.
struct RunChip: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    @State private var show = false

    var body: some View {
        Button { show = true } label: {
            ChipLabel(icon: model.routerOn && model.model.isEmpty ? "wand.and.stars" : "cpu", text: summary, active: true)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Model and effort: \(summary)")
        .sheet(isPresented: $show) { ModelEffortSheet(model: model) }
    }

    private var picker: String { model.router == "decisions" ? "OpenAI" : "Jev" }

    private var summary: String {
        if model.routerOn && model.model.isEmpty {
            if let pick = model.latestPick, let ran = pick.ranModel {
                return "\(picker): " + [ModelCatalog.displayName(ran), pick.ranEffort.map(ModelCatalog.effortLabel)].compactMap { $0 }.joined(separator: " · ")
            }
            return "\(picker) picks"
        }
        let m = model.model.isEmpty ? "Auto" : ModelCatalog.modelLabel(model.model, provider: model.provider, codex: app.codexModels)
        let e = model.effort.isEmpty ? nil : ModelCatalog.effortLabel(model.effort)
        return [m, e].compactMap { $0 }.joined(separator: " · ")
    }
}

/// "Send with <account>": the next turn's account, with its usage level.
struct AccountChip: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    @State private var routing: RoutingPreview?

    var body: some View {
        let pool = app.pool(model.provider)
        let chosen = model.sessionId == nil
            ? (model.draftAccount ?? pool.first { $0.nextUp == true && $0.isAvailable }?.name)
            : (routing?.preferences?.nextAccount ?? routing?.selected)
        let account = pool.first { $0.name == chosen }
        Menu {
            Section("Send with account") {
                Button {
                    choose(nil)
                } label: {
                    Label("Automatic", systemImage: isAutomatic ? "checkmark" : "arrow.triangle.branch")
                }
                ForEach(pool) { a in
                    Button {
                        choose(a.name)
                    } label: {
                        Label {
                            Text(a.title)
                            Text(a.level)
                        } icon: {
                            Image(systemName: chosen == a.name && !isAutomatic ? "checkmark" : "person.crop.circle")
                        }
                    }
                    .disabled(!a.isAvailable)
                }
            }
            if model.isRunning, let sid = model.sessionId {
                Section("Switch the running turn now") {
                    ForEach(pool.filter { $0.isAvailable && $0.name != routing?.runningAccount }) { a in
                        Button(a.title, systemImage: "arrow.left.arrow.right") {
                            Task {
                                try? await app.switchAccountNow(model.projectId, sid, a.name)
                                await refresh()
                            }
                        }
                    }
                }
            }
        } label: {
            ChipLabel(icon: "person.crop.circle", text: label(account?.title ?? chosen), active: !isAutomatic, dot: account?.levelColor ?? .secondary)
        }
        .buttonStyle(.plain)
        .task(id: model.sessionId) { await refresh() }
        .onChange(of: model.isRunning) { Task { await refresh() } }
    }

    private var isAutomatic: Bool {
        model.sessionId == nil ? model.draftAccount == nil : routing?.preferences?.nextAccount == nil
    }

    private func label(_ name: String?) -> String {
        guard let name else { return "No available account" }
        return (model.isRunning ? "Next: " : "Send with ") + name
    }

    private func choose(_ account: String?) {
        guard let sid = model.sessionId else {
            model.draftAccount = account
            return
        }
        Task {
            do {
                try await app.setNextAccount(model.projectId, sid, account)
            } catch {
                model.sendError = error.localizedDescription
            }
            await refresh()
        }
    }

    private func refresh() async {
        guard let sid = model.sessionId else { return }
        routing = await app.routingPreview(model.projectId, sid)
    }
}

struct AttachmentTray: View {
    @Binding var files: [PendingFile]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(files) { f in
                    HStack(spacing: 8) {
                        if let img = f.image {
                            Image(uiImage: img)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 40, height: 40)
                                .clipShape(.rect(cornerRadius: 8, style: .continuous))
                        } else {
                            Image(systemName: f.mime.hasPrefix("text/") ? "doc.text" : "doc")
                                .font(.title3)
                                .frame(width: 40, height: 40)
                                .background(.quaternary.opacity(0.5), in: .rect(cornerRadius: 8, style: .continuous))
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(f.name).font(.caption.weight(.medium)).lineLimit(1)
                            Text(f.sizeLabel).font(.caption2).foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: 130, alignment: .leading)
                        Button("Remove \(f.name)", systemImage: "xmark.circle.fill") { files.removeAll { $0.id == f.id } }
                            .labelStyle(.iconOnly)
                            .foregroundStyle(.secondary)
                    }
                    .padding(6)
                    .glassEffect(.regular, in: .rect(cornerRadius: 14, style: .continuous))
                }
            }
            .padding(.horizontal, 2)
        }
        .scrollClipDisabled()
    }
}

/// This conversation's queued messages: edit, reorder, pause, remove.
struct QueueSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ConversationModel
    @State private var editing: QueueItem?
    @State private var editText = ""

    var body: some View {
        let items = model.queued
        NavigationStack {
            List {
                Section {
                    ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.text).lineLimit(4)
                            Text(status(item, first: i == 0))
                                .font(.caption)
                                .foregroundStyle(item.paused == true || item.error != nil ? .orange : .secondary)
                        }
                        .swipeActions {
                            Button("Remove", systemImage: "trash", role: .destructive) { Task { await model.cancelQueued(item.id) } }
                            Button(item.paused == true ? "Resume" : "Pause", systemImage: item.paused == true ? "play" : "pause") {
                                Task { try? await app.editQueued(model.projectId, item.id, paused: item.paused != true) }
                            }
                            .tint(.orange)
                        }
                        .contextMenu {
                            Button("Edit", systemImage: "pencil") {
                                editText = item.text
                                editing = item
                            }
                            Button(item.paused == true ? "Resume" : "Pause", systemImage: item.paused == true ? "play" : "pause") {
                                Task { try? await app.editQueued(model.projectId, item.id, paused: item.paused != true) }
                            }
                            if i > 0 {
                                Button("Move up", systemImage: "arrow.up") { Task { try? await app.moveQueued(model.projectId, item.id, by: -1) } }
                            }
                            if i < items.count - 1 {
                                Button("Move down", systemImage: "arrow.down") { Task { try? await app.moveQueued(model.projectId, item.id, by: 1) } }
                            }
                            Button("Remove", systemImage: "trash", role: .destructive) { Task { await model.cancelQueued(item.id) } }
                        }
                    }
                } footer: {
                    Text("Queued messages send when this conversation is free, in this order.")
                }
            }
            .overlay {
                if items.isEmpty {
                    ContentUnavailableView("Nothing queued", systemImage: "tray", description: Text("While a turn runs, Send queues the next message here."))
                }
            }
            .navigationTitle("Queued")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .alert("Edit queued message", isPresented: Binding(get: { editing != nil }, set: { if !$0 { editing = nil } })) {
                TextField("Message", text: $editText, axis: .vertical)
                Button("Save") {
                    if let item = editing { Task { try? await app.editQueued(model.projectId, item.id, prompt: editText) } }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func status(_ item: QueueItem, first: Bool) -> String {
        if let e = item.error { return "Paused: \(e)" }
        if item.paused == true { return "Paused" }
        if let nb = item.notBefore, nb > Date().timeIntervalSince1970 * 1000 {
            return "Scheduled " + Date(timeIntervalSince1970: nb / 1000).formatted(date: .abbreviated, time: .shortened)
        }
        if item.dispatching == true { return "Sending" }
        return first ? (model.isWorking ? "Waiting for the current turn" : "Ready to send") : "Waiting for the earlier message"
    }
}
