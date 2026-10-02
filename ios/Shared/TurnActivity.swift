import ActivityKit
import Foundation

/// A running turn on the Lock Screen and in the Dynamic Island. Shared by the
/// app (which starts it) and the widget extension (which draws it).
struct TurnActivityAttributes: ActivityAttributes {
    /// What changes as the turn runs. The gateway pushes this as JSON
    /// (server/live-activity.ts `TurnContent`): keep the keys in step, and keep
    /// times as plain Unix seconds, since ActivityKit decodes a `Date` from
    /// seconds since 2001.
    struct ContentState: Codable, Hashable, Sendable {
        /// running, waiting (it asked something), done, failed, stopped.
        var status: String
        var steps: Int
        var startedAt: Double
        var activity: String?
        var endedAt: Double?
        var autopilotLeft: Int?
        var autopilotCount: Int?
        var detail: String?

        var started: Date { Date(timeIntervalSince1970: startedAt) }
        var ended: Date? { endedAt.map { Date(timeIntervalSince1970: $0) } }
        var isOver: Bool { endedAt != nil || status == "done" || status == "failed" || status == "stopped" }
    }

    let projectId: String
    let sessionId: String
    let title: String
    let project: String
    /// claude or codex.
    let provider: String

    /// Opens the conversation in the app.
    var link: URL? {
        var c = URLComponents()
        c.scheme = "x056"
        c.host = "conversation"
        c.queryItems = [URLQueryItem(name: "projectId", value: projectId), URLQueryItem(name: "sessionId", value: sessionId)]
        return c.url
    }
}
