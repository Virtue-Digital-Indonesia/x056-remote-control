import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var server = UserDefaults.standard.string(forKey: "server") ?? "https://x056.rc.val.id"
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Server", text: $server)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Token", text: $token)
                        .textContentType(.password)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("The gateway's X056_TOKEN. It is stored in the Keychain on this device only.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await connect() }
                    } label: {
                        HStack {
                            Text("Connect")
                            Spacer()
                            if busy { ProgressView() }
                        }
                    }
                    .disabled(busy || token.isEmpty || server.isEmpty)
                }
            }
            .navigationTitle("x056")
        }
    }

    private func connect() async {
        busy = true
        defer { busy = false }
        do {
            try await app.signIn(server: server, token: token)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
