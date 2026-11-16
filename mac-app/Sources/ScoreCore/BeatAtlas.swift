import Foundation

/// A beat is a rhythmic interval, NOT a fixed-width slice of pixels. Every timing value
/// is an exact rational number of quarter notes. Review decisions are stored separately
/// from the provisional MusicXML so an incorrectly engraved symbol can't change music.
public struct AtlasNote: Codable, Equatable {
    public let id: String
    public let pitch: String
    public let voice: String
    public let offset: MusicalTime      // from the start of this beat
    public let duration: MusicalTime
    public let articulation: [String]
    public let tieContinuation: Bool
    public let isRest: Bool
    public let isGrace: Bool
    public let sourceX: Double?
}

public struct AtlasBoundaryNote: Codable, Equatable {
    public let originID: String
    public let pitch: String
    public let voice: String
    public let offset: MusicalTime
}

public struct BeatRecord: Codable, Equatable {
    public let id: String
    public let measure: Int
    public let printedMeasure: String
    public let staff: Int
    public let beat: Int
    public let begin: MusicalTime
    public let length: MusicalTime
    public let incoming: [AtlasBoundaryNote]
    public let events: [AtlasNote]
    public let releases: [AtlasBoundaryNote]
    public let measureWidth: Double
    /// X positions measured in the original MusicXML engraving coordinate system;
    /// used to register a beat crop to the scanned system, not to infer duration.
    public let visualAnchors: [Double]
}

public struct BeatAtlas: Codable {
    public let beats: [BeatRecord]

    private struct Span {
        var originID: String
        var pitch: String
        var voice: String
        var staff: Int
        var start: MusicalTime
        var end: MusicalTime
        var tied: Bool
    }

    public init(score: ScoreTimeline) {
        let lengths = score.measureLengths
        var measureStarts: [MusicalTime] = []
        var cumulative = MusicalTime.zero
        for len in lengths { measureStarts.append(cumulative); cumulative = cumulative + len }
        // Tie stop/start are note segments in the XML but not separate attacks/releases.
        // Join them across measure boundaries per part/staff/voice/pitch.
        let indexed = score.events.filter { !$0.isRest && !$0.isGrace && $0.duration > .zero }
            .sorted { a,b in
                let ta=measureStarts[a.measure]+a.onset, tb=measureStarts[b.measure]+b.onset
                if ta != tb { return ta < tb }
                return a.sourceOrder < b.sourceOrder
            }
        var open: [String: Int] = [:]
        var spans: [Span] = []
        for event in indexed {
            let key="\(event.part):\(event.staff):\(event.voice):\(event.pitch)"
            let start=measureStarts[event.measure]+event.onset
            let finish=start+event.duration
            if event.tieStop, let idx=open[key], spans[idx].end == start {
                spans[idx].end=finish
                if !event.tieStart { open.removeValue(forKey:key) }
            } else {
                spans.append(Span(originID:event.id,pitch:event.pitch,voice:event.voice,
                                  staff:event.staff,start:start,end:finish,tied:event.tieStart))
                if event.tieStart { open[key]=spans.count-1 } else { open.removeValue(forKey:key) }
            }
        }
        var result: [BeatRecord] = []
        for measure in lengths.indices {
            let length = lengths[measure]
            // Quarter-note counting for the present 4/4 collection. A future score's
            // compound meter is subdivided into exact quarter units here as well.
            let count = max(1, Int(ceil(Double(length.numerator)/Double(length.denominator))))
            for staff in [1,2] {
                for bi in 0..<count {
                    let begin = MusicalTime(bi)
                    if begin >= length { break }
                    let rest = length-begin
                    let beatLength = rest < MusicalTime(1) ? rest : MusicalTime(1)
                    let start=measureStarts[measure]+begin
                    let end=start+beatLength
                    let entering=spans.filter { $0.staff==staff && $0.start < start && $0.end > start }
                        .map { AtlasBoundaryNote(originID:$0.originID,pitch:$0.pitch,voice:$0.voice,offset:.zero) }
                    let outgoing=spans.filter { $0.staff==staff && $0.end > start && $0.end <= end }
                        .map { AtlasBoundaryNote(originID:$0.originID,pitch:$0.pitch,voice:$0.voice,offset:$0.end-start) }
                    let events=score.events.filter {
                        $0.measure==measure && $0.staff==staff && $0.onset >= begin && $0.onset < begin+beatLength
                    }.sorted { a,b in a.onset == b.onset ? a.sourceOrder < b.sourceOrder : a.onset < b.onset }
                    let pieces=events.map { ev in
                        AtlasNote(id:ev.id,pitch:ev.pitch,voice:ev.voice,offset:ev.onset-begin,
                                  duration:ev.duration,articulation:ev.articulations,
                                  tieContinuation:ev.tieStop,isRest:ev.isRest,isGrace:ev.isGrace,
                                  sourceX:ev.sourceX)
                    }
                    result.append(BeatRecord(id:"m\(measure):s\(staff):b\(bi)",measure:measure,
                        printedMeasure:score.events.first(where:{$0.measure==measure})?.printedNumber ?? "\(measure+1)",
                        staff:staff,beat:bi+1,begin:begin,length:beatLength,
                        incoming:entering,events:pieces,releases:outgoing,
                        measureWidth:measure < score.measureWidths.count ? score.measureWidths[measure] : 0,
                        visualAnchors:pieces.compactMap(\.sourceX)))
                }
            }
        }
        self.beats=result
    }
    public func forMeasures(_ range: ClosedRange<Int>) -> [BeatRecord] {
        beats.filter { range.contains($0.measure) }
    }
}
