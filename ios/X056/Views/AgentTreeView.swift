import SwiftUI

/// The conversation's whole working setup, like the panel's agent tree:
/// the main session, its advisor, Jev's picks and forks, the agent team's
/// subagents, delegates, and the turns.
struct AgentTreeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let sessionId: String
    @State private var tree: AgentTree?
    @State private var subagents: [Subagent] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let tree {
                    mainSection(tree)
                    advisorSection(tree)
                    jevSection(tree)
                    teamSection(tree)
                    delegatesSection(tree)
                    turnsSection(tree)
                }
            }
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
            .navigationTitle("Agent tree")
            .navigationSubtitle(app.conversation(projectId, sessionId)?.title ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await poll() }
        }
        .presentationDetents([.large])
    }

    // MARK: sections

    private func mainSection(_ t: AgentTree) -> some View {
        Section("Main session") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    NodeStatus(text: t.main.running == true ? "Working" : t.main.background == true ? "Background work" : "Idle",
                               color: t.main.running == true ? Palette.ok : t.main.background == true ? .purple : .secondary)
                    Spacer()
                    if let by = t.main.pickedBy {
                        Text((by == "openai" ? "Picked by OpenAI" : "Picked by Jev") + (t.main.lean.map { ", lean \($0)" } ?? ""))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Palette.clay)
                    }
                }
                Text([t.main.model.map(ModelCatalog.displayName) ?? "Auto model", t.main.effort.map(ModelCatalog.effortLabel)].compactMap { $0 }.joined(separator: " · "))
                    .font(.headline)
                if let last = t.main.lastTurn, let line = lastTurnLine(last) {
                    Text(line).font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func advisorSection(_ t: AgentTree) -> some View {
        if let a = t.advisor, a.on || !(a.calls ?? []).isEmpty {
            Section {
                ForEach(Array((a.calls ?? []).reversed().enumerated()), id: \.offset) { _, c in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(c.verdict.map(ConversationModel.verdictLabel).map { $0.prefix(1).uppercased() + $0.dropFirst() }
                                 ?? (c.status == "reviewed" ? "Reviewed this step" : c.status == "declined" ? "Declined to advise" : c.status ?? "Call"))
                                .fontWeight(.medium)
                            Spacer()
                            if let at = c.at.flatMap(AppModel.isoDate) {
                                Text(at, format: .relative(presentation: .named, unitsStyle: .abbreviated)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if let trigger = c.trigger { Text("At the \(trigger) checkpoint").font(.caption).foregroundStyle(.secondary) }
                        if let advice = c.advice, !advice.isEmpty { Text(advice).font(.callout).foregroundStyle(.secondary).lineLimit(6) }
                        if let e = c.error { Text(e).font(.caption).foregroundStyle(.red) }
                    }
                }
                if (a.calls ?? []).isEmpty {
                    Text("No calls yet.").foregroundStyle(.secondary)
                }
            } header: {
                Text("Advisor" + (a.model.map { ", \(ModelCatalog.displayName($0))" } ?? ""))
            } footer: {
                if let note = a.note { Text(note) }
            }
        }
    }

    @ViewBuilder
    private func jevSection(_ t: AgentTree) -> some View {
        let picks = t.picks ?? []
        let forks = t.forks?.recent ?? []
        if t.helpers?.router != nil || t.helpers?.team == true || !picks.isEmpty || !forks.isEmpty {
            Section {
                ForEach(Array(picks.reversed().enumerated()), id: \.offset) { _, p in
                    CardRow(card: .decision(p))
                        .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                }
                if let f = t.forks, (f.total ?? 0) > 0 {
                    Text("\(f.sharp ?? 0) sharp, followed. \(f.split ?? 0) split, the main session decided.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                ForEach(Array(forks.reversed().enumerated()), id: \.offset) { _, f in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(f.question ?? "Fork").lineLimit(3)
                        HStack(spacing: 6) {
                            if let choice = f.choice { Text("→ \(choice)").fontWeight(.medium) }
                            if let c = f.confidence { Text("\(Int((c * 100).rounded()))%").foregroundStyle(.secondary) }
                            Spacer()
                            if let v = f.verdict {
                                Text(v == "sharp" ? "Sharp" : "Split")
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background((v == "sharp" ? Palette.ok : Color.secondary).opacity(0.14), in: .capsule)
                            }
                        }
                        .font(.caption)
                        if let e = f.error { Text(e).font(.caption).foregroundStyle(.red) }
                    }
                }
                if picks.isEmpty && forks.isEmpty {
                    Text("No picks or forks this turn.").foregroundStyle(.secondary)
                }
            } header: {
                Text(t.helpers?.router == "decisions" ? "OpenAI Decisions" : "Jev")
            }
        }
    }

    @ViewBuilder
    private func teamSection(_ t: AgentTree) -> some View {
        if t.team != nil || !subagents.isEmpty {
            Section {
                if let team = t.team {
                    HStack {
                        Text([team.model.map(ModelCatalog.displayName), team.effort.map(ModelCatalog.effortLabel)].compactMap { $0 }.joined(separator: " · "))
                        Spacer()
                        if let c = team.confidence, team.pickedBy != nil {
                            Text("Jev \(Int((c * 100).rounded()))%").font(.caption).foregroundStyle(Palette.clay)
                        }
                    }
                    if let roles = team.roles, !roles.isEmpty {
                        Text("Roles: " + roles.joined(separator: ", ")).font(.caption).foregroundStyle(.secondary)
                    }
                }
                ForEach(ordered(subagents), id: \.agent.agentId) { item in
                    SubagentRow(agent: item.agent)
                        .padding(.leading, CGFloat(item.depth) * 16)
                }
            } header: {
                Text(t.team != nil ? "Agent team" : "Subagents")
            }
        }
    }

    @ViewBuilder
    private func delegatesSection(_ t: AgentTree) -> some View {
        let delegates = t.delegates ?? []
        if !delegates.isEmpty {
            Section("Delegates") {
                ForEach(delegates) { d in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(d.role.prefix(1).uppercased() + d.role.dropFirst()).fontWeight(.medium)
                            Spacer()
                            if let gate = d.lastReport?.gate { GatePill(gate: gate) }
                            NodeStatus(text: delegateStatus(d), color: d.working == true ? Palette.ok : d.status == "failed" ? .red : .secondary)
                        }
                        Text([(d.provider == "codex" ? "ChatGPT" : "Claude"), d.model.map(ModelCatalog.displayName), "\(d.turns ?? 0) turns",
                              (d.pending?.isEmpty == false ? "\(d.pending!.count) queued" : nil)].compactMap { $0 }.joined(separator: ", "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let text = d.lastReport?.text, !text.isEmpty {
                            Text(text).font(.callout).foregroundStyle(.secondary).lineLimit(5)
                        }
                    }
                    .swipeActions {
                        if d.working == true || d.status == "idle" {
                            Button("Stop", systemImage: "stop.fill", role: .destructive) {
                                Task {
                                    _ = try? await app.client?.post("/api/delegates/stop", DelegateRef(projectId: projectId, sessionId: sessionId, id: d.id))
                                    await load()
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func turnsSection(_ t: AgentTree) -> some View {
        let turns = (t.turns ?? []).reversed().prefix(20)
        if !turns.isEmpty {
            Section("Turns") {
                ForEach(Array(turns), id: \.n) { turn in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Turn \(turn.n)").fontWeight(.medium)
                            if let p = turn.prompt, !p.isEmpty { Text(p).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                        }
                        Spacer()
                        if turn.running == true {
                            NodeStatus(text: "Now", color: Palette.ok)
                        } else if let at = turn.startedAt.flatMap(AppModel.isoDate) {
                            Text(at, format: .relative(presentation: .named, unitsStyle: .abbreviated)).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: data

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

    /// Depth-first, children under the agent that spawned them.
    private func ordered(_ all: [Subagent]) -> [(agent: Subagent, depth: Int)] {
        let byParent = Dictionary(grouping: all) { $0.parentAgentId ?? $0.spawnedBy ?? "" }
        let ids = Set(all.map(\.agentId))
        var out: [(Subagent, Int)] = []
        func walk(_ parent: String, _ depth: Int) {
            for a in (byParent[parent] ?? []).sorted(by: { ($0.startedAt ?? 0) < ($1.startedAt ?? 0) }) {
                out.append((a, depth))
                walk(a.agentId, depth + 1)
            }
        }
        // Roots: no parent, or a parent this list does not hold.
        for key in byParent.keys where key.isEmpty || !ids.contains(key) { walk(key, 0) }
        return out.map { (agent: $0.0, depth: $0.1) }
    }

    private func lastTurnLine(_ l: AgentTree.Main.LastTurn) -> String? {
        var parts: [String] = []
        if let s = l.steps { parts.append("\(s) steps") }
        if let ms = l.durationMs { parts.append(Duration.milliseconds(Int64(ms)).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow))) }
        if let c = l.costUsd { parts.append(String(format: "$%.2f", c)) }
        return parts.isEmpty ? nil : "Last turn: " + parts.joined(separator: ", ")
    }

    private func delegateStatus(_ d: AgentTree.Delegate) -> String {
        if d.working == true { return "Working" }
        switch d.status {
        case "idle": return "Idle"
        case "failed": return "Failed"
        case "stopped": return "Stopped"
        case "interrupted": return "Interrupted"
        default: return d.status.capitalized
        }
    }
}

struct DelegateRef: Encodable, Sendable { let projectId: String; let sessionId: String; let id: String }

struct NodeStatus: View {
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(color == .secondary ? Color.secondary : color)
    }
}

struct SubagentRow: View {
    let agent: Subagent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(name).fontWeight(.medium).lineLimit(1)
                Spacer()
                NodeStatus(text: status.0, color: status.1)
            }
            if let d = agent.description ?? agent.brief, !d.isEmpty {
                Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            if !bits.isEmpty {
                Text(bits).font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
    }

    private var name: String {
        guard let t = agent.agentType, t != "codex-subagent" else { return "Codex agent" }
        return t.prefix(1).uppercased() + t.dropFirst()
    }

    private var status: (String, Color) {
        switch agent.status {
        case "running": return ("Working", Palette.ok)
        case "done": return ("Done", .secondary)
        case "failed": return ("Failed", .red)
        case "stopped": return ("Stopped", .orange)
        case "ended": return ("Ended, no result", .secondary)
        default: return ("Status unknown", .secondary)
        }
    }

    private var bits: String {
        var parts: [String] = []
        if let s = agent.startedAt {
            let end = agent.endedAt ?? Date().timeIntervalSince1970 * 1000
            parts.append(Duration.milliseconds(Int64(max(0, end - s))).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow)))
        }
        if let usd = agent.cost?.usd { parts.append(String(format: "$%.2f", usd)) }
        return parts.joined(separator: ", ")
    }
}
