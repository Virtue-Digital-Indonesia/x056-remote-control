import PhotosUI
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ConversationModel
    @State private var nearBottom = true

    private let bottomID = "bottom"

    init(projectId: String, sessionId: String?) {
        _model = State(initialValue: ConversationModel(projectId: projectId, sessionId: sessionId))
    }

    var body: some View {
        let items = model.items
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if model.sessionId != nil, !model.done, !items.isEmpty {
                        Button {
                            let first = items.first?.id
                            Task {
                                await model.loadOlder()
                                if let first { proxy.scrollTo(first, anchor: .top) }
                            }
                        } label: {
                            if model.loadingOlder { ProgressView() } else { Text("Show earlier messages") }
                        }
                        .buttonStyle(.glass)
                        .controlSize(.small)
                        .frame(maxWidth: .infinity)
                    }
                    ForEach(items) { item in
                        switch item {
                        case .row(let r): MessageRow(row: r)
                        case .steps(let rs): StepsRow(rows: rs)
                        }
                    }
                    if model.isRunning || model.isBackground {
                        WorkingLine(activity: model.activity, background: model.isBackground)
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                .padding(.horizontal)
                .padding(.vertical, 12)
            }
            .overlay {
                if model.loading && model.rows.isEmpty {
                    ProgressView()
                } else if let error = model.loadError, model.rows.isEmpty {
                    ContentUnavailableView("Couldn't load this conversation", systemImage: "exclamationmark.bubble", description: Text(error))
                } else if model.sessionId == nil && model.rows.isEmpty {
                    ContentUnavailableView("New conversation", systemImage: "sparkles", description: Text("Your first message starts a turn in \(model.project?.name ?? "this project")."))
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .all)
            .defaultScrollAnchor(.bottom)
            .onScrollGeometryChange(for: Bool.self) { g in
                g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 120
            } action: { _, isNear in
                nearBottom = isNear
            }
            .onChange(of: model.rows.last?.id) { _, _ in
                guard nearBottom else { return }
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
            .onChange(of: model.loading) { _, loading in
                if !loading { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
        }
        .safeAreaBar(edge: .bottom) {
            ComposerArea(model: model)
        }
        .navigationTitle(model.conversation?.title ?? (model.sessionId == nil ? "New conversation" : "Conversation"))
        .navigationSubtitle(model.project?.name ?? "")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { PreferencesMenu(model: model) }
        }
        .task { await model.load() }
        .onAppear {
            app.attach(model)
            app.setVisible(projectId: model.projectId, sessionId: model.sessionId)
        }
        .onDisappear {
            app.detach(model)
            if app.visibleSessionId == model.sessionId { app.setVisible(projectId: nil, sessionId: nil) }
        }
    }
}

// MARK: rows

struct MessageRow: View {
    let row: ChatRow

    var body: some View {
        switch row.role {
        case .user:
            HStack(alignment: .bottom) {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 6) {
                    if let sender = row.sender {
                        Label(sender, systemImage: "arrow.turn.down.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(row.attachments.filter(\.isImage), id: \.url) { a in
                        AuthImage(path: a.url)
                            .frame(maxWidth: 220, maxHeight: 220)
                            .clipShape(.rect(cornerRadius: 14, style: .continuous))
                    }
                    ExpandableText(text: row.text, limit: 14)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 20, style: .continuous))
                        .opacity(row.pending ? 0.55 : 1)
                        .contextMenu { CopyButton(text: row.text) }
                    if row.failed {
                        Label("Not sent", systemImage: "exclamationmark.circle")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }
            }
        case .assistant:
            MarkdownText(text: row.text)
                .contextMenu { CopyButton(text: row.text) }
        case .error:
            Label(row.text, systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.red)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: .rect(cornerRadius: 14, style: .continuous))
                .textSelection(.enabled)
        case .advisor:
            Label(row.text, systemImage: "sparkles")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(4)
        case .notice, .action:
            Text(row.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(.quaternary.opacity(0.5), in: .capsule)
                .frame(maxWidth: .infinity)
        }
    }
}

struct CopyButton: View {
    let text: String

    var body: some View {
        Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = text }
    }
}

struct ExpandableText: View {
    let text: String
    let limit: Int
    @State private var expanded = false

    var body: some View {
        Text(text)
            .lineLimit(expanded ? nil : limit)
            .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
    }
}

/// A run of tool calls, folded to one line.
struct StepsRow: View {
    let rows: [ChatRow]
    @State private var open = false

    var body: some View {
        let last = rows[rows.count - 1]
        let inFlight = rows.contains(where: \.inFlight)
        let failed = rows.filter(\.failed).count
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: inFlight ? "gearshape.2" : ToolSymbol.name(for: last.text))
                        .symbolEffect(.rotate, options: .repeating, isActive: inFlight)
                        .frame(width: 18)
                    Text(rows.count == 1 ? last.text : "\(rows.count) steps")
                        .fontWeight(.medium)
                        .lineLimit(1)
                    if rows.count > 1 {
                        Text(last.text).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    if failed > 0 {
                        Text("\(failed) failed").foregroundStyle(.red)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .foregroundStyle(.tertiary)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(rows) { r in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Image(systemName: r.failed ? "xmark.circle.fill" : ToolSymbol.name(for: r.text))
                                .foregroundStyle(r.failed ? .red : .secondary)
                                .frame(width: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(r.text).lineLimit(2)
                                if let d = r.detail, !d.isEmpty {
                                    Text(d).foregroundStyle(.tertiary).lineLimit(3)
                                }
                            }
                        }
                        .contextMenu { CopyButton(text: [r.text, r.detail].compactMap { $0 }.joined(separator: "\n")) }
                    }
                }
                .font(.system(.caption, design: .monospaced))
                .padding(.top, 10)
                .padding(.leading, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 14, style: .continuous))
    }
}

struct WorkingLine: View {
    let activity: String?
    let background: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "ellipsis")
                .symbolEffect(.variableColor.iterative, options: .repeating)
                .foregroundStyle(background ? Color.purple : Palette.clay)
            Text(activity ?? (background ? "Working in the background" : "Working"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.leading, 2)
    }
}

// MARK: composer

/// Everything that floats over the bottom of the conversation, in glass.
struct ComposerArea: View {
    let model: ConversationModel

    var body: some View {
        GlassEffectContainer(spacing: 10) {
            VStack(spacing: 10) {
                if let banner = model.banner {
                    Label(banner, systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .glassEffect(.regular.tint(.orange.opacity(0.18)), in: .capsule)
                }
                if let error = model.sendError {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .glassEffect(.regular, in: .capsule)
                }
                if let q = model.question {
                    QuestionCard(question: q, model: model)
                }
                if !model.queued.isEmpty {
                    QueuePill(model: model)
                }
                Composer(model: model)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}

struct Composer: View {
    let model: ConversationModel
    @State private var text = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var images: [UIImage] = []
    @FocusState private var focused: Bool

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
        let working = model.isRunning || model.isBackground
        VStack(alignment: .leading, spacing: 8) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(images.indices, id: \.self) { i in
                            Image(uiImage: images[i])
                                .resizable()
                                .scaledToFill()
                                .frame(width: 60, height: 60)
                                .clipShape(.rect(cornerRadius: 12, style: .continuous))
                                .overlay(alignment: .topTrailing) {
                                    Button("Remove photo", systemImage: "xmark.circle.fill") { images.remove(at: i) }
                                        .labelStyle(.iconOnly)
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                        .offset(x: 5, y: -5)
                                }
                        }
                    }
                    .padding(.top, 6)
                    .padding(.horizontal, 4)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                // Chats take files through their own store, not inline attachments.
                if !(model.project?.isChat ?? false) {
                    PhotosPicker(selection: $picks, maxSelectionCount: 4, matching: .images) {
                        Image(systemName: "plus")
                            .font(.title3.weight(.medium))
                            .frame(width: 44, height: 44)
                    }
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel("Attach photos")
                }
                TextField(working ? "Queue a message" : "Message", text: $text, axis: .vertical)
                    .lineLimit(1...8)
                    .focused($focused)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .frame(minHeight: 44)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 22, style: .continuous))
                    .accessibilityIdentifier("composer")
                if working && empty {
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
                } else {
                    Button {
                        let t = text
                        let imgs = images
                        text = ""
                        images = []
                        Task { await model.send(t, images: imgs.compactMap { $0.jpegForUpload() }) }
                    } label: {
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
        }
        .animation(.snappy, value: working && empty)
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let img = UIImage(data: data) {
                        images.append(img)
                    }
                }
                picks = []
            }
        }
    }
}

struct QuestionCard: View {
    let question: PendingQuestion
    let model: ConversationModel
    @State private var answers: [Int: String] = [:]

    var body: some View {
        let parts = question.parts
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(.orange)
                Text(parts.count == 1 ? parts[0].question : "\(parts.count) questions")
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button("Dismiss", systemImage: "xmark") { Task { await model.dismissQuestion() } }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
            if parts.count == 1 {
                options(parts[0].options ?? []) { choice in Task { await model.send(choice, images: []) } }
            } else {
                ForEach(parts.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(i + 1). \(parts[i].question)").font(.footnote)
                        options(parts[i].options ?? [], selected: answers[i]) { answers[i] = $0 }
                    }
                }
                Button("Send answers") {
                    let text = parts.indices.map { i in "\(i + 1). \(parts[i].question)\nAnswer: \(answers[i] ?? "")" }.joined(separator: "\n\n")
                    Task { await model.send(text, images: []) }
                }
                .buttonStyle(.glassProminent)
                .disabled(answers.count < parts.count)
            }
        }
        .padding(14)
        .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 22, style: .continuous))
    }

    private func options(_ opts: [String], selected: String? = nil, pick: @escaping (String) -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(opts, id: \.self) { o in
                    if selected == o {
                        Button(o) { pick(o) }.buttonStyle(.glassProminent)
                    } else {
                        Button(o) { pick(o) }.buttonStyle(.glass)
                    }
                }
            }
        }
        .scrollClipDisabled()
    }
}

/// "2 queued", with each queued message cancellable from the menu.
struct QueuePill: View {
    let model: ConversationModel

    var body: some View {
        HStack {
            Menu {
                ForEach(model.queued) { item in
                    Button(role: .destructive) {
                        Task { await model.cancelQueued(item.id) }
                    } label: {
                        Label(String(item.text.prefix(60)), systemImage: "trash")
                    }
                }
            } label: {
                Label("\(model.queued.count) queued", systemImage: "tray.full")
                    .font(.footnote.weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
            }
            .glassEffect(.regular.interactive(), in: .capsule)
            Spacer()
        }
    }
}

struct PreferencesMenu: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel

    var body: some View {
        let provider = model.provider
        let models = ModelCatalog.models(provider: provider, codex: app.codexModels)
        let efforts = ModelCatalog.efforts(provider: provider, model: model.model, codex: app.codexModels)
        Menu {
            Picker(selection: Binding(get: { model.model }, set: { m in Task { await model.setPreferences(model: m, effort: model.effort) } })) {
                ForEach(models, id: \.self) { Text($0.label).tag($0.value) }
            } label: {
                Label("Model", systemImage: "cpu")
                Text(ModelCatalog.modelLabel(model.model, provider: provider, codex: app.codexModels))
            }
            .pickerStyle(.menu)
            Picker(selection: Binding(get: { model.effort }, set: { e in Task { await model.setPreferences(model: model.model, effort: e) } })) {
                ForEach(efforts, id: \.self) { Text(ModelCatalog.effortLabel($0)).tag($0) }
            } label: {
                Label("Effort", systemImage: "gauge.with.needle")
                Text(ModelCatalog.effortLabel(model.effort))
            }
            .pickerStyle(.menu)
            if let url = app.panelURL(projectId: model.projectId, sessionId: model.sessionId, isChat: model.project?.isChat ?? false) {
                Divider()
                Link(destination: url) { Label("Open in the panel", systemImage: "safari") }
            }
        } label: {
            Label("Model and effort", systemImage: "slider.horizontal.3")
        }
    }
}
