import SwiftUI

/// Pending `send_message` approvals: one conversation asking to message another.
struct ApprovalsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var error: String?
    @State private var busy: Set<String> = []

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
                ForEach(app.approvals) { a in
                    VStack(alignment: .leading, spacing: 8) {
                        Text("\(a.sender?.projectName ?? a.sender?.conversationTitle ?? "A conversation") → \(a.targetLabel ?? a.projectName ?? "a project")")
                            .font(.subheadline.weight(.semibold))
                        Text(a.message)
                            .font(.callout)
                            .lineLimit(12)
                            .textSelection(.enabled)
                        if let review = a.contextReview {
                            Label(review.reason ?? "Approving also changes this project's shared context.", systemImage: "exclamationmark.triangle")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        }
                        HStack {
                            Button("Deny", role: .destructive) { Task { await decide(a, approve: false) } }
                                .buttonStyle(.bordered)
                            Spacer()
                            Button("Approve") { Task { await decide(a, approve: true) } }
                                .buttonStyle(.borderedProminent)
                        }
                        .disabled(busy.contains(a.id))
                    }
                    .padding(.vertical, 4)
                }
            }
            .overlay {
                if app.approvals.isEmpty {
                    ContentUnavailableView("Nothing to approve", systemImage: "checkmark.shield")
                }
            }
            .refreshable { await app.refreshAll() }
            .navigationTitle("Approvals")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func decide(_ a: McpApproval, approve: Bool) async {
        guard let client = app.client else { return }
        busy.insert(a.id)
        defer { busy.remove(a.id) }
        do {
            let body = DecideBody(id: a.id, approve: approve, reviewedOperationId: approve ? a.contextReview?.operationId : nil)
            try await client.post("/api/mcp/approvals/decide", body)
            app.approvals.removeAll { $0.id == a.id }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
