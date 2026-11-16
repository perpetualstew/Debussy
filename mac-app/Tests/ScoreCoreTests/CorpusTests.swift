import Foundation
import XCTest
@testable import ScoreCore

final class CorpusTests: XCTestCase {
    func testRealMusicXMLImportsAndTravelsOnSameStaff() throws {
        let thisFile = URL(fileURLWithPath: #filePath)
        let path = thisFile.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/PianoLibraryMac/Resources/source.musicxml")
        let score = try ScoreTimeline(xml: Data(contentsOf: path))
        XCTAssertEqual(score.writtenMeasureCount, 88)
        XCTAssertGreaterThan(score.events.count, 900)
        XCTAssertTrue(score.events.contains { $0.staff == 1 })
        XCTAssertTrue(score.events.contains { $0.staff == 2 })
        let firstTrack = score.ordered(staffKey: "part:0:staff:1")
        XCTAssertTrue(zip(firstTrack,firstTrack.dropFirst()).allSatisfy { $0.measure <= $1.measure })
        let session = SelectionSession(score: score)
        session.selectFirst()
        for _ in 0..<200 { session.move(1) }
        XCTAssertEqual(session.selected?.staff, 1)
        XCTAssertGreaterThan(session.selected?.measure ?? 0, 1)
        session.undo()
        XCTAssertEqual(session.selected?.staff, 1)
    }
}
