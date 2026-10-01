import SwiftUI

/// First screen. The app icon is the passkey button: press it, Face ID runs,
/// you are in. The token is the fallback, one tap away.
struct LoginView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var server = UserDefaults.standard.string(forKey: "server") ?? "https://x056.rc.val.id"
    @State private var editingServer = false
    @State private var reachable: Bool?
    @State private var hasPasskeys: Bool?
    @State private var token = ""
    @State private var showToken = false
    @State private var busy: Busy?
    @State private var error: String?
    @FocusState private var focus: Field?

    private enum Busy { case passkey, token }
    private enum Field { case server, token }

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                // The key in the middle of the space above; where it goes and
                // how to get in otherwise sit at the bottom, in thumb reach.
                VStack(spacing: 0) {
                    Spacer(minLength: 56)
                    passkeyButton
                    Spacer(minLength: 48)
                    VStack(spacing: 20) {
                        gatewayRow
                        tokenSection
                    }
                    .padding(.bottom, 12)
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Palette.paper.ignoresSafeArea())
        .tint(Palette.clay)
        .task(id: server) { await probe() }
    }

    // MARK: the key

    private var passkeyButton: some View {
        let noPasskeys = hasPasskeys == false
        return Button {
            Task { await signInWithPasskey() }
        } label: {
            VStack(spacing: 28) {
                SignalKey(transmitting: busy == .passkey && !reduceMotion, dimmed: noPasskeys)
                VStack(spacing: 8) {
                    Text("Sign in to x056")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(Palette.ink)
                    Text(caption)
                        .font(.subheadline)
                        .foregroundStyle(error == nil ? Palette.stone : Palette.err)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .contentTransition(.opacity)
                }
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(KeyPressStyle())
        .disabled(busy != nil || noPasskeys)
        .accessibilityLabel("Sign in with passkey")
        .accessibilityHint(caption)
        .accessibilityIdentifier("passkey-button")
        .animation(.easeOut(duration: 0.2), value: caption)
    }

    private var caption: String {
        if let error { return error }
        if busy == .passkey { return "Waiting for Face ID" }
        if let notice = app.signInNotice { return notice }
        if hasPasskeys == false { return "This gateway has no passkey yet. Sign in with the access token, then add one in Settings." }
        return "Press the key to use your passkey."
    }

    // MARK: gateway

    private var gatewayRow: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(reachable == nil ? Palette.stone.opacity(0.5) : reachable! ? Palette.ok : Palette.warn)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            if editingServer {
                TextField("Server address", text: $server)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($focus, equals: .server)
                    .submitLabel(.done)
                    .onSubmit { editingServer = false }
                    .accessibilityIdentifier("server-field")
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    Text(host)
                        .font(.callout.weight(.medium))
                        .foregroundStyle(Palette.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(reachable == nil ? "Checking the gateway" : reachable! ? "Gateway is reachable" : "Can't reach this gateway")
                        .font(.caption)
                        .foregroundStyle(Palette.stone)
                }
                .accessibilityElement(children: .combine)
            }
            Spacer(minLength: 8)
            Button(editingServer ? "Done" : "Change") {
                editingServer.toggle()
                focus = editingServer ? .server : nil
            }
            .font(.callout.weight(.medium))
            .accessibilityIdentifier("change-server")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Palette.line))
    }

    private var host: String {
        (try? AppModel.serverURL(server)).map { url in
            url.port.map { "\(url.host() ?? ""):\($0)" } ?? (url.host() ?? server)
        } ?? server
    }

    // MARK: token

    private var tokenSection: some View {
        VStack(spacing: 12) {
            if showToken {
                VStack(spacing: 10) {
                    HStack(spacing: 10) {
                        Image(systemName: "key.horizontal")
                            .foregroundStyle(Palette.stone)
                            .accessibilityHidden(true)
                        SecureField("Access token", text: $token)
                            .textContentType(.password)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focus, equals: .token)
                            .submitLabel(.go)
                            .onSubmit { Task { await signInWithToken() } }
                            .accessibilityIdentifier("token-field")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                    .background(Palette.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(focus == .token ? Palette.clay : Palette.line))

                    Button {
                        Task { await signInWithToken() }
                    } label: {
                        ZStack {
                            Text("Sign in with token").opacity(busy == .token ? 0 : 1)
                            if busy == .token { ProgressView().tint(Palette.clay) }
                        }
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .foregroundStyle(Palette.clay)
                        .background(Palette.clayWeak, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    }
                    .disabled(busy != nil || token.trimmingCharacters(in: .whitespaces).isEmpty)
                    .accessibilityIdentifier("token-signin")

                    Text("The token is kept only in this iPhone's Keychain.")
                        .font(.footnote)
                        .foregroundStyle(Palette.stone)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            } else {
                Button("Use an access token") {
                    withAnimation(.snappy) { showToken = true }
                    focus = .token
                }
                .font(.callout.weight(.medium))
                .accessibilityIdentifier("use-token")
            }
        }
    }

    // MARK: actions

    private func probe() async {
        reachable = nil
        hasPasskeys = nil
        // Debounce typing in the server field.
        try? await Task.sleep(for: .milliseconds(editingServer ? 500 : 0))
        guard !Task.isCancelled, let url = try? AppModel.serverURL(server) else { return }
        var req = URLRequest(url: url.appending(path: "api/version"), timeoutInterval: 6)
        req.httpShouldHandleCookies = false
        let ok = ((try? await URLSession.shared.data(for: req))?.1 as? HTTPURLResponse)?.statusCode == 200
        guard !Task.isCancelled else { return }
        reachable = ok
        hasPasskeys = await AppModel.passkeysAvailable(server: server)
        if hasPasskeys == false { withAnimation(.snappy) { showToken = true } }
    }

    private func signInWithPasskey() async {
        error = nil
        busy = .passkey
        defer { busy = nil }
        do {
            try await app.signInWithPasskey(server: server)
        } catch PasskeyError.cancelled {
            // Closing the sheet is not an error.
        } catch {
            self.error = describe(error, passkey: true)
        }
    }

    private func signInWithToken() async {
        guard busy == nil else { return }
        error = nil
        busy = .token
        defer { busy = nil }
        do {
            try await app.signIn(server: server, token: token)
        } catch {
            self.error = describe(error, passkey: false)
        }
    }

    private func describe(_ error: Error, passkey: Bool) -> String {
        if let e = error as? APIError {
            if e.status == 401 { return "That token was not accepted." }
            if passkey && e.status == 400 { return "The gateway did not accept this passkey. Try again, or use the access token." }
            if e.status == 0 { return e.message }
            return "The gateway answered \(e.status): \(e.message)"
        }
        if (error as? URLError) != nil { return "Can't reach \(host). Check the address and your connection." }
        return error.localizedDescription
    }
}

/// The app icon as a physical key: the icon's gradient and "x0" glyph, a soft
/// highlight on top, and signal rings that radiate while Face ID runs.
private struct SignalKey: View {
    let transmitting: Bool
    let dimmed: Bool
    private let size: CGFloat = 132
    private var corner: CGFloat { size * 0.26 }

    var body: some View {
        key
            .frame(width: size, height: size)
            // Rings draw outside the key without taking layout space.
            .background {
                if transmitting { rings }
            }
            .accessibilityHidden(true)
    }

    private var rings: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            ZStack {
                ForEach(0..<3, id: \.self) { i in
                    let phase = (t / 1.8 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                    RoundedRectangle(cornerRadius: corner, style: .continuous)
                        .strokeBorder(Palette.clay.opacity(0.55 * (1 - phase)), lineWidth: 1.5)
                        .frame(width: size, height: size)
                        .scaleEffect(1 + phase * 0.75)
                }
            }
        }
    }

    private var key: some View {
        RoundedRectangle(cornerRadius: corner, style: .continuous)
            .fill(LinearGradient(colors: [Palette.iconTop, Palette.iconBottom], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .fill(LinearGradient(colors: [.white.opacity(0.22), .clear], startPoint: .top, endPoint: .center))
            }
            .overlay {
                Text("x0")
                    .font(.system(size: size * 0.42, weight: .heavy))
                    .tracking(-2)
                    .foregroundStyle(Palette.iconGlyph)
            }
            .shadow(color: Palette.iconBottom.opacity(dimmed ? 0 : 0.28), radius: 16, y: 10)
            .saturation(dimmed ? 0 : 1)
            .opacity(dimmed ? 0.45 : 1)
    }
}

/// Pressing the key pushes it in.
private struct KeyPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.spring(duration: 0.25, bounce: 0.4), value: configuration.isPressed)
    }
}
