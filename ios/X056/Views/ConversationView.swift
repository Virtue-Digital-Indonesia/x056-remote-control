import PhotosUI
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ConversationModel
    @State private var nearBottom = true
    @State private var showTree = false

    private let bottomID = "bottom"

    init(projectId: String, sessionId: String?, draftID: UUID? = nil) {
        let model = ConversationModel(projectId: projectId, sessionId: sessionId)
        if let draftID, let settings = AppModel.shared.draftSettings[draftID] {
            model.draftModel = settings.model
            model.draftEffort = settings.effort
            model.draftAccount = settings.account
        }
        _model = State(initialValue: model)
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
                        WorkingLine(activity: model.activity, background: model.isBackground, model: model.activeModel)
                    }
                    Color.clear.frame(height: 1).id(bottomID)
                }
                // A readable measure when iPhone Duo is open or on iPad.
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
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
        // A conversation gets the whole screen: no tab bar (on iPhone Duo, no
        // tabs or Search in the rail), only its own toolbar.
        .toolbar(.hidden, for: .tabBar)
        .navigationTitle(model.conversation?.title ?? (model.sessionId == nil ? "New conversation" : "Conversation"))
        .navigationSubtitle(model.project?.name ?? "")
        .toolbarTitleDisplayMode(.inline)
        .toolbar {
            if let sid = model.sessionId {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Agents", systemImage: "point.3.connected.trianglepath.dotted") { showTree = true }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("More", systemImage: "ellipsis") {
                        if let url = app.panelURL(projectId: model.projectId, sessionId: sid, isChat: model.isChat) {
                            Link(destination: url) { Label("Open in the panel", systemImage: "safari") }
                        }
                        Button("Copy conversation ID", systemImage: "number") { UIPasteboard.general.string = sid }
                    }
                }
            }
        }
        .sheet(isPresented: $showTree) {
            if let sid = model.sessionId { AgentTreeView(projectId: model.projectId, sessionId: sid) }
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
        case .card:
            if let card = row.card { CardRow(card: card) }
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
    var model: String?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "ellipsis")
                .symbolEffect(.variableColor.iterative, options: .repeating)
                .foregroundStyle(background ? Color.purple : Palette.clay)
            Text(activity ?? (background ? "Working in the background" : model.map { "Working with \(ModelCatalog.displayName($0))" } ?? "Working"))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .padding(.leading, 2)
    }
}

// MARK: question

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
                options(parts[0].options ?? []) { choice in Task { await model.send(choice, files: []) } }
            } else {
                ForEach(parts.indices, id: \.self) { i in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(i + 1). \(parts[i].question)").font(.footnote)
                        options(parts[i].options ?? [], selected: answers[i]) { answers[i] = $0 }
                    }
                }
                Button("Send answers") {
                    let text = parts.indices.map { i in "\(i + 1). \(parts[i].question)\nAnswer: \(answers[i] ?? "")" }.joined(separator: "\n\n")
                    Task { await model.send(text, files: []) }
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


/// A Jev pick, an advisor consultation, or a delegate report.
struct CardRow: View {
    let card: ChatCard

    var body: some View {
        switch card {
        case .decision(let d):
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "wand.and.stars").foregroundStyle(Palette.clay)
                    Text(d.backendName + (d.lean == "low" ? " · Low" : d.lean == "high" ? " · High" : ""))
                        .fontWeight(.semibold)
                    if d.error == nil || d.auto != nil, let m = d.ranModel {
                        Text([ModelCatalog.displayName(m), d.ranEffort.map(ModelCatalog.effortLabel)].compactMap { $0 }.joined(separator: " · "))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Palette.clayWeak, in: .capsule)
                            .foregroundStyle(Palette.clay)
                    }
                    Spacer(minLength: 4)
                    if let ms = d.latencyMs {
                        Text(String(format: "%.1f s", ms / 1000)).foregroundStyle(.tertiary)
                    }
                }
                Text(d.verdict).foregroundStyle(d.error == nil ? .secondary : Color.orange)
                if !d.noteLine.isEmpty {
                    Text(d.noteLine).font(.caption).foregroundStyle(.tertiary).lineLimit(3)
                }
                if let team = d.team, d.error == nil, let effort = team.effort {
                    Text("Team: " + [team.model.map(ModelCatalog.displayName), ModelCatalog.effortLabel(effort)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 14, style: .continuous))
        case .advisor(let title, let detail):
            VStack(alignment: .leading, spacing: 4) {
                Label(title, systemImage: "person.badge.shield.checkmark").fontWeight(.medium)
                if let detail, !detail.isEmpty {
                    Text(detail).foregroundStyle(.secondary).lineLimit(6)
                }
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 14, style: .continuous))
        case .delegate(let role, let gate, let text):
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label("Delegate \(role)", systemImage: "person.2").fontWeight(.medium)
                    Spacer()
                    if let gate { GatePill(gate: gate) }
                }
                Text(text).foregroundStyle(.secondary).lineLimit(8)
            }
            .font(.footnote)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 14, style: .continuous))
            .contextMenu { CopyButton(text: text) }
        }
    }
}

/// How a delegate's report was routed.
struct GatePill: View {
    let gate: String

    var body: some View {
        let (text, color): (String, Color) = switch gate {
        case "needs_human": ("Needs you", .orange)
        case "needs_orchestrator": ("Needs orchestrator", .blue)
        case "blocked": ("Blocked", .red)
        default: ("Done", Palette.ok)
        }
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .foregroundStyle(color)
            .background(color.opacity(0.14), in: .capsule)
    }
}
