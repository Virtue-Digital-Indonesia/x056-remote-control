import SwiftUI
import XCTest
@testable import X056

/// Renders screens the fixture gateway has no data for (usage gauges, a
/// mixed fleet), at iPhone Duo's widths, as attachments to look at.
@MainActor
final class RenderTests: XCTestCase {
    static let fleetJSON = """
    [{"name":"a","provider":"claude","displayName":"Efran","email":"efran@val.id","active":false,"nextUp":true,"state":{"kind":"ok"},
      "quota":{"fiveHour":{"utilization":0,"resetsAt":"2026-10-01T12:00:00Z"},"sevenDay":{"utilization":8,"resetsAt":"2026-10-03T00:00:00Z"},"weeklyScoped":[{"label":"Fable","utilization":0,"resetsAt":"2026-10-03T00:00:00Z"}]}},
     {"name":"b","provider":"claude","displayName":"X056","email":"x056@datahive.id","active":true,"state":{"kind":"ok"},
      "quota":{"fiveHour":{"utilization":0},"sevenDay":{"utilization":14,"resetsAt":"2026-10-07T00:00:00Z"},"weeklyScoped":[{"label":"Fable","utilization":2,"resetsAt":"2026-10-07T00:00:00Z"}]}},
     {"name":"f","provider":"claude","displayName":"Datahiver","email":"ceo@datahive.id","state":{"kind":"unauthenticated"},
      "quota":{"fiveHour":{"utilization":1},"sevenDay":{"utilization":74},"weeklyScoped":[{"label":"Fable","utilization":100}]}},
     {"name":"e","provider":"codex","displayName":"ChatGPT Pro","email":"pro@val.id","active":true,"state":{"kind":"ok"},
      "quota":{"windows":[{"label":"5 hours","utilization":0.31},{"label":"Weekly","utilization":0.72}]}},
     {"name":"g","provider":"codex","displayName":"ChatGPT Business","email":"biz@val.id","state":{"kind":"limited","until":1790853600},
      "quota":{"windows":[{"label":"5 hours","utilization":1.0},{"label":"Weekly","utilization":0.95}]}}]
    """

    func testAccountsGridAtDuoWidths() throws {
        let fleet = try JSONDecoder().decode([Account].self, from: Data(Self.fleetJSON.utf8))
        XCTAssertEqual(UsageWindow.of(fleet[0]).map(\.label), ["5 hours", "7 days", "Fable"])
        for (width, name) in [(CGFloat(380), "portrait"), (600, "open")] {
            for scheme in [ColorScheme.light, .dark] {
                let view = AccountsGrid(accounts: fleet)
                    .padding()
                    .frame(width: width)
                    .background(Color(.systemGroupedBackground))
                    .environment(\.colorScheme, scheme)
                attach(view, "accounts-\(name)-\(scheme == .dark ? "dark" : "light")")
            }
        }
    }

    func attach(_ view: some View, _ name: String) {
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let image = renderer.uiImage else { return XCTFail("could not render \(name)") }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
