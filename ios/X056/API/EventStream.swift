import Foundation

/// One Server-Sent Event as the gateway writes it.
struct ServerEvent: Sendable {
    var id: String?
    var event: String?
    var data: String
}

/// Incremental SSE parser. Fed raw bytes, not `bytes.lines`: that sequence drops
/// empty lines, and an empty line is what ends an event.
struct SSEParser {
    private var buffer = Data()
    private var id: String?
    private var event: String?
    private var data: [String] = []

    mutating func feed(_ byte: UInt8) -> ServerEvent? {
        guard byte == 0x0A else {
            buffer.append(byte)
            return nil
        }
        var line = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll(keepingCapacity: true)
        if line.hasSuffix("\r") { line.removeLast() }
        return take(line)
    }

    private mutating func take(_ line: String) -> ServerEvent? {
        if line.isEmpty {
            defer { id = nil; event = nil; data = [] }
            guard !data.isEmpty else { return nil }
            return ServerEvent(id: id, event: event, data: data.joined(separator: "\n"))
        }
        if line.hasPrefix(":") { return nil } // comment / keep-alive
        let field: Substring
        var value: Substring = ""
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
        }
        switch field {
        case "data": data.append(String(value))
        case "event": event = String(value)
        case "id": id = String(value)
        default: break
        }
        return nil
    }
}
