import Foundation

// Shapes of the gateway's JSON, as the web panel reads them. Every field the
// server may omit is optional: a missing key must never fail a whole list.

/// Any JSON value. SSE event payloads differ per `kind`, so the envelope keeps
/// `data` generic and each handler reads the fields it needs.
enum JSONValue: Codable, Sendable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let b): try c.encode(b)
        case .number(let n): try c.encode(n)
        case .string(let s): try c.encode(s)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }

    subscript(_ key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? { if case .string(let s) = self { return s }; return nil }
    var bool: Bool? { if case .bool(let b) = self { return b }; return nil }
    var number: Double? { if case .number(let n) = self { return n }; return nil }

    /// Re-decode this value as a concrete type.
    func decode<T: Decodable>(_ type: T.Type) -> T? {
        guard let data = try? JSONEncoder().encode(self) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}

/// One SSE envelope: `data: {"seq","ts","kind","data"}`.
struct GatewayEvent: Decodable, Sendable {
    let seq: Int
    let ts: String?
    let kind: String
    let data: JSONValue
}

struct AuthStatus: Decodable, Sendable { let authed: Bool? }

struct ProjectsResponse: Decodable, Sendable {
    let current: String?
    let projects: [Project]
}

struct Project: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    var name: String
    var cwd: String?
    var kind: String?
    var provider: String?
    var model: String?
    var effort: String?
    var lastSessionId: String?
    var archivedAt: Double?
    var conversations: [Conversation]?
    var running: Bool?
    var runningSessionIds: [String]?
    var runningAccounts: [String: String]?
    var backgroundSessionIds: [String]?

    var isChat: Bool { kind == "chat" }
    var providerName: String { provider ?? "claude" }
}

struct Conversation: Codable, Sendable, Identifiable, Hashable {
    var id: String { sessionId }
    let sessionId: String
    var title: String
    var createdAt: Double?
    var lastMessageAt: Double?
    var model: String?
    var effort: String?
    var provider: String?
    var lastOutcome: Outcome?

    /// Epoch ms of the last activity, for sorting.
    var recency: Double { lastMessageAt ?? createdAt ?? 0 }
}

struct Outcome: Codable, Sendable, Hashable {
    let status: String
    let at: String?
    let reason: String?
}

struct HistoryPage: Decodable, Sendable {
    let rows: [HistoryEntry]
    let cursor: Int?
    let done: Bool?
}

struct HistoryEntry: Decodable, Sendable {
    let role: String
    let text: String?
    let ts: String?
    let messageId: String?
    let attachments: [AttachmentRef]?
    let sender: Sender?
    let detail: String?
    let sub: Bool?
    let args: String?
    let advisor: JSONValue?
}

struct AttachmentRef: Codable, Sendable, Hashable {
    let name: String?
    let type: String?
    let url: String

    var isImage: Bool { (type ?? "").hasPrefix("image/") }
}

struct Sender: Codable, Sendable, Hashable {
    let kind: String?
    let projectName: String?
    let conversationTitle: String?
}

/// `{sessionId}` without a requestId, a DeliveryReceipt with one.
struct SendReply: Decodable, Sendable {
    let sessionId: String?
    let requestId: String?
    let status: String?
    let id: String?
    let error: String?
}

struct ActivityEvent: Decodable, Sendable {
    let toolUseId: String
    let parentToolUseId: String?
    let tool: String?
    let label: String?
    let detail: String?
    let status: String
    let isSubagent: Bool?
}

struct QueueItem: Decodable, Sendable, Identifiable, Hashable {
    let id: String
    let text: String
    let at: Double?
    let sessionId: String?
    let paused: Bool?
    let dispatching: Bool?
    let error: String?
}

struct QuestionPart: Decodable, Sendable, Hashable {
    let question: String
    let options: [String]?
}

struct PendingQuestion: Decodable, Sendable, Hashable {
    let projectId: String
    let sessionId: String
    let question: String
    let options: [String]?
    let questions: [QuestionPart]?
    let at: String

    /// The parts to render: `questions` when the model asked several.
    var parts: [QuestionPart] {
        if let questions, questions.count > 1 { return questions }
        return [QuestionPart(question: question, options: options)]
    }
}

struct McpApproval: Decodable, Sendable, Identifiable, Hashable {
    struct Review: Decodable, Sendable, Hashable { let operationId: String; let reason: String? }
    let id: String
    let projectId: String
    let projectName: String?
    let targetLabel: String?
    let message: String
    let sessionId: String?
    let createdAt: String?
    let status: String
    let sender: Sender?
    let contextReview: Review?
}

struct Account: Decodable, Sendable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let label: String?
    let provider: String?
    let providerLabel: String?
    let displayName: String?
    let email: String?
    let paused: Bool?
    let active: Bool?
    let nextUp: Bool?
    let state: AccountState?
    let quota: Usage?
    let quotaError: String?
    let quotaStale: Bool?
}

struct AccountState: Decodable, Sendable, Hashable {
    let kind: String
    /// Epoch SECONDS, unlike every other timestamp here.
    let until: Double?
    let estimated: Bool?
}

struct Usage: Decodable, Sendable, Hashable {
    struct Window: Decodable, Sendable, Hashable { let utilization: Double; let resetsAt: String? }
    struct Labeled: Decodable, Sendable, Hashable { let label: String; let utilization: Double; let resetsAt: String? }
    let fiveHour: Window?
    let sevenDay: Window?
    let weeklyScoped: [Labeled]?
    let windows: [Labeled]?
}

struct CodexModel: Decodable, Sendable, Hashable {
    let slug: String
    let label: String
    let efforts: [String]?
    let defaultEffort: String?
}

struct ModelsResponse: Decodable, Sendable {
    let codex: [CodexModel]?
}

struct ApnsStatus: Decodable, Sendable {
    struct Device: Decodable, Sendable, Hashable { let env: String; let name: String?; let at: Double; let token: String }
    let configured: Bool
    let bundleId: String?
    let devices: [Device]
}

struct ApnsTestReply: Decodable, Sendable {
    struct Result: Decodable, Sendable, Hashable { let token: String; let env: String; let status: Int; let reason: String? }
    let configured: Bool
    let results: [Result]
}

struct OK: Decodable, Sendable { let ok: Bool? }

// MARK: request bodies

struct UploadAttachment: Encodable, Sendable {
    let name: String
    let data: String
}

struct SendBody: Encodable, Sendable {
    let prompt: String
    let projectId: String
    var sessionId: String?
    var model: String?
    var effort: String?
    let requestId: String
    var attachments: [UploadAttachment]?
}

struct ConversationRef: Encodable, Sendable {
    let projectId: String
    let sessionId: String
}

struct HaltBody: Encodable, Sendable {
    let projectId: String
    let sessionId: String
    let dropQueued: Bool
}

struct PreferencesBody: Encodable, Sendable {
    let projectId: String
    let sessionId: String
    let model: String
    let effort: String
}

struct QueueRemoveBody: Encodable, Sendable {
    let projectId: String
    let id: String
}

struct DismissQuestionBody: Encodable, Sendable {
    let projectId: String
    let sessionId: String
    let at: String
}

struct DecideBody: Encodable, Sendable {
    let id: String
    let approve: Bool
    var reviewedOperationId: String?
}

struct ApnsRegisterBody: Encodable, Sendable {
    let token: String
    let env: String
    let name: String?
}

struct ApnsUnregisterBody: Encodable, Sendable {
    let token: String
}

struct Empty: Encodable, Sendable {}
