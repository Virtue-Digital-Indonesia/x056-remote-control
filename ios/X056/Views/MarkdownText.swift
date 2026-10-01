import SwiftUI

/// Enough Markdown for an assistant reply: fenced code blocks as their own
/// scrollable monospace boxes, headings, and everything else through
/// AttributedString's inline Markdown (bold, italic, code, links), with line
/// breaks kept.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(Self.blocks(text).enumerated()), id: \.offset) { _, block in
                switch block {
                case .code(let lang, let code):
                    CodeBlock(language: lang, code: code)
                case .heading(let level, let line):
                    Text(Self.inline(line))
                        .font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
                case .prose(let prose):
                    Text(Self.inline(prose))
                        .textSelection(.enabled)
                }
            }
        }
    }

    enum Block {
        case prose(String)
        case heading(Int, String)
        case code(String, String)
    }

    nonisolated static func blocks(_ text: String) -> [Block] {
        var out: [Block] = []
        var prose: [String] = []
        var code: [String]? = nil
        var lang = ""
        func flush() {
            let joined = prose.joined(separator: "\n").trimmingCharacters(in: .newlines)
            if !joined.isEmpty { out.append(.prose(joined)) }
            prose = []
        }
        for raw in text.components(separatedBy: "\n") {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if let open = code {
                    out.append(.code(lang, open.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    code = []
                }
                continue
            }
            if code != nil { code!.append(raw); continue }
            if let h = heading(trimmed) {
                flush()
                out.append(h)
                continue
            }
            prose.append(raw)
        }
        if let open = code { out.append(.code(lang, open.joined(separator: "\n"))) } // unterminated while streaming
        flush()
        return out
    }

    private nonisolated static func heading(_ line: String) -> Block? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes), line.dropFirst(hashes).hasPrefix(" ") else { return nil }
        return .heading(hashes, String(line.dropFirst(hashes + 1)))
    }

    nonisolated static func inline(_ s: String) -> AttributedString {
        let opts = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: s, options: opts)) ?? AttributedString(s)
    }
}

struct CodeBlock: View {
    let language: String
    let code: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !language.isEmpty {
                Text(language).font(.caption2).foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
