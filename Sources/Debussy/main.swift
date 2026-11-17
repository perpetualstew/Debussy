#if os(macOS)
import AppKit
import Foundation
import WebKit
import CryptoKit

/// Native bridge for the standalone Debussy presentation designer.
/// MusicXML is read-only; this process never edits scores or scan references.
final class DebussyHost: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private let fm = FileManager.default
    private var window: NSWindow!
    private var web: WKWebView!
    private var pieces: [[String: Any]] = []
    private var export: ExportSession?

    private var root: URL {
        // A built Debussy.app sits directly in the project directory.
        let installed = Bundle.main.bundleURL.deletingLastPathComponent()
        if fm.fileExists(atPath: installed.appendingPathComponent("Resources/collection.json").path) { return installed }
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
    private var stateFolder: URL { root.appendingPathComponent("DebussyState") }
    private var stateURL: URL { stateFolder.appendingPathComponent("layouts.json") }
    private var generatedFolder: URL { root.appendingPathComponent("Generated") }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(); let appItem = NSMenuItem(); let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Debussy", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu; menu.addItem(appItem); NSApp.mainMenu = menu
        do {
            let catalogData = try Data(contentsOf: root.appendingPathComponent("Resources/collection.json"))
            let catalog = try JSONSerialization.jsonObject(with: catalogData) as? [String: Any]
            pieces = catalog?["pieces"] as? [[String: Any]] ?? []
            if pieces.count != 15 { throw AppError.invalid("Expected 15 seed pieces; found \(pieces.count)") }
            try fm.createDirectory(at: stateFolder, withIntermediateDirectories: true)
            try fm.createDirectory(at: generatedFolder, withIntermediateDirectories: true)
        } catch {
            NSAlert(error: error).runModal(); NSApp.terminate(nil); return
        }
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "debussy")
        web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = self
        web.isInspectable = true
        window = NSWindow(contentRect: NSRect(x: 70, y: 70, width: 1510, height: 945),
                          styleMask: [.titled, .closable, .resizable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "Debussy — Presentation Designer"
        window.minSize = NSSize(width: 1000, height: 670)
        window.contentView = web
        window.center(); window.makeKeyAndOrderFront(nil)
        let page = root.appendingPathComponent("UI/index.html")
        web.loadFileURL(page, allowingReadAccessTo: root)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { errorAlert(error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { errorAlert(error) }

    private func send(_ method: String, _ value: Any) {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.Debussy.\(method)(\(json));") { _, error in
            if let error { NSLog("Debussy JS callback: %@", error.localizedDescription) }
        }
    }
    private func errorAlert(_ error: Error) { NSLog("Debussy: %@", error.localizedDescription); send("nativeError", ["message": error.localizedDescription]) }
    private func safePiece(_ slug: String) -> Bool { pieces.contains { ($0["slug"] as? String) == slug } }
    private func simpleKey(_ s: String) -> Bool {
        !s.isEmpty && s.count < 120 && s.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
    }
    private func loadPiece(slug: String) throws {
        guard safePiece(slug) else { throw AppError.invalid("Unknown arrangement") }
        let directory = root.appendingPathComponent("ReferenceMusic").appendingPathComponent(slug)
        let manifestURL = directory.appendingPathComponent("manifest.json")
        guard let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: manifestURL)) as? [String: Any],
              let systems = manifest["systems"] as? [[String: Any]], !systems.isEmpty else {
            throw AppError.invalid("Missing source system manifest for \(slug)")
        }
        var result: [[String: Any]] = []
        for system in systems {
            guard let name = system["id"] as? String,
                  let score = system["score"] as? String,
                  name.range(of: "^s[0-9]+$", options: .regularExpression) != nil,
                  score == "excerpts/\(name).musicxml" else {
                throw AppError.invalid("Unexpected system/source path in \(slug)")
            }
            let xml = try String(contentsOf: directory.appendingPathComponent(score), encoding: .utf8)
            result.append(["id": name, "first": system["first"] ?? 0,
                           "last": system["last"] ?? 0, "xml": xml])
        }
        let title = pieces.first { ($0["slug"] as? String) == slug }?["title"] as? String ?? slug
        send("receivePiece", ["slug": slug, "title": title, "systems": result,
                              "sourceStatus": pieces.first { ($0["slug"] as? String) == slug }?["status"] ?? "needs-review"])
    }
    private func saveState(_ value: Any) throws {
        guard let state = value as? [String: Any], let layouts = state["layouts"] as? [String: Any],
              layouts.count <= 1000, JSONSerialization.isValidJSONObject(state) else {
            throw AppError.invalid("Invalid layout state")
        }
        let data = try JSONSerialization.data(withJSONObject: state, options: [.prettyPrinted, .sortedKeys])
        guard data.count < 2_000_000 else { throw AppError.invalid("Layout state is too large") }
        try data.write(to: stateURL, options: .atomic)
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any], let type = payload["type"] as? String else { return }
        do {
            switch type {
            case "ready":
                let state: Any = (try? JSONSerialization.jsonObject(with: Data(contentsOf: stateURL))) ?? ["layouts": [:]]
                send("bootstrap", ["pieces": pieces, "state": state])
            case "loadPiece":
                guard let slug = payload["slug"] as? String else { return }
                try loadPiece(slug: slug)
            case "save":
                try saveState(payload["value"] ?? [:])
            case "openSources":
                NSWorkspace.shared.open(root.appendingPathComponent("ReferenceMusic"))
            case "openPublished":
                NSWorkspace.shared.open(generatedFolder)
            case "beginExport":
                try beginExport(payload)
            case "cancelExport":
                if let session = export { try? fm.removeItem(at: session.staging) }; export = nil
            case "exportPage":
                try exportPage(payload)
            case "finishExport":
                try finishExport()
            default: break
            }
        } catch {
            // An interrupted export never replaces an existing completed package.
            if type == "exportPage" || type == "finishExport" || type == "beginExport" {
                if let session = export { try? fm.removeItem(at: session.staging) }
                export = nil
            }
            errorAlert(error)
        }
    }
    private struct ExportSession {
        var slug: String
        var profile: String
        var expected: Int
        var width: Int
        var height: Int
        var staging: URL
        var metadata: [String: Any]
        var entries: [[String: Any]] = []
    }
    private func beginExport(_ payload: [String: Any]) throws {
        guard export == nil,
              let slug = payload["slug"] as? String, safePiece(slug),
              let profile = payload["profile"] as? String, simpleKey(profile),
              let total = payload["total"] as? Int, total > 0, total <= 400,
              let width = payload["width"] as? Int, [1080,1920].contains(width),
              let height = payload["height"] as? Int, [1080,1920].contains(height),
              let metadata = payload["metadata"] as? [String: Any] else {
            throw AppError.invalid("Invalid export request")
        }
        let location = generatedFolder.appendingPathComponent(slug).appendingPathComponent(profile)
        try fm.createDirectory(at: location, withIntermediateDirectories: true)
        let staging = location.appendingPathComponent(".working-" + UUID().uuidString)
        try fm.createDirectory(at: staging, withIntermediateDirectories: false)
        export = ExportSession(slug: slug, profile: profile, expected: total, width: width, height: height,
                               staging: staging, metadata: metadata)
        send("exportStarted", ["total": total])
    }
    private func exportPage(_ payload: [String: Any]) throws {
        guard var session = export, let index = payload["index"] as? Int,
              index == session.entries.count, index < session.expected,
              let encoded = payload["png"] as? String,
              encoded.hasPrefix("data:image/png;base64,"),
              let data = Data(base64Encoded: String(encoded.dropFirst("data:image/png;base64,".count))),
              data.count > 40, data.count < 22_000_000,
              data.prefix(8) == Data([137,80,78,71,13,10,26,10]) else {
            throw AppError.invalid("Invalid or out-of-order PNG")
        }
        let name = String(format: "page-%04d.png", index + 1)
        try data.write(to: session.staging.appendingPathComponent(name), options: .atomic)
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        session.entries.append(["index": index, "file": name, "sha256": hash, "bytes": data.count])
        export = session
        send("pageSaved", ["index": index, "total": session.expected])
    }
    private func finishExport() throws {
        guard let session = export, session.entries.count == session.expected else {
            throw AppError.invalid("Export incomplete")
        }
        let time = ISO8601DateFormatter().string(from: Date())
        let manifest: [String: Any] = [
            "schema": 1, "source": "Debussy MusicXML / embedded Verovio",
            "piece": session.slug, "profile": session.profile,
            "generatedAt": time, "width": session.width, "height": session.height,
            "pages": session.entries, "layout": session.metadata,
            "reviewStatus": "pilot - engraving requires visual approval"
        ]
        let contents = try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted,.sortedKeys])
        try contents.write(to: session.staging.appendingPathComponent("manifest.json"), options: .atomic)
        let formatter = DateFormatter(); formatter.dateFormat = "yyyyMMdd-HHmmss"
        let target = session.staging.deletingLastPathComponent()
            .appendingPathComponent(formatter.string(from: Date()) + "-" + String(UUID().uuidString.prefix(6)))
        try fm.moveItem(at: session.staging, to: target)
        let pointer: [String: Any] = ["revision": target.lastPathComponent, "profile": session.profile, "piece": session.slug]
        try JSONSerialization.data(withJSONObject: pointer, options: [.prettyPrinted,.sortedKeys])
            .write(to: target.deletingLastPathComponent().appendingPathComponent("latest.json"), options: .atomic)
        export = nil
        send("exportFinished", ["folder": target.path, "pages": session.entries.count])
    }
}

private enum AppError: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let host = DebussyHost()
app.delegate = host
app.run()
#endif
