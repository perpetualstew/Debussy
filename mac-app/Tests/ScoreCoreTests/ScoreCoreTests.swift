import XCTest
@testable import ScoreCore

final class ScoreCoreTests: XCTestCase {
    let fixture = """
    <score-partwise version="4.0"><part id="P1">
      <measure number="1"><attributes><divisions>12</divisions></attributes>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><staff>1</staff></note>
        <note><pitch><step>D</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><staff>1</staff></note>
        <backup><duration>24</duration></backup>
        <note><pitch><step>C</step><octave>3</octave></pitch><duration>12</duration><voice>2</voice><staff>2</staff></note>
      </measure>
      <measure number="2"><note><pitch><step>E</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><staff>1</staff></note>
        <backup><duration>12</duration></backup><note><rest/><duration>12</duration><voice>2</voice><staff>2</staff></note></measure>
    </part></score-partwise>
    """
    func testRationalTime() {
        XCTAssertEqual(MusicalTime(2,3), MusicalTime(4,6))
        XCTAssertEqual(MusicalTime(1,3)+MusicalTime(1,6), MusicalTime(1,2))
        XCTAssertEqual(MusicalTime(1,2)-MusicalTime(3,4), MusicalTime(-1,4))
    }
    func testStaffTraversalCrossesBarlinesWithoutChangingHands() throws {
        let s = SelectionSession(score: try ScoreTimeline(xml: Data(fixture.utf8)))
        s.selectFirst()
        XCTAssertEqual(s.selected?.pitch,"C5")
        s.move(1);XCTAssertEqual(s.selected?.pitch,"D5")
        s.move(1);XCTAssertEqual(s.selected?.pitch,"E5")
        XCTAssertEqual(s.selected?.measure,1)
        XCTAssertEqual(s.selected?.staff,1)
        s.move(1);XCTAssertEqual(s.selected?.pitch,"E5")
        s.move(-2);XCTAssertEqual(s.selected?.pitch,"C5")
    }
    func testLeftHandAndUndoSelectionHistory() throws {
        let s=SelectionSession(score:try ScoreTimeline(xml:Data(fixture.utf8)))
        s.selectFirst(staff:2)
        XCTAssertEqual(s.selected?.pitch,"C3")
        s.move(1);XCTAssertEqual(s.selected?.pitch,"Rest")
        s.undo();XCTAssertEqual(s.selected?.pitch,"C3")
        s.redo();XCTAssertEqual(s.selected?.pitch,"Rest")
        s.undo();s.selectFirst(staff:1)
        XCTAssertFalse(s.canRedo)
    }
    func testChordsShareOnsetAndGraceHasNoDuration() throws {
        let extra = """
        <score-partwise><part id="P1"><measure number="1"><attributes><divisions>12</divisions></attributes>
        <note><grace slash="yes"/><pitch><step>A</step><octave>4</octave></pitch><voice>1</voice><staff>1</staff></note>
        <note><pitch><step>C</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><staff>1</staff></note>
        <note><chord/><pitch><step>E</step><octave>5</octave></pitch><duration>12</duration><voice>1</voice><staff>1</staff></note></measure></part></score-partwise>
        """
        let notes=try ScoreTimeline(xml:Data(extra.utf8)).events
        XCTAssertEqual(notes.count,3)
        XCTAssertEqual(notes[0].onset,.zero)
        XCTAssertEqual(notes[1].onset,notes[2].onset)
        XCTAssertTrue(notes[0].isGrace)
    }
}
