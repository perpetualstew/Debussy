import XCTest
@testable import ScoreCore

final class LibraryNavigationTests: XCTestCase {
    func testInsidePieceAndCrossPiece() {
        let counts=[17,23,18]
        XCTAssertEqual(LibrarySystemNavigator.destination(piece:1, system:11, step:1, systemCounts:counts), LibrarySystemLocation(piece:1,system:12))
        XCTAssertEqual(LibrarySystemNavigator.destination(piece:1, system:0, step:-1, systemCounts:counts), LibrarySystemLocation(piece:0,system:16))
        XCTAssertEqual(LibrarySystemNavigator.destination(piece:1, system:22, step:1, systemCounts:counts), LibrarySystemLocation(piece:2,system:0))
    }
    func testCollectionWrapAround() {
        let counts=[17,23,18]
        XCTAssertEqual(LibrarySystemNavigator.destination(piece:2, system:17, step:1, systemCounts:counts), LibrarySystemLocation(piece:0,system:0))
        XCTAssertEqual(LibrarySystemNavigator.destination(piece:0, system:0, step:-1, systemCounts:counts), LibrarySystemLocation(piece:2,system:17))
    }
    func testInvalidPositionFailsSafely() {
        XCTAssertNil(LibrarySystemNavigator.destination(piece:2,system:18,step:1,systemCounts:[17,23,18]))
        XCTAssertNil(LibrarySystemNavigator.destination(piece:0,system:0,step:0,systemCounts:[17]))
    }
}
