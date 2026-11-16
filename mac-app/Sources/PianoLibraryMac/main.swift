#if os(macOS)
import AppKit
import WebKit
import Foundation
import CryptoKit
import Darwin
import UniformTypeIdentifiers

/// The host only serves local resources, verifies historical locks, and saves state.
/// Music, practice scheduling and performance navigation live in separate modules.
final class LibraryHost: NSObject, NSApplicationDelegate, WKURLSchemeHandler, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var reviewProcess: Process?
    var reviewLog: FileHandle?
    var projectRoot: URL {
        let sibling = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        if files.fileExists(atPath: sibling.appendingPathComponent("run-offline-review.command").path) { return sibling }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }
    let files = FileManager.default
    var root: URL {
        if let base = Bundle.main.resourceURL {
            let packed = base.appendingPathComponent("PianoLibraryData")
            if files.fileExists(atPath: packed.appendingPathComponent("collection.json").path) { return packed }
        }
        return Bundle.module.resourceURL!.appendingPathComponent("Resources")
    }
    var legacy: URL { files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PianoLibrary") }
    var stateURL: URL {
        if let custom = ProcessInfo.processInfo.environment["PIANO_LIBRARY_USER_DATA"] { return URL(fileURLWithPath: custom).appendingPathComponent("state.json") }
        return files.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PianoLibraryRebuilt/state.json")
    }
    func windowDidExitFullScreen(_ notification: Notification) {
        web.evaluateJavaScript("document.body.classList.remove('performance-focus','fullscreen');document.getElementById('exit-performance-focus').hidden=true;window.dispatchEvent(new Event('resize'));", completionHandler: nil)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu(), item = NSMenuItem(), app = NSMenu()
        app.addItem(withTitle: "Quit Piano Library", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = app; menu.addItem(item); NSApp.mainMenu = menu
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(self, forURLScheme: "pianolibrary")
        config.userContentController.add(self, name: "library")
        if let audit = ProcessInfo.processInfo.environment["PIANO_LIBRARY_NAVIGATION_AUDIT"], let script = try? String(contentsOfFile: audit, encoding: .utf8) {
            config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        web = WKWebView(frame: .zero, configuration: config)
        web.isInspectable = true
        web.navigationDelegate = self
        window = NSWindow(contentRect: NSRect(x: 60, y: 60, width: 1440, height: 900), styleMask: [.titled,.closable,.resizable,.miniaturizable], backing: .buffered, defer: false)
        window.delegate = self
        window.title = "Piano Library — Transcribe · Practice · Perform"
        window.minSize = NSSize(width: 850, height: 600)
        window.contentView = web; window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: URL(string: "pianolibrary://local/UI/app.html")!))
        NSApp.activate(ignoringOtherApps: true)
        if let output = ProcessInfo.processInfo.environment["PIANO_LIBRARY_SMOKE_OUTPUT"] { smoke(output: output, attempt: 0) }
    }
    func smoke(output: String, attempt: Int, stage: Int = 0) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            let expression = "JSON.stringify({ready:!!window.Library,mode:window.Library?.getMode(),systems:document.querySelector('#system')?.options.length,svg:!!document.querySelector('#editor')?.contentDocument?.querySelector('#notation svg'),renderStatus:document.querySelector('#editor')?.contentDocument?.querySelector('#status')?.textContent,status:document.querySelector('#message')?.textContent,practice:document.querySelector('#practice-stats')?.textContent,pages:document.querySelectorAll('#spread .page').length,imagesReady:[...document.querySelectorAll('#spread img')].every(i=>i.complete&&i.naturalWidth>0),state:window.Library?.getState()})"
            self.web.evaluateJavaScript(expression) { value, error in
                let text = value as? String ?? "{}"
                let object = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] ?? [:]
                if stage == 0, let renderStatus = object["renderStatus"] as? String, renderStatus.contains("source-coordinate layout") {
                    self.web.evaluateJavaScript("document.querySelector('[data-mode=practice]').click(); document.querySelector('#grades button:nth-child(9)').click()") { _,_ in self.smoke(output: output, attempt: attempt + 1, stage: 1) }
                } else if stage == 1, let practice = object["practice"] as? String, practice.contains("1 / 304") {
                    self.web.evaluateJavaScript("document.querySelector('[data-mode=perform]').click()") { _,_ in self.smoke(output: output, attempt: attempt + 1, stage: 2) }
                } else if stage == 2 && object["pages"] as? Int == 2 && object["imagesReady"] as? Bool == true || attempt >= 90 {
                    var result = object
                    result["passed"] = stage == 2 && object["pages"] as? Int == 2 && object["imagesReady"] as? Bool == true
                    result["persistedState"] = (try? self.json(self.stateURL)) ?? [:]
                    if let bytes = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted,.sortedKeys]) { try? bytes.write(to: URL(fileURLWithPath: output), options: .atomic) }
                    self.web.takeSnapshot(with: nil) { image, _ in
                        if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff), let png = bitmap.representation(using: .png, properties: [:]) {
                            try? png.write(to: URL(fileURLWithPath: output).deletingPathExtension().appendingPathExtension("png"), options: .atomic)
                        }
                        NSApp.terminate(nil)
                    }
                } else { self.smoke(output: output, attempt: attempt + 1, stage: stage) }
            }
        }
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard web != nil else { return .terminateNow }
        web.evaluateJavaScript("window.Library?.flushEditor?.()") { value, _ in
            if let text = value as? String, let bytes = text.data(using: .utf8), (try? JSONSerialization.jsonObject(with: bytes)) != nil {
                try? self.files.createDirectory(at: self.stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? bytes.write(to: self.stateURL, options: .atomic)
            }
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func json(_ url: URL) throws -> Any { try JSONSerialization.jsonObject(with: Data(contentsOf: url)) }
    func system(_ components: URLComponents) throws -> [String: Any] {
        let query = Dictionary(components.queryItems?.map { ($0.name, $0.value ?? "") } ?? [], uniquingKeysWith: { a,_ in a })
        guard let slug = query["piece"], let id = query["system"],
              let catalog = try json(root.appendingPathComponent("collection.json")) as? [String: Any],
              let pieces = catalog["pieces"] as? [[String: Any]],
              let piece = pieces.first(where: { $0["slug"] as? String == slug }),
              let directory = piece["directory"] as? String else { throw CocoaError(.fileReadInvalidFileName) }
        let folder = root.appendingPathComponent(directory)
        guard let manifest = try json(folder.appendingPathComponent("manifest.json")) as? [String: Any],
              let systems = manifest["systems"] as? [[String: Any]],
              var payload = systems.first(where: { $0["id"] as? String == id }),
              let first = payload["first"] as? Int, let last = payload["last"] as? Int,
              let score = payload["score"] as? String, let scan = payload["scan"] as? String else { throw CocoaError(.fileReadCorruptFile) }
        let excerpt = try Data(contentsOf: folder.appendingPathComponent(score))
        payload["xml"] = String(decoding: excerpt, as: UTF8.self)
        payload["fullScoreXML"] = try String(contentsOf: folder.appendingPathComponent("source.musicxml"), encoding: .utf8)
        payload["scan"] = directory + "/" + scan
        payload["pieceSlug"] = slug; payload["pieceTitle"] = piece["title"]
        payload["reviewMode"] = manifest["reviewMode"] ?? "aligned"
        payload["allSystemBarlines"] = systems.map { ["first": $0["first"] ?? 0, "barlines": $0["barlines"] ?? []] }
        payload["atlas"] = [:] as [String: String]; payload["reviews"] = [:] as [String: String]
        payload["reviewMarks"] = ((try? json(legacy.appendingPathComponent("ReviewMarks/\(slug).json"))) as? [String: Any]).map { Array($0.values) } ?? []
        // Historical hand-positioned offsets must not compound the rebuilt
        // source layout. Approved historical snapshots retain their own geometry.
        payload["positionOffsets"] = [:] as [String: [String: Double]]
        if query["historical"] == "1" {
        do {
            if let lock = try SystemLockStore(applicationSupport: legacy).load(slug: slug, first: first, last: last, excerpt: excerpt, scan: Data(contentsOf: folder.appendingPathComponent(scan))) {
                payload["lockedSnapshot"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(lock.payload))
            }
        } catch { payload["lockedSnapshotError"] = error.localizedDescription }
        }
        return payload
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { FileHandle.standardError.write(Data(("Navigation failed: " + error.localizedDescription + "\n").utf8)) }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        do {
            guard let url = task.request.url, let components = URLComponents(url: url, resolvingAgainstBaseURL: false), url.host == "local" else { throw CocoaError(.fileReadNoPermission) }
            let bytes: Data, mime: String
            if url.path == "/api/review-progress" {
                let logURL = projectRoot.appendingPathComponent("QA/offline-review-run.log")
                let log = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
                let lines = log.split(separator: "\n")
                let modified = (try? files.attributesOfItem(atPath: logURL.path)[.modificationDate]) as? Date
                let pidText = (try? String(contentsOf: projectRoot.appendingPathComponent("QA/offline-review.run.lock/pid"), encoding: .utf8)) ?? ""
                let savedPID = Int32(pidText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
                let externalRunning = savedPID > 0 && kill(savedPID, 0) == 0
                let exitText = (try? String(contentsOf: projectRoot.appendingPathComponent("QA/offline-review.exit-status"), encoding: .utf8)) ?? ""
                let exitCode = Int(exitText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? -1
                let progress: [String: Any] = ["exitCode": exitCode, "running": (reviewProcess?.isRunning ?? false) || externalRunning, "latest": String(lines.last ?? "No comparison log yet"), "recent": lines.suffix(8).map(String.init), "secondsSinceUpdate": modified.map { Date().timeIntervalSince($0) } ?? -1]
                bytes = try JSONSerialization.data(withJSONObject: progress)
                mime = "application/json"
            } else if url.path == "/api/corrections" {
                bytes = (try? Data(contentsOf: projectRoot.appendingPathComponent("Sources/PianoLibraryMac/Resources/UI/scan-match-corrections.json"))) ?? (try? Data(contentsOf: root.appendingPathComponent("UI/scan-match-corrections.json"))) ?? Data("{\"schema\":1,\"systems\":{}}".utf8); mime = "application/json"
            } else if url.path == "/api/state" {
                bytes = (try? Data(contentsOf: stateURL)) ?? Data("{}".utf8); mime = "application/json"
            } else if url.path == "/api/system" {
                bytes = try JSONSerialization.data(withJSONObject: system(components)); mime = "application/json"
            } else {
                let target = root.appendingPathComponent(String(url.path.dropFirst())).standardizedFileURL.resolvingSymlinksInPath()
                guard target.path.hasPrefix(root.standardizedFileURL.resolvingSymlinksInPath().path + "/") else { throw CocoaError(.fileReadNoPermission) }
                bytes = try Data(contentsOf: target)
                mime = ["js":"application/javascript", "json":"application/json", "html":"text/html", "css":"text/css", "jpg":"image/jpeg", "png":"image/png", "svg":"image/svg+xml", "musicxml":"application/xml" ][target.pathExtension] ?? "application/octet-stream"
            }
            let response = URLResponse(url: url, mimeType: mime, expectedContentLength: bytes.count, textEncodingName: mime.hasPrefix("text/") || mime.contains("json") || mime.contains("javascript") ? "utf-8" : nil)
            task.didReceive(response); task.didReceive(bytes); task.didFinish()
        } catch { FileHandle.standardError.write(Data(("Local request failed: " + (task.request.url?.absoluteString ?? "") + " " + error.localizedDescription + "\n").utf8)); task.didFailWithError(error) }
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        do {
            if type == "navigationAuditComplete", let destination = ProcessInfo.processInfo.environment["PIANO_LIBRARY_AUDIT_OUTPUT"], let result = body["result"] as? [String: Any] {
                try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted,.sortedKeys]).write(to: URL(fileURLWithPath: destination), options: .atomic)
                NSApp.terminate(nil)
            } else if type == "performanceFullscreen", let enabled = body["enabled"] as? Bool {
                if self.window.styleMask.contains(.fullScreen) != enabled { self.window.toggleFullScreen(nil) }
            } else if type == "openEvidence" {
                let report = projectRoot.appendingPathComponent("QA/offline-review/review-gallery.html")
                guard files.fileExists(atPath: report.path) else { throw CocoaError(.fileNoSuchFile) }
                NSWorkspace.shared.open(report)
            } else if type == "runOfflineReview" {
                guard reviewProcess == nil else { return }
                let script = projectRoot.appendingPathComponent("run-offline-review.command")
                guard files.fileExists(atPath: script.path) else { throw CocoaError(.fileNoSuchFile) }
                let log = projectRoot.appendingPathComponent("QA/offline-review-run.log")
                try files.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
                files.createFile(atPath: log.path, contents: nil)
                let handle = try FileHandle(forWritingTo: log)
                let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/bash")
                process.arguments = [script.path]; process.currentDirectoryURL = projectRoot
                var env = ProcessInfo.processInfo.environment
                env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
                process.environment = env; process.standardOutput = handle; process.standardError = handle
                process.terminationHandler = { [weak self] done in
                    try? handle.close()
                    DispatchQueue.main.async {
                        self?.reviewProcess = nil; self?.reviewLog = nil
                        let success = done.terminationStatus == 0
                        self?.web.evaluateJavaScript("window.Library?.offlineStatus(\(success ? "true" : "false"))", completionHandler: nil)
                    }
                }
                reviewProcess = process; reviewLog = handle
                do { try process.run() } catch { reviewProcess = nil; reviewLog = nil; try? handle.close(); throw error }
            } else if type == "saveState", let value = body["state"] as? [String: Any] {
                let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
                guard bytes.count < 20_000_000 else { throw CocoaError(.fileWriteOutOfSpace) }
                try files.createDirectory(at: stateURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                if let previous = try? Data(contentsOf: stateURL) {
                    if (try? JSONSerialization.jsonObject(with: previous)) != nil {
                        try previous.write(to: stateURL.deletingLastPathComponent().appendingPathComponent("state.previous.json"), options: .atomic)
                    } else {
                        try previous.write(to: stateURL.deletingLastPathComponent().appendingPathComponent("state-recovery-" + UUID().uuidString + ".json"), options: .atomic)
                    }
                }
                try bytes.write(to: stateURL, options: .atomic)
                web.evaluateJavaScript("window.Library?.didSave(true)", completionHandler: nil)
            } else if type == "copy", let text = body["text"] as? String, text.utf8.count < 15_000_000 {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            } else if type == "export", let text = body["text"] as? String {
                let panel = NSSavePanel(); panel.nameFieldStringValue = "PianoLibrary-progress.json"; panel.allowedContentTypes = [.json]
                panel.beginSheetModal(for: window) { answer in
                    if answer == .OK, let url = panel.url { do { try Data(text.utf8).write(to: url, options: .atomic) } catch { NSAlert(error: error).runModal() } }
                }
            }
        } catch {
            if type == "runOfflineReview" { web.evaluateJavaScript("window.Library?.offlineStatus(false)", completionHandler: nil) }
            else { web.evaluateJavaScript("window.Library?.didSave(false)", completionHandler: nil) }
        }
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let host = LibraryHost()
application.delegate = host
application.run()
#endif
