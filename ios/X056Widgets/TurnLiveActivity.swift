import ActivityKit
import SwiftUI
import WidgetKit

@main
struct X056Widgets: WidgetBundle {
    var body: some Widget {
        TurnLiveActivity()
    }
}

/// A running turn on the Lock Screen and in the Dynamic Island: what step it
/// is on, how long it has run, and how it ended.
struct TurnLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TurnActivityAttributes.self) { context in
            LockScreenTurn(attributes: context.attributes, state: context.state)
                .padding(16)
                .activitySystemActionForegroundColor(Turn.clay)
                .widgetURL(context.attributes.link)
        } dynamicIsland: { context in
            let s = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Turn.symbol(s)
                        .font(.title2)
                        .foregroundStyle(Turn.color(s))
                        .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Turn.clock(s)
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 1) {
                        Text(context.attributes.title).font(.headline).lineLimit(1)
                        Text(context.attributes.project).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Turn.line(s)
                            .font(.subheadline)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let left = s.autopilotLeft {
                            AutopilotProgress(left: left, count: s.autopilotCount)
                        }
                    }
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                Turn.symbol(s).foregroundStyle(Turn.color(s))
            } compactTrailing: {
                Turn.clock(s)
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .frame(maxWidth: 46)
            } minimal: {
                Turn.symbol(s).foregroundStyle(Turn.color(s))
            }
            .keylineTint(Turn.clay)
            .widgetURL(context.attributes.link)
        }
    }
}

struct LockScreenTurn: View {
    let attributes: TurnActivityAttributes
    let state: TurnActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 12) {
                Turn.symbol(state)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(Turn.color(state).gradient, in: .rect(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 1) {
                    Text(attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                    Text("\(attributes.project) · \(attributes.provider == "codex" ? "ChatGPT" : "Claude")")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Turn.clock(state)
                    .font(.title3.monospacedDigit().weight(.semibold))
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 90, alignment: .trailing)
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Turn.line(state)
                    .font(.subheadline)
                    .lineLimit(2)
                Spacer(minLength: 8)
                Text(state.steps == 1 ? "1 step" : "\(state.steps) steps")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            if let left = state.autopilotLeft {
                AutopilotProgress(left: left, count: state.autopilotCount)
            }
        }
    }
}

struct AutopilotProgress: View {
    let left: Int
    let count: Int?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "repeat").font(.caption.weight(.semibold)).foregroundStyle(.indigo)
            if let count, count > 0 {
                ProgressView(value: Double(count - left), total: Double(count))
                    .tint(.indigo)
                Text("\(left) of \(count) left").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            } else {
                Text("Autopilot · \(left) left").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
        }
    }
}

/// How a turn's state reads, shared by every presentation.
enum Turn {
    static let clay = Color(red: 0xE3 / 255, green: 0x97 / 255, blue: 0x78 / 255)

    static func symbol(_ s: TurnActivityAttributes.ContentState) -> Image {
        switch s.status {
        case "waiting": return Image(systemName: "questionmark.bubble.fill")
        case "done": return Image(systemName: "checkmark.circle.fill")
        case "failed": return Image(systemName: "xmark.octagon.fill")
        case "stopped": return Image(systemName: "stop.circle.fill")
        default: return Image(systemName: s.autopilotLeft != nil ? "repeat.circle.fill" : "sparkles")
        }
    }

    static func color(_ s: TurnActivityAttributes.ContentState) -> Color {
        switch s.status {
        case "waiting": return .orange
        case "done": return .green
        case "failed": return .red
        case "stopped": return .gray
        default: return s.autopilotLeft != nil ? .indigo : clay
        }
    }

    /// Counts up while it runs; the time it took once it ended (or asked).
    @ViewBuilder static func clock(_ s: TurnActivityAttributes.ContentState) -> some View {
        if let ended = s.ended {
            Text(Duration.seconds(max(0, ended.timeIntervalSince(s.started))).formatted(.units(allowed: [.hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 2)))
        } else {
            Text(s.started, style: .timer)
        }
    }

    /// The one line that says where it is.
    static func line(_ s: TurnActivityAttributes.ContentState) -> Text {
        switch s.status {
        case "waiting": return Text("\(Text("Needs your answer:").fontWeight(.semibold)) \(s.detail ?? "")")
        case "done": return Text(s.autopilotCount != nil ? "Autopilot run finished" : "Done")
        case "failed": return Text("\(Text("Failed").fontWeight(.semibold))\(s.detail.map { ": \($0)" } ?? "")")
        case "stopped": return Text(s.detail ?? "Stopped")
        default: return Text(s.activity ?? "Working…")
        }
    }
}
