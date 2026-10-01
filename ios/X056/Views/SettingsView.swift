import SwiftUI
import UserNotifications

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var authorization: UNAuthorizationStatus = .notDetermined
    @State private var gateway: ApnsStatus?
    @State private var testResult: String?
    @State private var confirmSignOut = false
    @State private var passkeyCount: Int?
    @State private var passkeyResult: String?
    @State private var addingPasskey = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Gateway") {
                    LabeledContent("Server", value: app.server?.host() ?? "-")
                    LabeledContent("Stream", value: streamLabel)
                }
                Section {
                    LabeledContent("Signed in with", value: app.credential?.isPasskey == true ? "Passkey" : "Access token")
                    LabeledContent("Passkeys on this gateway", value: passkeyCount.map(String.init) ?? "…")
                    Button {
                        Task { await addPasskey() }
                    } label: {
                        HStack {
                            Text("Add a passkey on this iPhone")
                            Spacer()
                            if addingPasskey { ProgressView() }
                        }
                    }
                    .disabled(addingPasskey)
                    if let passkeyResult { Text(passkeyResult).font(.caption).foregroundStyle(.secondary) }
                } header: {
                    Text("Sign-in")
                } footer: {
                    Text("A passkey signs you in with Face ID and syncs through iCloud Keychain. Passkeys you made in the panel work here too.")
                }
                Section {
                    LabeledContent("This iPhone", value: authLabel)
                    LabeledContent("Gateway key", value: gateway.map { $0.configured ? "Installed" : "Not installed" } ?? "…")
                    LabeledContent("Registered devices", value: gateway.map { String($0.devices.count) } ?? "…")
                    if authorization == .notDetermined {
                        Button("Allow notifications") { Task { await Push.requestAndRegister(); await refresh() } }
                    } else if authorization == .denied {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                        }
                    }
                    Button("Send a test notification") { Task { await test() } }
                        .disabled(!(gateway?.configured ?? false))
                    if let testResult { Text(testResult).font(.caption).foregroundStyle(.secondary) }
                    if let e = app.pushError { Text(e).font(.caption).foregroundStyle(.red) }
                } header: {
                    Text("Notifications")
                } footer: {
                    Text("The gateway sends a notification when a turn finishes, fails, asks you something, or is interrupted. Reply straight from the notification.")
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                } footer: {
                    Text("x056 \(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "") (\(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""))")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await refresh() }
            .confirmationDialog("Sign out of this gateway?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) { Task { await app.signOut(); dismiss() } }
            }
        }
    }

    private var streamLabel: String {
        switch app.connection {
        case .live: return "Live"
        case .connecting: return "Connecting…"
        case .offline: return "Offline"
        case .failed(let m): return m
        }
    }

    private var authLabel: String {
        switch authorization {
        case .authorized, .provisional, .ephemeral: return "Allowed"
        case .denied: return "Off in Settings"
        default: return "Not asked yet"
        }
    }

    private func refresh() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
        gateway = try? await app.client?.get("/api/push/apns", as: ApnsStatus.self)
        passkeyCount = (try? await app.client?.get("/api/auth/passkey/list", as: [PasskeyInfo].self))?.count
    }

    private func addPasskey() async {
        addingPasskey = true
        defer { addingPasskey = false }
        do {
            try await app.addPasskey()
            passkeyResult = "Passkey added. Next time, sign in with Face ID."
            await refresh()
        } catch PasskeyError.cancelled {
            passkeyResult = nil
        } catch {
            passkeyResult = error.localizedDescription
        }
    }

    private func test() async {
        guard let client = app.client else { return }
        do {
            let r: ApnsTestReply = try await client.post("/api/push/apns/test", Empty(), as: ApnsTestReply.self)
            testResult = r.results.isEmpty ? "No devices registered." : r.results.map { "\($0.env) \($0.token): \($0.status == 200 ? "sent" : "\($0.status) \($0.reason ?? "")")" }.joined(separator: "\n")
        } catch {
            testResult = error.localizedDescription
        }
    }
}
