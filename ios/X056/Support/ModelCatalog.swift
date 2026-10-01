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
        Option(value: "opus", label: "Opus 5.5"),
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

    /// A model id as people read it: "claude-opus-5-5-…" → "Opus 5.5",
    /// "sonnet" → "Sonnet", "gpt-6-astra" → "Astra".
    static func displayName(_ id: String) -> String {
        let lower = id.lowercased()
        for family in ["opus", "sonnet", "haiku", "fable"] {
            guard let r = lower.range(of: family) else { continue }
            let rest = lower[r.upperBound...].split(separator: "-").prefix(2).filter { $0.allSatisfy(\.isNumber) && $0.count <= 2 }
            let name = family.prefix(1).uppercased() + family.dropFirst()
            return rest.isEmpty ? name : name + " " + rest.joined(separator: ".")
        }
        // "gpt-6.1-sol" → "GPT-6.1 Sol"
        if lower.hasPrefix("gpt-") {
            let parts = lower.split(separator: "-").dropFirst()
            let version = parts.first.map(String.init) ?? ""
            let names = parts.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }
            return (["GPT-" + version] + names).joined(separator: " ")
        }
        return id
    }

    /// The panel's one-line model descriptions (panel.html MODEL_DESC).
    static func description(_ model: String, provider: String) -> String {
        switch model {
        case "": return provider == "codex" ? "House default, Terra" : "House default, Sonnet"
        case "fable": return "Frontier model, for the hardest problems"
        case "opus": return "Deep reasoning for long, multi-step work"
        case "sonnet": return "Balanced and quick, the everyday choice"
        case "haiku": return "Fastest and cheapest, for small edits"
        case "gpt-6-astra": return "Strongest, for long multi-step work"
        case "gpt-6.1-sol": return "Newest frontier model, rolling out by plan"
        case "gpt-5.6-terra": return "Fast and balanced, the house default"
        default: return ""
        }
    }

    static func symbol(_ model: String) -> String {
        let m = model.lowercased()
        if m.isEmpty { return "wand.and.sparkles" }
        if m.contains("fable") { return "sparkles" }
        if m.contains("opus") { return "brain" }
        if m.contains("sonnet") { return "bolt" }
        if m.contains("haiku") { return "hare" }
        if m.contains("astra") { return "star" }
        if m.contains("sol") { return "sun.max" }
        if m.contains("terra") { return "globe.asia.australia" }
        if m.contains("luna") { return "moon" }
        return "cpu"
    }

    /// 1-4 bars, like the panel's effort meter; 0 for Auto.
    static func effortLevel(_ e: String) -> Int {
        switch e {
        case "minimal", "low": return 1
        case "medium": return 2
        case "high": return 3
        case "xhigh", "max", "ultra", "ultracode": return 4
        default: return 0
        }
    }

    static func effortShort(_ e: String) -> String {
        switch e {
        case "": return "Auto"
        case "medium": return "Med"
        case "xhigh": return "X-high"
        default: return effortLabel(e)
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
