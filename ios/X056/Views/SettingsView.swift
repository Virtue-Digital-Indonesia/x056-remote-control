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
    /// This iPhone's notification settings on the gateway.
    @State private var notify: DeviceSettings?
    @State private var notifyError: String?
    @AppStorage(LiveTurns.enabledKey) private var liveActivities = true

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
                    Text("A passkey signs you in with \(Biometry.name) and syncs through iCloud Keychain. Passkeys you made in the panel work here too.")
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
                if let notify {
                    Section {
                        LabeledContent("Needs you", value: "Always")
                        Toggle("Finished long turns I started", isOn: binding(\.finished))
                        Toggle("Automation and background", isOn: binding(\.automation))
                    } header: {
                        Text("What this iPhone gets")
                    } footer: {
                        Text("Needs you: questions, approvals, failed turns and failed scheduled tasks. Long turns: 45 seconds or more, the end of an autopilot run, a parked turn. Automation: autopilot steps' results, scheduled tasks, delegates and conversations messaging each other.")
                    }
                    Section {
                        Toggle("Quiet hours", isOn: binding(\.quietHours.enabled))
                        if notify.quietHours.enabled {
                            DatePicker("From", selection: time(\.quietHours.start), displayedComponents: .hourAndMinute)
                            DatePicker("Until", selection: time(\.quietHours.end), displayedComponents: .hourAndMinute)
                        }
                    } footer: {
                        Text("Nothing reaches this iPhone in quiet hours, urgent notices included. Times are this iPhone's (\(TimeZone.current.identifier)).")
                    }
                } else if let notifyError {
                    Section("What this iPhone gets") {
                        Text(notifyError).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Toggle("Turns I send", isOn: $liveActivities)
                } header: {
                    Text("Live Activities")
                } footer: {
                    Text(LiveTurns.shared.available
                         ? "A turn you send from this iPhone shows on the Lock Screen and in the Dynamic Island until it ends: the step it is on, how long it has run, and how it ended. Any running conversation can be followed from its ⋯ menu."
                         : "Live Activities are off for x056 in the iPhone's Settings.")
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
        // Each part on its own: one slow answer must not hold up the rest.
        async let apns = try? app.client?.get("/api/push/apns", as: ApnsStatus.self)
        async let passkeys = try? app.client?.get("/api/auth/passkey/list", as: [PasskeyInfo].self)
        async let device: Void = loadNotify()
        gateway = await apns
        passkeyCount = await passkeys?.count
        await device
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func loadNotify() async {
        if app.pushEndpoint == nil {
            notifyError = "Allow notifications first: these settings belong to this iPhone's registration with the gateway."
        } else {
            do {
                notify = try await app.pushSettings()
                notifyError = nil
            } catch {
                notifyError = error.localizedDescription
            }
        }
    }

    private func addPasskey() async {
        addingPasskey = true
        defer { addingPasskey = false }
        do {
            try await app.addPasskey()
            passkeyResult = "Passkey added. Next time, sign in with \(Biometry.name)."
            await refresh()
        } catch PasskeyError.cancelled {
            passkeyResult = nil
        } catch {
            passkeyResult = error.localizedDescription
        }
    }

    /// A toggle that saves to the gateway as it changes.
    private func binding<V>(_ path: WritableKeyPath<DeviceSettings, V>) -> Binding<V> {
        Binding(get: { notify![keyPath: path] }, set: { value in
            notify?[keyPath: path] = value
            save()
        })
    }

    /// "22:00" on the gateway, a time of day here.
    private func time(_ path: WritableKeyPath<DeviceSettings, String>) -> Binding<Date> {
        Binding(get: {
            let parts = (notify?[keyPath: path] ?? "00:00").split(separator: ":").compactMap { Int($0) }
            return Calendar.current.date(bySettingHour: parts.first ?? 0, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
        }, set: { date in
            let c = Calendar.current.dateComponents([.hour, .minute], from: date)
            notify?[keyPath: path] = String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
            save()
        })
    }

    private func save() {
        guard let notify else { return }
        Task {
            do {
                if let saved = try await app.savePushSettings(notify) { self.notify = saved }
            } catch {
                notifyError = error.localizedDescription
            }
        }
    }

    private func test() async {
        guard let client = app.client else { return }
        do {
            // Only this iPhone (a gateway that predates `token` sends to all).
            let r: ApnsTestReply = try await client.post("/api/push/apns/test", ApnsTestBody(token: Push.deviceToken?.lowercased() ?? ""), as: ApnsTestReply.self)
            testResult = r.results.isEmpty ? "No devices registered." : r.results.map { "\($0.env) \($0.token): \($0.status == 200 ? "sent" : "\($0.status) \($0.reason ?? "")")" }.joined(separator: "\n")
        } catch {
            testResult = error.localizedDescription
        }
    }
}
