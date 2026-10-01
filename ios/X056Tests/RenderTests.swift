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

    /// Shaped like the panel screenshot: Codex main on GPT-6.1 Sol picked by
    /// Jev, Astra advisor, one sharp fork, a Jev-picked team, four workers.
    static func treeJSON() -> (String, String) {
        let now = Date().timeIntervalSince1970 * 1000
        let iso = { (msAgo: Double) in ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: (now - msAgo) / 1000)) }
        let tree = """
        {"provider":"codex","helpers":{"advisor":true,"team":true,"router":"jev"},"turnStartedAt":"\(iso(600_000))",
         "main":{"model":"gpt-6.1-sol","effort":"high","pickedBy":"jev","running":true,"background":false,"lastTurn":{"steps":42,"durationMs":312000,"costUsd":1.84}},
         "advisor":{"on":true,"kind":"gateway","model":"gpt-6-astra","checkpoints":true,"calls":[]},
         "team":{"model":"gpt-6.1-sol","effort":"medium","pickedBy":"jev","confidence":0.6,"roles":["explorer","worker","default"]},
         "forks":{"total":1,"sharp":1,"split":0,"recent":[{"at":"\(iso(420_000))","question":"How should I sequence independent final verification?","options":["a","b"],"choice":"Prepare real-browser verifier first","confidence":0.88,"verdict":"sharp"}]},
         "gates":[],"picks":[{"at":"\(iso(590_000))","backend":"jev","model":"gpt-6.1-sol","effort":"high","notes":["model -> gpt-6.1-sol","effort -> high"],"latencyMs":310}],
         "delegates":[],
         "turns":[{"n":1,"startedAt":"\(iso(3_600_000))","endedAt":"\(iso(3_000_000))","prompt":"Port the OCR verifier"},{"n":2,"startedAt":"\(iso(600_000))","endedAt":null,"prompt":"Finish the verification pass","running":true}]}
        """
        let subs = """
        {"subagents":[
         {"agentId":"a1","agentType":"codex-subagent","description":"Hooke","status":"running","startedAt":\(now - 300_000)},
         {"agentId":"a2","agentType":"codex-subagent","description":"Popper","status":"running","startedAt":\(now - 280_000)},
         {"agentId":"a3","agentType":"codex-subagent","description":"Lorentz","status":"done","startedAt":\(now - 500_000),"endedAt":\(now - 200_000)},
         {"agentId":"a4","agentType":"codex-subagent","description":"Linnaeus","status":"done","startedAt":\(now - 520_000),"endedAt":\(now - 150_000)},
         {"agentId":"e1","agentType":"codex-subagent","description":"Kepler","status":"done","startedAt":\(now - 3_500_000),"endedAt":\(now - 3_300_000)},
         {"agentId":"e2","agentType":"codex-subagent","description":"Noether","status":"done","startedAt":\(now - 3_400_000),"endedAt":\(now - 3_200_000)},
         {"agentId":"e3","agentType":"codex-subagent","description":"Euler","status":"failed","startedAt":\(now - 3_300_000),"endedAt":\(now - 3_100_000)}]}
        """
        return (tree, subs)
    }

    func testAgentTreeAtDuoWidths() throws {
        let (t, s) = Self.treeJSON()
        let tree = try JSONDecoder().decode(AgentTree.self, from: Data(t.utf8))
        let subs = try JSONDecoder().decode(SubagentsReply.self, from: Data(s.utf8)).subagents
        let w = TurnWindow(tree: tree, turnN: nil)
        XCTAssertEqual(w.workers(subs).count, 4)
        XCTAssertEqual(w.earlier(subs).flatMap(\.1).count, 3)
        for (width, name) in [(CGFloat(380), "portrait"), (820, "open")] {
            for scheme in [ColorScheme.light, .dark] {
                let view = AgentTreeContent(tree: tree, subagents: subs, turnN: nil, wide: width >= 620)
                    .padding()
                    .frame(width: width)
                    .background(Color(.systemGroupedBackground))
                    .environment(\.colorScheme, scheme)
                attach(view, "tree-\(name)-\(scheme == .dark ? "dark" : "light")")
            }
        }
    }

    func testPickerSheets() {
        let defaults = ["opus": "high"]
        for scheme in [ColorScheme.light, .dark] {
            let me = ModelEffortContent(model: "opus", effort: "high", provider: "claude", routerName: nil, codex: [], defaults: defaults) { _, _ in }
                .padding().frame(width: 390).background(Color(.systemGroupedBackground)).environment(\.colorScheme, scheme)
            attach(me, "model-effort-\(scheme == .dark ? "dark" : "light")")
            let jev = try? JSONDecoder().decode(JevStatus.self, from: Data(#"{"configured":true,"estimatedLeft":4.12}"#.utf8))
            let hs = HelpersContent(helpers: Helpers(advisor: true, team: false, router: "jev", lean: "high"), provider: "claude", started: true,
                                    jev: jev, decisions: nil) { _ in }
                .padding().frame(width: 390).background(Color(.systemGroupedBackground)).environment(\.colorScheme, scheme)
            attach(hs, "helpers-\(scheme == .dark ? "dark" : "light")")
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
