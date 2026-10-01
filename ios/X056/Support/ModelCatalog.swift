import Foundation

/// The model and effort choices the panel offers. Claude has no catalog
/// endpoint, so its list is the panel's hard-coded one; Codex comes from
/// `/api/models`.
enum ModelCatalog {
    struct Option: Hashable {
        let value: String
        let label: String
    }

    /// What "Auto" sends. The panel resolves Auto at send time to these house
    /// defaults, so a conversation on Auto follows them if they change.
    static let autoModel = ["claude": "sonnet", "codex": "gpt-5.6-terra"]

    static let claudeModels: [Option] = [
        Option(value: "", label: "Auto (Sonnet)"),
        Option(value: "fable", label: "Fable"),
        Option(value: "opus", label: "Opus"),
        Option(value: "sonnet", label: "Sonnet"),
        Option(value: "haiku", label: "Haiku"),
    ]

    static let claudeEfforts = ["", "low", "medium", "high", "xhigh", "max", "ultracode"]

    static func effortLabel(_ e: String) -> String {
        switch e {
        case "": return "Auto effort"
        case "xhigh": return "Extra high"
        case "ultracode": return "Ultracode"
        default: return e.prefix(1).uppercased() + e.dropFirst()
        }
    }

    static func models(provider: String, codex: [CodexModel]) -> [Option] {
        guard provider == "codex" else { return claudeModels }
        let auto = codex.first { $0.slug == autoModel["codex"] }?.label ?? "Terra"
        return [Option(value: "", label: "Auto (\(auto))")] + codex.map { Option(value: $0.slug, label: $0.label) }
    }

    static func efforts(provider: String, model: String, codex: [CodexModel]) -> [String] {
        guard provider == "codex" else { return claudeEfforts }
        if let m = codex.first(where: { $0.slug == model }), let e = m.efforts { return [""] + e }
        // Auto: the union of what the models offer, in the usual order.
        let all = Set(codex.flatMap { $0.efforts ?? [] })
        return [""] + ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].filter(all.contains)
    }

    static func modelLabel(_ model: String?, provider: String, codex: [CodexModel]) -> String {
        let m = model ?? ""
        return models(provider: provider, codex: codex).first { $0.value == m }?.label ?? m
    }

    /// The model a turn runs on: the saved pick, else this provider's Auto default.
    static func effectiveModel(_ saved: String?, provider: String) -> String? {
        if let saved, !saved.isEmpty { return saved }
        return autoModel[provider]
    }
}
