import SwiftUI

/// What a conversation is doing, in the panel's colours: accent for a turn,
/// violet for work with no turn behind it, orange when it waits on you.
enum WorkState: Equatable {
    case idle, running, background, needsYou, failed

    @MainActor
    static func of(_ sessionId: String, in app: AppModel, outcome: Outcome? = nil) -> WorkState {
        if app.questions[sessionId] != nil { return .needsYou }
        if app.running.contains(sessionId) { return .running }
        if app.background.contains(sessionId) { return .background }
        if outcome?.status == "failed" { return .failed }
        return .idle
    }

    /// The strongest state among several conversations (a project row).
    static func strongest(_ states: [WorkState]) -> WorkState {
        for s in [WorkState.needsYou, .running, .background, .failed] where states.contains(s) { return s }
        return .idle
    }
}

struct StateSymbol: View {
    let state: WorkState

    var body: some View {
        switch state {
        case .running:
            Image(systemName: "waveform")
                .symbolEffect(.variableColor.iterative.reversing, options: .repeating)
                .foregroundStyle(Palette.clay)
                .accessibilityLabel("Working")
        case .background:
            Image(systemName: "waveform")
                .symbolEffect(.variableColor.iterative.reversing, options: .repeating)
                .foregroundStyle(.purple)
                .accessibilityLabel("Working in the background")
        case .needsYou:
            Image(systemName: "questionmark.bubble.fill")
                .foregroundStyle(.orange)
                .accessibilityLabel("Needs you")
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .accessibilityLabel("Last turn failed")
        case .idle:
            EmptyView()
        }
    }
}

/// A Settings-style tile: projects in clay, chats in blue.
struct ProjectTile: View {
    let isChat: Bool
    var size: CGFloat = 30

    var body: some View {
        Image(systemName: isChat ? "bubble.left.and.text.bubble.right.fill" : "folder.fill")
            .font(.system(size: size * 0.5, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background((isChat ? Color.blue : Palette.clay).gradient, in: .rect(cornerRadius: size * 0.27, style: .continuous))
            .accessibilityHidden(true)
    }
}

enum ToolSymbol {
    /// Tool rows are labelled "Read server/push.ts", "Bash npm test", …
    static func name(for label: String) -> String {
        let tool = label.split(separator: " ").first.map(String.init)?.lowercased() ?? ""
        switch tool {
        case "read", "view": return "doc.text"
        case "edit", "write", "multiedit", "notebookedit", "apply_patch": return "pencil"
        case "bash", "shell", "exec", "run": return "terminal"
        case "grep", "glob", "search", "find", "ls": return "magnifyingglass"
        case "webfetch", "websearch", "fetch": return "globe"
        case "task", "agent", "spawn_agent": return "person.2"
        case "todowrite", "plan", "update_plan": return "checklist"
        default: return "hammer"
        }
    }
}

extension Double {
    /// Epoch milliseconds as a short relative time ("5 min. ago").
    var relativeFromMillis: String {
        Date(timeIntervalSince1970: self / 1000).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}

extension Project {
    var providerLabel: String { providerName == "codex" ? "ChatGPT" : "Claude" }
}

extension Account {
    /// The panel's available(): not paused, not limited or signed out, and no
    /// usage window already at its limit.
    var isAvailable: Bool {
        paused != true
            && !["limited", "unauthenticated"].contains(state?.kind ?? "")
            && !UsageWindow.of(self).contains { $0.percent >= 100 }
    }

    /// The fullest usage window, 0-100.
    var fullest: Double? { UsageWindow.of(self).map(\.percent).max() }

    var level: String {
        if paused == true { return "Paused" }
        switch state?.kind {
        case "unauthenticated": return "Needs login"
        case "limited":
            let at = state?.until.map { Date(timeIntervalSince1970: $0).formatted(date: .omitted, time: .shortened) }
            return at.map { "Limit reached, resets \($0)" } ?? "Limit reached"
        default:
            guard let f = fullest else { return "Usage not checked" }
            return f >= 100 ? "Limit reached" : "\(Int(f.rounded()))% of the limit used"
        }
    }

    var levelColor: Color {
        if !isAvailable { return paused == true ? .secondary : .red }
        guard let f = fullest else { return .secondary }
        return f > 80 ? .orange : f >= 50 ? .yellow : Palette.ok
    }

    var title: String { displayName ?? label ?? name }
}
