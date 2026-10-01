import SwiftUI

/// Enough Markdown for an assistant reply: fenced code blocks as their own
/// scrollable monospace boxes, headings, tables, and everything else through
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
                case .table(let header, let rows):
                    TableBlock(header: header, rows: rows)
                }
            }
        }
    }

    enum Block {
        case prose(String)
        case heading(Int, String)
        case code(String, String)
        case table([String], [[String]])
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
        let lines = text.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let raw = lines[i]
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            i += 1
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
            // A table: a row of cells, then a |---|---| line under it.
            if trimmed.contains("|"), i < lines.count, isTableRule(lines[i]) {
                flush()
                let header = cells(trimmed)
                var rows: [[String]] = []
                i += 1
                while i < lines.count {
                    let row = lines[i].trimmingCharacters(in: .whitespaces)
                    guard row.contains("|") else { break }
                    rows.append(cells(row))
                    i += 1
                }
                out.append(.table(header, rows))
                continue
            }
            prose.append(raw)
        }
        if let open = code { out.append(.code(lang, open.joined(separator: "\n"))) } // unterminated while streaming
        flush()
        return out
    }

    private nonisolated static func isTableRule(_ line: String) -> Bool {
        let parts = cells(line.trimmingCharacters(in: .whitespaces))
        return !parts.isEmpty && parts.allSatisfy { cell in
            var c = Substring(cell)
            if c.hasPrefix(":") { c = c.dropFirst() }
            if c.hasSuffix(":") { c = c.dropLast() }
            return !c.isEmpty && c.allSatisfy { $0 == "-" }
        }
    }

    /// A row's cells: the outer pipes dropped, `\|` kept as a literal pipe.
    nonisolated static func cells(_ line: String) -> [String] {
        var row = Substring(line)
        if row.hasPrefix("|") { row = row.dropFirst() }
        if row.hasSuffix("|") && !row.hasSuffix("\\|") { row = row.dropLast() }
        var out: [String] = [], cell = "", escaped = false
        for ch in row {
            if escaped { cell.append(ch); escaped = false; continue }
            if ch == "\\" { escaped = true; continue }
            if ch == "|" { out.append(cell.trimmingCharacters(in: .whitespaces)); cell = ""; continue }
            cell.append(ch)
        }
        if escaped { cell.append("\\") }
        out.append(cell.trimmingCharacters(in: .whitespaces))
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

/// A Markdown table: sideways scrolling when it is wider than the screen,
/// each column as wide as its short cells and capped so long ones wrap.
struct TableBlock: View {
    let header: [String]
    let rows: [[String]]

    var body: some View {
        let widths = columnWidths
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(header.indices, id: \.self) { c in
                        cell(header[c], width: widths[c]).fontWeight(.semibold)
                    }
                }
                .background(Color(.tertiarySystemFill))
                ForEach(rows.indices, id: \.self) { r in
                    Divider()
                    GridRow {
                        ForEach(header.indices, id: \.self) { c in
                            cell(c < rows[r].count ? rows[r][c] : "", width: widths[c])
                        }
                    }
                }
            }
            .clipShape(.rect(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(.quaternary))
        }
        .textSelection(.enabled)
    }

    private func cell(_ text: String, width: CGFloat) -> some View {
        Text(MarkdownText.inline(text))
            .font(.subheadline)
            .fixedSize(horizontal: false, vertical: true)
            .frame(width: width, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
    }

    private var columnWidths: [CGFloat] {
        header.indices.map { c in
            let column = [header[c]] + rows.map { c < $0.count ? $0[c] : "" }
            let longest = column.map { $0.filter { !"*`_".contains($0) }.count }.max() ?? 0
            return min(max(CGFloat(longest) * 7.5, 60), 220)
        }
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
