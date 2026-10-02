import SwiftUI

/// Autopilot for one conversation: the gateway sends "keep going" after each
/// turn until a reply says it is done or the steps run out. A standing
/// instruction rides along with every step, such as the plan to follow.
struct AutopilotSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let sessionId: String

    @State private var steps = 20
    @State private var instruction = ""
    /// The instruction as the gateway has it, to tell an edit from none.
    @State private var savedInstruction = ""
    @State private var selection: TextSelection?
    @FocusState private var editing: Bool
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false

    static let tint = Color.indigo
    private static let presets = [5, 10, 20, 50]

    private var state: AutopilotState? { app.autopilot[sessionId] }
    private var running: Bool { state != nil && state?.paused != true }
    private var supportsInstruction: Bool { app.autopilotInstructions != false }
    private var instructionChanged: Bool {
        instruction.trimmingCharacters(in: .whitespacesAndNewlines) != savedInstruction.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        // Its own header, not a navigation bar: on iPhone Duo the bar's Done
        // was gone for good once the keyboard had been up in this sheet.
        VStack(spacing: 0) {
            HStack {
                Text("Autopilot").font(.headline)
                Spacer()
                Button("Done") { dismiss() }
                    .buttonStyle(.glass)
            }
            .padding(.horizontal)
            .padding(.top, 14)
            .padding(.bottom, 6)
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    statusCard
                    if !running { stepsCard }
                    instructionCard
                    Label("Autopilot stops when a reply says it is done, when the steps run out, or when a turn fails. Stop it any time.", systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let error {
                        Label(error, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                .padding()
                .frame(maxWidth: 640)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            // While the instruction is being typed the buttons step aside (over
            // the keyboard they would cover the text) for one small one that
            // puts the keyboard away.
            .safeAreaInset(edge: .bottom) {
                if editing {
                    HStack {
                        Spacer()
                        Button("Hide keyboard", systemImage: "keyboard.chevron.compact.down") { editing = false }
                            .labelStyle(.iconOnly)
                            .buttonStyle(.glass)
                    }
                    .padding(.horizontal)
                    .padding(.bottom, 8)
                } else {
                    actions
                }
            }
        }
        .background(Color(.systemGroupedBackground))
        .animation(.snappy, value: editing)
        .task { await load() }
        .presentationDetents([.large])
    }

    // MARK: cards

    private var statusCard: some View {
        RoleCard(color: Self.tint) {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    if let state, let count = state.count, count > 0 {
                        Circle().stroke(.quaternary, lineWidth: 5)
                        Circle()
                            .trim(from: 0, to: CGFloat(count - state.remaining) / CGFloat(count))
                            .stroke(Self.tint.gradient, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                            .rotationEffect(.degrees(-90))
                    }
                    IconTile(symbol: state?.paused == true ? "pause.fill" : "repeat", color: state?.paused == true ? .orange : Self.tint, size: 34)
                        .symbolEffect(.rotate, options: .repeating, isActive: running && app.running.contains(sessionId))
                }
                .frame(width: 52, height: 52)
                VStack(alignment: .leading, spacing: 3) {
                    Text(headline).font(.headline)
                    Text(subline)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .animation(.snappy, value: state)
    }

    private var headline: String {
        guard let state else { return "Keep this conversation going" }
        if state.paused == true { return "Paused" }
        if let count = state.count { return "\(state.remaining) of \(count) steps left" }
        return "\(state.remaining) steps left"
    }

    private var subline: String {
        guard let state else { return "After each turn the gateway sends \u{201C}keep going\u{201D}, until the task says it is done or the steps run out." }
        if state.paused == true { return state.pauseReason.map { "\($0). Start it again to carry on." } ?? "A turn did not finish. Start it again to carry on." }
        return app.running.contains(sessionId) ? "Working on the current step." : "The next step starts in a moment."
    }

    private var stepsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                Text("Steps").font(.headline)
                Spacer()
                Text("\(steps)")
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .contentTransition(.numericText())
                Stepper("Steps", value: $steps, in: 1...500)
                    .labelsHidden()
            }
            HStack(spacing: 8) {
                ForEach(Self.presets, id: \.self) { n in
                    Button("\(n)") { withAnimation(.snappy) { steps = n } }
                        .buttonStyle(ChipButtonStyle(selected: steps == n, tint: Self.tint))
                }
            }
            Text("Each step is one turn. A reply that says it is done ends the run early.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
    }

    private var instructionCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Standing instruction")
                    .font(.headline)
                Spacer()
                Text("Sent with every step")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ZStack(alignment: .topLeading) {
                TextEditor(text: $instruction, selection: $selection)
                    .focused($editing)
                    .scrollContentBackground(.hidden)
                    .frame(minHeight: 120)
                    .disabled(!supportsInstruction)
                    .accessibilityLabel("Standing instruction")
                if instruction.isEmpty {
                    Text("e.g. Follow docs/plan.md and tick off each item as you finish it.")
                        .foregroundStyle(.tertiary)
                        .padding(.top, 8)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                }
            }
            .padding(8)
            .background(Color(.tertiarySystemFill), in: .rect(cornerRadius: 14, style: .continuous))
            if supportsInstruction {
                FlowRow(spacing: 8) {
                    suggestion("Plan doc", "doc.text", "Follow the implementation plan in ", select: "docs/PLAN.md", then: " and tick off each item as you finish it.")
                    suggestion("Tests each step", "checkmark.seal", "Run the tests after each change and fix failures before moving on.")
                    suggestion("Commit as you go", "arrow.triangle.branch", "Commit after each finished item, with a message that says what changed.")
                }
            } else {
                Label("This gateway does not take an instruction yet. It will after its next update.", systemImage: "arrow.down.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
    }

    /// Adds a sentence on its own line. With `select`, that part is selected
    /// so typing replaces it (a placeholder path).
    private func suggestion(_ title: String, _ symbol: String, _ lead: String, select: String = "", then tail: String = "") -> some View {
        Button {
            let sep = instruction.isEmpty || instruction.hasSuffix("\n") ? "" : "\n"
            instruction += sep + lead
            let from = instruction.count
            instruction += select + tail
            if !select.isEmpty {
                let lower = instruction.index(instruction.startIndex, offsetBy: from)
                let upper = instruction.index(lower, offsetBy: select.count)
                selection = TextSelection(range: lower..<upper)
            }
            editing = true
        } label: {
            Label(title, systemImage: symbol)
        }
        .buttonStyle(ChipButtonStyle(selected: false, tint: Self.tint))
    }

    // MARK: actions

    @ViewBuilder private var actions: some View {
        VStack(spacing: 10) {
            if running {
                if supportsInstruction {
                    Button {
                        Task { await run { try await app.setAutopilotInstruction(projectId: projectId, sessionId: sessionId, instruction: instruction); savedInstruction = instruction } }
                    } label: {
                        Text("Save instruction").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glassProminent)
                    .disabled(!instructionChanged || busy)
                }
                Button(role: .destructive) {
                    Task { await run { try await app.stopAutopilot(sessionId: sessionId) } }
                } label: {
                    Text("Stop autopilot").frame(maxWidth: .infinity)
                }
                .buttonStyle(.glass)
                .disabled(busy)
            } else {
                Button {
                    Task {
                        await run {
                            if state?.paused == true { try await app.stopAutopilot(sessionId: sessionId) }
                            try await app.startAutopilot(projectId: projectId, sessionId: sessionId, count: steps, instruction: supportsInstruction ? instruction : "")
                            savedInstruction = instruction
                        }
                    }
                } label: {
                    Label(state?.paused == true ? "Start again" : "Start autopilot", systemImage: "play.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.glassProminent)
                .tint(Self.tint)
                .disabled(busy)
                if state?.paused == true {
                    Button(role: .destructive) {
                        Task { await run { try await app.stopAutopilot(sessionId: sessionId) } }
                    } label: {
                        Text("Stop autopilot").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)
                    .disabled(busy)
                }
            }
        }
        .controlSize(.large)
        .padding(.horizontal)
        .padding(.bottom, 8)
        .frame(maxWidth: 640)
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        error = nil
        defer { busy = false }
        do { try await work() } catch { self.error = error.localizedDescription }
    }

    private func load() async {
        guard !loaded else { return }
        loaded = true
        await app.loadAutopilot()
        let last = await app.autopilotLast(projectId: projectId, sessionId: sessionId)
        if let state {
            steps = state.paused == true ? max(state.remaining, 1) : (state.count ?? state.remaining)
            instruction = state.instruction ?? ""
        } else {
            if let c = last?.count { steps = c }
            instruction = last?.instruction ?? ""
        }
        savedInstruction = state?.instruction ?? ""
    }
}

/// A rounded chip: tinted when selected, a quiet fill otherwise.
struct ChipButtonStyle: ButtonStyle {
    var selected: Bool
    var tint: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .foregroundStyle(selected ? Color.white : tint)
            .background(selected ? AnyShapeStyle(tint.gradient) : AnyShapeStyle(tint.opacity(0.12)), in: .capsule)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(.capsule)
    }
}

/// The running autopilot over the composer: what is left, the instruction,
/// and Stop. Tapping it opens the sheet.
struct AutopilotBar: View {
    let state: AutopilotState
    let working: Bool
    let open: () -> Void
    let stop: () -> Void

    var body: some View {
        let paused = state.paused == true
        HStack(spacing: 12) {
            Button(action: open) {
                HStack(spacing: 10) {
                    Image(systemName: paused ? "pause.circle.fill" : "repeat.circle.fill")
                        .font(.title3)
                        .foregroundStyle(paused ? Color.orange : AutopilotSheet.tint)
                        .symbolEffect(.rotate, options: .repeating, isActive: working && !paused)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(paused ? "Autopilot paused" : state.count.map { "Autopilot · \(state.remaining) of \($0) left" } ?? "Autopilot · \(state.remaining) left")
                            .font(.subheadline.weight(.semibold))
                            .contentTransition(.numericText())
                        if let line = paused ? state.pauseReason : state.instruction, !line.isEmpty {
                            Text(line)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityHint("Shows autopilot")
            Button("Stop", role: .destructive, action: stop)
                .buttonStyle(.glass)
                .controlSize(.small)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(.regular.tint(AutopilotSheet.tint.opacity(0.1)), in: .rect(cornerRadius: 22, style: .continuous))
    }
}
