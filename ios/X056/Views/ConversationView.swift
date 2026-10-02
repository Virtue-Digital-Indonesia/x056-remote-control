import PhotosUI
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ConversationModel
    @State private var nearBottom = true
    /// Keep the newest message in view as it arrives. Scrolling up by hand
    /// stops it; sending, reaching the bottom or the Latest button resumes it.
    @State private var following = true
    @State private var userScrolling = false
    /// Reading back through history folds the composer away.
    @State private var composerFolded = false
    @State private var showTree = false
    @State private var showAutopilot = false
    @State private var showTranscript = false
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var offsetY: CGFloat = 0
    @State private var contentHeight: CGFloat = 0
    /// While earlier messages load: where the view was, so their height can
    /// be added to the offset and the screen stays on what you were reading.
    @State private var holdPlace: HoldPlace?

    private struct HoldPlace: Equatable {
        let offset: CGFloat
        let height: CGFloat
        let rows: Int
    }

    init(projectId: String, sessionId: String?, draftID: UUID? = nil) {
        let model = ConversationModel(projectId: projectId, sessionId: sessionId)
        if let draftID, let settings = AppModel.shared.draftSettings[draftID] {
            model.draftModel = settings.model
            model.draftEffort = settings.effort
            model.draftAccount = settings.account
        }
        _model = State(initialValue: model)
    }

    private func toLatest(animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
        } else {
            position.scrollTo(edge: .bottom)
        }
    }

    private func jumpToLatest() {
        following = true
        toLatest()
    }

    var body: some View {
        let items = model.items
        ScrollView {
            // Not lazy: a lazy stack guesses the height of rows it has not
            // drawn, so the content height was wrong at the bottom (the last
            // message under the composer, scrolling to it sprang back) and
            // opening a step list shifted the rows around it.
            VStack(alignment: .leading, spacing: 16) {
                if model.sessionId != nil, !model.done, !items.isEmpty {
                    Button {
                        following = false
                        holdPlace = HoldPlace(offset: offsetY, height: contentHeight, rows: model.rows.count)
                        Task {
                            let before = model.rows.count
                            await model.loadOlder()
                            if model.rows.count == before { holdPlace = nil }
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
            }
            // A readable measure when iPhone Duo is open or on iPad.
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
            .padding(.horizontal)
            .padding(.vertical, 12)
        }
        .scrollPosition($position)
        .overlay {
            if model.loading && model.rows.isEmpty {
                ProgressView()
            } else if let error = model.loadError, model.rows.isEmpty {
                ContentUnavailableView("Couldn't load this conversation", systemImage: "exclamationmark.bubble", description: Text(error))
            } else if model.sessionId == nil && model.rows.isEmpty {
                ContentUnavailableView("New conversation", systemImage: "sparkles", description: Text("Your first message starts a turn in \(model.project?.name ?? "this project")."))
            }
        }
        // Floats above the composer instead of joining its bar: a taller bar
        // would resize the scroll view and set off following.
        .overlay(alignment: .bottomTrailing) {
            let show = !nearBottom && !composerFolded
            ZStack {
                if show {
                    LatestButton(working: model.isWorking, action: jumpToLatest)
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: show)
            .padding(.trailing, 16)
            .padding(.bottom, 10)
        }
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .all)
        // Only the first position is the bottom. Later size changes are left
        // to `following`, so opening a step list grows downward instead of
        // pushing the conversation up.
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .onScrollPhaseChange { _, phase in
            userScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
        }
        .onScrollGeometryChange(for: Bool.self) { g in
            g.contentOffset.y + g.containerSize.height >= g.contentSize.height - 120
        } action: { _, isNear in
            nearBottom = isNear
            guard isNear else { return }
            following = true
            if composerFolded { withAnimation(.snappy) { composerFolded = false } }
        }
        // Measured from under the top bar, as `ScrollPosition.scrollTo(y:)`
        // counts it (the raw offset includes the bar's inset).
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentOffset.y + $0.contentInsets.top } action: { old, new in
            offsetY = new
            // Scrolling up by hand, away from the latest message: stop
            // following and give the screen to the history.
            guard userScrolling, new < old, !nearBottom else { return }
            following = false
            if !composerFolded { withAnimation(.snappy) { composerFolded = true } }
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, new in
            contentHeight = new
            // Earlier messages arrived above: move down by their height.
            if let hold = holdPlace, model.rows.count != hold.rows {
                holdPlace = nil
                position.scrollTo(y: hold.offset + (new - hold.height))
            }
        }
        .onChange(of: "\(model.rows.count)|\(model.isRunning || model.isBackground)|\(model.activity ?? "")") { _, _ in
            guard following, holdPlace == nil else { return }
            withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: model.sendCount) { _, _ in
            // Sending is a return to the conversation's end.
            jumpToLatest()
        }
        .onScrollGeometryChange(for: CGFloat.self) { $0.containerSize.height } action: { _, _ in
            // The keyboard, the composer unfolding, iPhone Duo resizing.
            if following { toLatest(animated: false) }
        }
        .onChange(of: model.loading) { _, loading in
            if !loading { toLatest(animated: false) }
        }
        .safeAreaBar(edge: .bottom) {
            ComposerArea(model: model, folded: $composerFolded, jumpToLatest: jumpToLatest) { showAutopilot = true }
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
                        Button(app.autopilot[sid] == nil ? "Autopilot…" : "Autopilot", systemImage: "repeat") { showAutopilot = true }
                        Button("Transcript", systemImage: "terminal") { showTranscript = true }
                        if LiveTurns.shared.isFollowing(sid) {
                            Button("Stop following on Lock Screen", systemImage: "iphone.slash") {
                                Task { await LiveTurns.shared.unfollow(sid) }
                            }
                        } else if model.isWorking, LiveTurns.shared.available {
                            Button("Follow on Lock Screen", systemImage: "iphone.badge.play") { model.followOnLockScreen() }
                        }
                        Divider()
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
        .sheet(isPresented: $showAutopilot) {
            if let sid = model.sessionId { AutopilotSheet(projectId: model.projectId, sessionId: sid) }
        }
        .fullScreenCover(isPresented: $showTranscript) {
            if let sid = model.sessionId { TranscriptView(projectId: model.projectId, sessionId: sid, title: model.conversation?.title ?? "Transcript") }
        }
        .environment(\.openTranscript, model.sessionId.map { OpenTranscriptAction(sessionId: $0) { showTranscript = true } })
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

/// Opens the conversation's transcript ("what actually happened"). Equal by
/// conversation, so the rows that read it are not redrawn on every update.
struct OpenTranscriptAction: Equatable {
    let sessionId: String
    let run: () -> Void
    func callAsFunction() { run() }
    static func == (a: Self, b: Self) -> Bool { a.sessionId == b.sessionId }
}

extension EnvironmentValues {
    @Entry var openTranscript: OpenTranscriptAction? = nil
}

struct MessageRow: View {
    @Environment(\.openTranscript) private var openTranscript
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
            VStack(alignment: .leading, spacing: 10) {
                Label(row.text, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                if let openTranscript {
                    Button("See what happened", systemImage: "terminal") { openTranscript() }
                        .font(.footnote.weight(.medium))
                        .buttonStyle(.glass)
                        .controlSize(.small)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.08), in: .rect(cornerRadius: 14, style: .continuous))
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
            .accessibilityIdentifier("steps")
            // The list drops down from under the header: it moves in from the
            // top of a clipped box that grows with it, so it never draws over
            // the header on the way.
            VStack(alignment: .leading, spacing: 0) {
                if open {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(rows) { r in StepLine(row: r) }
                    }
                    .padding(.leading, 26)
                    // The rail runs down from the header's icon to its steps.
                    .overlay(alignment: .leading) {
                        Capsule().fill(.quaternary).frame(width: 2).padding(.leading, 8)
                    }
                    .padding(.top, 12)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: 14, style: .continuous))
    }
}

/// One step inside an open StepsRow.
struct StepLine: View {
    let row: ChatRow

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: row.failed ? "xmark.circle.fill" : ToolSymbol.name(for: row.text))
                .foregroundStyle(row.failed ? .red : .secondary)
                .symbolEffect(.pulse, isActive: row.inFlight)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let d = row.detail, !d.isEmpty {
                    Text(d)
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                        .lineLimit(3)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { CopyButton(text: [row.text, row.detail].compactMap { $0 }.joined(separator: "\n")) }
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
    /// Folded while a message is being typed below it.
    var folded = false
    @State private var picked: [Int: String] = [:]
    /// A written answer wins over a picked option, as on the panel.
    @State private var written: [Int: String] = [:]
    @State private var formHeight: CGFloat = 0
    /// Folded to its header, to read the conversation behind it.
    @State private var collapsed = false

    var body: some View {
        let parts = question.parts
        let collapsed = collapsed || folded
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "questionmark.bubble.fill")
                    .foregroundStyle(.orange)
                Text(parts.count == 1 ? parts[0].question : "\(parts.count) questions")
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(collapsed ? 1 : nil)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Button(collapsed ? "Show questions" : "Hide questions", systemImage: collapsed ? "chevron.up" : "chevron.down") {
                    // Folded for typing: put the keyboard away to answer here.
                    if folded { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                    withAnimation(.snappy) { self.collapsed = folded ? false : !self.collapsed }
                }
                .labelStyle(.iconOnly)
                .foregroundStyle(.secondary)
                Button("Dismiss", systemImage: "xmark") { Task { await model.dismissQuestion() } }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.secondary)
            }
            if collapsed {
                EmptyView()
            } else if parts.count == 1 {
                let opts = parts[0].options ?? []
                if !opts.isEmpty {
                    options(opts) { choice in Task { await model.send(choice, files: []) } }
                    Text("Or write your own answer in the message box.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else {
                // A long batch scrolls inside the card, so the message box
                // and the conversation stay on screen.
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(parts.indices, id: \.self) { i in part(i, parts[i]) }
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { formHeight = $0 }
                }
                .frame(height: min(max(formHeight, 1), 240))
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicatorsFlash(onAppear: true)
                Button("Send answers") {
                    let text = parts.indices.map { i in "\(i + 1). \(parts[i].question)\nAnswer: \(answer(i) ?? "")" }.joined(separator: "\n\n")
                    Task { await model.send(text, files: []) }
                }
                .buttonStyle(.glassProminent)
                .disabled(parts.indices.contains { answer($0) == nil })
            }
        }
        .padding(14)
        .glassEffect(.regular.tint(.orange.opacity(0.12)), in: .rect(cornerRadius: 22, style: .continuous))
        .animation(.snappy, value: folded)
    }

    private func part(_ i: Int, _ q: QuestionPart) -> some View {
        let opts = q.options ?? []
        return VStack(alignment: .leading, spacing: 8) {
            Text("\(i + 1). \(q.question)")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            if !opts.isEmpty {
                options(opts, selected: hasWritten(i) ? nil : picked[i]) { choice in
                    picked[i] = choice
                    written[i] = ""
                }
            }
            TextField(opts.isEmpty ? "Your answer" : "Or write your own answer", text: Binding(
                get: { written[i] ?? "" },
                set: { written[i] = $0 }
            ), axis: .vertical)
            .lineLimit(1...4)
            .font(.footnote)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 12, style: .continuous))
            .accessibilityLabel("Your answer: \(q.question)")
        }
    }

    private func hasWritten(_ i: Int) -> Bool {
        !(written[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func answer(_ i: Int) -> String? {
        hasWritten(i) ? written[i]!.trimmingCharacters(in: .whitespacesAndNewlines) : picked[i]
    }

    /// Options wrap onto as many lines as they need; a long one wraps its text.
    private func options(_ opts: [String], selected: String? = nil, pick: @escaping (String) -> Void) -> some View {
        FlowRow(spacing: 8) {
            ForEach(opts, id: \.self) { o in
                let label = Text(o).multilineTextAlignment(.leading)
                if selected == o {
                    Button { pick(o) } label: { label }.buttonStyle(.glassProminent)
                } else {
                    Button { pick(o) } label: { label }.buttonStyle(.glass)
                }
            }
        }
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
