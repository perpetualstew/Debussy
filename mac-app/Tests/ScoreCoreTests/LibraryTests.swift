import XCTest
import Foundation
@testable import ScoreCore

final class LibraryTests: XCTestCase {
    private struct Entry: Decodable {
        let slug: String
        let directory: String
        let measures: Int
    }
    private struct Catalog: Decodable { let pieces: [Entry] }
    func testAllFifteenScoresImportWithoutMusicalContentChanges() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/PianoLibraryMac/Resources",isDirectory:true)
        let catalog = try JSONDecoder().decode(Catalog.self,
            from:Data(contentsOf:root.appendingPathComponent("collection.json")))
        XCTAssertEqual(catalog.pieces.count, 15)
        var total=0
        for piece in catalog.pieces {
            let path=root.appendingPathComponent(piece.directory).appendingPathComponent("source.musicxml")
            let score=try ScoreTimeline(xml:Data(contentsOf:path))
            XCTAssertEqual(score.writtenMeasureCount,piece.measures, piece.slug)
            XCTAssertFalse(score.events.isEmpty,piece.slug)
            XCTAssertNotNil(score.ordered(staffKey:"part:0:staff:1").first,piece.slug)
            total += score.writtenMeasureCount
        }
        XCTAssertEqual(total,1280)
    }
}
