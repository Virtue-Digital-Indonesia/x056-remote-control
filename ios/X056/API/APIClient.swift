import Foundation

struct APIError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { status == 401 ? "The gateway rejected the token." : message }
}

/// Thin JSON client for the gateway. Every route takes the X056 token as a
/// Bearer header, the first thing `AuthGuard` checks.
struct APIClient: Sendable {
    let baseURL: URL
    let token: String

    func url(_ path: String, query: [String: String?] = [:]) -> URL {
        var c = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { k, v in v.map { URLQueryItem(name: k, value: $0) } }
        if !items.isEmpty { c.queryItems = items.sorted { $0.name < $1.name } }
        return c.url!
    }

    func request(_ method: String, _ path: String, query: [String: String?] = [:], body: Data? = nil, timeout: TimeInterval = 30) -> URLRequest {
        var r = URLRequest(url: url(path, query: query), timeoutInterval: timeout)
        r.httpMethod = method
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.httpBody = body
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        return r
    }

    func get<T: Decodable & Sendable>(_ path: String, query: [String: String?] = [:], as: T.Type = T.self) async throws -> T {
        try await send(request("GET", path, query: query))
    }

    func post<T: Decodable & Sendable>(_ path: String, _ body: some Encodable & Sendable, as: T.Type = T.self) async throws -> T {
        try await send(request("POST", path, body: try JSONEncoder().encode(body)))
    }

    @discardableResult
    func post(_ path: String, _ body: some Encodable & Sendable) async throws -> Data {
        try await raw(request("POST", path, body: try JSONEncoder().encode(body)))
    }

    func send<T: Decodable & Sendable>(_ req: URLRequest) async throws -> T {
        let data = try await raw(req)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(status: 0, message: "Unexpected reply from \(req.url?.path() ?? "gateway"): \(error)")
        }
    }

    func raw(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await URLSession.shared.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw APIError(status: status, message: Self.errorMessage(data) ?? "HTTP \(status)")
        }
        return data
    }

    /// NestJS errors are `{ statusCode, message }`; `message` may be an array.
    static func errorMessage(_ data: Data) -> String? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let m = obj["message"] as? String { return m }
        if let m = obj["message"] as? [String] { return m.joined(separator: "; ") }
        return obj["error"] as? String
    }
}
