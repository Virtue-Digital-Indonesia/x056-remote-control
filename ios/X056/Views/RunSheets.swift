import SwiftUI

/// Model and effort for the next turns.
struct ModelEffortSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ConversationModel

    var body: some View {
        NavigationStack {
            ScrollView {
                ModelEffortContent(model: model.model, effort: model.effort, provider: model.provider, routerName: routerName,
                                   codex: app.codexModels, defaults: app.modelEffortDefaults) { m, e in
                    Task { await model.setPreferences(model: m, effort: e) }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Model and effort")
            .navigationSubtitle(model.provider == "codex" ? "ChatGPT" : "Claude")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private var routerName: String? {
        switch model.helpers.router {
        case "jev": return "Jev"
        case "decisions": return "OpenAI"
        default: return nil
        }
    }
}

/// The sheet's body, plain so a test can render it.
struct ModelEffortContent: View {
    let model: String
    let effort: String
    let provider: String
    /// "Jev" or "OpenAI" when a picker chooses Auto.
    let routerName: String?
    let codex: [CodexModel]
    let defaults: [String: String]
    let choose: (String, String) -> Void

    var body: some View {
        let models = ModelCatalog.models(provider: provider, codex: codex)
        let efforts = ModelCatalog.efforts(provider: provider, model: model, codex: codex)
        VStack(alignment: .leading, spacing: 22) {
            // What the next turn runs with.
            HStack(spacing: 14) {
                IconTile(symbol: ModelCatalog.symbol(model), color: RoleColor.main, size: 46)
                VStack(alignment: .leading, spacing: 4) {
                    Text(model.isEmpty ? (routerName.map { "\($0) picks" } ?? autoName(models)) : ModelCatalog.modelLabel(model, provider: provider, codex: codex))
                        .font(.title3.weight(.semibold))
                    HStack(spacing: 6) {
                        EffortMeter(level: ModelCatalog.effortLevel(effort), height: 12)
                        Text(effort.isEmpty ? (routerName.map { "\($0) picks the effort" } ?? "Auto effort") : ModelCatalog.effortLabel(effort))
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))

            VStack(alignment: .leading, spacing: 8) {
                Text("Model").font(.headline).padding(.leading, 4)
                VStack(spacing: 0) {
                    ForEach(Array(models.enumerated()), id: \.element) { i, o in
                        Button {
                            // A model's saved default effort comes with it, like the panel.
                            let e = defaults[o.value].flatMap { ModelCatalog.efforts(provider: provider, model: o.value, codex: codex).contains($0) ? $0 : nil } ?? effort
                            choose(o.value, e)
                        } label: {
                            HStack(spacing: 12) {
                                IconTile(symbol: ModelCatalog.symbol(o.value), color: o.value == model ? RoleColor.main : .gray, size: 30)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(o.value.isEmpty && routerName != nil ? "\(routerName!) picks" : o.label).foregroundStyle(.primary)
                                    let d = o.value.isEmpty && routerName != nil ? "Chosen per turn, starting from the house default" : ModelCatalog.description(o.value, provider: provider)
                                    if !d.isEmpty { Text(d).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer(minLength: 8)
                                if o.value == model {
                                    Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Palette.clay)
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .contentShape(.rect)
                        }
                        .buttonStyle(.plain)
                        if i < models.count - 1 { Divider().padding(.leading, 56) }
                    }
                }
                .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Effort").font(.headline).padding(.leading, 4)
                // A grid, not a scroller: every level stays in view.
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
                        ForEach(efforts, id: \.self) { e in
                            let on = e == effort
                            Button { choose(model, e) } label: {
                                VStack(spacing: 6) {
                                    if e.isEmpty {
                                        Image(systemName: routerName == nil ? "a.circle" : "wand.and.stars").font(.system(size: 15, weight: .semibold))
                                            .frame(height: 16)
                                    } else {
                                        EffortMeter(level: ModelCatalog.effortLevel(e), color: on ? .white : RoleColor.main, height: 16)
                                    }
                                    Text(e.isEmpty && routerName != nil ? routerName! : ModelCatalog.effortShort(e))
                                        .font(.caption.weight(.semibold))
                                }
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                                .padding(.horizontal, 6)
                                .foregroundStyle(on ? .white : .primary)
                                .background(on ? AnyShapeStyle(Palette.clay) : AnyShapeStyle(Color(.secondarySystemGroupedBackground)),
                                            in: .rect(cornerRadius: 14, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(ModelCatalog.effortLabel(e))
                            .accessibilityAddTraits(on ? .isSelected : [])
                        }
                }
                if let d = defaults[model], !model.isEmpty {
                    Text("\(ModelCatalog.modelLabel(model, provider: provider, codex: codex)) defaults to \(ModelCatalog.effortLabel(d).lowercased()) effort.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.leading, 4)
                }
            }
        }
    }

    private func autoName(_ models: [ModelCatalog.Option]) -> String { models.first?.label ?? "Auto" }
}

/// Advisor, agent team, and who picks model and effort, for the next turns.
struct HelpersSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let model: ConversationModel

    var body: some View {
        NavigationStack {
            ScrollView {
                HelpersContent(helpers: model.helpers, provider: model.provider, started: model.sessionId != nil,
                               jev: app.jevStatus, decisions: app.decisionsStatus) { h in
                    Task { await model.setHelpers(h) }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Helpers")
            .navigationSubtitle("For the next turns")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct HelpersContent: View {
    let helpers: Helpers
    let provider: String
    let started: Bool
    let jev: JevStatus?
    let decisions: DecisionsStatus?
    let save: (Helpers) -> Void

    var body: some View {
        let codex = provider == "codex"
        VStack(alignment: .leading, spacing: 22) {
            if !started {
                Label("Send the first message, then choose helpers for the following turns.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            VStack(spacing: 10) {
                toggleCard("Advisor", symbol: "person.badge.shield.checkmark.fill", color: RoleColor.advisor,
                           text: codex ? "Astra reviews the plan, repeated failures and the finished turn." : "A stronger model reviews the plan, repeated errors and the result.",
                           on: helpers.advisor == true) { var h = helpers; h.advisor = $0; save(h) }
                toggleCard("Agent team", symbol: "person.3.fill", color: RoleColor.sub,
                           text: (codex ? "Explorer and worker subagents, plus a researcher, on medium effort." : "Explorer, worker and researcher subagents on Opus, medium effort.")
                               + (helpers.router != nil ? " Small forks go to \(helpers.router == "decisions" ? "OpenAI Decisions" : "Jev")." : ""),
                           on: helpers.team == true) { var h = helpers; h.team = $0; save(h) }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Who picks model and effort").font(.headline).padding(.leading, 4)
                VStack(spacing: 10) {
                    pickerCard(nil, title: "Your choice", symbol: "slider.horizontal.3", color: .gray,
                               text: "The model and effort in the composer.", enabled: true)
                    pickerCard("jev", title: "Jev", symbol: "wand.and.stars", color: RoleColor.jev, text: jevText,
                               enabled: (jev?.configured ?? true) || helpers.router == "jev")
                    pickerCard("decisions", title: "OpenAI Decisions", symbol: "brain.filled.head.profile", color: .indigo, text: decisionsText,
                               enabled: (decisions?.configured ?? false) || helpers.router == "decisions", tag: "Preview")
                }
            }

            if helpers.router != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Lean").font(.headline).padding(.leading, 4)
                    HStack(spacing: 8) {
                        leanButton("low", "Low", "leaf.fill")
                        leanButton(nil, "Medium", "scalemass.fill")
                        leanButton("high", "High", "flame.fill")
                    }
                    Text(leanCaption).font(.footnote).foregroundStyle(.secondary).padding(.leading, 4)
                }
            }
        }
        .disabled(!started)
        .opacity(started ? 1 : 0.6)
    }

    private var jevText: String {
        guard let j = jev else { return "Picks the model and effort for each turn." }
        guard j.configured else { return "Needs a TypeSafe API key." }
        return "Picks the model and effort for each turn" + (j.estimatedLeft.map { String(format: ", about $%.2f left.", $0) } ?? ".")
    }

    private var decisionsText: String {
        guard let d = decisions, d.configured else { return "Needs an OpenAI API key with Decisions access." }
        return "Picks the model and effort for each turn, in place of Jev" + (d.calls.map { ", \($0) calls so far." } ?? ".")
    }

    private var leanCaption: String {
        switch helpers.lean {
        case "low": return "Errs toward cheaper models and lower effort."
        case "high": return "Errs toward the best result."
        default: return "Balanced between cost and result."
        }
    }

    private func toggleCard(_ title: String, symbol: String, color: Color, text: String, on: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { on }, set: set)) {
            HStack(alignment: .top, spacing: 12) {
                IconTile(symbol: symbol, color: color, size: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.body.weight(.semibold))
                    Text(text).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .tint(color)
        .padding(14)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
    }

    private func pickerCard(_ router: String?, title: String, symbol: String, color: Color, text: String, enabled: Bool, tag: String? = nil) -> some View {
        let on = helpers.router == router
        return Button {
            var h = helpers
            h.router = router
            save(h)
        } label: {
            HStack(alignment: .top, spacing: 12) {
                IconTile(symbol: symbol, color: on ? color : .gray, size: 34)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                        if let tag {
                            Text(tag).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2)
                                .background(.quaternary, in: .capsule)
                        }
                    }
                    Text(text).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(on ? color : Color.secondary.opacity(0.5))
            }
            .padding(14)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(on ? color.opacity(0.6) : .clear, lineWidth: 1.5)
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.5)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func leanButton(_ lean: String?, _ title: String, _ symbol: String) -> some View {
        let on = helpers.lean == lean
        return Button {
            var h = helpers
            h.lean = lean
            save(h)
        } label: {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 17, weight: .semibold))
                Text(title).font(.caption.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .foregroundStyle(on ? .white : .primary)
            .background(on ? AnyShapeStyle(RoleColor.jev.gradient) : AnyShapeStyle(Color(.secondarySystemGroupedBackground)),
                        in: .rect(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
