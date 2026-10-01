import SwiftUI

/// The fleet's usage. Claude reports utilization 0-100; Codex reports its
/// windows as a 0-1 fraction.
struct AccountsView: View {
    @Environment(AppModel.self) private var app
    @State private var accounts: [Account] = []
    @State private var error: String?

    var body: some View {
        let claude = accounts.filter { $0.provider != "codex" }
        let codex = accounts.filter { $0.provider == "codex" }
        List {
            if !claude.isEmpty {
                Section("Claude") { ForEach(claude) { AccountRow(account: $0) } }
            }
            if !codex.isEmpty {
                Section("ChatGPT") { ForEach(codex) { AccountRow(account: $0) } }
            }
        }
        .overlay {
            if accounts.isEmpty {
                if let error {
                    ContentUnavailableView("Couldn't load accounts", systemImage: "gauge.with.dots.needle.0percent", description: Text(error))
                } else {
                    ProgressView()
                }
            }
        }
        .refreshable { await load() }
        .task(id: app.accountsTick) { await load() }
        .task {
            // The panel polls every 60 s; the gateway caches upstream for 90.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                await load()
            }
        }
        .navigationTitle("Accounts")
    }

    private func load() async {
        guard let client = app.client else { return }
        do {
            accounts = try await client.get("/api/accounts", as: [Account].self)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct AccountRow: View {
    let account: Account

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(account.displayName ?? account.label ?? account.name)
                        .font(.headline)
                    if let email = account.email {
                        Text(email).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                StateBadge(account: account)
            }
            let windows = UsageWindow.of(account)
            if !windows.isEmpty {
                HStack(alignment: .top, spacing: 18) {
                    ForEach(windows) { UsageGauge(window: $0) }
                }
            } else if let e = account.quotaError {
                Text(e).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 6)
    }
}

struct UsageWindow: Identifiable {
    let label: String
    let percent: Double
    let resetsAt: Date?
    var id: String { label }

    static func of(_ a: Account) -> [UsageWindow] {
        guard let q = a.quota else { return [] }
        if let w = q.windows, !w.isEmpty {
            return w.map { UsageWindow(label: $0.label, percent: $0.utilization * 100, resetsAt: date($0.resetsAt)) }
        }
        var out: [UsageWindow] = []
        if let f = q.fiveHour { out.append(UsageWindow(label: "5 hours", percent: f.utilization, resetsAt: date(f.resetsAt))) }
        if let s = q.sevenDay { out.append(UsageWindow(label: "7 days", percent: s.utilization, resetsAt: date(s.resetsAt))) }
        out += (q.weeklyScoped ?? []).map { UsageWindow(label: $0.label, percent: $0.utilization, resetsAt: date($0.resetsAt)) }
        return out
    }

    private static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}

struct UsageGauge: View {
    let window: UsageWindow

    var body: some View {
        let p = min(max(window.percent, 0), 100)
        VStack(spacing: 6) {
            Gauge(value: p, in: 0...100) {
                Text(window.label)
            } currentValueLabel: {
                Text("\(Int(p.rounded()))")
                    .font(.system(.body, design: .rounded).weight(.semibold))
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .tint(p >= 90 ? .red : p >= 70 ? .orange : Palette.clay)
            Text(window.label)
                .font(.caption)
                .lineLimit(1)
            if let r = window.resetsAt {
                Text(r, format: .relative(presentation: .named, unitsStyle: .abbreviated))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(minWidth: 64)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.label): \(Int(p.rounded())) percent used")
    }
}

struct StateBadge: View {
    let account: Account

    var body: some View {
        let (text, color) = describe()
        if let text {
            Text(text)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .foregroundStyle(color)
                .background(color.opacity(0.14), in: .capsule)
        }
    }

    private func describe() -> (String?, Color) {
        if account.paused == true { return ("Paused", .secondary) }
        switch account.state?.kind {
        case "limited":
            let until = account.state?.until.map { Date(timeIntervalSince1970: $0).formatted(date: .omitted, time: .shortened) }
            return (until.map { "Limited until \($0)" } ?? "Limited", .orange)
        case "unauthenticated":
            return ("Signed out", .red)
        default:
            if account.active == true { return ("In use", .green) }
            if account.nextUp == true { return ("Next", .blue) }
            return (nil, .secondary)
        }
    }
}
