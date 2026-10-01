import SwiftUI
import XCTest
@testable import X056

/// Renders components the fixture gateway has no data for (usage gauges),
/// in both appearances, as test attachments to look at.
@MainActor
final class RenderTests: XCTestCase {
    func testAccountRowWithUsage() throws {
        let json = """
        {"name":"a","provider":"claude","displayName":"Efran (Max 20x)","email":"efran@example.com","active":true,
         "state":{"kind":"ok"},
         "quota":{"fiveHour":{"utilization":42,"resetsAt":"2026-10-01T12:00:00Z"},
                  "sevenDay":{"utilization":78,"resetsAt":"2026-10-04T00:00:00Z"},
                  "weeklyScoped":[{"label":"Opus","utilization":93}]}}
        """
        let account = try JSONDecoder().decode(Account.self, from: Data(json.utf8))
        XCTAssertEqual(UsageWindow.of(account).map(\.label), ["5 hours", "7 days", "Opus"])
        for scheme in [ColorScheme.light, .dark] {
            let view = AccountRow(account: account)
                .padding(20)
                .frame(width: 380)
                .background(Color(.secondarySystemGroupedBackground))
                .environment(\.colorScheme, scheme)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 3
            let image = try XCTUnwrap(renderer.uiImage)
            let attachment = XCTAttachment(image: image)
            attachment.name = "account-row-\(scheme == .dark ? "dark" : "light")"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
    }
}
