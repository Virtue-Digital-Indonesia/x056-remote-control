import SwiftUI

/// The Bot: a personal assistant that keeps an eye on your conversations and
/// answers in plain words. It is the gateway's own Bot chat (`POST /api/bot`),
/// which has its persona and acts on its own. An older gateway gets a chat
/// named "Bot" whose first message (hidden here) says how to use the x056
/// tools and what to ask before doing.
struct BotView: View {
    @Environment(AppModel.self) private var app
    @State private var model: ConversationModel?
    @State private var dictation = Dictation()
    @State private var waking = false
    @State private var error: String?

    var body: some View {
        Group {
            if let model {
                BotHome(model: model, dictation: dictation)
            } else {
                BotWelcome(waking: waking, error: error) { Task { await wake() } }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // A background, so its wide glows never widen the screen's layout.
        .background { BotBackdrop() }
        .fontDesign(.rounded)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Back", systemImage: "chevron.left") { app.botOpen = false }
            }
            if let model, let sid = model.sessionId {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu("More", systemImage: "ellipsis") {
                        SystemHistoryToggle(model: model)
                        Button("Open as a conversation", systemImage: "bubble.left.and.text.bubble.right") {
                            app.botPath.append(.conversation(projectId: model.projectId, sessionId: sid))
                        }
                        if let url = app.panelURL(projectId: model.projectId, sessionId: sid, isChat: true) {
                            Link(destination: url) { Label("Open in the panel", systemImage: "safari") }
                        }
                    }
                }
            }
        }
        .toolbarTitleDisplayMode(.inline)
        .task(id: app.bot?.sessionId) { await adopt() }
        .onAppear {
            guard let model else { return }
            app.attach(model)
            app.setVisible(projectId: model.projectId, sessionId: model.sessionId)
            Task { await model.reload() }
        }
        .onDisappear {
            dictation.stop()
            guard let model else { return }
            app.detach(model)
            if app.visibleSessionId == model.sessionId { app.setVisible(projectId: nil, sessionId: nil) }
        }
    }

    /// The Bot this gateway has, if any, as a live conversation.
    private func adopt() async {
        guard let bot = app.bot, model?.sessionId != bot.sessionId else { return }
        let m = ConversationModel(projectId: bot.projectId, sessionId: bot.sessionId)
        m.liveActivity = false
        if let old = model { app.detach(old) }
        model = m
        app.attach(m)
        app.setVisible(projectId: m.projectId, sessionId: m.sessionId)
        app.rememberBot(bot.projectId, bot.sessionId)
        await m.load()
    }

    private func wake() async {
        waking = true
        error = nil
        defer { waking = false }
        do {
            let (pid, sid, serverBot) = try await app.wakeBot()
            let m = ConversationModel(projectId: pid, sessionId: sid)
            m.liveActivity = false
            model = m
            app.attach(m)
            app.setVisible(projectId: pid, sessionId: sid)
            if serverBot { await m.load() } else { await m.send(AppModel.botSetupPrompt, files: []) }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

// MARK: welcome

/// Before there is a Bot: the orb asleep, and one button that wakes it.
private struct BotWelcome: View {
    let waking: Bool
    let error: String?
    let wake: () -> Void
    @State private var appeared = false

    var body: some View {
        VStack(spacing: 22) {
            Spacer(minLength: 20)
            BotOrb(mood: waking ? .thinking : appeared ? .idle : .asleep, size: 150)
                .scaleEffect(appeared ? 1 : 0.85)
            VStack(spacing: 10) {
                Text("Meet your Bot")
                    .font(.largeTitle.weight(.bold))
                Text("A personal assistant that keeps an eye on your conversations and tells you, in plain words, what is running, what finished and what needs you.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 360)
            }
            Button(action: wake) {
                HStack(spacing: 8) {
                    if waking { ProgressView().tint(.white) } else { Image(systemName: "sparkles") }
                    Text(waking ? "Waking up…" : "Wake the Bot")
                }
                .font(.headline)
                .foregroundStyle(.white)
                .padding(.horizontal, 28)
                .padding(.vertical, 15)
                .background(LinearGradient(colors: [BotColors.violet, BotColors.sky], startPoint: .leading, endPoint: .trailing), in: .capsule)
                .shadow(color: BotColors.violet.opacity(0.45), radius: 18, y: 8)
            }
            .buttonStyle(.plain)
            .disabled(waking)
            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            Text("It is a Claude chat on your gateway named Bot, so the panel and your other devices see the same one. It hands work to your conversations, follows it and reports back, without asking you first.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 380)
                .padding(.bottom, 24)
        }
        .padding(.horizontal, 24)
        .onAppear { withAnimation(.smooth(duration: 1.4)) { appeared = true } }
    }
}

// MARK: home

/// The Bot with its sky: a greeting, your work in orbit, what needs you, and
/// the conversation.
private struct BotHome: View {
    @Environment(AppModel.self) private var app
    let model: ConversationModel
    let dictation: Dictation

    private let endID = "bot-end"

    var body: some View {
        let nodes = constellation
        let mood: BotMood = dictation.isListening ? .listening
            : model.isWorking ? .thinking
            : nodes.contains(where: { $0.state == .needsYou || $0.state == .failed }) ? .attention : .idle
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    BotGreeting(nodes: nodes)
                    Constellation(nodes: nodes, mood: mood, level: dictation.level, orbSize: 118) { node in
                        app.botPath.append(.conversation(projectId: node.projectId, sessionId: node.sessionId))
                    }
                    .frame(height: 290)
                    let moments = self.moments(nodes)
                    if !moments.isEmpty {
                        MomentsStrip(moments: moments) { m in
                            app.botPath.append(.conversation(projectId: m.projectId, sessionId: m.sessionId))
                        }
                    }
                    BotThread(model: model)
                    Color.clear.frame(height: 1).id(endID)
                }
                .padding(.vertical, 8)
                .frame(maxWidth: 720)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.rows.count) { _, _ in
                withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(endID, anchor: .bottom) }
            }
            .onChange(of: model.loading) { _, loading in
                if !loading, model.rows.count > 1 { proxy.scrollTo(endID, anchor: .bottom) }
            }
            // The new message scrolls into view from rows.count above: one
            // scroll, not two racing the keyboard.
            .safeAreaBar(edge: .bottom) {
                BotInput(model: model, dictation: dictation)
            }
        }
    }

    /// Every conversation that is running, working in the background,
    /// waiting on you or failed unread, the Bot's own left out. Urgent first.
    private var constellation: [BotNode] {
        let bot = model.sessionId
        var out: [BotNode] = []
        for p in app.projects {
            for c in p.conversations ?? [] where c.sessionId != bot {
                var state = WorkState.of(c.sessionId, in: app, outcome: c.lastOutcome)
                if state == .failed, app.unread[AppModel.key(p.id, c.sessionId)] == nil { state = .idle }
                guard state != .idle else { continue }
                out.append(BotNode(projectId: p.id, sessionId: c.sessionId, title: c.title.isEmpty ? p.name : c.title, state: state))
            }
        }
        let rank: (WorkState) -> Int = { [.needsYou: 0, .failed: 1, .running: 2, .background: 3][$0] ?? 4 }
        return Array(out.sorted { rank($0.state) < rank($1.state) }.prefix(14))
    }

    private func moments(_ nodes: [BotNode]) -> [Moment] {
        nodes.prefix(8).map { n in
            let detail: String
            switch n.state {
            case .needsYou: detail = app.questions[n.sessionId]?.parts.first?.question ?? "Asked you something"
            case .failed: detail = app.conversation(n.projectId, n.sessionId)?.lastOutcome?.reason ?? "The last turn failed"
            case .running: detail = app.runningAccounts[n.sessionId].map { "Running on account \($0)" } ?? "Running"
            case .background: detail = "Working in the background"
            case .idle: detail = ""
            }
            return Moment(node: n, detail: detail, project: app.project(n.projectId)?.name ?? "")
        }
    }
}

/// "Good evening" and where things stand, in one line.
private struct BotGreeting: View {
    let nodes: [BotNode]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(Self.greeting)
                .font(.largeTitle.weight(.bold))
            Text(status)
                .font(.title3)
                .foregroundStyle(.secondary)
                .contentTransition(.numericText())
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var status: String {
        let running = nodes.filter { $0.state == .running || $0.state == .background }.count
        let needs = nodes.filter { $0.state == .needsYou }.count
        let failed = nodes.filter { $0.state == .failed }.count
        var parts: [String] = []
        if needs > 0 { parts.append(needs == 1 ? "1 needs you" : "\(needs) need you") }
        if failed > 0 { parts.append(failed == 1 ? "1 failed" : "\(failed) failed") }
        if running > 0 { parts.append("\(running) running") }
        return parts.isEmpty ? "All quiet. Ask me anything." : parts.joined(separator: " · ")
    }

    private static var greeting: String {
        switch Calendar.current.component(.hour, from: Date()) {
        case 5..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        case 17..<22: return "Good evening"
        default: return "Hello, night owl"
        }
    }
}

// MARK: moments

struct Moment: Identifiable, Hashable {
    let node: BotNode
    let detail: String
    let project: String
    var id: String { node.id }
    var projectId: String { node.projectId }
    var sessionId: String { node.sessionId }
}

/// What deserves a look, as cards you can swipe through.
private struct MomentsStrip: View {
    let moments: [Moment]
    let open: (Moment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(moments) { m in
                    Button { open(m) } label: { MomentCard(moment: m) }
                        .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
        .scrollClipDisabled()
    }
}

private struct MomentCard: View {
    let moment: Moment

    var body: some View {
        let n = moment.node
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle().fill(n.color).frame(width: 8, height: 8).shadow(color: n.color, radius: 4)
                Text(Self.kind(n.state))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(n.color)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            Text(n.title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Text(moment.detail)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2, reservesSpace: true)
            if !moment.project.isEmpty {
                Text(moment.project)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(14)
        .frame(width: 230, alignment: .leading)
        .glassEffect(.regular.tint(n.color.opacity(0.08)), in: .rect(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(n.color.opacity(0.3), lineWidth: 1)
        }
    }

    static func kind(_ s: WorkState) -> String {
        switch s {
        case .needsYou: return "Needs you"
        case .failed: return "Failed"
        case .running: return "Running"
        case .background: return "In the background"
        case .idle: return ""
        }
    }
}

// MARK: thread

/// The conversation with the Bot, in its own style: its replies beside a
/// small orb, yours in a bright bubble, its look-ups folded into one line.
private struct BotThread: View {
    let model: ConversationModel

    var body: some View {
        // Shown on request, and dimmed, so the quiet view stays the obvious one.
        let system = model.showSystemHistory ? BotHistory.systemRows(model.rows) : []
        VStack(alignment: .leading, spacing: 16) {
            ForEach(model.items) { item in
                switch item {
                case .row(let r): BotLine(row: r).opacity(system.contains(r.id) ? 0.6 : 1)
                case .steps(let rs): BotLookups(rows: rs).opacity(system.contains(rs[0].id) ? 0.6 : 1)
                }
            }
            if model.isWorking {
                HStack(spacing: 10) {
                    BotOrb(mood: .thinking, size: 22)
                        .frame(width: 30, height: 30)
                    Text(model.activity.map { "\($0)…" } ?? "Thinking…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .shimmering()
                }
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 20)
        .animation(.snappy, value: model.isWorking)
    }
}

private struct BotLine: View {
    let row: ChatRow

    var body: some View {
        switch row.role {
        case .user:
            // Its setup message is for the Bot, not for this screen.
            if let kind = row.senderKind, BotHistory.systemSenders.contains(kind) {
                SystemNote(kind: kind, text: row.text)
            } else if !row.text.hasPrefix(AppModel.botSetupPrefix) {
                HStack {
                    Spacer(minLength: 56)
                    Text(row.text)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background(LinearGradient(colors: [BotColors.violet, BotColors.sky], startPoint: .topLeading, endPoint: .bottomTrailing),
                                    in: .rect(cornerRadius: 22, style: .continuous))
                        .opacity(row.pending ? 0.6 : 1)
                        .contextMenu { CopyButton(text: row.text) }
                }
            }
        case .assistant:
            HStack(alignment: .top, spacing: 10) {
                BotOrb(mood: .idle, size: 22)
                    .frame(width: 30, height: 30)
                MarkdownText(text: row.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contextMenu { CopyButton(text: row.text) }
            }
        case .error:
            Label(row.text, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote)
                .foregroundStyle(.red)
        case .notice:
            BotNotice(text: row.text)
        case .action, .card:
            EmptyView()
        }
    }
}

/// A message the gateway or a helper sent the Bot, shown in system history.
private struct SystemNote: View {
    let kind: String
    let text: String

    var body: some View {
        let (label, icon) = Self.label(kind)
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 3) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.6), in: .rect(cornerRadius: 16, style: .continuous))
        .contextMenu { CopyButton(text: text) }
    }

    static func label(_ kind: String) -> (String, String) {
        switch kind {
        case "bot_event": return ("Digest from the gateway", "tray.full")
        case "bot_brief": return ("Morning brief request", "sun.max")
        default: return ("Advisor", "lightbulb")
        }
    }
}

/// A notice in the Bot's chat. "Bot needs you" is a card that always shows;
/// a routine "Bot status" (system history only) is a quiet one; anything
/// else, such as a stopped turn, is one small line.
private struct BotNotice: View {
    let text: String

    var body: some View {
        if let rest = strip("Bot needs you: ") {
            card(rest, label: "Needs you", color: BotColors.amber)
        } else if let rest = strip("Bot status: ") {
            card(rest, label: "Status", color: .secondary)
        } else {
            Label(text, systemImage: "info.circle")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private static func lines(_ s: Substring) -> (String, String) {
        let parts = s.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        return (String(parts.first ?? ""), parts.count > 1 ? String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines) : "")
    }

    private func card(_ rest: Substring, label: String, color: Color) -> some View {
        let (title, body) = Self.lines(rest)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 8, height: 8)
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(color)
            }
            Text(title)
                .font(.subheadline.weight(.semibold))
            if !body.isEmpty {
                Text(body)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular.tint(color.opacity(0.08)), in: .rect(cornerRadius: 18, style: .continuous))
        .contextMenu { CopyButton(text: text) }
    }

    private func strip(_ prefix: String) -> Substring? {
        text.hasPrefix(prefix) ? text.dropFirst(prefix.count) : nil
    }
}

/// Shows or folds away the Bot's system rows (BotHistory), on the Bot
/// screen and when the Bot's chat is opened as a conversation.
struct SystemHistoryToggle: View {
    let model: ConversationModel

    var body: some View {
        Button(model.showSystemHistory ? "Hide system history" : "Show system history", systemImage: "clock.arrow.circlepath") {
            withAnimation(.snappy) { model.showSystemHistory.toggle() }
        }
    }
}

/// The tools the Bot used for an answer, folded to one line.
private struct BotLookups: View {
    let rows: [ChatRow]
    @State private var open = false

    var body: some View {
        let busy = rows.contains(where: \.inFlight)
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.snappy) { open.toggle() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "scope")
                        .foregroundStyle(BotColors.teal)
                        .symbolEffect(.pulse, isActive: busy)
                    Text(busy ? "Looking" : rows.count == 1 ? "Looked at 1 thing" : "Looked at \(rows.count) things")
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .fixedSize()
                    Text(rows.last?.text ?? "")
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.down")
                        .rotationEffect(.degrees(open ? 180 : 0))
                        .foregroundStyle(.tertiary)
                }
                .font(.footnote)
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(rows) { r in
                        Text("· " + r.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                .padding(.leading, 26)
                .transition(.opacity)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: .rect(cornerRadius: 16, style: .continuous))
        .padding(.leading, 40)
    }
}

// MARK: input

/// What you say to the Bot: a suggestion, typed words, or your voice.
private struct BotInput: View {
    let model: ConversationModel
    let dictation: Dictation
    @State private var text = ""
    /// From a send until its turn shows as working. The box is empty then,
    /// but the suggestions must not come back: they slid in and popped out
    /// again while the keyboard went down.
    @State private var sending = false
    @State private var sends = 0

    private static let suggestions: [(String, String)] = [
        ("Brief me", "sun.max"),
        ("What needs me?", "exclamationmark.bubble"),
        ("What's running?", "waveform.path.ecg"),
        ("What finished today?", "checkmark.circle"),
    ]

    var body: some View {
        let empty = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let suggest = empty && !sending && !dictation.isListening && !model.isWorking
        VStack(spacing: 10) {
            if suggest {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.suggestions, id: \.0) { s in
                            Button { send(s.0) } label: {
                                Label(s.0, systemImage: s.1)
                                    .font(.subheadline.weight(.medium))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 9)
                            }
                            .buttonStyle(.plain)
                            .glassEffect(.regular.interactive(), in: .capsule)
                        }
                    }
                    .padding(.horizontal, 2)
                }
                .scrollClipDisabled()
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            if case .unavailable(let why) = dictation.state {
                Text(why).font(.caption).foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 10) {
                Group {
                    if dictation.isListening {
                        HStack(spacing: 10) {
                            Waveform(levels: dictation.levels)
                                .frame(width: 92, height: 26)
                            Text(dictation.transcript.isEmpty ? "Listening…" : dictation.transcript)
                                .font(.body)
                                .foregroundStyle(dictation.transcript.isEmpty ? .secondary : .primary)
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                    } else {
                        // The composer's own box: Markdown as you type, and
                        // Return is a newline (the arrow button sends).
                        ComposerTextView(text: $text, placeholder: "Ask Bot…", longTextLimit: 50_000, maxLines: 5, identifier: "bot-input") { _ in }
                    }
                }
                .frame(minHeight: 48)
                .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 24, style: .continuous))
                if empty || dictation.isListening {
                    Button {
                        Task {
                            let wasListening = dictation.isListening
                            await dictation.toggle()
                            if wasListening, !dictation.transcript.isEmpty { text = dictation.transcript }
                        }
                    } label: {
                        Image(systemName: dictation.isListening ? "stop.fill" : "mic.fill")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(dictation.isListening ? .white : BotColors.violet)
                            .frame(width: 48, height: 48)
                            .background(dictation.isListening ? AnyShapeStyle(BotColors.rose.gradient) : AnyShapeStyle(.clear), in: .circle)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .circle)
                    .accessibilityLabel(dictation.isListening ? "Stop listening" : "Speak")
                } else {
                    Button { send(text) } label: {
                        Image(systemName: "arrow.up")
                            .font(.title3.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 48, height: 48)
                            .background(LinearGradient(colors: [BotColors.violet, BotColors.sky], startPoint: .topLeading, endPoint: .bottomTrailing), in: .circle)
                            .shadow(color: BotColors.violet.opacity(0.4), radius: 10, y: 4)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Send")
                    .accessibilityIdentifier("bot-send")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .frame(maxWidth: 720)
        .frame(maxWidth: .infinity)
        .animation(.snappy, value: empty)
        .animation(.snappy, value: suggest)
        .animation(.snappy, value: dictation.isListening)
        .onChange(of: dictation.transcript) { _, heard in
            if !dictation.isListening, !heard.isEmpty { text = heard }
        }
        .onChange(of: model.isWorking) { _, working in
            if working { sending = false }
        }
    }

    private func send(_ message: String) {
        let t = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        sending = true
        sends += 1
        let this = sends
        text = ""
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task {
            await model.send(t, files: [])
            // A send that failed, or a turn that never reported as working.
            if model.sendError == nil { try? await Task.sleep(for: .seconds(10)) }
            if sends == this { sending = false }
        }
    }
}

/// The microphone's last levels as bars, newest on the right.
private struct Waveform: View {
    let levels: [Double]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(Array(levels.suffix(18).enumerated()), id: \.offset) { _, v in
                Capsule()
                    .fill(LinearGradient(colors: [BotColors.teal, BotColors.violet], startPoint: .bottom, endPoint: .top))
                    .frame(width: 3, height: max(3, 26 * v))
            }
        }
        .animation(.easeOut(duration: 0.08), value: levels)
    }
}

// MARK: shimmer

private struct Shimmer: ViewModifier {
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .overlay {
                if !reduceMotion {
                    GeometryReader { geo in
                        LinearGradient(colors: [.clear, .white.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: geo.size.width * 0.5)
                            .offset(x: phase * geo.size.width * 1.5)
                    }
                    .mask(content)
                    .allowsHitTesting(false)
                }
            }
            .onAppear {
                withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 1 }
            }
    }
}

extension View {
    func shimmering() -> some View { modifier(Shimmer()) }
}
