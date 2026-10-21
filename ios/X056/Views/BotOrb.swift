import SwiftUI

/// How the Bot looks right now.
enum BotMood: Equatable {
    /// Not set up yet.
    case asleep
    case idle
    /// Its turn is running.
    case thinking
    /// Dictation is on.
    case listening
    /// Something in the constellation needs you.
    case attention

    /// How fast the gradient flows.
    var speed: Double {
        switch self {
        case .asleep: return 0.25
        case .idle: return 0.55
        case .thinking: return 1.6
        case .listening: return 0.9
        case .attention: return 0.7
        }
    }

    var palette: [Color] {
        switch self {
        case .asleep: return [Color(hex: 0x4B4A63), Color(hex: 0x6E6C8F), Color(hex: 0x8F8DA8), Color(hex: 0x3A3950)]
        case .idle: return [BotColors.violet, BotColors.teal, BotColors.sky, BotColors.peach, BotColors.deep]
        case .thinking: return [BotColors.violet, BotColors.sky, BotColors.teal, Color(hex: 0xB78CFF), BotColors.deep]
        case .listening: return [BotColors.teal, BotColors.sky, Color(hex: 0x7EF0D8), BotColors.violet, BotColors.deep]
        case .attention: return [BotColors.peach, Color(hex: 0xFFC46B), Color(hex: 0xFF7A8A), BotColors.violet, Color(hex: 0x5A2A4A)]
        }
    }

    var tint: Color { palette[0] }

    func label(named name: String) -> String {
        switch self {
        case .asleep: return "\(name), not set up"
        case .idle: return "\(name), ready"
        case .thinking: return "\(name), thinking"
        case .listening: return "\(name), listening"
        case .attention: return "\(name), something needs you"
        }
    }
}

enum BotColors {
    static let violet = Color(hex: 0x7C6CFF)
    static let teal = Color(hex: 0x3FD9C8)
    static let sky = Color(hex: 0x5AB4FF)
    static let peach = Color(hex: 0xFFA88A)
    static let deep = Color(hex: 0x2B2766)
    static let amber = Color(hex: 0xFFB547)
    static let rose = Color(hex: 0xFF6B7D)
}

/// The Bot's face: a living gradient sphere. It breathes when idle, swirls
/// when thinking, swells with your voice and warms when something needs you.
struct BotOrb: View {
    var mood: BotMood
    /// Microphone level, 0-1, while listening.
    var level: Double = 0
    var size: CGFloat = 140
    var name = "Bot"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate * mood.speed
            let breath = reduceMotion ? 1 : 1 + 0.025 * sin(t * 1.3)
            ZStack {
                // The glow it sits in.
                Self.mesh(t: t, palette: mood.palette)
                    .frame(width: size * 1.3, height: size * 1.3)
                    .clipShape(Circle())
                    .blur(radius: size * 0.3)
                    .opacity(mood == .asleep ? 0.25 : 0.65)
                if mood == .listening { Ripples(t: t, level: level, size: size) }
                Self.mesh(t: t, palette: mood.palette)
                    .frame(width: size, height: size)
                    .clipShape(Circle())
                    // A highlight up and to the left, a shade down and right:
                    // a sphere, not a disc.
                    .overlay {
                        Circle().fill(RadialGradient(colors: [.white.opacity(0.55), .clear], center: UnitPoint(x: 0.32, y: 0.26), startRadius: 0, endRadius: size * 0.5))
                            .blendMode(.softLight)
                    }
                    .overlay {
                        Circle().fill(RadialGradient(colors: [.clear, .black.opacity(0.28)], center: UnitPoint(x: 0.4, y: 0.35), startRadius: size * 0.3, endRadius: size * 0.62))
                    }
                    .overlay(Circle().strokeBorder(.white.opacity(0.25), lineWidth: 1))
                    .shadow(color: mood.tint.opacity(0.5), radius: size * 0.16, y: size * 0.05)
                    .scaleEffect(breath * (1 + 0.16 * level))
                if mood == .thinking { Sparks(t: t, size: size) }
            }
            .frame(width: size * 1.55, height: size * 1.55)
        }
        .accessibilityElement()
        .accessibilityLabel(mood.label(named: name))
        .animation(.smooth(duration: 0.6), value: mood)
    }

    /// A 3x3 mesh whose middle points wander, its colours drifting round the palette.
    static func mesh(t: Double, palette: [Color]) -> MeshGradient {
        func p(_ x: Double, _ y: Double) -> SIMD2<Float> { SIMD2(Float(x), Float(y)) }
        let a = 0.12
        let colors: [Color] = (0..<9).map { i in
            let f = (Double(i) * 0.37 + t * 0.05).truncatingRemainder(dividingBy: 1) * Double(palette.count)
            let lo = Int(f) % palette.count, hi = (lo + 1) % palette.count
            return palette[lo].mix(with: palette[hi], by: f - floor(f))
        }
        return MeshGradient(width: 3, height: 3, points: [
            p(0, 0), p(0.5 + a * sin(t * 0.8), 0), p(1, 0),
            p(0, 0.5 + a * cos(t * 0.7)), p(0.5 + 0.18 * sin(t * 1.1), 0.5 + 0.18 * cos(t * 0.9)), p(1, 0.5 + a * sin(t * 0.6)),
            p(0, 1), p(0.5 + a * cos(t * 1.0), 1), p(1, 1),
        ], colors: colors)
    }
}

/// Rings that spread out from the orb while it listens, bigger when you speak.
private struct Ripples: View {
    let t: Double
    let level: Double
    let size: CGFloat

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { i in
                let phase = (t * 0.6 + Double(i) / 3).truncatingRemainder(dividingBy: 1)
                Circle()
                    .stroke(BotColors.teal.opacity((1 - phase) * (0.35 + level * 0.5)), lineWidth: 1.5)
                    .frame(width: size * (1 + phase * (0.45 + level * 0.4)), height: size * (1 + phase * (0.45 + level * 0.4)))
            }
        }
    }
}

/// Small lights circling the orb while it thinks.
private struct Sparks: View {
    let t: Double
    let size: CGFloat

    var body: some View {
        Canvas { ctx, canvas in
            let c = CGPoint(x: canvas.width / 2, y: canvas.height / 2)
            for i in 0..<10 {
                let r = size * (0.62 + 0.08 * Double(i % 3))
                let a = t * (0.9 + 0.12 * Double(i % 4)) + Double(i) * .pi / 5
                let p = CGPoint(x: c.x + r * cos(a), y: c.y + r * 0.42 * sin(a))
                let front = sin(a) > 0
                let d: CGFloat = front ? 4 : 2.5
                ctx.fill(Path(ellipseIn: CGRect(x: p.x - d / 2, y: p.y - d / 2, width: d, height: d)),
                         with: .color(.white.opacity(front ? 0.9 : 0.35)))
            }
        }
        .frame(width: size * 1.55, height: size * 1.55)
        .allowsHitTesting(false)
    }
}

/// A conversation in the constellation.
struct BotNode: Identifiable, Hashable {
    let projectId: String
    let sessionId: String
    let title: String
    let state: WorkState
    var id: String { sessionId }

    var color: Color {
        switch state {
        case .running: return BotColors.teal
        case .background: return BotColors.violet
        case .needsYou: return BotColors.amber
        case .failed: return BotColors.rose
        case .idle: return BotColors.sky
        }
    }
}

/// Your work, orbiting the Bot: every running or waiting conversation is a
/// light on one of two tilted orbits, passing behind the orb and in front of
/// it. What needs you is labelled and pulses. Tap one to open it.
struct Constellation: View {
    let nodes: [BotNode]
    var mood: BotMood
    var level: Double = 0
    var orbSize: CGFloat = 132
    var botName = "Bot"
    var open: (BotNode) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { ctx in
            let t = ctx.date.timeIntervalSinceReferenceDate
            GeometryReader { geo in
                let c = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
                let orbits = [CGSize(width: geo.size.width * 0.3, height: geo.size.height * 0.2),
                              CGSize(width: geo.size.width * 0.45, height: geo.size.height * 0.33)]
                ZStack {
                    ForEach(0..<2, id: \.self) { o in
                        Ellipse()
                            .stroke(Color.primary.opacity(0.09), style: StrokeStyle(lineWidth: 1, dash: o == 0 ? [] : [2, 5]))
                            .frame(width: orbits[o].width * 2, height: orbits[o].height * 2)
                            .position(c)
                    }
                    let shown = nodes.isEmpty ? Self.ambient : nodes
                    ForEach(Array(shown.enumerated()), id: \.element.id) { i, node in
                        let o = i % 2
                        let period: Double = o == 0 ? 48 : 74
                        let a = Double(i) / Double(max(shown.count, 1)) * 2 * .pi + t / period * 2 * .pi * (o == 0 ? 1 : -0.8)
                        let depth = sin(a)
                        let ambient = nodes.isEmpty
                        NodeLight(node: node, depth: depth, ambient: ambient, t: t)
                            .position(x: c.x + orbits[o].width * cos(a), y: c.y + orbits[o].height * depth)
                            .zIndex(depth > 0 ? 2 : 0)
                            .onTapGesture { if !ambient { open(node) } }
                    }
                    BotOrb(mood: mood, level: level, size: orbSize, name: botName)
                        .position(c)
                        .zIndex(1)
                }
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// Faint lights when nothing is running, so the sky is never empty.
    private static let ambient: [BotNode] = (0..<6).map {
        BotNode(projectId: "", sessionId: "ambient-\($0)", title: "", state: .idle)
    }
}

private struct NodeLight: View {
    let node: BotNode
    let depth: Double
    let ambient: Bool
    let t: Double

    var body: some View {
        let near = (depth + 1) / 2
        let d: CGFloat = ambient ? 4 + 3 * near : 9 + 6 * near
        let urgent = node.state == .needsYou || node.state == .failed
        VStack(spacing: 4) {
            ZStack {
                if urgent {
                    Circle()
                        .stroke(node.color.opacity(0.6 * (1 - (t * 0.8).truncatingRemainder(dividingBy: 1))), lineWidth: 1.5)
                        .frame(width: d * (1.6 + (t * 0.8).truncatingRemainder(dividingBy: 1)), height: d * (1.6 + (t * 0.8).truncatingRemainder(dividingBy: 1)))
                }
                Circle()
                    .fill(node.color.gradient)
                    .frame(width: d, height: d)
                    .shadow(color: node.color.opacity(ambient ? 0.3 : 0.9), radius: ambient ? 3 : 7)
            }
            if urgent, depth > -0.2, !node.title.isEmpty {
                Text(node.title)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.ultraThinMaterial, in: .capsule)
                    .frame(maxWidth: 130)
            }
        }
        .opacity(ambient ? 0.25 + 0.3 * near : 0.45 + 0.55 * near)
        .contentShape(Circle().inset(by: -14))
        .accessibilityElement()
        .accessibilityLabel(ambient ? "" : "\(node.title), \(Self.stateLabel(node.state))")
        .accessibilityAddTraits(ambient ? [] : .isButton)
        .accessibilityHidden(ambient)
    }

    static func stateLabel(_ s: WorkState) -> String {
        switch s {
        case .running: return "running"
        case .background: return "working in the background"
        case .needsYou: return "needs you"
        case .failed: return "failed"
        case .idle: return "idle"
        }
    }
}

/// The Bot's sky: a soft aurora by day, deep space with a few stars by night.
struct BotBackdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let dark = scheme == .dark
        ZStack {
            LinearGradient(colors: dark ? [Color(hex: 0x06060E), Color(hex: 0x110D24)] : [Color(hex: 0xF7F6FF), Color(hex: 0xEDF6F5)],
                           startPoint: .top, endPoint: .bottom)
            Circle().fill(BotColors.violet.opacity(dark ? 0.32 : 0.18)).frame(width: 440, height: 440).blur(radius: 120).offset(x: -150, y: -280)
            Circle().fill(BotColors.teal.opacity(dark ? 0.22 : 0.16)).frame(width: 380, height: 380).blur(radius: 120).offset(x: 170, y: -120)
            Circle().fill(BotColors.peach.opacity(dark ? 0.12 : 0.12)).frame(width: 320, height: 320).blur(radius: 110).offset(x: -60, y: 340)
            if dark {
                Canvas { ctx, size in
                    var seed: UInt64 = 0x9E3779B97F4A7C15
                    func next() -> Double {
                        seed = seed &* 6364136223846793005 &+ 1442695040888963407
                        return Double(seed >> 33) / Double(1 << 31)
                    }
                    for _ in 0..<70 {
                        let p = CGPoint(x: next() * size.width, y: next() * size.height)
                        let d = 0.6 + next() * 1.4
                        ctx.fill(Path(ellipseIn: CGRect(x: p.x, y: p.y, width: d, height: d)), with: .color(.white.opacity(0.15 + next() * 0.45)))
                    }
                }
            }
        }
        .ignoresSafeArea()
    }
}
