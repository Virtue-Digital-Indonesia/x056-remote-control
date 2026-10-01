import SwiftUI

/// The agent roles' colours, as in the panel's tree: main session orange,
/// subagents blue, Jev green, advisor purple, delegates teal.
enum RoleColor {
    static let main = Color.orange
    static let sub = Color.blue
    static let jev = Color.green
    static let advisor = Color.purple
    static let delegate = Color.teal
}

/// A Settings-style symbol tile.
struct IconTile: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 30

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.48, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(color.gradient, in: .rect(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

/// Effort as four rising bars, like a signal meter; none lit for Auto.
struct EffortMeter: View {
    let level: Int
    var color: Color = RoleColor.main
    var height: CGFloat = 14

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(1...4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(i <= level ? AnyShapeStyle(color) : AnyShapeStyle(.quaternary))
                    .frame(width: height * 0.3, height: height * (0.4 + 0.2 * CGFloat(i - 1)))
            }
        }
        .frame(height: height, alignment: .bottom)
        .accessibilityHidden(true)
    }
}

/// A grouped card with a role tint: a hairline in the role's colour and a
/// faint wash, so the pipeline reads by colour like the panel's outline.
struct RoleCard<Content: View>: View {
    let color: Color
    var dashed = false
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
            .background(color.opacity(0.06), in: .rect(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(color.opacity(dashed ? 0.6 : 0.35), style: StrokeStyle(lineWidth: dashed ? 1.5 : 1, dash: dashed ? [6, 5] : []))
            }
    }
}

/// A thin capsule meter for a 0-1 confidence.
struct ConfidenceMeter: View {
    let value: Double?
    var color: Color = RoleColor.jev

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule().fill(color).frame(width: geo.size.width * CGFloat(min(max(value ?? 0, 0), 1)))
            }
        }
        .frame(height: 6)
        .accessibilityLabel(value.map { "Confidence \(Int(($0 * 100).rounded())) percent" } ?? "Confidence unknown")
    }
}

/// Lays chips out in rows, wrapping to the width it is given.
struct FlowRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0 && x + s.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            x += s.width + spacing
            rowH = max(rowH, s.height)
            maxX = max(maxX, x - spacing)
        }
        return CGSize(width: min(maxX, width), height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX && x + s.width > bounds.maxX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowH = max(rowH, s.height)
        }
    }
}
