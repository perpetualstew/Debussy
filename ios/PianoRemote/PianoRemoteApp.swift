import SwiftUI
import UniformTypeIdentifiers
import UIKit

@main
struct PianoRemoteApp: App {
    var body: some Scene { WindowGroup { RemoteView() } }
}

struct RemoteView: View {
    @StateObject private var bluetooth = BluetoothController()
    @StateObject private var library = Library()
    @AppStorage("homeURL") private var homeURL = ""
    @State private var token = Secrets.get()
    @State private var piece = ""
    @State private var profile = ""
    @State private var theme = "light"
    @State private var importing = false
    @State private var busy = false
    @State private var homeBusy = false
    @State private var homeTask: Task<Void, Never>?
    @State private var error = ""
    @State private var status = ""
    @State private var pageNumber = "1"
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            Form {
                Section("SideTrak") {
                    Text(bluetooth.connection)
                    Button("Find Pi") { bluetooth.scan() }.disabled(busy)
                    ForEach(bluetooth.devices, id: \.identifier) { device in
                        Button(device.name ?? "Piano Library") { bluetooth.connect(device) }.disabled(busy)
                    }
                    Text(status).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Previous", systemImage: "backward.end.fill") { command(["op": "prev"]) }
                        Spacer()
                        Button("Next", systemImage: "forward.end.fill") { command(["op": "next"]) }
                    }.buttonStyle(.borderedProminent).controlSize(.large).disabled(!bluetooth.ready || busy)
                    Button("First page") { command(["op": "home"]) }.disabled(!bluetooth.ready || busy)
                    HStack {
                        TextField("Page", text: $pageNumber).keyboardType(.numberPad)
                        Button("Go to page") { if let page = Int(pageNumber) { command(["op": "goto", "page": page]) } }
                    }.disabled(!bluetooth.ready || busy)
                }
                if let manifest = library.manifest {
                    Section("Presentation") {
                        Picker("Piece", selection: $piece) {
                            ForEach(manifest.pieces.keys.sorted(), id: \.self) { slug in Text(manifest.pieces[slug]!.title).tag(slug) }
                        }
                        Picker("Screens and size", selection: $profile) {
                            ForEach((manifest.pieces[piece]?.variants.keys.sorted() ?? []), id: \.self) { id in Text(manifest.profiles[id]?.label ?? id).tag(id) }
                        }
                        Picker("Theme", selection: $theme) { Text("Light").tag("light"); Text("Dark").tag("dark") }.pickerStyle(.segmented)
                        Button("Show on SideTrak") { command(["op": "select", "piece": piece, "profile": profile, "theme": theme]) }
                            .disabled(!bluetooth.ready || busy || piece.isEmpty || profile.isEmpty)
                        Text("Changes use the PNGs already on the Pi. Sync first after updating the phone library.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.disabled(busy)
                }
                Section("Offline library") {
                    Text(library.progress)
                    Button("Import Mac export folder") { importing = true }.disabled(busy || homeBusy)
                    Button("Sync library to Pi") { run { try await library.sync(to: bluetooth); try await readStatus() } }
                        .disabled(busy || !bluetooth.ready || library.manifest == nil)
                    Text("Keep this app open while syncing. Interrupted image transfers resume on the next sync. The pedal and Pi continue to work without the phone.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Home Mac") {
                    TextField("https://your-home-library", text: $homeURL).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                    SecureField("Library access token", text: $token).onChange(of: token) { _, value in Secrets.save(value) }
                    Button("Refresh phone from Mac") { refreshHome() }.disabled(busy || homeBusy || homeURL.isEmpty)
                    Button("Ask Mac to rebuild PNG library") { refreshHome(render: true) }.disabled(busy || homeBusy || homeURL.isEmpty)
                    if homeBusy {
                        ProgressView("Updating from Mac…")
                        Button("Cancel home update") { homeTask?.cancel() }
                    }
                    Text("The Mac must be awake and reachable for updates. Cached music needs no connection home.").font(.caption).foregroundStyle(.secondary)
                }
                if busy { ProgressView("Working…") }
                if !error.isEmpty { Section { Text(error).foregroundStyle(.red) } }
            }
            .navigationTitle("Piano Library")
            .fileImporter(isPresented: $importing, allowedContentTypes: [.folder]) { result in
                run { try await library.importFolder(result.get()); chooseDefaults() }
            }
            .onAppear { chooseDefaults() }
            .onChange(of: bluetooth.ready) { _, ready in if ready && !busy { run { try await readStatus() } } }
            .onChange(of: piece) { chooseDefaults() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active && !homeURL.isEmpty && !busy && !homeBusy { refreshHome() }
            }
        }
    }
    private func chooseDefaults() {
        guard let manifest = library.manifest else { return }
        if manifest.pieces[piece] == nil { piece = manifest.pieces.keys.sorted().first ?? "" }
        if manifest.pieces[piece]?.variants[profile] == nil { profile = manifest.pieces[piece]?.variants.keys.sorted().first ?? "" }
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = ""
        UIApplication.shared.isIdleTimerDisabled = true
        Task {
            defer { busy = false; UIApplication.shared.isIdleTimerDisabled = false }
            do { try await action() } catch { self.error = error.localizedDescription }
        }
    }
    private func command(_ message: [String: Any]) {
        run { let reply = try await bluetooth.send(message); showStatus(reply) }
    }
    private func refreshHome(render: Bool = false) {
        guard !homeBusy else { return }
        homeBusy = true
        let address = homeURL
        homeTask = Task {
            defer { homeBusy = false }
            do { try await library.refresh(base: address, render: render); chooseDefaults() }
            catch { self.error = "Home update unavailable. Cached controls still work. \(error.localizedDescription)" }
        }
    }
    private func readStatus() async throws { showStatus(try await bluetooth.send(["op": "status"])) }
    private func showStatus(_ reply: [String: Any]) {
        if reply["ready"] as? Bool == false { status = "Pi is waiting for its first library"; return }
        let pages = (reply["pages"] as? [Any] ?? []).map { $0 is NSNull ? "blank" : String(describing: $0) }.joined(separator: " / ")
        status = "Pages \(pages) · \(reply["theme"] as? String ?? "")"
        if let selected = reply["piece"] as? String, library.manifest?.pieces[selected] != nil { piece = selected }
        if let selected = reply["profile"] as? String, library.manifest?.profiles[selected] != nil { profile = selected }
        if let selected = reply["theme"] as? String { theme = selected }
    }
}
