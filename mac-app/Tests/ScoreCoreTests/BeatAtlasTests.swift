import XCTest
@testable import ScoreCore

final class BeatAtlasTests: XCTestCase {
    func testRationalBeatMappingWithTieAndChord() throws {
        let xml="""
        <score-partwise><part id="P1">
        <measure number="1" width="400"><attributes><divisions>12</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
          <note default-x="100"><pitch><step>C</step><octave>4</octave></pitch><duration>48</duration><voice>1</voice><staff>1</staff><tie type="start"/></note>
          <backup><duration>24</duration></backup>
          <note default-x="220"><pitch><step>E</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice><staff>1</staff><notations><articulations><staccato/></articulations></notations></note>
          <note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>6</duration><voice>1</voice><staff>1</staff></note>
          <note><rest/><duration>18</duration><voice>1</voice><staff>1</staff></note>
        </measure>
        <measure number="2" width="240"><note default-x="50"><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><staff>1</staff><tie type="stop"/></note></measure>
        </part></score-partwise>
        """
        let score=try ScoreTimeline(xml:Data(xml.utf8))
        let atlas=BeatAtlas(score:score)
        XCTAssertEqual(atlas.beats.count,16)
        let b2=atlas.beats.first{$0.measure==0 && $0.staff==1 && $0.beat==2}!
        XCTAssertEqual(b2.incoming.map(\.pitch),["C4"])
        let b3=atlas.beats.first{$0.measure==0 && $0.staff==1 && $0.beat==3}!
        XCTAssertEqual(b3.events.map(\.pitch),["E4","G4","Rest"])
        XCTAssertEqual(b3.events[0].articulation,["staccato"])
        XCTAssertEqual(b3.events[0].duration,MusicalTime(1,2))
        let firstNext=atlas.beats.first{$0.measure==1 && $0.staff==1 && $0.beat==1}!
        XCTAssertEqual(firstNext.events[0].tieContinuation,true)
        XCTAssertTrue(firstNext.incoming.contains(where:{$0.pitch=="C4"}))
        XCTAssertEqual(firstNext.releases.map(\.pitch),["C4"])
    }
    func testRealScoreHasExactBeatAtlas() throws {
        let url=URL(fileURLWithPath:#filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/PianoLibraryMac/Resources/source.musicxml").standardizedFileURL
        let timeline=try ScoreTimeline(xml:Data(contentsOf:url))
        let atlas=BeatAtlas(score:timeline)
        XCTAssertEqual(timeline.writtenMeasureCount,88)
        XCTAssertEqual(atlas.beats.count,528)
        XCTAssertTrue(atlas.beats.allSatisfy{$0.length==MusicalTime(1)})
        XCTAssertTrue(atlas.beats.contains(where: { $0.staff==1 && $0.events.contains(where: {$0.voice != "1"}) }))
    }
}
