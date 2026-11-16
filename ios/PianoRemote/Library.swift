import Foundation
import CryptoKit
import Security

struct Page: Codable { let start: Int; let end: Int; let light: String; let dark: String }
struct Variant: Codable { let pages: [Page] }
struct Piece: Codable { let title: String; let variants: [String: Variant]; let routeLength: Int }
struct Profile: Codable { let label: String; let width: Int; let height: Int; let slots: Int; let arrangement: String }
struct Manifest: Codable {
    let schema: Int; let library: String; let revision: String
    let pieces: [String: Piece]; let profiles: [String: Profile]
    var hashes: Set<String> { Set(pieces.values.flatMap { $0.variants.values.flatMap { $0.pages.flatMap { [$0.light, $0.dark] } } }) }
}

enum Secrets {
    static func get() -> String {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "PianoLibraryHome", kSecReturnData as String: true]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String) {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "PianoLibraryHome"]
        SecItemDelete(query as CFDictionary)
        var record = query
        record[kSecValueData as String] = Data(token.utf8)
        record[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(record as CFDictionary, nil)
    }
}

@MainActor
final class Library: ObservableObject {
    @Published var manifest: Manifest?
    @Published var progress = "Import a Mac export to begin"
    let root: URL
    var manifestData = Data()
    init() {
        root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Performance", isDirectory: true)
        try? FileManager.default.createDirectory(at: root.appendingPathComponent("objects"), withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: root.appendingPathComponent("manifest.json")), let model = try? Self.decode(data) {
            manifestData = data; manifest = model; progress = "\(model.pieces.count) pieces available offline"
        }
    }
    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func validHash(_ hash: String) -> Bool { hash.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    static func decode(_ data: Data) throws -> Manifest {
        guard data.count <= 2_000_000 else { throw RemoteError.message("Library manifest is too large") }
        let model = try JSONDecoder().decode(Manifest.self, from: data)
        guard model.schema == 1, !model.pieces.isEmpty, validHash(model.revision), model.hashes.allSatisfy(validHash) else {
            throw RemoteError.message("Invalid performance library")
        }
        return model
    }
    func object(_ hash: String) -> URL { root.appendingPathComponent("objects/\(hash).png") }
    func contains(_ hash: String) -> Bool {
        guard let data = try? Data(contentsOf: object(hash)) else { return false }
        return Self.hash(data) == hash
    }
    func accept(_ data: Data, hash: String) throws {
        guard data.count <= 33_554_432, Self.hash(data) == hash,
              data.prefix(8) == Data([137,80,78,71,13,10,26,10]) else { throw RemoteError.message("PNG checksum failed") }
        try data.write(to: object(hash), options: .atomic)
    }
    func activate(_ data: Data, _ model: Manifest) throws {
        try data.write(to: root.appendingPathComponent("manifest.json"), options: .atomic)
        manifestData = data; manifest = model
        progress = "\(model.pieces.count) pieces available offline"
    }
    func importFolder(_ url: URL) async throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url.appendingPathComponent("manifest.json"))
        let model = try Self.decode(data)
        for (index, hash) in model.hashes.sorted().enumerated() {
            if !contains(hash) { try accept(Data(contentsOf: url.appendingPathComponent("objects/\(hash).png")), hash: hash) }
            progress = "Importing \(index+1)/\(model.hashes.count) images"
            await Task.yield()
        }
        try activate(data, model)
    }
    private func request(base: String, path: String, method: String = "GET") throws -> URLRequest {
        guard let url = URL(string: base), url.scheme == "https", url.host != nil else { throw RemoteError.message("Use an HTTPS home-library address") }
        var request = URLRequest(url: url.appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("Bearer \(Secrets.get())", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 120
        return request
    }
    private func fetch(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw RemoteError.message("Home library unavailable or access token rejected") }
        return data
    }
    func refresh(base: String, render: Bool = false) async throws {
        if render {
            _ = try await fetch(request(base: base, path: "render", method: "POST"))
            progress = "Mac is preparing updated PNGs…"
            while true {
                try await Task.sleep(nanoseconds: 2_000_000_000)
                let status = try await fetch(request(base: base, path: "render"))
                let job = try JSONSerialization.jsonObject(with: status) as? [String: Any] ?? [:]
                if let error = job["error"] as? String { throw RemoteError.message(error) }
                if job["running"] as? Bool == false { break }
            }
        }
        let data = try await fetch(request(base: base, path: "manifest.json"))
        let model = try Self.decode(data)
        for (index, hash) in model.hashes.sorted().enumerated() {
            if !contains(hash) { try accept(await fetch(request(base: base, path: "objects/\(hash).png")), hash: hash) }
            progress = "Updating phone \(index+1)/\(model.hashes.count)"
        }
        try activate(data, model)
    }
    func sync(to bluetooth: BluetoothController) async throws {
        guard let manifest else { throw RemoteError.message("Import or download a library first") }
        let snapshotData = manifestData
        for (index, hash) in manifest.hashes.sorted().enumerated() {
            let data = try Data(contentsOf: object(hash))
            guard Self.hash(data) == hash else { throw RemoteError.message("Phone cache needs repair; refresh from Mac") }
            let result = try await bluetooth.send(["op": "begin", "hash": hash, "size": data.count])
            if result["complete"] as? Bool != true {
                var offset = result["offset"] as? Int ?? 0
                while offset < data.count {
                    let end = min(offset+4096, data.count)
                    let reply = try await bluetooth.send(["op": "chunk", "hash": hash, "offset": offset, "data": data.subdata(in: offset..<end).base64EncodedString()])
                    guard let next = reply["offset"] as? Int, next > offset, next <= data.count else { throw RemoteError.message("Invalid transfer acknowledgement") }
                    offset = next
                }
                _ = try await bluetooth.send(["op": "finish", "hash": hash])
            }
            progress = "Syncing Pi \(index+1)/\(manifest.hashes.count) images"
        }
        let json = try JSONSerialization.jsonObject(with: snapshotData)
        _ = try await bluetooth.send(["op": "activate", "manifest": json])
        progress = "Pi library is up to date"
    }
}
