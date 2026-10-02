import ActivityKit
import Foundation

/// Live Activities for running turns. The app starts one when it sends a
/// message (or on "Follow on Lock Screen") and hands the activity's push
/// token to the gateway, which keeps it current while the phone is locked
/// (server/live-activity.ts). While the app is open the event stream updates
/// it here too, so it also works on a gateway without those pushes.
@MainActor @Observable
final class LiveTurns {
    static let shared = LiveTurns()

    /// Conversations on the Lock Screen now. Observable, so a menu or a
    /// button reads it fresh (an activity can be pending for a moment).
    private(set) var following: Set<String> = []

    /// Settings › Live Activities: start one for turns this iPhone sends.
    static let enabledKey = "liveActivities"
    static var enabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    var available: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    @ObservationIgnored private var watchers: [String: Task<Void, Never>] = [:]
    /// Push tokens by activity id, to end the gateway's registration.
    @ObservationIgnored private var tokens: [String: String] = [:]
    /// The newest state per activity. ActivityKit applies an update later, so
    /// reading it back would miss one sent a moment ago (a question just
    /// before the turn's end).
    @ObservationIgnored private var latest: [String: TurnActivityAttributes.ContentState] = [:]

    private var all: [Activity<TurnActivityAttributes>] { Activity<TurnActivityAttributes>.activities }

    func activity(for sessionId: String) -> Activity<TurnActivityAttributes>? {
        all.first { $0.attributes.sessionId == sessionId && $0.activityState != .ended && $0.activityState != .dismissed }
    }

    func isFollowing(_ sessionId: String) -> Bool { following.contains(sessionId) }

    /// Start one for a conversation whose turn is starting or running. One per
    /// conversation: a second call is a no-op.
    func follow(projectId: String, sessionId: String, title: String, project: String, provider: String,
                steps: Int = 0, activity: String? = nil, autopilot: AutopilotState? = nil) {
        guard available, self.activity(for: sessionId) == nil else { return }
        let attributes = TurnActivityAttributes(projectId: projectId, sessionId: sessionId, title: title, project: project, provider: provider)
        let state = TurnActivityAttributes.ContentState(
            status: "running", steps: steps, startedAt: Date().timeIntervalSince1970, activity: activity,
            autopilotLeft: autopilot?.remaining, autopilotCount: autopilot?.count)
        do {
            let a = try Activity.request(attributes: attributes, content: ActivityContent(state: state, staleDate: nil), pushType: .token)
            following.insert(sessionId)
            watch(a)
        } catch {
            // Turned off for the app, or too many running: the chat still works.
            NSLog("x056 Live Activity not started: %@", String(describing: error))
        }
    }

    /// Ends what the Lock Screen still shows as running for a conversation
    /// that is not: a push that never came (an older gateway, the app
    /// suspended before the turn's end). Its last outcome says how it ended.
    func reconcile(running: Set<String>, autopilot: Set<String>, outcome: (String, String) -> Outcome?) {
        // A minute's grace: a turn just sent may not show as running yet.
        let settled = Date().timeIntervalSince1970 - 60
        for a in all where a.activityState == .active && !a.content.state.isOver && a.content.state.startedAt < settled {
            let sid = a.attributes.sessionId
            guard !running.contains(sid), !autopilot.contains(sid) else { continue }
            let last = outcome(a.attributes.projectId, sid)
            let failed = last?.status == "failed" || last?.status == "parked"
            Task { await end(a, a.content.state, status: failed ? "failed" : last?.status == "stopped" ? "stopped" : "done", detail: failed ? last?.reason : nil) }
        }
    }

    /// Stop following: it leaves the Lock Screen at once.
    func unfollow(_ sessionId: String) async {
        for a in all where a.attributes.sessionId == sessionId {
            await end(a, a.content.state, immediately: true)
        }
    }

    /// Activities outlive the app's process: watch their tokens again on launch.
    func resume() {
        for a in all where a.activityState != .ended && a.activityState != .dismissed {
            following.insert(a.attributes.sessionId)
            if watchers[a.id] == nil { watch(a) }
        }
    }

    /// The event stream, while the app is open. Mirrors the gateway's rules.
    func apply(_ e: GatewayEvent, autopilot: AutopilotState?) {
        guard let sid = e.data["sessionId"]?.string, let a = activity(for: sid) else { return }
        var s = latest[a.id] ?? a.content.state
        let d = e.data
        switch e.kind {
        case "session_started":
            let keep = autopilot != nil && s.status == "running"
            s = .init(status: "running", steps: keep ? s.steps : 0, startedAt: keep ? s.startedAt : Date().timeIntervalSince1970,
                      autopilotLeft: autopilot?.remaining, autopilotCount: autopilot?.count)
        case "activity":
            guard d["parentToolUseId"] == nil || d["parentToolUseId"] == .null else { return }
            let label = d["label"]?.string ?? d["tool"]?.string ?? "Working"
            if d["status"]?.string == "start" {
                s.steps += 1
                s.activity = label
            } else if d["status"]?.string == "error" {
                s.activity = "Failed: " + label
            } else { return }
            s.status = "running"
        case "question":
            s.status = "waiting"
            s.activity = nil
            s.detail = d["question"]?.string
        case "autopilot":
            if d["active"]?.bool == true {
                s.autopilotLeft = d["remaining"]?.number.map(Int.init) ?? s.autopilotLeft
                s.autopilotCount = d["count"]?.number.map(Int.init) ?? s.autopilotCount
            } else if s.activity == "Next step in a moment" {
                Task { await end(a, s, status: d["reason"]?.string == "stopped" ? "stopped" : "done") }
                return
            } else { return }
        case "session_done":
            let status = d["status"]?.string
            let ended = status == "failed" || status == "parked" ? "failed" : status == "stopped" ? "stopped" : "done"
            if ended == "done", let left = autopilot?.remaining, left > 0 {
                s.activity = "Next step in a moment"
            } else if ended == "done", s.status == "waiting" {
                // It ended by asking something: that is what to show.
                Task { await end(a, s, status: "waiting") }
                return
            } else {
                Task { await end(a, s, status: ended, detail: ended == "done" ? nil : d["reason"]?.string) }
                return
            }
        case "session_error":
            Task { await end(a, s, status: "failed", detail: d["message"]?.string) }
            return
        default:
            return
        }
        let id = a.id
        latest[id] = s
        Task { await Self.deliver(id, s, ending: nil) }
    }

    /// ActivityKit's `update`/`end` run off the main actor and `Activity` is
    /// not Sendable, so only its id and the (Sendable) state cross over.
    private nonisolated static func deliver(_ id: String, _ s: TurnActivityAttributes.ContentState, ending policy: ActivityUIDismissalPolicy?) async {
        guard let a = Activity<TurnActivityAttributes>.activities.first(where: { $0.id == id }) else { return }
        let content = ActivityContent(state: s, staleDate: nil)
        if let policy { await a.end(content, dismissalPolicy: policy) } else { await a.update(content) }
    }

    private func end(_ a: Activity<TurnActivityAttributes>, _ state: TurnActivityAttributes.ContentState,
                     status: String? = nil, detail: String? = nil, immediately: Bool = false) async {
        var s = state
        if let status { s.status = status }
        s.endedAt = s.endedAt ?? Date().timeIntervalSince1970
        s.activity = nil
        if let detail { s.detail = detail }
        let policy: ActivityUIDismissalPolicy = immediately ? .immediate : .after(Date().addingTimeInterval(20 * 60))
        let id = a.id
        latest[id] = nil
        await Self.deliver(id, s, ending: policy)
        if let token = tokens.removeValue(forKey: id) {
            _ = try? await AppModel.shared.client?.post("/api/push/apns/activity/end", ActivityTokenBody(token: token))
        }
        watchers.removeValue(forKey: id)?.cancel()
        following.remove(a.attributes.sessionId)
    }

    private func watch(_ a: Activity<TurnActivityAttributes>) {
        let sid = a.attributes.sessionId
        let tokens = Task { [weak self] in
            for await data in a.pushTokenUpdates {
                let token = data.map { String(format: "%02x", $0) }.joined()
                await self?.register(a, token: token)
            }
        }
        // Ended by a push, or swiped away on the Lock Screen.
        let states = Task { [weak self] in
            for await state in a.activityStateUpdates where state == .ended || state == .dismissed {
                self?.following.remove(sid)
            }
        }
        watchers[a.id] = Task {
            await withTaskCancellationHandler {
                await tokens.value
                await states.value
            } onCancel: {
                tokens.cancel()
                states.cancel()
            }
        }
    }

    private func register(_ a: Activity<TurnActivityAttributes>, token: String) async {
        tokens[a.id] = token
        guard let client = AppModel.shared.client else { return }
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        let s = a.content.state
        let body = ActivityRegisterBody(token: token, env: env, projectId: a.attributes.projectId, sessionId: a.attributes.sessionId,
                                        content: .init(steps: s.steps, startedAt: s.startedAt, activity: s.activity))
        // A gateway without Live Activity pushes answers 404: the event
        // stream still updates it while the app is open.
        _ = try? await client.post("/api/push/apns/activity", body)
    }
}

struct ActivityRegisterBody: Encodable, Sendable {
    struct Seed: Encodable, Sendable {
        let steps: Int
        let startedAt: Double
        let activity: String?
    }
    let token: String
    let env: String
    let projectId: String
    let sessionId: String
    let content: Seed
}

struct ActivityTokenBody: Encodable, Sendable { let token: String }
