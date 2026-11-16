import Foundation

/// A system location in the ordered 15-arrangement library.
public struct LibrarySystemLocation: Equatable {
    public let piece: Int
    public let system: Int
    public init(piece: Int, system: Int) { self.piece = piece; self.system = system }
}

/// Independent of AppKit, selection state, and score loading. Reused by buttons
/// and Shift+arrows, so neither can stop silently at a piece boundary.
public enum LibrarySystemNavigator {
    public static func destination(piece: Int, system: Int, step: Int,
                                   systemCounts: [Int]) -> LibrarySystemLocation? {
        guard !systemCounts.isEmpty, systemCounts.allSatisfy({$0 > 0}),
              systemCounts.indices.contains(piece),
              (0..<systemCounts[piece]).contains(system), (step == -1 || step == 1) else {
            return nil
        }
        let within = system + step
        if (0..<systemCounts[piece]).contains(within) {
            return LibrarySystemLocation(piece:piece, system:within)
        }
        let nextPiece = (piece + step + systemCounts.count) % systemCounts.count
        return LibrarySystemLocation(piece:nextPiece,
                                     system:step > 0 ? 0 : systemCounts[nextPiece] - 1)
    }
}
