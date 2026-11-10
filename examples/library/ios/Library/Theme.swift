// PhaseLock's colors, as the web demo and phaselock.io use them: a near-neutral dark ground and
// text, and phosphor green as the one accent.

import SwiftUI

enum Palette {
    static let ground = Color(hex: 0x0B0F0D)
    static let panel = Color(hex: 0x18221E)
    static let border = Color(hex: 0x2C3A33)
    static let text = Color(hex: 0xE8ECE9)
    static let muted = Color(hex: 0x8A9A92)
    static let accent = Color(hex: 0x2EE6A8)
    static let onAccent = Color(hex: 0x0A1F18)
    static let amber = Color(hex: 0xF2D98C)
    static let alarm = Color(hex: 0xE5786D)
    // a button's ground, and its ground while pressed, a dark shade of the accent
    static let buttonGround = Color(hex: 0x0E0E0E)
    static let buttonPressed = Color(hex: 0x04120D)
    // a disabled button's border and text
    static let disabledBorder = Color(hex: 0x2A2A2A)
    static let disabledText = Color(hex: 0x5C5C5C)
}

extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xff) / 255,
            green: Double((hex >> 8) & 0xff) / 255,
            blue: Double(hex & 0xff) / 255
        )
    }
}

/** a color from the #rrggbb a patron's record holds, or muted gray for anything else */
func colorOf(_ hex: String) -> Color {
    guard hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else { return Palette.muted }
    return Color(hex: v)
}
