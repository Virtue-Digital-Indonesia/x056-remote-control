import Foundation

/// Markdown help for the composer's plain-text box: lists that carry on when
/// you press Return, a format toggle for the selection, and the spans to
/// style as you type. The box keeps plain Markdown source, so what you see
/// is what is sent. Pure, on UTF-16 offsets (`NSRange`), so the text view
/// applies the results as they are and the tests read them.
enum MarkdownEditing {
    /// Replace `range` with `text`, then select `selection` in the result.
    struct Edit: Equatable {
        var range: NSRange
        var text: String
        var selection: NSRange
    }

    // MARK: lists

    /// A line's list or quote marker: "  - ", "3. ", "- [x] ", "> ".
    struct Marker: Equatable {
        /// Everything before the item's words, indent included.
        var prefix: String
        /// What the next line starts with: the number one up, a task unchecked.
        var next: String
        var indent: String
        /// The item's number, for an ordered list.
        var number: Int?
    }

    static func marker(in line: String) -> Marker? {
        let c = Array(line)
        var i = 0
        while i < c.count, c[i] == " " || c[i] == "\t" { i += 1 }
        let indent = String(c[..<i])
        guard i < c.count, !isRule(line) else { return nil }
        if c[i] == ">" {
            var end = i + 1
            if end < c.count, c[end] == " " { end += 1 }
            return Marker(prefix: String(c[..<end]), next: indent + "> ", indent: indent, number: nil)
        }
        var head: String
        var number: Int?
        if "-*+•".contains(c[i]) {
            head = String(c[i])
            i += 1
        } else if c[i].isASCII, c[i].isNumber {
            var j = i
            while j < c.count, j - i < 9, c[j].isASCII, c[j].isNumber { j += 1 }
            guard j < c.count, c[j] == "." || c[j] == ")", let n = Int(String(c[i..<j])) else { return nil }
            number = n
            head = "\(n + 1)\(c[j])"
            i = j + 1
        } else {
            return nil
        }
        // A list marker is followed by a space: "-foo", "**" and "1.5" are not lists.
        var k = i
        while k < c.count, c[k] == " " || c[k] == "\t" { k += 1 }
        guard k > i else { return nil }
        let spacing = String(c[i..<k])
        var end = k
        var task = false
        if k + 2 < c.count, c[k] == "[", " xX".contains(c[k + 1]), c[k + 2] == "]" {
            var m = k + 3
            while m < c.count, c[m] == " " { m += 1 }
            if m > k + 3 || m == c.count { task = true; end = m }
        }
        return Marker(prefix: String(c[..<end]), next: indent + head + spacing + (task ? "[ ] " : ""), indent: indent, number: number)
    }

    /// "---", "* * *", "___": a rule, not a list.
    private static func isRule(_ line: String) -> Bool {
        let s = line.filter { $0 != " " && $0 != "\t" }
        guard s.count >= 3, let first = s.first, "-*_".contains(first) else { return false }
        return s.allSatisfy { $0 == first }
    }

    /// Return inside a list item starts the next item; Return on an empty
    /// item ends the list, as in Notes. Nil means an ordinary newline.
    static func returnKey(in text: String, selection: NSRange) -> Edit? {
        guard selection.length == 0 else { return nil }
        let ns = text as NSString
        let cursor = selection.location
        let line = lineRange(ns, at: cursor)
        guard let m = marker(in: ns.substring(with: line)) else { return nil }
        let prefixLength = m.prefix.utf16.count
        // The cursor inside the marker itself: a plain newline.
        guard cursor - line.location >= prefixLength else { return nil }
        let words = ns.substring(with: NSRange(location: line.location + prefixLength, length: line.length - prefixLength))
        if words.trimmingCharacters(in: .whitespaces).isEmpty {
            return Edit(range: line, text: "", selection: NSRange(location: line.location, length: 0))
        }
        let opened = "\n" + m.next
        guard let n = m.number else {
            return Edit(range: selection, text: opened, selection: NSRange(location: cursor + opened.utf16.count, length: 0))
        }
        // An ordered list renumbers the items below the new one. Deeper
        // lines between them (a nested list, a wrapped paragraph) stay.
        var replaced = ns.substring(with: NSRange(location: cursor, length: line.location + line.length - cursor))
        var end = line.location + line.length
        var next = n + 2
        var changed = false
        while end < ns.length {
            let below = lineRange(ns, at: end + 1)
            let belowText = ns.substring(with: below)
            let indent = belowText.prefix { $0 == " " || $0 == "\t" }
            if let bm = marker(in: belowText), bm.indent == m.indent, bm.number != nil {
                let rest = belowText.dropFirst(bm.indent.count)
                let renumbered = bm.indent + String(next) + rest.drop { $0.isASCII && $0.isNumber }
                replaced += "\n" + renumbered
                next += 1
                changed = changed || renumbered != belowText
            } else if indent.count > m.indent.count, !belowText.trimmingCharacters(in: .whitespaces).isEmpty {
                replaced += "\n" + belowText
            } else {
                break
            }
            end = below.location + below.length
        }
        guard changed else {
            return Edit(range: selection, text: opened, selection: NSRange(location: cursor + opened.utf16.count, length: 0))
        }
        return Edit(range: NSRange(location: cursor, length: end - cursor), text: opened + replaced,
                    selection: NSRange(location: cursor + opened.utf16.count, length: 0))
    }

    /// The line holding `offset`, without its line break.
    private static func lineRange(_ ns: NSString, at offset: Int) -> NSRange {
        let r = ns.lineRange(for: NSRange(location: min(offset, ns.length), length: 0))
        var end = r.location + r.length
        while end > r.location, [10, 13].contains(ns.character(at: end - 1)) { end -= 1 }
        return NSRange(location: r.location, length: end - r.location)
    }

    // MARK: formatting

    /// Bold, italic, code or strikethrough on the selection: wraps it, or
    /// unwraps it when it already has that format. With nothing selected it
    /// leaves the cursor between a new pair of markers.
    static func toggle(_ mark: String, in text: String, selection: NSRange) -> Edit {
        let ns = text as NSString
        let m = mark.utf16.count
        let sel = selection
        // Markers right outside the selection.
        if sel.location >= m, sel.location + sel.length + m <= ns.length,
           ns.substring(with: NSRange(location: sel.location - m, length: m)) == mark,
           ns.substring(with: NSRange(location: sel.location + sel.length, length: m)) == mark,
           holds(mark, before: run(of: mark, in: ns, endingAt: sel.location), after: run(of: mark, in: ns, startingAt: sel.location + sel.length)) {
            return Edit(range: NSRange(location: sel.location - m, length: sel.length + 2 * m), text: ns.substring(with: sel),
                        selection: NSRange(location: sel.location - m, length: sel.length))
        }
        let selected = ns.substring(with: sel) as NSString
        // Markers inside the selection.
        if sel.length > 2 * m, selected.hasPrefix(mark), selected.hasSuffix(mark),
           holds(mark, before: run(of: mark, in: selected, startingAt: 0), after: run(of: mark, in: selected, endingAt: selected.length)) {
            let inner = selected.substring(with: NSRange(location: m, length: sel.length - 2 * m))
            return Edit(range: sel, text: inner, selection: NSRange(location: sel.location, length: inner.utf16.count))
        }
        // Spaces at the ends stay outside: "**word** ", never "**word **".
        let s = selected as String
        let lead = String(s.prefix { $0.isWhitespace }), trail = String(s.reversed().prefix { $0.isWhitespace }.reversed())
        let core = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !core.isEmpty else {
            return Edit(range: sel, text: s + mark + mark, selection: NSRange(location: sel.location + s.utf16.count + m, length: 0))
        }
        return Edit(range: sel, text: lead + mark + core + mark + trail,
                    selection: NSRange(location: sel.location + lead.utf16.count + m, length: core.utf16.count))
    }

    /// Whether runs of a marker's character on both sides carry that marker:
    /// a single `*` is italic only on an odd run, since `**` is bold.
    private static func holds(_ mark: String, before: Int, after: Int) -> Bool {
        let m = mark.utf16.count
        guard before >= m, after >= m else { return false }
        return m > 1 || (before % 2 == 1 && after % 2 == 1)
    }

    private static func run(of mark: String, in ns: NSString, endingAt end: Int) -> Int {
        guard let ch = mark.utf16.first else { return 0 }
        var i = end
        while i > 0, ns.character(at: i - 1) == ch { i -= 1 }
        return end - i
    }

    private static func run(of mark: String, in ns: NSString, startingAt start: Int) -> Int {
        guard let ch = mark.utf16.first else { return 0 }
        var i = start
        while i < ns.length, ns.character(at: i) == ch { i += 1 }
        return i - start
    }

    // MARK: styling

    enum Style: Equatable {
        /// `**`, `#`, `>`: shown, but faint.
        case marker
        /// `-`, `1.`, `- [ ]`.
        case listMarker
        case bold, italic, strike, code, codeBlock, heading, quote, link
    }

    struct Span: Equatable {
        var range: NSRange
        var style: Style
    }

    /// What to style, in the order to apply it: a line's own style first,
    /// then what is inside it, markers last so they stay faint.
    static func spans(_ text: String) -> [Span] {
        let ns = text as NSString
        var out: [Span] = []
        var inFence = false
        ns.enumerateSubstrings(in: NSRange(location: 0, length: ns.length), options: [.byLines, .substringNotRequired]) { _, line, _, _ in
            let s = ns.substring(with: line)
            let trimmed = s.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                inFence.toggle()
                out.append(Span(range: line, style: .codeBlock))
                out.append(Span(range: line, style: .marker))
                return
            }
            if inFence {
                if line.length > 0 { out.append(Span(range: line, style: .codeBlock)) }
                return
            }
            if line.length == 0 { return }
            if isRule(s) {
                out.append(Span(range: line, style: .marker))
                return
            }
            var content = line
            if let h = firstMatch(heading, in: ns, range: line) {
                let marks = h.range(at: 0)
                content = NSRange(location: marks.location + marks.length, length: line.location + line.length - marks.location - marks.length)
                if content.length > 0 { out.append(Span(range: content, style: .heading)) }
                out.append(Span(range: marks, style: .marker))
            } else if let q = firstMatch(quote, in: ns, range: line) {
                let marks = q.range(at: 0)
                content = NSRange(location: marks.location + marks.length, length: line.location + line.length - marks.location - marks.length)
                if content.length > 0 { out.append(Span(range: content, style: .quote)) }
                out.append(Span(range: marks, style: .marker))
            } else if let m = marker(in: s) {
                let indent = m.indent.utf16.count, length = m.prefix.utf16.count
                out.append(Span(range: NSRange(location: line.location + indent, length: length - indent), style: .listMarker))
                content = NSRange(location: line.location + length, length: line.length - length)
            }
            if content.length > 0 { out += inline(ns, content) }
        }
        return out
    }

    private static func inline(_ ns: NSString, _ range: NSRange) -> [Span] {
        var out: [Span] = []
        var code: [NSRange] = []
        for m in codeSpan.matches(in: ns as String, range: range) {
            let ticks = m.range(at: 1).length
            let whole = m.range
            code.append(whole)
            out.append(Span(range: whole, style: .code))
            out.append(Span(range: NSRange(location: whole.location, length: ticks), style: .marker))
            out.append(Span(range: NSRange(location: whole.location + whole.length - ticks, length: ticks), style: .marker))
        }
        func free(_ r: NSRange) -> Bool { !code.contains { NSIntersectionRange($0, r).length > 0 } }
        for (regex, style, marks) in [(bold, Style.bold, 2), (strike, .strike, 2), (italicStar, .italic, 1), (italicUnderscore, .italic, 1)] {
            for m in regex.matches(in: ns as String, range: range) where free(m.range) {
                let whole = m.range
                out.append(Span(range: whole, style: style))
                out.append(Span(range: NSRange(location: whole.location, length: marks), style: .marker))
                out.append(Span(range: NSRange(location: whole.location + whole.length - marks, length: marks), style: .marker))
            }
        }
        for m in link.matches(in: ns as String, range: range) where free(m.range) {
            let label = m.range(at: 1), whole = m.range
            out.append(Span(range: label, style: .link))
            out.append(Span(range: NSRange(location: whole.location, length: 1), style: .marker))
            let tail = label.location + label.length
            out.append(Span(range: NSRange(location: tail, length: whole.location + whole.length - tail), style: .marker))
        }
        return out
    }

    private static func firstMatch(_ regex: NSRegularExpression, in ns: NSString, range: NSRange) -> NSTextCheckingResult? {
        regex.firstMatch(in: ns as String, range: range)
    }

    // Patterns run on one line at a time, so `^` is the line's start.
    private static let heading = try! NSRegularExpression(pattern: #"^[ \t]{0,3}#{1,6}[ \t]+"#)
    private static let quote = try! NSRegularExpression(pattern: #"^[ \t]*(?:>[ \t]?)+"#)
    private static let codeSpan = try! NSRegularExpression(pattern: #"(`+)(?!`)(.+?)(?<!`)\1(?!`)"#)
    private static let bold = try! NSRegularExpression(pattern: #"(\*\*|__)(?=\S)(.+?)(?<=\S)\1"#)
    private static let strike = try! NSRegularExpression(pattern: #"~~(?=\S)(.+?)(?<=\S)~~"#)
    private static let italicStar = try! NSRegularExpression(pattern: #"(?<![*\\])\*(?![\s*])(.+?)(?<![\s*\\])\*(?!\*)"#)
    private static let italicUnderscore = try! NSRegularExpression(pattern: #"(?<![\w_])_(?![\s_])(.+?)(?<![\s_])_(?![\w_])"#)
    private static let link = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\(([^)\s]+)\)"#)
}
