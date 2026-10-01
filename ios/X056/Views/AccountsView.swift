import SwiftUI

/// The usage bars per account. Claude reports utilization 0-100; Codex reports
/// its windows as a 0-1 fraction.
struct AccountsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var accounts: [Account] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List(accounts) { a in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(a.displayName ?? a.label ?? a.name).font(.headline)
                        Text(a.providerLabel ?? a.provider ?? "").font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        stateBadge(a)
                    }
                    if let email = a.email { Text(email).font(.caption).foregroundStyle(.secondary) }
                    ForEach(bars(a), id: \.label) { bar in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(bar.label)
                                Spacer()
                                Text("\(Int(bar.percent.rounded()))%")
                                if let r = bar.resets { Text("· \(r)").foregroundStyle(.secondary) }
                            }
                            .font(.caption)
                            ProgressView(value: min(bar.percent, 100), total: 100)
                                .tint(bar.percent >= 90 ? .red : bar.percent >= 70 ? .orange : .accentColor)
                        }
                    }
                    if let e = a.quotaError { Text(e).font(.caption2).foregroundStyle(.secondary).lineLimit(2) }
                }
                .padding(.vertical, 4)
            }
            .overlay {
                if accounts.isEmpty {
                    if let error { ContentUnavailableView("Couldn't load", systemImage: "gauge.with.dots.needle.0percent", description: Text(error)) } else { ProgressView() }
                }
            }
            .refreshable { await load() }
            .task(id: app.accountsTick) { await load() }
            .task {
                // The panel polls every 60 s; the server caches upstream for 90.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(60))
                    await load()
                }
            }
            .navigationTitle("Accounts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
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

    private struct Bar { let label: String; let percent: Double; let resets: String? }

    private func bars(_ a: Account) -> [Bar] {
        guard let q = a.quota else { return [] }
        if let w = q.windows, !w.isEmpty {
            return w.map { Bar(label: $0.label, percent: $0.utilization * 100, resets: resets($0.resetsAt)) }
        }
        var out: [Bar] = []
        if let f = q.fiveHour { out.append(Bar(label: "5 hours", percent: f.utilization, resets: resets(f.resetsAt))) }
        if let s = q.sevenDay { out.append(Bar(label: "7 days", percent: s.utilization, resets: resets(s.resetsAt))) }
        out += (q.weeklyScoped ?? []).map { Bar(label: $0.label, percent: $0.utilization, resets: resets($0.resetsAt)) }
        return out
    }

    private func resets(_ iso: String?) -> String? {
        guard let iso else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        return date.map { "resets " + $0.formatted(.relative(presentation: .named, unitsStyle: .abbreviated)) }
    }

    @ViewBuilder
    private func stateBadge(_ a: Account) -> some View {
        if a.paused == true {
            badge("Paused", .gray)
        } else {
            switch a.state?.kind {
            case "limited":
                let until = a.state?.until.map { Date(timeIntervalSince1970: $0).formatted(date: .omitted, time: .shortened) }
                badge(until.map { "Limited · \($0)" } ?? "Limited", .orange)
            case "unauthenticated":
                badge("Signed out", .red)
            default:
                if a.active == true { badge("Active", .green) } else if a.nextUp == true { badge("Next", .blue) }
            }
        }
    }

    private func badge(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }
}
