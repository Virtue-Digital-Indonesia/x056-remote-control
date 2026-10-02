import SwiftUI

/// The conversation's whole working setup, like the panel's expanded agent
/// tree: the main session, its advisor, the Jev fork layer, the subagents it
/// delegated to, delegates, back to the main session, and a session log.
struct AgentTreeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let sessionId: String
    @State private var tree: AgentTree?
    @State private var subagents: [Subagent] = []
    @State private var error: String?
    /// nil: the latest turn.
    @State private var turnN: Int?

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                ScrollView {
                    if let tree {
                        AgentTreeContent(tree: tree, subagents: subagents, turnN: turnN, wide: geo.size.width >= 620,
                                         router: app.effectiveRouter(tree.helpers ?? Helpers(), app.conversation(projectId, sessionId))) { id in
                            Task {
                                _ = try? await app.client?.post("/api/delegates/stop", DelegateRef(projectId: projectId, sessionId: sessionId, id: id))
                                await load()
                            }
                        }
                        .padding()
                    }
                }
                .background(Color(.systemGroupedBackground))
                .overlay {
                    if tree == nil {
                        if let error {
                            ContentUnavailableView("Couldn't load the agent tree", systemImage: "point.3.connected.trianglepath.dotted", description: Text(error))
                        } else {
                            ProgressView()
                        }
                    }
                }
                .refreshable { await load() }
            }
            .navigationTitle("Agent tree")
            .navigationSubtitle(turnTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if let turns = tree?.turns, turns.count > 1 {
                        Menu("Turn", systemImage: "clock.arrow.circlepath") {
                            Picker("Turn", selection: $turnN) {
                                Text("Latest turn").tag(Int?.none)
                                ForEach(turns.reversed(), id: \.n) { t in
                                    Text("Turn \(t.n)" + (t.prompt.map { ": \($0.prefix(40))" } ?? "")).tag(Optional(t.n))
                                }
                            }
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .task { await poll() }
        }
    }

    private var turnTitle: String {
        guard let turns = tree?.turns, let last = turns.last else { return app.conversation(projectId, sessionId)?.title ?? "" }
        let n = turnN ?? last.n
        let live = tree?.main.running == true || tree?.main.background == true
        return "Turn \(n)" + (turnN == nil ? (live ? ", live" : ", idle") : "")
    }

    private func poll() async {
        while !Task.isCancelled {
            await load()
            let busy = tree?.main.running == true || tree?.main.background == true || subagents.contains { $0.status == "running" }
            try? await Task.sleep(for: .seconds(busy ? 3 : 15))
        }
    }

    private func load() async {
        guard let client = app.client else { return }
        let q = ["projectId": projectId, "sessionId": sessionId]
        do {
            tree = try await client.get("/api/conversations/agent-tree", query: q, as: AgentTree.self)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        if let s = try? await client.get("/api/conversations/subagents", query: q, as: SubagentsReply.self) {
            subagents = s.subagents
        }
    }
}

struct DelegateRef: Encodable, Sendable { let projectId: String; let sessionId: String; let id: String }

/// The tree itself, for one turn. A plain view, so a test can render it.
struct AgentTreeContent: View {
    let tree: AgentTree
    let subagents: [Subagent]
    var turnN: Int?
    var wide: Bool
    /// The picker that runs (AppModel.effectiveRouter); nil falls back to
    /// what the tree's helpers saved.
    var router: String? = nil
    var stopDelegate: (String) -> Void = { _ in }
    @State private var earlierOpen = false

    private var picker: String? { router ?? (tree.helpers?.router == "none" ? nil : tree.helpers?.router) }

    var body: some View {
        let w = TurnWindow(tree: tree, turnN: turnN)
        let advisorOn = tree.advisor?.on == true
        VStack(alignment: .leading, spacing: 18) {
            Legend(tree: tree, picker: picker, showForks: showForks(w), hasWorkers: tree.team != nil || !subagents.isEmpty)
            if wide && advisorOn {
                HStack(alignment: .top, spacing: 18) {
                    AdvisorCard(advisor: tree.advisor!, calls: w.calls(tree.advisor?.calls ?? []))
                        .frame(width: 250)
                    pipeline(w)
                }
            } else {
                if advisorOn {
                    AdvisorCard(advisor: tree.advisor!, calls: w.calls(tree.advisor?.calls ?? []))
                }
                pipeline(w)
            }
            SessionLog(events: logEvents(w))
        }
    }

    private func showForks(_ w: TurnWindow) -> Bool {
        tree.team != nil || picker != nil || !w.forks(tree.forks?.recent ?? []).isEmpty
    }

    @ViewBuilder
    private func pipeline(_ w: TurnWindow) -> some View {
        let thisTurn = w.workers(subagents)
        let earlier = w.earlier(subagents)
        let delegates = tree.delegates ?? []
        let anyWorkers = !subagents.isEmpty || !delegates.isEmpty
        VStack(spacing: 0) {
            MainCard(main: tree.main)
            if showForks(w) {
                Connector(from: RoleColor.main, to: RoleColor.jev)
                ForkCard(forks: w.forks(tree.forks?.recent ?? []), picker: picker)
            }
            if tree.team != nil || !subagents.isEmpty {
                Connector(from: showForks(w) ? RoleColor.jev : RoleColor.main, to: RoleColor.sub,
                          label: tree.team != nil ? "Delegate to subagents" : "Subagents", strong: tree.team.map(teamLabel))
                workers(thisTurn, earlier)
            }
            if !delegates.isEmpty {
                Connector(from: RoleColor.sub, to: RoleColor.delegate, label: tree.team != nil || !subagents.isEmpty ? nil : "Delegate to hidden workers")
                DelegatesCard(delegates: delegates, stop: stopDelegate)
            }
            if tree.team != nil || anyWorkers {
                Connector(from: delegates.isEmpty ? RoleColor.sub : RoleColor.delegate, to: RoleColor.main)
                RoleCard(color: RoleColor.main, dashed: true) {
                    VStack(spacing: 4) {
                        Text("Back to main session" + (tree.main.effort.map { ", \(ModelCatalog.effortLabel($0).lowercased())" } ?? ""))
                            .font(.headline)
                            .foregroundStyle(RoleColor.main)
                        Text("Reviews and verifies").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            if tree.helpers?.advisor != true && tree.helpers?.team != true && picker == nil && !anyWorkers {
                Text("Turn on Advisor, Agent team or Jev from Helpers, or ask this conversation to delegate work.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
            }
        }
        .frame(maxWidth: .infinity)
    }

    @ViewBuilder
    private func workers(_ list: [Subagent], _ earlier: [(String, [Subagent])]) -> some View {
        VStack(spacing: 12) {
            if list.isEmpty {
                Text("No workers this turn.").font(.footnote).foregroundStyle(.secondary).padding(.vertical, 8)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 170), spacing: 10, alignment: .top)], spacing: 10) {
                    ForEach(nest(list), id: \.agent.agentId) { item in
                        SubagentCard(agent: item.agent, model: workerLabel(item.agent), children: item.children)
                    }
                }
            }
            let n = earlier.reduce(0) { $0 + $1.1.count }
            if n > 0 {
                Button {
                    withAnimation(.snappy) { earlierOpen.toggle() }
                } label: {
                    Label("\(n) earlier", systemImage: earlierOpen ? "chevron.down" : "chevron.right")
                        .font(.footnote.weight(.medium))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 7)
                        .overlay(Capsule().strokeBorder(.tertiary, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                if earlierOpen {
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(earlier, id: \.0) { group in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(group.0).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                                ForEach(group.1) { s in
                                    HStack(spacing: 8) {
                                        SubagentStatusIcon(status: s.status)
                                        Text(SubagentCard.role(s)).font(.footnote.weight(.medium))
                                        Text(s.description ?? s.brief ?? "").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                }
                            }
                        }
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 16, style: .continuous))
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
    }

    /// Top-level workers, each with the agents it spawned.
    private func nest(_ list: [Subagent]) -> [(agent: Subagent, children: [Subagent])] {
        let ids = Set(list.map(\.agentId))
        func parent(_ s: Subagent) -> String? {
            if let p = s.parentAgentId, ids.contains(p), p != s.agentId { return p }
            if let p = s.spawnedBy, ids.contains(p) { return p }
            return nil
        }
        let kids = Dictionary(grouping: list.filter { parent($0) != nil }) { parent($0)! }
        return list.filter { parent($0) == nil }.map { ($0, kids[$0.agentId] ?? []) }
    }

    private func teamLabel(_ team: AgentTree.Team) -> String {
        guard team.pickedBy != nil else { return "effort " + (team.effort.map(ModelCatalog.effortLabel)?.lowercased() ?? "medium") }
        return [team.model.map(ModelCatalog.displayName), team.effort.map { ModelCatalog.effortLabel($0).lowercased() },
                (team.pickedBy == "openai" ? "Decisions" : "Jev") + (team.confidence.map { " \(Int(($0 * 100).rounded()))%" } ?? "")]
            .compactMap { $0 }.joined(separator: " · ")
    }

    /// The panel's workerLabel: the team's model and effort for a team role.
    private func workerLabel(_ s: Subagent) -> String? {
        guard let team = tree.team else { return nil }
        if tree.provider == "codex" {
            return ((team.pickedBy != nil ? team.model.map { ModelCatalog.displayName($0) + " · " } : nil) ?? "") + "effort " + (team.effort ?? "medium")
        }
        let type = s.agentType ?? ""
        var role = type, effort = "medium"
        for suffix in ["-low", "-high"] where type.hasSuffix(suffix) {
            role = String(type.dropLast(suffix.count))
            effort = String(suffix.dropFirst())
        }
        guard (team.roles ?? []).contains(role) else { return nil }
        return ModelCatalog.displayName(team.model ?? "opus") + " · " + effort
    }

    private func logEvents(_ w: TurnWindow) -> [LogEvent] {
        var ev: [LogEvent] = []
        for s in w.workers(subagents) {
            if let at = s.startedAt { ev.append(LogEvent(at: at, tag: SubagentCard.role(s), color: RoleColor.sub, text: "started, " + (s.description ?? s.brief ?? ""))) }
            if let at = s.endedAt { ev.append(LogEvent(at: at, tag: SubagentCard.role(s), color: RoleColor.sub, text: SubagentStatusIcon.label(s.status).lowercased() + ", " + (s.description ?? s.brief ?? ""))) }
        }
        let jevTag = picker == "decisions" ? "decisions" : "jev"
        for f in w.forks(tree.forks?.recent ?? []) {
            guard let at = f.at.flatMap(TurnWindow.ms) else { continue }
            let p = f.confidence.map { String(format: " p=%.2f", $0) } ?? ""
            ev.append(LogEvent(at: at, tag: jevTag, color: RoleColor.jev,
                               text: (f.question ?? "") + (f.choice.map { " → \($0)" } ?? "") + p + (f.verdict == "sharp" ? ", sharp, followed" : ", split, main model decided")))
        }
        for g in w.forks(tree.gates ?? []) {
            guard let at = g.at.flatMap(TurnWindow.ms) else { continue }
            ev.append(LogEvent(at: at, tag: "gate", color: RoleColor.delegate,
                               text: (g.question ?? "").replacingOccurrences(of: "report gate · ", with: "") + " → " + (g.choice ?? "unsure")))
        }
        for c in w.calls(tree.advisor?.calls ?? []) {
            guard let at = c.at.flatMap(TurnWindow.ms) else { continue }
            let text = tree.advisor?.kind == "claude"
                ? "advisor " + (c.status ?? "")
                : (AdvisorCard.checkpointLabel(c.trigger) ?? c.trigger ?? "call") + ", " + (c.error.map { "error: \($0)" } ?? c.verdict.map(ConversationModel.verdictLabel) ?? "")
            ev.append(LogEvent(at: at, tag: "advisor", color: RoleColor.advisor, text: text))
        }
        for p in w.picks(tree.picks ?? []) {
            guard let at = p.at.flatMap(TurnWindow.ms) else { continue }
            ev.append(LogEvent(at: at, tag: p.backend == "openai" ? "decisions" : "jev", color: RoleColor.jev, text: p.noteLine.isEmpty ? "unchanged" : p.noteLine))
        }
        for d in tree.delegates ?? [] {
            guard let r = d.lastReport, let at = r.at.flatMap(TurnWindow.ms) else { continue }
            ev.append(LogEvent(at: at, tag: d.role, color: RoleColor.delegate, text: (r.gate ?? r.status ?? "report") + ", " + (r.text?.split(separator: "\n").first.map(String.init) ?? "")))
        }
        return Array(ev.sorted { $0.at > $1.at }.prefix(15))
    }
}

/// Which turn's work to show, by the panel's membership rule: a node belongs
/// to a turn when it started before the turn ended and was running or ended
/// after the turn began.
struct TurnWindow {
    let start: Double
    let end: Double
    let turns: [(n: Int, start: Double)]

    init(tree: AgentTree, turnN: Int?) {
        let list = (tree.turns ?? []).compactMap { t in t.startedAt.flatMap(Self.ms).map { (n: t.n, start: $0, end: t.endedAt.flatMap(Self.ms)) } }
        turns = list.map { (n: $0.n, start: $0.start) }
        let pick = list.last { $0.n == (turnN ?? list.last?.n) } ?? list.last
        if let pick, let i = list.firstIndex(where: { $0.n == pick.n }) {
            start = pick.start
            let next = i + 1 < list.count ? list[i + 1].start : nil
            end = turnN == nil ? .infinity : (pick.end ?? next ?? .infinity)
        } else {
            start = 0
            end = .infinity
        }
    }

    static func ms(_ iso: String) -> Double? { AppModel.isoDate(iso).map { $0.timeIntervalSince1970 * 1000 } }

    func contains(_ at: Double) -> Bool { at >= start && at < end }

    func workers(_ all: [Subagent]) -> [Subagent] {
        all.filter { s in
            guard let st = s.startedAt else { return false }
            let running = s.status == "running"
            return st < end && (running || (s.endedAt ?? st) >= start)
        }
        .sorted { ($0.status == "running" ? 0 : 1, $0.startedAt ?? 0) < ($1.status == "running" ? 0 : 1, $1.startedAt ?? 0) }
    }

    /// Workers from before this turn, grouped by the turn they started in.
    func earlier(_ all: [Subagent]) -> [(String, [Subagent])] {
        let mine = Set(workers(all).map(\.agentId))
        let older = all.filter { !mine.contains($0.agentId) && ($0.startedAt ?? 0) < start }
        var groups: [Int: [Subagent]] = [:], before: [Subagent] = []
        for s in older {
            let st = s.startedAt ?? 0
            if let t = turns.last(where: { $0.start <= st }) { groups[t.n, default: []].append(s) } else { before.append(s) }
        }
        var out = groups.keys.sorted(by: >).map { ("Turn \($0)", groups[$0]!) }
        if !before.isEmpty { out.append(("Before the first turn", before)) }
        return out
    }

    func forks(_ list: [AgentTree.Fork]) -> [AgentTree.Fork] { list.filter { $0.at.flatMap(Self.ms).map(contains) ?? false } }
    func calls(_ list: [AgentTree.AdvisorCall]) -> [AgentTree.AdvisorCall] { list.filter { $0.at.flatMap(Self.ms).map(contains) ?? false } }
    func picks(_ list: [JevDecision]) -> [JevDecision] { list.filter { $0.at.flatMap(Self.ms).map(contains) ?? false } }
}

// MARK: cards

struct Legend: View {
    let tree: AgentTree
    var picker: String? = nil
    let showForks: Bool
    let hasWorkers: Bool

    var body: some View {
        FlowRow(spacing: 8) {
            chip(RoleColor.main, [tree.main.model.map(ModelCatalog.displayName) ?? "Main session", tree.main.effort.map { ModelCatalog.effortLabel($0).lowercased() }])
            if hasWorkers {
                chip(RoleColor.sub, ["Subagents", tree.team.flatMap { $0.pickedBy != nil ? $0.model.map(ModelCatalog.displayName) : nil }, tree.team?.effort])
            }
            if showForks { chip(RoleColor.jev, [picker == "decisions" ? "Decisions" : "Jev", "forks"]) }
            if !(tree.delegates ?? []).isEmpty { chip(RoleColor.delegate, ["Delegates"]) }
            if tree.advisor?.on == true { chip(RoleColor.advisor, [tree.advisor?.model.map(ModelCatalog.displayName), "advisor"]) }
        }
    }

    private func chip(_ color: Color, _ parts: [String?]) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 2.5, style: .continuous).fill(color).frame(width: 10, height: 10)
            Text(parts.compactMap { $0 }.joined(separator: " · "))
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(.secondarySystemGroupedBackground), in: .capsule)
    }
}

/// Short vertical line between pipeline cards, coloured from one role to the
/// next, with an optional caption.
struct Connector: View {
    let from: Color
    let to: Color
    var label: String?
    var strong: String?

    var body: some View {
        VStack(spacing: 6) {
            line
            if let label {
                Text("\(label)  \(Text(strong ?? "").fontWeight(.semibold).foregroundStyle(to))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                line
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var line: some View {
        Capsule()
            .fill(LinearGradient(colors: [from.opacity(0.6), to.opacity(0.6)], startPoint: .top, endPoint: .bottom))
            .frame(width: 2, height: label == nil ? 22 : 12)
    }
}

struct MainCard: View {
    let main: AgentTree.Main

    var body: some View {
        RoleCard(color: RoleColor.main) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    IconTile(symbol: ModelCatalog.symbol(main.model ?? ""), color: RoleColor.main, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(main.model.map(ModelCatalog.displayName) ?? "Auto model").font(.headline)
                        Text("Main session, plans and decides").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    status
                }
                HStack(spacing: 8) {
                    Text("Effort").foregroundStyle(.secondary)
                    EffortMeter(level: ModelCatalog.effortLevel(main.effort ?? ""))
                    Text(main.effort.map(ModelCatalog.effortLabel) ?? "Default").fontWeight(.medium)
                    Spacer(minLength: 8)
                    if let by = main.pickedBy {
                        Label((by == "openai" ? "Picked by OpenAI" : "Picked by Jev") + (main.lean.map { ", lean \($0)" } ?? ""), systemImage: "wand.and.stars")
                            .font(.caption.weight(.semibold))
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .foregroundStyle(RoleColor.jev)
                            .background(RoleColor.jev.opacity(0.14), in: .capsule)
                    }
                }
                .font(.subheadline)
                if let last = main.lastTurn, let line = Self.lastTurnLine(last) {
                    Text(line).font(.caption).foregroundStyle(.tertiary)
                }
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        if main.running == true {
            Label("Working", systemImage: "circle.fill")
                .symbolEffect(.pulse, options: .repeating)
                .foregroundStyle(RoleColor.main)
                .font(.caption.weight(.semibold))
        } else if main.background == true {
            Label("Background", systemImage: "circle.lefthalf.filled")
                .foregroundStyle(.purple)
                .font(.caption.weight(.semibold))
        } else {
            Label("Idle", systemImage: "circle")
                .foregroundStyle(.secondary)
                .font(.caption.weight(.semibold))
        }
    }

    static func lastTurnLine(_ l: AgentTree.Main.LastTurn) -> String? {
        var parts: [String] = []
        if let s = l.steps { parts.append("\(s) steps") }
        if let ms = l.durationMs { parts.append(Duration.milliseconds(Int64(ms)).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow))) }
        if let c = l.costUsd { parts.append(String(format: "$%.2f", c)) }
        return parts.isEmpty ? nil : "Last turn: " + parts.joined(separator: ", ")
    }
}

struct ForkCard: View {
    let forks: [AgentTree.Fork]
    let picker: String?

    var body: some View {
        let sharp = forks.filter { $0.verdict == "sharp" }.count
        RoleCard(color: RoleColor.jev) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    IconTile(symbol: "wand.and.stars", color: RoleColor.jev, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(picker == "decisions" ? "OpenAI Decisions" : "Jev").font(.headline)
                        Text("Fork layer").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    VStack(alignment: .trailing, spacing: 0) {
                        Text("\(forks.count)").font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(RoleColor.jev)
                        Text(forks.count == 1 ? "fork" : "forks").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if forks.isEmpty {
                    Text("No forks yet. Small either-or questions go here.").font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(Array(forks.suffix(4).reversed().enumerated()), id: \.offset) { _, f in
                        VStack(alignment: .leading, spacing: 5) {
                            Text(f.question ?? "Fork").font(.subheadline).lineLimit(2)
                            HStack(spacing: 8) {
                                ConfidenceMeter(value: f.confidence, color: f.verdict == "sharp" ? RoleColor.jev : .secondary)
                                Text(f.confidence.map { String(format: "%.2f", $0) } ?? "–")
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                                Text(f.verdict == "sharp" ? "Sharp" : "Split")
                                    .font(.caption2.weight(.bold))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .foregroundStyle(f.verdict == "sharp" ? .white : .secondary)
                                    .background(f.verdict == "sharp" ? AnyShapeStyle(RoleColor.jev) : AnyShapeStyle(.quaternary), in: .capsule)
                            }
                            if let choice = f.choice {
                                Text("→ \(choice)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    HStack {
                        Text("Sharp \(sharp), followed").foregroundStyle(RoleColor.jev)
                        Spacer()
                        Text("Split \(forks.count - sharp), main model decided").foregroundStyle(RoleColor.main)
                    }
                    .font(.caption.weight(.medium))
                }
            }
        }
    }
}

struct SubagentCard: View {
    let agent: Subagent
    let model: String?
    let children: [Subagent]

    static func role(_ s: Subagent) -> String {
        guard let t = s.agentType, t != "codex-subagent" else { return "Codex agent" }
        return t.prefix(1).uppercased() + t.dropFirst()
    }

    var body: some View {
        RoleCard(color: RoleColor.sub) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    IconTile(symbol: "person.fill", color: RoleColor.sub, size: 24)
                    Text(Self.role(agent)).font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                if let model {
                    Text(model).font(.caption.weight(.medium)).foregroundStyle(RoleColor.sub).lineLimit(1)
                }
                if let d = agent.description ?? agent.brief, !d.isEmpty {
                    Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                HStack(spacing: 5) {
                    SubagentStatusIcon(status: agent.status)
                    Text(SubagentStatusIcon.label(agent.status)).font(.caption.weight(.medium))
                    Spacer(minLength: 4)
                    if let usd = agent.cost?.usd { Text(String(format: "$%.2f", usd)).font(.caption2).foregroundStyle(.tertiary) }
                }
                ForEach(children) { c in
                    HStack(spacing: 6) {
                        Image(systemName: "arrow.turn.down.right").font(.caption2).foregroundStyle(.tertiary)
                        SubagentStatusIcon(status: c.status)
                        Text(Self.role(c)).font(.caption.weight(.medium)).lineLimit(1)
                    }
                }
            }
        }
    }
}

struct SubagentStatusIcon: View {
    let status: String

    static func label(_ s: String) -> String {
        switch s {
        case "running": return "Running"
        case "done": return "Done"
        case "failed": return "Failed"
        case "stopped": return "Stopped"
        case "ended": return "Ended, no result"
        default: return "Status unknown"
        }
    }

    var body: some View {
        switch status {
        case "running":
            Image(systemName: "circle.dotted").symbolEffect(.rotate, options: .repeating).foregroundStyle(RoleColor.sub)
        case "done":
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case "failed":
            Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        case "stopped":
            Image(systemName: "stop.circle.fill").foregroundStyle(.orange)
        default:
            Image(systemName: "minus.circle").foregroundStyle(.secondary)
        }
    }
}

struct AdvisorCard: View {
    let advisor: AgentTree.Advisor
    let calls: [AgentTree.AdvisorCall]

    static let checkpoints = [("plan", "Before a plan"), ("stuck", "When an error repeats"), ("done", "Before done")]
    static func checkpointLabel(_ trigger: String?) -> String? { checkpoints.first { $0.0 == trigger }?.1.lowercased() }

    var body: some View {
        RoleCard(color: RoleColor.advisor) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    IconTile(symbol: "person.badge.shield.checkmark.fill", color: RoleColor.advisor, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(advisor.model.map(ModelCatalog.displayName) ?? "Advisor").font(.headline)
                        Text("Advisor, on call").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                if advisor.kind != "claude" {
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Self.checkpoints, id: \.0) { cp in
                            let hit = calls.contains { $0.trigger == cp.0 }
                            Label(cp.1, systemImage: hit ? "diamond.fill" : "diamond")
                                .font(.subheadline)
                                .foregroundStyle(hit ? RoleColor.advisor : .secondary)
                        }
                    }
                }
                HStack {
                    Text("Calls this turn").foregroundStyle(.secondary)
                    Spacer()
                    Text("\(calls.count)").fontWeight(.semibold).monospacedDigit().foregroundStyle(RoleColor.advisor)
                }
                .font(.subheadline)
                if let advice = calls.last(where: { $0.advice?.isEmpty == false })?.advice {
                    Text("“\(advice)”").font(.footnote).foregroundStyle(.secondary).lineLimit(6)
                }
                Text(advisor.note ?? "Reviews the turn at these checkpoints and never writes code itself.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

struct DelegatesCard: View {
    let delegates: [AgentTree.Delegate]
    let stop: (String) -> Void

    var body: some View {
        RoleCard(color: RoleColor.delegate) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    IconTile(symbol: "person.2.fill", color: RoleColor.delegate, size: 34)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Delegates").font(.headline)
                        Text("Reports gated by Jev").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                ForEach(delegates) { d in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(d.role.prefix(1).uppercased() + d.role.dropFirst()).font(.subheadline.weight(.semibold))
                            Spacer()
                            if let gate = d.lastReport?.gate { GatePill(gate: gate) }
                            SubagentStatusIcon(status: d.working == true ? "running" : d.status == "failed" ? "failed" : d.status == "stopped" ? "stopped" : "done")
                        }
                        Text([(d.provider == "codex" ? "ChatGPT" : "Claude"), d.model.map(ModelCatalog.displayName), "\(d.turns ?? 0) turns",
                              (d.pending?.isEmpty == false ? "\(d.pending!.count) queued" : nil)].compactMap { $0 }.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let text = d.lastReport?.text, !text.isEmpty {
                            Text(text).font(.footnote).foregroundStyle(.secondary).lineLimit(4)
                        }
                    }
                    .contextMenu {
                        if d.working == true || d.status == "idle" {
                            Button("Stop delegate", systemImage: "stop.fill", role: .destructive) { stop(d.id) }
                        }
                    }
                }
            }
        }
    }
}

struct LogEvent: Hashable {
    let at: Double
    let tag: String
    let color: Color
    let text: String
}

struct SessionLog: View {
    let events: [LogEvent]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Session log").font(.headline)
            if events.isEmpty {
                Text("Nothing yet this turn.").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(events, id: \.self) { e in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(Date(timeIntervalSince1970: e.at / 1000), format: .dateTime.hour().minute().second())
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.tertiary)
                    Text(e.tag)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(e.color)
                        .frame(width: 92, alignment: .leading)
                        .lineLimit(1)
                    Text(e.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
    }
}
