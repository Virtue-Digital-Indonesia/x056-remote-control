import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A file waiting to go out with the next message: a photo, a pasted or
/// picked file, or long pasted text turned into a .txt.
struct PendingFile: Identifiable, Hashable {
    let id = UUID()
    var name: String
    var data: Data
    var mime: String

    var isImage: Bool { mime.hasPrefix("image/") }
    var image: UIImage? { isImage ? UIImage(data: data) : nil }
    var sizeLabel: String { ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file) }

    /// The `attachments` entry the gateway saves to disk for the model to Read.
    var upload: UploadAttachment {
        UploadAttachment(name: name, data: "data:\(mime);base64," + data.base64EncodedString())
    }

    static func photo(_ image: UIImage, index: Int) -> PendingFile? {
        guard let data = image.jpegForUpload() else { return nil }
        return PendingFile(name: "photo-\(index).jpg", data: data, mime: "image/jpeg")
    }

    static func text(_ text: String) -> PendingFile {
        let stamp = Date().formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false).dateTimeSeparator(.standard))
            .replacingOccurrences(of: ":", with: "")
        return PendingFile(name: "pasted-text-\(stamp).txt", data: Data(text.utf8), mime: "text/plain")
    }

    static func mime(for type: UTType?, fallbackName: String) -> String {
        type?.preferredMIMEType ?? UTType(filenameExtension: (fallbackName as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}

extension EnvironmentValues {
    /// The composer is folded away. Its UIKit text view hides too: SwiftUI's
    /// hiding on the container does not reach it, so it stayed in the
    /// accessibility tree and kept the keyboard.
    @Entry var composerFolded = false
}

/// The composer's text area: a UITextView, because SwiftUI's TextField
/// cannot take a pasted image or file. A paste of images or files becomes
/// attachments; a paste of text longer than `longTextLimit` becomes a .txt
/// attachment; anything else pastes as text.
///
/// It holds Markdown source and shows it styled as you type (markers stay,
/// faint). Return carries a list on, Return on an empty item ends it, and
/// Format in the edit menu (or ⌘B, ⌘I, ⌘⇧C) wraps the selection. Return
/// is a newline, never a send: the send button sends.
struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var longTextLimit: Int
    var maxLines = 8
    var identifier = "composer"
    /// Set while the text view has the keyboard.
    var editing: Binding<Bool>? = nil
    var onPaste: ([PendingFile]) -> Void

    func makeUIView(context: Context) -> PasteAwareTextView {
        let view = PasteAwareTextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        view.textContainer.lineFragmentPadding = 4
        view.isScrollEnabled = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.returnKeyType = .default
        view.accessibilityIdentifier = identifier
        return view
    }

    func updateUIView(_ view: PasteAwareTextView, context: Context) {
        // The binding usually holds the very string the view last reported,
        // so this is an identity check, not a read and compare of the text.
        if text != context.coordinator.reported {
            view.text = text
            context.coordinator.reported = text
            context.coordinator.measure = true
            MarkdownStyler.style(view)
        }
        view.placeholder = placeholder
        view.longTextLimit = longTextLimit
        view.onPaste = onPaste
        view.isHidden = context.environment.composerFolded
        if view.isHidden, view.isFirstResponder { view.resignFirstResponder() }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PasteAwareTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 280
        let line = UIFont.preferredFont(forTextStyle: .body).lineHeight
        let cap = line * CGFloat(maxLines) + view.textContainerInset.top + view.textContainerInset.bottom
        // Past the cap the box stays at the cap while the text grows: laying
        // out the whole text again on every keystroke is what made a long
        // message lag. A shorter text (or a new width) measures again.
        let coordinator = context.coordinator
        if view.isScrollEnabled, !coordinator.measure, view.contentSize.height > cap, abs(view.bounds.width - width) < 0.5 {
            return CGSize(width: width, height: cap)
        }
        coordinator.measure = false
        let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        view.isScrollEnabled = fitted.height > cap
        return CGSize(width: width, height: min(fitted.height, cap))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, editing: editing) }

    final class Coordinator: NSObject, UITextViewDelegate {
        let text: Binding<String>
        let editing: Binding<Bool>?
        /// The text last handed to the binding.
        var reported = ""
        /// Measure the full text on the next size pass (it may have shrunk).
        var measure = true
        /// What the coming change touches, for styling only those lines.
        private var edited: NSRange?
        private var wholeText = false

        init(text: Binding<String>, editing: Binding<Bool>?) {
            self.text = text
            self.editing = editing
        }

        func textViewDidBeginEditing(_ view: UITextView) { editing?.wrappedValue = true }
        func textViewDidEndEditing(_ view: UITextView) { editing?.wrappedValue = false }

        func textViewDidChange(_ view: UITextView) {
            let now = view.text ?? ""
            if now.utf8.count < reported.utf8.count { measure = true }
            reported = now
            text.wrappedValue = now
            MarkdownStyler.style(view, edited: wholeText ? nil : edited)
            edited = nil
            wholeText = false
            view.invalidateIntrinsicContentSize()
            (view as? PasteAwareTextView)?.textChanged()
        }

        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText string: String) -> Bool {
            // Return inside a list starts the next item, or ends the list on an empty one.
            if string == "\n", view.markedTextRange == nil, let view = view as? PasteAwareTextView,
               let edit = MarkdownEditing.returnKey(in: view.text, selection: range) {
                view.apply(edit)
                return false
            }
            // A code fence changes how every line below it reads, so an edit
            // to a fence line restyles the whole text; others, their lines.
            let ns = view.textStorage.mutableString
            let before = ns.substring(with: ns.paragraphRange(for: range))
            wholeText = MarkdownStyler.hasFence(before) || MarkdownStyler.hasFence(string)
            edited = NSRange(location: range.location, length: (string as NSString).length)
            return true
        }

        func textView(_ view: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            guard let view = view as? PasteAwareTextView, view.isEditable else { return nil }
            let format = UIMenu(title: "Format", image: UIImage(systemName: "textformat"), children: PasteAwareTextView.formats.map { f in
                UIAction(title: f.title, image: UIImage(systemName: f.icon)) { [weak view] _ in view?.toggleMarkdown(f.mark) }
            })
            return UIMenu(children: suggestedActions + [format])
        }
    }
}

/// Paints the box's Markdown: bold and italic in place, code in a mono face,
/// headings bold, list markers in the accent, every other marker faint.
/// Sizes stay the body size, so lines do not jump as you type.
@MainActor enum MarkdownStyler {
    private static let accent = UIColor(Palette.clay)
    private static let keys: [NSAttributedString.Key] = [.font, .foregroundColor, .backgroundColor, .strikethroughStyle]

    /// Texts shorter than this restyle whole on each change; it is cheap.
    private static let wholeTextLimit = 1500

    /// Works out the styled text aside, then touches only the runs whose
    /// style changed: plain typing changes nothing, and an attribute edit
    /// under the keyboard on every keystroke dropped fast typing. In a long
    /// text only the lines `edited` touched are worked out again.
    static func style(_ view: UITextView, edited: NSRange? = nil) {
        // Mid-composition (Japanese, Chinese, dictation): restyle once it is committed.
        guard view.markedTextRange == nil else { return }
        let storage = view.textStorage
        let ns = storage.mutableString
        let base = UIFont.preferredFont(forTextStyle: .body)
        let plain: [NSAttributedString.Key: Any] = [.font: base, .foregroundColor: UIColor.label]
        view.typingAttributes = plain
        var range = NSRange(location: 0, length: ns.length)
        var inFence = false
        if let edited, ns.length > wholeTextLimit {
            let at = min(edited.location, ns.length)
            range = ns.paragraphRange(for: NSRange(location: at, length: min(edited.length, ns.length - at)))
            inFence = hasFence(ns) && fenceOpen(before: range.location, in: ns)
        }
        let target = NSMutableAttributedString(string: ns.substring(with: range), attributes: plain)
        for span in MarkdownEditing.spans(target.string, inFence: inFence) {
            apply(span, to: target, base: base)
        }
        var changes: [(NSRange, [NSAttributedString.Key: Any])] = []
        target.enumerateAttributes(in: NSRange(location: 0, length: target.length)) { attrs, r, _ in
            let at = NSRange(location: r.location + range.location, length: r.length)
            if !matches(storage, attrs, in: at) { changes.append((at, attrs)) }
        }
        guard !changes.isEmpty else { return }
        let selection = view.selectedRange
        storage.beginEditing()
        for (r, attrs) in changes {
            for key in keys where attrs[key] == nil { storage.removeAttribute(key, range: r) }
            storage.addAttributes(attrs, range: r)
        }
        storage.endEditing()
        if view.selectedRange != selection { view.selectedRange = selection }
    }

    static func hasFence(_ text: String) -> Bool { text.contains("```") || text.contains("~~~") }
    private static func hasFence(_ ns: NSString) -> Bool {
        ns.range(of: "```").location != NSNotFound || ns.range(of: "~~~").location != NSNotFound
    }

    /// Whether a code fence is open where `location` starts.
    private static func fenceOpen(before location: Int, in ns: NSString) -> Bool {
        var open = false
        ns.enumerateSubstrings(in: NSRange(location: 0, length: location), options: [.byLines, .substringNotRequired]) { _, line, _, _ in
            let head = ns.substring(with: NSRange(location: line.location, length: min(line.length, 64))).drop { $0 == " " || $0 == "\t" }
            if head.hasPrefix("```") || head.hasPrefix("~~~") { open.toggle() }
        }
        return open
    }

    private static func matches(_ storage: NSTextStorage, _ want: [NSAttributedString.Key: Any], in range: NSRange) -> Bool {
        var same = true
        storage.enumerateAttributes(in: range) { have, _, stop in
            for key in keys where !equal(have[key], want[key]) {
                same = false
                stop.pointee = true
                return
            }
        }
        return same
    }

    private static func equal(_ a: Any?, _ b: Any?) -> Bool {
        switch (a, b) {
        case (nil, nil): return true
        case let (a as NSObject, b as NSObject): return a.isEqual(b)
        default: return false
        }
    }

    private static func apply(_ span: MarkdownEditing.Span, to storage: NSMutableAttributedString, base: UIFont) {
        let r = span.range
        guard r.location + r.length <= storage.length else { return }
        switch span.style {
        case .marker: storage.addAttribute(.foregroundColor, value: UIColor.tertiaryLabel, range: r)
        case .listMarker: storage.addAttribute(.foregroundColor, value: accent, range: r)
        case .bold, .heading: add(.traitBold, to: storage, in: r, base: base)
        case .italic: add(.traitItalic, to: storage, in: r, base: base)
        case .strike:
            storage.addAttribute(.strikethroughStyle, value: NSUnderlineStyle.single.rawValue, range: r)
            storage.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: r)
        case .code:
            storage.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: base.pointSize * 0.94, weight: .regular), range: r)
            storage.addAttribute(.backgroundColor, value: UIColor.tertiarySystemFill, range: r)
        case .codeBlock:
            storage.addAttribute(.font, value: UIFont.monospacedSystemFont(ofSize: base.pointSize * 0.94, weight: .regular), range: r)
        case .quote: storage.addAttribute(.foregroundColor, value: UIColor.secondaryLabel, range: r)
        case .link: storage.addAttribute(.foregroundColor, value: UIColor.link, range: r)
        }
    }

    /// Adds a trait to whatever font each piece already has, so bold inside
    /// italic is both.
    private static func add(_ trait: UIFontDescriptor.SymbolicTraits, to storage: NSMutableAttributedString, in range: NSRange, base: UIFont) {
        storage.enumerateAttribute(.font, in: range) { value, r, _ in
            let font = value as? UIFont ?? base
            guard let d = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(trait)) else { return }
            storage.addAttribute(.font, value: UIFont(descriptor: d, size: font.pointSize), range: r)
        }
    }
}

final class PasteAwareTextView: UITextView {
    var onPaste: (([PendingFile]) -> Void)?
    var longTextLimit = 4000
    var placeholder = "" { didSet { if placeholder != oldValue { placeholderLabel.text = placeholder } } }

    /// A label, not a draw(_:) override: drawing made the whole view repaint
    /// on every keystroke.
    private let placeholderLabel: UILabel = {
        let l = UILabel()
        l.font = .preferredFont(forTextStyle: .body)
        l.adjustsFontForContentSizeCategory = true
        l.textColor = .placeholderText
        l.isAccessibilityElement = false
        return l
    }()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        addSubview(placeholderLabel)
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        addSubview(placeholderLabel)
    }

    override var text: String! { didSet { textChanged() } }

    func textChanged() { placeholderLabel.isHidden = textStorage.length > 0 }

    override func layoutSubviews() {
        super.layoutSubviews()
        let x = textContainerInset.left + textContainer.lineFragmentPadding
        placeholderLabel.frame = CGRect(x: x, y: textContainerInset.top, width: max(0, bounds.width - x - textContainerInset.right),
                                        height: placeholderLabel.font.lineHeight)
    }

    static let formats: [(title: String, icon: String, mark: String)] = [
        ("Bold", "bold", "**"),
        ("Italic", "italic", "*"),
        ("Code", "chevron.left.forwardslash.chevron.right", "`"),
        ("Strikethrough", "strikethrough", "~~"),
    ]

    /// A hardware keyboard's shortcuts, as on the panel: ⌘B, ⌘I, ⌘⇧C.
    override var keyCommands: [UIKeyCommand]? {
        let own = [
            UIKeyCommand(title: "Bold", action: #selector(formatBold), input: "b", modifierFlags: .command),
            UIKeyCommand(title: "Italic", action: #selector(formatItalic), input: "i", modifierFlags: .command),
            UIKeyCommand(title: "Code", action: #selector(formatCode), input: "c", modifierFlags: [.command, .shift]),
        ]
        own.forEach { $0.wantsPriorityOverSystemBehavior = true }
        return (super.keyCommands ?? []) + own
    }

    @objc private func formatBold() { toggleMarkdown("**") }
    @objc private func formatItalic() { toggleMarkdown("*") }
    @objc private func formatCode() { toggleMarkdown("`") }

    func toggleMarkdown(_ mark: String) {
        apply(MarkdownEditing.toggle(mark, in: text, selection: selectedRange))
    }

    /// One undoable replacement, then the binding and the styling catch up.
    func apply(_ edit: MarkdownEditing.Edit) {
        guard let start = position(from: beginningOfDocument, offset: edit.range.location),
              let end = position(from: start, offset: edit.range.length),
              let range = textRange(from: start, to: end) else { return }
        replace(range, withText: edit.text)
        selectedRange = edit.selection
        delegate?.textViewDidChange?(self)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) {
            let pb = UIPasteboard.general
            return pb.hasStrings || pb.hasImages || pb.hasURLs || pb.numberOfItems > 0
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        let pb = UIPasteboard.general
        if pb.hasImages, let images = pb.images, !images.isEmpty {
            onPaste?(images.enumerated().compactMap { PendingFile.photo($0.element, index: $0.offset + 1) })
            return
        }
        // Files copied in Files or another app: anything that is not plain text.
        let fileProviders = pb.itemProviders.filter { p in
            !p.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
                && !p.hasItemConformingToTypeIdentifier(UTType.url.identifier)
                && p.registeredTypeIdentifiers.contains { UTType($0)?.conforms(to: .data) == true }
        }
        if !fileProviders.isEmpty {
            Task { @MainActor in
                var files: [PendingFile] = []
                for p in fileProviders {
                    if let f = await Self.load(p) { files.append(f) }
                }
                if !files.isEmpty { onPaste?(files) }
            }
            return
        }
        if let s = pb.string, s.count > longTextLimit {
            onPaste?([.text(s)])
            return
        }
        super.paste(sender)
    }

    private static func load(_ provider: NSItemProvider) async -> PendingFile? {
        guard let typeID = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) else { return nil }
        let type = UTType(typeID)
        let name = provider.suggestedName.map { n in
            (n as NSString).pathExtension.isEmpty ? n + (type?.preferredFilenameExtension.map { "." + $0 } ?? "") : n
        } ?? "file" + (type?.preferredFilenameExtension.map { "." + $0 } ?? "")
        return await withCheckedContinuation { cont in
            _ = provider.loadDataRepresentation(forTypeIdentifier: typeID) { data, _ in
                cont.resume(returning: data.map { PendingFile(name: name, data: $0, mime: PendingFile.mime(for: type, fallbackName: name)) })
            }
        }
    }
}
