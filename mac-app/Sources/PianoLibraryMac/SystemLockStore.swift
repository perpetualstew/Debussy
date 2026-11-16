#if os(macOS)
import Foundation
import CryptoKit

/// The approved *appearance*, not just the instructions used to regenerate it.
/// Source excerpt and reference scan checksums prevent a newer app from silently
/// combining an old locked engraving with changed musical/scan source data.
private func lockSHA256(_ bytes: Data) -> String {
    SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
}

struct SystemLockPayload: Codable {
    let schema: Int
    let pieceSlug: String
    let first: Int
    let last: Int
    let sourceCatalogSHA256: String // provenance; other systems may change
    let excerptSHA256: String
    let scanSHA256: String
    let svg: String
    let staffRules: String
    let staffRulesAttributes: [String: String]
    let staffSizePercent: Double
    let viewportWidth: Double
    let notationHeight: Double
    let paneHeight: Double
    let mappedEvents: Int
    let savedAt: String
}

struct SystemLockDocument: Codable {
    let payload: SystemLockPayload
    let sha256: String

    static func signed(_ payload: SystemLockPayload) throws -> SystemLockDocument {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return SystemLockDocument(payload: payload, sha256: lockSHA256(try encoder.encode(payload)))
    }

    func verify() throws {
        let expected = try SystemLockDocument.signed(payload).sha256
        guard sha256 == expected else { throw SystemLockError.invalid("Saved system lock fingerprint does not match") }
    }
}

enum SystemLockError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self { case .invalid(let why): return "Locked system cannot be displayed: \(why). No re-engraving has been permitted." }
    }
}

final class SystemLockStore {
    let folder: URL

    init(applicationSupport: URL) {
        folder = applicationSupport.appendingPathComponent("SystemLocks", isDirectory: true)
    }

    private func safeSlug(_ slug: String) -> Bool {
        !slug.isEmpty && slug.utf8.count < 120 && slug.allSatisfy {
            ($0 >= "a" && $0 <= "z") || ($0 >= "0" && $0 <= "9") || $0 == "-"
        }
    }

    func url(slug: String, first: Int) -> URL {
        // Only callers with a manifest-validated slug and first index use this.
        folder.appendingPathComponent(slug, isDirectory: true)
            .appendingPathComponent(String(format: "s%04d.lock.json", first))
    }

    func exists(slug: String, first: Int) -> Bool {
        FileManager.default.fileExists(atPath: url(slug:slug, first:first).path)
    }

    func load(slug: String, first: Int, last: Int, excerpt: Data, scan: Data) throws -> SystemLockDocument? {
        guard safeSlug(slug), first >= 0, last >= first else { throw SystemLockError.invalid("Invalid system identity") }
        let path = url(slug: slug, first: first)
        guard FileManager.default.fileExists(atPath:path.path) else { return nil }
        let doc: SystemLockDocument
        do { doc = try JSONDecoder().decode(SystemLockDocument.self, from:Data(contentsOf:path)) }
        catch { throw SystemLockError.invalid("Unreadable lock record at \(path.path): \(error.localizedDescription)") }
        try doc.verify()
        let p = doc.payload
        guard p.schema == 1, p.pieceSlug == slug, p.first == first, p.last == last,
              p.excerptSHA256 == lockSHA256(excerpt), p.scanSHA256 == lockSHA256(scan),
              p.svg.hasPrefix("<svg"), p.svg.utf8.count < 15_000_000,
              p.mappedEvents >= 0, p.staffSizePercent.isFinite, p.staffSizePercent >= 40,
              p.staffSizePercent <= 180, p.viewportWidth.isFinite, p.viewportWidth > 100,
              p.notationHeight.isFinite, p.notationHeight > 10,
              p.paneHeight.isFinite, p.paneHeight > 10 else {
            throw SystemLockError.invalid("Source, scan, or frozen rendering no longer matches the approved snapshot")
        }
        return doc
    }

    func save(slug: String, first: Int, last: Int, catalogSHA: String,
              excerpt: Data, scan: Data, capture: [String:Any]) throws {
        guard safeSlug(slug), first >= 0, last >= first, !exists(slug:slug, first:first) else {
            throw SystemLockError.invalid("Lock already exists or its identity is invalid")
        }
        guard let capSlug=capture["pieceSlug"] as? String, capSlug==slug,
              let capFirst=capture["first"] as? Int, capFirst==first,
              let capLast=capture["last"] as? Int, capLast==last,
              let svg=capture["svg"] as? String, svg.hasPrefix("<svg"), svg.utf8.count < 15_000_000,
              let rules=capture["staffRules"] as? String, rules.utf8.count < 2_000_000,
              let attrs=capture["staffRulesAttributes"] as? [String:String],
              let zoom=capture["staffSizePercent"] as? Double, zoom.isFinite, zoom>=40, zoom<=180,
              let width=capture["viewportWidth"] as? Double, width.isFinite, width>100,
              let notationHeight=capture["notationHeight"] as? Double, notationHeight.isFinite,notationHeight>10,
              let paneHeight=capture["paneHeight"] as? Double, paneHeight.isFinite,paneHeight>10,
              let events=capture["mappedEvents"] as? Int, events >= 0 else {
            throw SystemLockError.invalid("Renderer did not supply a complete, current system snapshot")
        }
        let p=SystemLockPayload(schema:1, pieceSlug:slug, first:first, last:last,
                                sourceCatalogSHA256:catalogSHA, excerptSHA256:lockSHA256(excerpt),
                                scanSHA256:lockSHA256(scan), svg:svg, staffRules:rules,
                                staffRulesAttributes:attrs, staffSizePercent:zoom,
                                viewportWidth:width, notationHeight:notationHeight,
                                paneHeight:paneHeight, mappedEvents:events,
                                savedAt:ISO8601DateFormatter().string(from:Date()))
        let doc=try SystemLockDocument.signed(p)
        let path=url(slug:slug,first:first)
        try FileManager.default.createDirectory(at:path.deletingLastPathComponent(),withIntermediateDirectories:true)
        let encoder=JSONEncoder();encoder.outputFormatting=[.sortedKeys]
        try encoder.encode(doc).write(to:path, options:.atomic)
        // The approved lock is verified on disk BEFORE the UI may say "locked".
        guard try load(slug:slug,first:first,last:last,excerpt:excerpt,scan:scan) != nil else {
            throw SystemLockError.invalid("New lock could not be verified from disk")
        }
    }

    func remove(slug: String, first: Int) throws {
        guard safeSlug(slug), first>=0 else { throw SystemLockError.invalid("Invalid system identity") }
        let path=url(slug:slug,first:first)
        guard FileManager.default.fileExists(atPath:path.path) else { return }
        try FileManager.default.removeItem(at:path)
    }

    func count(slug: String, firsts: [Int]) -> Int {
        firsts.filter { exists(slug:slug,first:$0) }.count
    }
}
#endif
