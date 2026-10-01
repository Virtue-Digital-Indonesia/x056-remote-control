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
                LazyVStack(alignment: .leading, spacing: 14) {
                    if model.sessionId != nil, !model.done, !items.isEmpty {
                        Button {
                            let first = items.first?.id
                            Task {
                                await model.loadOlder()
                                if let first { proxy.scrollTo(first, anchor: .top) }
                            }
                        } label: {
                            if model.loadingOlder { ProgressView() } else { Text("Load earlier").font(.footnote) }
                        }
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
                    ContentUnavailableView("Couldn't load", systemImage: "exclamationmark.bubble", description: Text(error))
                } else if model.sessionId == nil && model.rows.isEmpty {
                    ContentUnavailableView("New conversation", systemImage: "sparkles", description: Text("in \(model.project?.name ?? "this project")"))
                }
            }
            .scrollDismissesKeyboard(.interactively)
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
        .safeAreaInset(edge: .bottom) {
            ComposerArea(model: model)
        }
        .navigationTitle(model.conversation?.title ?? (model.sessionId == nil ? "New conversation" : "Conversation"))
        .navigationBarTitleDisplayMode(.inline)
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
                Spacer(minLength: 40)
                VStack(alignment: .trailing, spacing: 4) {
                    if let sender = row.sender {
                        Text(sender).font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(row.attachments.filter(\.isImage), id: \.url) { a in
                        AuthImage(path: a.url)
                            .frame(maxWidth: 220, maxHeight: 220)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    ExpandableText(text: row.text, limit: 14)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color.accentColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 16))
                        .opacity(row.pending ? 0.55 : 1)
                    if row.failed {
                        Label("Not sent", systemImage: "exclamationmark.circle").font(.caption2).foregroundStyle(.red)
                    }
                }
            }
        case .assistant:
            MarkdownText(text: row.text)
        case .error:
            Label(row.text, systemImage: "exclamationmark.triangle")
                .font(.footnote)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        case .advisor:
            Label(row.text, systemImage: "sparkles")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(4)
        case .notice, .action:
            Text(row.text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
        }
    }
}

struct ExpandableText: View {
    let text: String
    let limit: Int
    @State private var expanded = false

    var body: some View {
        Text(text)
            .lineLimit(expanded ? nil : limit)
            .textSelection(.enabled)
            .onTapGesture { expanded.toggle() }
    }
}

/// A run of tool calls, folded to one line: "6 steps · Edit server/push.ts".
struct StepsRow: View {
    let rows: [ChatRow]
    @State private var open = false

    var body: some View {
        let last = rows[rows.count - 1]
        let inFlight = rows.contains(where: \.inFlight)
        let failed = rows.filter(\.failed).count
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(rows) { r in
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 6) {
                            Image(systemName: r.failed ? "xmark.circle" : r.inFlight ? "circle.dotted" : "checkmark.circle")
                                .foregroundStyle(r.failed ? .red : .secondary)
                            Text(r.text).lineLimit(2)
                        }
                        if let d = r.detail, !d.isEmpty {
                            Text(d).lineLimit(3).foregroundStyle(.tertiary).padding(.leading, 22)
                        }
                    }
                }
            }
            .font(.system(.caption, design: .monospaced))
            .padding(.top, 4)
        } label: {
            HStack(spacing: 6) {
                if inFlight { ProgressView().controlSize(.mini) }
                Text(rows.count == 1 ? last.text : "\(rows.count) steps · \(last.text)")
                    .lineLimit(1)
                if failed > 0 { Text("· \(failed) failed").foregroundStyle(.red) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .tint(.secondary)
    }
}

struct WorkingLine: View {
    let activity: String?
    let background: Bool

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small).tint(background ? .purple : nil)
            Text(activity ?? (background ? "Working in the background" : "Working…"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }
}

// MARK: composer

struct ComposerArea: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let banner = model.banner {
                Label(banner, systemImage: "arrow.triangle.2.circlepath").font(.caption).foregroundStyle(.orange)
            }
            if let error = model.sendError {
                Label(error, systemImage: "exclamationmark.circle").font(.caption).foregroundStyle(.red)
            }
            if let q = model.question {
                QuestionCard(question: q, model: model)
            }
            if !model.queued.isEmpty {
                QueueStrip(model: model)
            }
            Composer(model: model)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

struct Composer: View {
    let model: ConversationModel
    @State private var text = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var images: [UIImage] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(images.indices, id: \.self) { i in
                            Image(uiImage: images[i])
                                .resizable()
                                .scaledToFill()
                                .frame(width: 56, height: 56)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .overlay(alignment: .topTrailing) {
                                    Button { images.remove(at: i) } label: {
                                        Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                                    }
                                    .offset(x: 4, y: -4)
                                }
                        }
                    }
                    .padding(.top, 4)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                // Chats take files through their own store, not inline attachments.
                if !(model.project?.isChat ?? false) {
                    PhotosPicker(selection: $picks, maxSelectionCount: 4, matching: .images) {
                        Image(systemName: "photo.on.rectangle").font(.title3)
                    }
                    .padding(.bottom, 6)
                }
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityIdentifier("composer")
                if model.isRunning || model.isBackground {
                    Button {
                        Task { await model.stop() }
                    } label: {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .accessibilityLabel("Stop")
                    .tint(model.isBackground ? .purple : .red)
                }
                Button {
                    let t = text
                    let imgs = images
                    text = ""
                    images = []
                    Task { await model.send(t, images: imgs.compactMap { $0.jpegForUpload() }) }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .accessibilityIdentifier("send")
                .accessibilityLabel("Send")
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty)
            }
        }
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(.orange)
                Text(parts.count == 1 ? parts[0].question : "\(parts.count) questions")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Button { Task { await model.dismissQuestion() } } label: { Image(systemName: "xmark") }
                    .foregroundStyle(.secondary)
            }
            if parts.count == 1 {
                options(parts[0].options ?? []) { choice in Task { await model.send(choice, images: []) } }
            } else {
                ForEach(parts.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(i + 1). \(parts[i].question)").font(.footnote)
                        options(parts[i].options ?? [], selected: answers[i]) { answers[i] = $0 }
                    }
                }
                Button("Send answers") {
                    let text = parts.indices.map { i in "\(i + 1). \(parts[i].question)\nAnswer: \(answers[i] ?? "")" }.joined(separator: "\n\n")
                    Task { await model.send(text, images: []) }
                }
                .buttonStyle(.borderedProminent)
                .disabled(answers.count < parts.count)
            }
        }
        .padding(10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }

    private func options(_ opts: [String], selected: String? = nil, pick: @escaping (String) -> Void) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                ForEach(opts, id: \.self) { o in
                    Button(o) { pick(o) }
                        .buttonStyle(.bordered)
                        .tint(selected == o ? .accentColor : .secondary)
                }
            }
        }
    }
}

struct QueueStrip: View {
    let model: ConversationModel
    @State private var open = false

    var body: some View {
        DisclosureGroup(isExpanded: $open) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(model.queued) { item in
                    HStack(alignment: .top) {
                        Text(item.text).font(.caption).lineLimit(3)
                        Spacer()
                        Button(role: .destructive) { Task { await model.cancelQueued(item.id) } } label: { Image(systemName: "trash") }
                    }
                }
            }
        } label: {
            Label("\(model.queued.count) queued", systemImage: "tray.full").font(.caption)
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
            Picker("Model", selection: Binding(get: { model.model }, set: { m in Task { await model.setPreferences(model: m, effort: model.effort) } })) {
                ForEach(models, id: \.self) { Text($0.label).tag($0.value) }
            }
            .pickerStyle(.menu)
            Picker("Effort", selection: Binding(get: { model.effort }, set: { e in Task { await model.setPreferences(model: model.model, effort: e) } })) {
                ForEach(efforts, id: \.self) { Text(ModelCatalog.effortLabel($0)).tag($0) }
            }
            .pickerStyle(.menu)
            if let url = panelURL {
                Link(destination: url) { Label("Open in browser", systemImage: "safari") }
            }
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
    }

    /// The panel's own link for this conversation (`manager.conversationUrl`).
    private var panelURL: URL? {
        guard let base = app.server else { return nil }
        if model.project?.isChat ?? false { return base.appending(path: "chat/\(model.projectId)") }
        guard let sid = model.sessionId, var c = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        c.path = "/"
        c.queryItems = [URLQueryItem(name: "project", value: model.projectId), URLQueryItem(name: "session", value: sid)]
        return c.url
    }
}
