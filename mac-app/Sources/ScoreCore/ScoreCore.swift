import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

public struct MusicalTime: Hashable, Comparable, Codable {
    public let numerator: Int
    public let denominator: Int
    public init(_ numerator: Int, _ denominator: Int = 1) {
        precondition(denominator > 0)
        let gcd = Self.gcd(abs(numerator), denominator)
        self.numerator = numerator / gcd
        self.denominator = denominator / gcd
    }
    private static func gcd(_ a: Int, _ b: Int) -> Int {
        var a = a, b = b
        while b != 0 { (a, b) = (b, a % b) }
        return max(1, a)
    }
    public static func +(l: Self, r: Self) -> Self { Self(l.numerator*r.denominator+r.numerator*l.denominator, l.denominator*r.denominator) }
    public static func -(l: Self, r: Self) -> Self { Self(l.numerator*r.denominator-r.numerator*l.denominator, l.denominator*r.denominator) }
    public static func <(l: Self, r: Self) -> Bool { l.numerator*r.denominator < r.numerator*l.denominator }
    public static let zero = MusicalTime(0)
}

public struct MusicalEvent: Hashable, Codable {
    public let id: String
    public let part: Int
    public let staff: Int
    public let voice: String
    public let measure: Int       // 0-based written measure, not the printed number
    public let printedNumber: String
    public let onset: MusicalTime
    public let sourceOrder: Int
    public let pitch: String
    public let isRest: Bool
    public let isGrace: Bool
    public let duration: MusicalTime
    public let tieStart: Bool
    public let tieStop: Bool
    public let articulations: [String]
    public let sourceX: Double?

    public var staffKey: String { "part:\(part):staff:\(staff)" }
}

private final class Node {
    let name: String
    let attributes: [String: String]
    var children: [Node] = []
    var contents = ""
    init(_ name: String, _ attributes: [String: String]) { self.name = name; self.attributes = attributes }
    func first(_ name: String) -> Node? { children.first { $0.name == name } }
    func all(_ name: String) -> [Node] { children.filter { $0.name == name } }
    func string(_ name: String, _ fallback: String = "") -> String { first(name)?.contents.trimmingCharacters(in: .whitespacesAndNewlines) ?? fallback }
}
private final class TreeBuilder: NSObject, XMLParserDelegate {
    var roots: [Node] = []
    var stack: [Node] = []
    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String]) {
        let node = Node(elementName, attributeDict)
        if let parent = stack.last { parent.children.append(node) } else { roots.append(node) }
        stack.append(node)
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { stack.last?.contents += string }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) { if !stack.isEmpty { stack.removeLast() } }
}

public enum ScoreError: Error, CustomStringConvertible {
    case invalidXML, noParts
    public var description: String { switch self { case .invalidXML: return "MusicXML could not be parsed"; case .noParts: return "No MusicXML parts found" } }
}

public struct ScoreTimeline {
    public let events: [MusicalEvent]
    public let writtenMeasureCount: Int
    public let measureLengths: [MusicalTime]
    public let measureWidths: [Double]
    public init(xml: Data) throws {
        let parser = XMLParser(data: xml)
        let builder = TreeBuilder()
        parser.delegate = builder
        guard parser.parse(), let root = builder.roots.first, root.name == "score-partwise" else { throw ScoreError.invalidXML }
        let parts = root.all("part")
        guard !parts.isEmpty else { throw ScoreError.noParts }
        var list: [MusicalEvent] = []
        var maxMeasure = 0
        var lengths: [MusicalTime] = []
        var widths: [Double] = []
        for (pi, part) in parts.enumerated() {
            let measures = part.all("measure")
            maxMeasure = max(maxMeasure, measures.count)
            var divisions = 1
            var currentMeter = MusicalTime(4)
            for (mi, measure) in measures.enumerated() {
                if pi == 0 { widths.append(Double(measure.attributes["width"] ?? "") ?? 0) }
                var cursor = MusicalTime.zero
                var lastChordOnset = MusicalTime.zero
                var order = 0
                for item in measure.children {
                    switch item.name {
                    case "attributes":
                        if let d = Int(item.string("divisions")), d > 0 { divisions = d }
                        if let time = item.first("time"), let b = Int(time.string("beats")),
                           let t = Int(time.string("beat-type")), t > 0 { currentMeter = MusicalTime(b*4,t) }
                    case "backup":
                        let duration = Int(item.string("duration")) ?? 0
                        cursor = cursor - MusicalTime(duration, divisions)
                    case "forward":
                        let duration = Int(item.string("duration")) ?? 0
                        cursor = cursor + MusicalTime(duration, divisions)
                    case "note":
                        let grace = item.first("grace") != nil
                        let chord = item.first("chord") != nil
                        let rest = item.first("rest") != nil
                        let onset = chord ? lastChordOnset : cursor
                        let staff = max(1, Int(item.string("staff", "1")) ?? 1)
                        let voice = item.string("voice", "1")
                        let pitchNode = item.first("pitch")
                        let pname = pitchNode?.string("step") ?? ""
                        let octave = pitchNode?.string("octave") ?? ""
                        let alter = Int(pitchNode?.string("alter") ?? "0") ?? 0
                        let pitch = rest ? "Rest" : (pname + (alter > 0 ? String(repeating: "♯", count: alter) : (alter < 0 ? String(repeating: "♭", count: -alter) : "")) + octave)
                        let noteDuration = grace ? MusicalTime.zero : MusicalTime(Int(item.string("duration")) ?? 0, divisions)
                        let ties = item.all("tie").compactMap { $0.attributes["type"] }
                        let articulations = item.first("notations")?.first("articulations")?.children.map { $0.name } ?? []
                        list.append(MusicalEvent(id: "p\(pi)-m\(mi)-n\(order)",part: pi,staff: staff,voice: voice,measure: mi,printedNumber: measure.attributes["number"] ?? "\(mi+1)",onset:onset,sourceOrder:order,pitch:pitch,isRest:rest,isGrace:grace,duration:noteDuration,tieStart:ties.contains("start"),tieStop:ties.contains("stop"),articulations:articulations,sourceX:Double(item.attributes["default-x"] ?? "")))
                        if !chord { lastChordOnset = cursor }
                        if !chord && !grace { cursor = cursor + MusicalTime(Int(item.string("duration")) ?? 0, divisions) }
                        order += 1
                    default: break
                    }
                }
                if pi == 0 { lengths.append(currentMeter) }
            }
        }
        self.measureLengths = lengths
        self.measureWidths = widths
        self.events = list
        self.writtenMeasureCount = maxMeasure
    }
    public func ordered(staffKey: String) -> [MusicalEvent] {
        events.filter { $0.staffKey == staffKey }.sorted { a,b in
            if a.measure != b.measure { return a.measure < b.measure }
            if a.onset != b.onset { return a.onset < b.onset }
            if a.voice != b.voice { return a.voice < b.voice }
            return a.sourceOrder < b.sourceOrder
        }
    }
}

public final class SelectionSession {
    public let score: ScoreTimeline
    public private(set) var selectedID: String?
    private var steps: [String?] = []
    private var cursor = -1
    public init(score: ScoreTimeline) { self.score = score }
    public var selected: MusicalEvent? { score.events.first { $0.id == selectedID } }
    public var canUndo: Bool { cursor > 0 }
    public var canRedo: Bool { cursor + 1 < steps.count }
    public func select(_ id: String?) {
        guard id == nil || score.events.contains(where: { $0.id == id }) else { return }
        guard id != selectedID || cursor == -1 else { return }
        if cursor + 1 < steps.count { steps.removeSubrange((cursor+1)..<steps.count) }
        steps.append(id);cursor = steps.count - 1; selectedID = id
    }
    public func selectFirst(staff: Int = 1, part: Int = 0) {
        let track = score.ordered(staffKey: "part:\(part):staff:\(staff)")
        select(track.first?.id)
    }
    public func move(_ amount: Int) {
        guard let old = selected else { selectFirst(); return }
        let track = score.ordered(staffKey: old.staffKey)
        guard let index = track.firstIndex(where: {$0.id == old.id}) else { return }
        let target = index + amount
        if track.indices.contains(target) { select(track[target].id) }
    }
    public func undo() { guard canUndo else { return };cursor -= 1;selectedID = steps[cursor] }
    public func redo() { guard canRedo else { return };cursor += 1;selectedID = steps[cursor] }
}
