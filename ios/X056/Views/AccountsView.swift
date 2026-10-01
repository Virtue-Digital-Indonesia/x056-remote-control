import SwiftUI

/// The fleet's usage. Claude reports utilization 0-100; Codex reports its
/// windows as a 0-1 fraction.
struct AccountsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            AccountsGrid(accounts: app.accounts)
                .padding(.horizontal)
                .padding(.bottom, 24)
        }
        .background(Color(.systemGroupedBackground))
        .overlay {
            if app.accounts.isEmpty {
                if let error = app.accountsError {
                    ContentUnavailableView("Couldn't load accounts", systemImage: "gauge.with.dots.needle.0percent", description: Text(error))
                } else {
                    ProgressView()
                }
            }
        }
        .refreshable { await app.loadAccounts() }
        .task(id: app.accountsTick) { await app.loadAccounts() }
        .task {
            // The panel polls every 60 s; the gateway caches upstream for 90.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                await app.loadAccounts()
            }
        }
        .navigationTitle("Accounts")
    }
}

/// Summary chips, then one adaptive grid of cards per provider: one column
/// on a phone held upright, two on iPhone Duo open, more on iPad.
struct AccountsGrid: View {
    let accounts: [Account]

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            FleetSummary(accounts: accounts)
            section("Claude", accounts.filter { $0.provider != "codex" })
            section("ChatGPT", accounts.filter { $0.provider == "codex" })
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ items: [Account]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .padding(.leading, 4)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 240), spacing: 12, alignment: .top)], spacing: 12) {
                    ForEach(items.sorted(by: AccountCard.order)) { AccountCard(account: $0) }
                }
            }
        }
    }
}

struct FleetSummary: View {
    let accounts: [Account]

    var body: some View {
        let ready = accounts.filter { [.inUse, .next, .ready].contains(AccountCard.status($0)) }.count
        let limited = accounts.filter { AccountCard.status($0) == .limited }.count
        let signedOut = accounts.filter { AccountCard.status($0) == .signedOut }.count
        let paused = accounts.filter { AccountCard.status($0) == .paused }.count
        HStack(spacing: 8) {
            chip("\(ready) available", .green, show: true)
            chip("\(limited) limited", .orange, show: limited > 0)
            chip("\(signedOut) signed out", .red, show: signedOut > 0)
            chip("\(paused) paused", .secondary, show: paused > 0)
        }
        .padding(.top, 8)
    }

    @ViewBuilder
    private func chip(_ text: String, _ color: Color, show: Bool) -> some View {
        if show {
            HStack(spacing: 6) {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(text)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Color(.secondarySystemGroupedBackground), in: .capsule)
        }
    }
}

struct AccountCard: View {
    let account: Account

    enum Status { case inUse, next, ready, limited, signedOut, paused }

    static func status(_ a: Account) -> Status {
        if a.paused == true { return .paused }
        switch a.state?.kind {
        case "limited": return .limited
        case "unauthenticated": return .signedOut
        default: return a.active == true ? .inUse : a.nextUp == true ? .next : .ready
        }
    }

    /// In use first, then next up, then ready; trouble sinks to the bottom.
    static func order(_ l: Account, _ r: Account) -> Bool {
        func rank(_ a: Account) -> Int {
            switch status(a) {
            case .inUse: return 0
            case .next: return 1
            case .ready: return 2
            case .limited: return 3
            case .paused: return 4
            case .signedOut: return 5
            }
        }
        return (rank(l), l.name) < (rank(r), r.name)
    }

    var body: some View {
        let status = Self.status(account)
        let dim = status == .signedOut || status == .paused
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(account.displayName ?? account.label ?? account.name)
                        .font(.headline)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let email = account.email {
                        Text(email)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 4)
                StateBadge(account: account)
            }
            let windows = UsageWindow.of(account)
            if !windows.isEmpty {
                // Reset times line up across a card only if any window has one.
                let resets = windows.contains { $0.resetsAt != nil }
                HStack(alignment: .top, spacing: 14) {
                    ForEach(windows) { UsageGauge(window: $0, showsReset: resets) }
                }
                .opacity(dim ? 0.45 : 1)
            } else {
                Text(account.quotaError ?? "No usage reported yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
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
    var showsReset = true

    var body: some View {
        let p = min(max(window.percent, 0), 100)
        VStack(spacing: 5) {
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
            if showsReset {
                Text(window.resetsAt.map { $0.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)) } ?? " ")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(minWidth: 60)
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
                .lineLimit(1)
                .fixedSize()
        }
    }

    private func describe() -> (String?, Color) {
        switch AccountCard.status(account) {
        case .paused: return ("Paused", .secondary)
        case .limited:
            let until = account.state?.until.map { Date(timeIntervalSince1970: $0).formatted(date: .omitted, time: .shortened) }
            return (until.map { "Until \($0)" } ?? "Limited", .orange)
        case .signedOut: return ("Signed out", .red)
        case .inUse: return ("In use", .green)
        case .next: return ("Next", .blue)
        case .ready: return (nil, .secondary)
        }
    }
}
