import SwiftUI
import UIKit

/// History attachments are `/api/...` URLs behind the gateway's auth, so
/// AsyncImage can't load them: it can't send the Bearer header.
struct AuthImage: View {
    @Environment(AppModel.self) private var app
    let path: String
    @State private var image: UIImage?
    @State private var failed = false

    private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else if failed {
                Image(systemName: "photo").foregroundStyle(.secondary)
            } else {
                ProgressView()
            }
        }
        .task(id: path) { await load() }
    }

    private func load() async {
        if let hit = Self.cache.object(forKey: path as NSString) { image = hit; return }
        guard let client = app.client else { return }
        let url = URL(string: path, relativeTo: client.baseURL)?.absoluteURL ?? client.baseURL
        var req = URLRequest(url: url)
        req.setValue("Bearer \(client.token)", forHTTPHeaderField: "Authorization")
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200,
              let img = UIImage(data: data) else { failed = true; return }
        Self.cache.setObject(img, forKey: path as NSString)
        image = img
    }
}

extension UIImage {
    /// Phone photos are 12+ MP; the model needs a fraction of that.
    func jpegForUpload(maxSide: CGFloat = 2048) -> Data? {
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
        return resized.jpegData(compressionQuality: 0.8)
    }
}
