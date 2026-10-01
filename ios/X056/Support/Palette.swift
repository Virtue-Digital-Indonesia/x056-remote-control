import SwiftUI
import UIKit

/// The panel's own colour tokens (server/public/panel.html :root), light and
/// dark, so the app and the panel read as one product.
enum Palette {
    static let paper = Color(light: 0xFDFCFB, dark: 0x1C1B19)
    static let surface = Color(light: 0xF3F1ED, dark: 0x262421)
    static let line = Color(light: 0xE6E1DA, dark: 0x34302B)
    static let ink = Color(light: 0x282521, dark: 0xEEEAE3)
    static let stone = Color(light: 0x6E675F, dark: 0xB6AFA5)
    static let clay = Color(light: 0xAC4B30, dark: 0xE39778)
    static let clayWeak = Color(light: 0xF6E8E0, dark: 0x38271F)
    static let onClay = Color(light: 0xFFFFFF, dark: 0x211915)
    static let ok = Color(light: 0x15803D, dark: 0x4ADE80)
    static let warn = Color(light: 0xB45309, dark: 0xFBBF24)
    static let err = Color(light: 0xB91C1C, dark: 0xF87171)

    /// The app icon's gradient and glyph colour, the same in both modes.
    static let iconTop = Color(hex: 0xDD7B5F)
    static let iconBottom = Color(hex: 0xB4532F)
    static let iconGlyph = Color(hex: 0xFDEEE6)
}

extension Color {
    init(hex: UInt32) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }

    init(light: UInt32, dark: UInt32) {
        self.init(UIColor { traits in
            UIColor(Color(hex: traits.userInterfaceStyle == .dark ? dark : light))
        })
    }
}
