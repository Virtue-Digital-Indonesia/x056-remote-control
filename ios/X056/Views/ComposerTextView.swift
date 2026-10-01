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

/// The composer's text area: a UITextView, because SwiftUI's TextField
/// cannot take a pasted image or file. A paste of images or files becomes
/// attachments; a paste of text longer than `longTextLimit` becomes a .txt
/// attachment; anything else pastes as text.
extension EnvironmentValues {
    /// The composer is folded away. Its UIKit text view hides too: SwiftUI's
    /// hiding on the container does not reach it, so it stayed in the
    /// accessibility tree and kept the keyboard.
    @Entry var composerFolded = false
}

struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var longTextLimit: Int
    var maxLines = 8
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
        view.accessibilityIdentifier = "composer"
        return view
    }

    func updateUIView(_ view: PasteAwareTextView, context: Context) {
        if view.text != text { view.text = text }
        view.placeholder = placeholder
        view.longTextLimit = longTextLimit
        view.onPaste = onPaste
        view.isHidden = context.environment.composerFolded
        if view.isHidden, view.isFirstResponder { view.resignFirstResponder() }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView view: PasteAwareTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 280
        let fitted = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = view.font?.lineHeight ?? 20
        let cap = line * CGFloat(maxLines) + view.textContainerInset.top + view.textContainerInset.bottom
        view.isScrollEnabled = fitted.height > cap
        return CGSize(width: width, height: min(fitted.height, cap))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, UITextViewDelegate {
        let text: Binding<String>
        init(text: Binding<String>) { self.text = text }

        func textViewDidChange(_ view: UITextView) {
            text.wrappedValue = view.text
            view.invalidateIntrinsicContentSize()
            (view as? PasteAwareTextView)?.setNeedsDisplay()
        }
    }
}

final class PasteAwareTextView: UITextView {
    var onPaste: (([PendingFile]) -> Void)?
    var longTextLimit = 4000
    var placeholder = "" { didSet { if placeholder != oldValue { setNeedsDisplay() } } }

    override var text: String! { didSet { setNeedsDisplay() } }

    override func draw(_ rect: CGRect) {
        super.draw(rect)
        guard text.isEmpty, !placeholder.isEmpty else { return }
        let origin = CGPoint(x: textContainerInset.left + textContainer.lineFragmentPadding, y: textContainerInset.top)
        (placeholder as NSString).draw(at: origin, withAttributes: [
            .font: font ?? .preferredFont(forTextStyle: .body),
            .foregroundColor: UIColor.placeholderText,
        ])
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
