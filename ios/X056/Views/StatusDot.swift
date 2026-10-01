import SwiftUI

/// The panel's busy colours: accent for a running turn, violet for background
/// work with no turn behind it.
struct WorkingIndicator: View {
    let running: Bool
    let background: Bool

    var body: some View {
        if running {
            ProgressView().controlSize(.small)
        } else if background {
            ProgressView().controlSize(.small).tint(.purple)
        }
    }
}

extension Double {
    /// Epoch milliseconds as a short relative time ("5 min. ago").
    var relativeFromMillis: String {
        Date(timeIntervalSince1970: self / 1000).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }
}
