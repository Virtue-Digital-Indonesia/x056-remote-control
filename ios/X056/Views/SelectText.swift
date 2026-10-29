import SwiftUI
import UIKit

extension View {
    /// A message's long-press menu: Copy takes all of it, Select Text opens it
    /// with selection handles to copy a part (SwiftUI text on iOS selects all
    /// or nothing). `markdown`: shown as the reply looks, so a copied part
    /// carries no Markdown marks.
    func messageMenu(_ text: String, markdown: Bool = false) -> some View {
        modifier(MessageMenu(text: text, markdown: markdown))
    }
}

private struct MessageMenu: ViewModifier {
    let text: String
    let markdown: Bool
    @State private var selecting = false

    func body(content: Content) -> some View {
        content
            .contextMenu {
                CopyButton(text: text)
                Button("Select Text", systemImage: "text.cursor") { selecting = true }
            }
            .sheet(isPresented: $selecting) { SelectTextSheet(text: text, markdown: markdown) }
    }
}

/// One message on its own, all of it selected, to copy just a part.
struct SelectTextSheet: View {
    let text: String
    let markdown: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var selected = ""

    var body: some View {
        let shown = markdown ? SelectableText.rendered(text) : SelectableText.plain(text)
        NavigationStack {
            SelectableText(text: shown, selected: $selected)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle("Select Text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(selected.isEmpty ? "Copy All" : "Copy") {
                            UIPasteboard.general.string = selected.isEmpty ? shown.string : selected
                            dismiss()
                        }
                    }
                }
        }
        .presentationDetents([.large])
    }
}

/// A read-only text view: drag the handles, then Copy (here or in the
/// edit menu). It opens with everything selected.
struct SelectableText: UIViewRepresentable {
    let text: NSAttributedString
    @Binding var selected: String

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .systemBackground
        view.textContainerInset = UIEdgeInsets(top: 16, left: 14, bottom: 32, right: 14)
        view.alwaysBounceVertical = true
        view.accessibilityIdentifier = "select-text"
        view.delegate = context.coordinator
        view.attributedText = text
        DispatchQueue.main.async {
            view.becomeFirstResponder()
            view.selectedRange = NSRange(location: 0, length: view.attributedText.length)
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.selected = $selected
    }

    func makeCoordinator() -> Coordinator { Coordinator(selected: $selected) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var selected: Binding<String>

        init(selected: Binding<String>) { self.selected = selected }

        func textViewDidChangeSelection(_ view: UITextView) {
            let range = view.selectedRange
            let part = range.length > 0 ? (view.text as NSString).substring(with: range) : ""
            // Not inside SwiftUI's update of this view.
            DispatchQueue.main.async { [selected] in selected.wrappedValue = part }
        }
    }

    static func plain(_ text: String) -> NSAttributedString {
        NSAttributedString(string: text, attributes: [.font: UIFont.preferredFont(forTextStyle: .body), .foregroundColor: UIColor.label])
    }

    /// The reply as MarkdownText draws it: headings bold, code monospaced,
    /// tables a tab between cells (so a pasted row lands in columns), and
    /// bold, italic, inline code and links inside the prose.
    static func rendered(_ text: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let body = UIFont.preferredFont(forTextStyle: .body)
        let mono = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        func add(_ s: NSAttributedString) {
            if out.length > 0 { out.append(NSAttributedString(string: "\n\n", attributes: [.font: body])) }
            out.append(s)
        }
        for block in MarkdownText.blocks(text) {
            switch block {
            case .prose(let prose):
                add(inline(prose, font: body))
            case .heading(let level, let line):
                let style: UIFont.TextStyle = level == 1 ? .title3 : level == 2 ? .headline : .subheadline
                add(inline(line, font: bold(.preferredFont(forTextStyle: style))))
            case .code(_, let code):
                add(NSAttributedString(string: code, attributes: [.font: mono, .foregroundColor: UIColor.label, .backgroundColor: UIColor.secondarySystemBackground]))
            case .table(let header, let rows):
                let font = UIFont.preferredFont(forTextStyle: .subheadline)
                let table = NSMutableAttributedString()
                for (r, row) in ([header] + rows).enumerated() {
                    if r > 0 { table.append(NSAttributedString(string: "\n", attributes: [.font: font])) }
                    for (c, cell) in row.enumerated() {
                        if c > 0 { table.append(NSAttributedString(string: "\t", attributes: [.font: font])) }
                        table.append(inline(cell, font: r == 0 ? bold(font) : font))
                    }
                }
                add(table)
            }
        }
        return out
    }

    private static func inline(_ s: String, font: UIFont) -> NSAttributedString {
        let parsed = MarkdownText.inline(s)
        let out = NSMutableAttributedString()
        for run in parsed.runs {
            let piece = String(parsed[run.range].characters)
            let intent = run.inlinePresentationIntent ?? []
            var f = font
            if intent.contains(.code) {
                f = .monospacedSystemFont(ofSize: font.pointSize * 0.92, weight: intent.contains(.stronglyEmphasized) ? .semibold : .regular)
            } else {
                var traits = f.fontDescriptor.symbolicTraits
                if intent.contains(.stronglyEmphasized) { traits.insert(.traitBold) }
                if intent.contains(.emphasized) { traits.insert(.traitItalic) }
                if let d = f.fontDescriptor.withSymbolicTraits(traits) { f = UIFont(descriptor: d, size: 0) }
            }
            var attrs: [NSAttributedString.Key: Any] = [.font: f, .foregroundColor: UIColor.label]
            if intent.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            if let link = run.link { attrs[.link] = link }
            out.append(NSAttributedString(string: piece, attributes: attrs))
        }
        return out
    }

    private static func bold(_ font: UIFont) -> UIFont {
        font.fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: 0) } ?? font
    }
}
