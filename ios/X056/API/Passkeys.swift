import AuthenticationServices
import UIKit

/// Native passkeys against the gateway's own WebAuthn routes (server/webauthn.ts),
/// the same ones the panel's "Log in with passkey" uses.
///
/// iOS offers x056.rc.val.id's passkeys to this app only because the app has
/// `webcredentials:x056.rc.val.id` and the gateway lists the app in
/// /.well-known/apple-app-site-association (server/apple-app-site.ts).
/// The signed client data carries origin `https://<rp id>`, which is what the
/// gateway expects for that host.
enum Passkeys {
    /// Sign in; returns the session id the gateway set as `x056_session`.
    @MainActor
    static func signIn(baseURL: URL) async throws -> String {
        let api = APIClient(baseURL: baseURL, credential: nil)
        var optionsRequest = api.request("POST", "/api/auth/passkey/auth/options", body: Data("{}".utf8))
        optionsRequest.setValue(api.origin, forHTTPHeaderField: "Origin")
        let opts: PasskeyRequestOptions = try await api.send(optionsRequest)
        guard let challenge = Data(base64URL: opts.options.challenge) else { throw PasskeyError.malformed }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: opts.options.rpId ?? baseURL.host() ?? "")
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.allowedCredentials = (opts.options.allowCredentials ?? [])
            .compactMap { Data(base64URL: $0.id) }
            .map(ASAuthorizationPlatformPublicKeyCredentialDescriptor.init(credentialID:))
        request.userVerificationPreference = .preferred

        let authorization = try await PasskeySheet().run(request)
        guard let a = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else { throw PasskeyError.malformed }
        let body = PasskeyVerifyBody(flowId: opts.flowId, response: AssertionJSON(
            id: a.credentialID.base64URL,
            rawId: a.credentialID.base64URL,
            response: .init(
                clientDataJSON: a.rawClientDataJSON.base64URL,
                authenticatorData: a.rawAuthenticatorData.base64URL,
                signature: a.signature.base64URL,
                userHandle: a.userID.isEmpty ? nil : a.userID.base64URL)))

        var verify = api.request("POST", "/api/auth/passkey/auth/verify", body: try JSONEncoder().encode(body))
        verify.setValue(api.origin, forHTTPHeaderField: "Origin")
        let (data, response) = try await URLSession.shared.data(for: verify)
        guard let http = response as? HTTPURLResponse else { throw PasskeyError.malformed }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: APIClient.errorMessage(data) ?? "The gateway did not accept the passkey.")
        }
        guard let session = sessionCookie(from: http) else { throw PasskeyError.noSession }
        return session
    }

    /// Create a passkey on this iPhone for a gateway we are already signed in to.
    @MainActor
    static func register(client: APIClient, label: String) async throws {
        var optionsRequest = client.request("POST", "/api/auth/passkey/register/options", body: Data("{}".utf8))
        optionsRequest.setValue(client.origin, forHTTPHeaderField: "Origin")
        let opts: PasskeyCreationOptions = try await client.send(optionsRequest)
        guard let challenge = Data(base64URL: opts.options.challenge),
              let userID = Data(base64URL: opts.options.user.id) else { throw PasskeyError.malformed }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: opts.options.rp.id ?? client.baseURL.host() ?? "")
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: opts.options.user.name, userID: userID)
        request.excludedCredentials = (opts.options.excludeCredentials ?? [])
            .compactMap { Data(base64URL: $0.id) }
            .map(ASAuthorizationPlatformPublicKeyCredentialDescriptor.init(credentialID:))

        let authorization = try await PasskeySheet().run(request)
        guard let r = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
              let attestation = r.rawAttestationObject else { throw PasskeyError.malformed }
        let body = PasskeyVerifyBody(flowId: opts.flowId, response: AttestationJSON(
            id: r.credentialID.base64URL,
            rawId: r.credentialID.base64URL,
            response: .init(clientDataJSON: r.rawClientDataJSON.base64URL, attestationObject: attestation.base64URL)),
            label: label)
        var verify = client.request("POST", "/api/auth/passkey/register/verify", body: try JSONEncoder().encode(body))
        verify.setValue(client.origin, forHTTPHeaderField: "Origin")
        _ = try await client.raw(verify)
    }

    static func sessionCookie(from response: HTTPURLResponse) -> String? {
        guard let url = response.url else { return nil }
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { acc, pair in
            if let k = pair.key as? String, let v = pair.value as? String { acc[k] = v }
        }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).first { $0.name == "x056_session" }?.value
    }
}

enum PasskeyError: LocalizedError {
    case cancelled
    case malformed
    case noSession

    var errorDescription: String? {
        switch self {
        case .cancelled: return nil
        case .malformed: return "The passkey reply could not be read."
        case .noSession: return "The gateway accepted the passkey but sent no session."
        }
    }
}

/// One system passkey sheet, awaited.
@MainActor
private final class PasskeySheet: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    func run(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { cont in
            continuation = cont
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation?.resume(returning: authorization)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let canceled = (error as? ASAuthorizationError)?.code == .canceled
        continuation?.resume(throwing: canceled ? PasskeyError.cancelled : error)
        continuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let key = scenes.flatMap(\.windows).first(where: \.isKeyWindow) { return key }
        return ASPresentationAnchor(windowScene: scenes[0])
    }
}

// MARK: WebAuthn JSON (what @simplewebauthn/server expects)

struct PasskeyAvailability: Decodable, Sendable { let available: Bool }

struct PasskeyInfo: Decodable, Sendable { let id: String; let label: String? }

struct CredentialDescriptor: Decodable, Sendable { let id: String }

struct PasskeyRequestOptions: Decodable, Sendable {
    struct Options: Decodable, Sendable {
        let challenge: String
        let rpId: String?
        let allowCredentials: [CredentialDescriptor]?
    }
    let options: Options
    let flowId: String
}

struct PasskeyCreationOptions: Decodable, Sendable {
    struct Options: Decodable, Sendable {
        struct RP: Decodable, Sendable { let id: String? }
        struct User: Decodable, Sendable { let id: String; let name: String }
        let challenge: String
        let rp: RP
        let user: User
        let excludeCredentials: [CredentialDescriptor]?
    }
    let options: Options
    let flowId: String
}

struct AssertionJSON: Encodable, Sendable {
    struct Response: Encodable, Sendable {
        let clientDataJSON: String
        let authenticatorData: String
        let signature: String
        let userHandle: String?
    }
    let id: String
    let rawId: String
    var type = "public-key"
    let response: Response
    var clientExtensionResults: [String: String] = [:]
    var authenticatorAttachment = "platform"
}

struct AttestationJSON: Encodable, Sendable {
    struct Response: Encodable, Sendable {
        let clientDataJSON: String
        let attestationObject: String
        var transports = ["internal", "hybrid"]
    }
    let id: String
    let rawId: String
    var type = "public-key"
    let response: Response
    var clientExtensionResults: [String: String] = [:]
    var authenticatorAttachment = "platform"
}

struct PasskeyVerifyBody<R: Encodable & Sendable>: Encodable, Sendable {
    let flowId: String
    let response: R
    var label: String?
}

extension Data {
    init?(base64URL s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        b += String(repeating: "=", count: (4 - b.count % 4) % 4)
        self.init(base64Encoded: b)
    }

    var base64URL: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
