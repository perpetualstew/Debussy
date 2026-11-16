import Foundation
import CoreBluetooth

enum RemoteError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

// Core Bluetooth invokes this Objective-C delegate on the explicitly selected
// main queue. Async entry points/timers also run on MainActor (Swift 5 mode).
final class BluetoothController: NSObject, ObservableObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    static let service = CBUUID(string: "d8aa0001-6921-4f5e-9c21-7069616e6f31")
    static let receive = CBUUID(string: "d8aa0002-6921-4f5e-9c21-7069616e6f31")
    static let transmit = CBUUID(string: "d8aa0003-6921-4f5e-9c21-7069616e6f31")
    @Published var connection = "Disconnected"
    @Published var ready = false
    @Published var devices: [CBPeripheral] = []
    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var pending: CheckedContinuation<[String: Any], Error>?
    private var chunks: [Data] = []
    private var incoming = Data()
    private var requestID = ""
    private var timeout: Task<Void, Never>?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }
    func scan() {
        guard central.state == .poweredOn else { connection = "Enable Bluetooth in Settings"; return }
        devices = []
        connection = "Looking for your Pi…"
        central.scanForPeripherals(withServices: [Self.service])
    }
    func connect(_ device: CBPeripheral) {
        central.stopScan()
        peripheral = device
        device.delegate = self
        connection = "Connecting…"
        central.connect(device)
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state != .poweredOn { ready = false; connection = "Bluetooth unavailable"; fail("Bluetooth unavailable") }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        if !devices.contains(where: { $0.identifier == peripheral.identifier }) { devices.append(peripheral) }
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices([Self.service])
    }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        connection = error?.localizedDescription ?? "Connection failed"
        ready = false
        fail(connection)
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        ready = false; rx = nil; tx = nil
        connection = "Disconnected — Pi continues playing"
        fail("Bluetooth disconnected. Reconnect and sync to resume.")
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if let error { connection = error.localizedDescription; return }
        for service in peripheral.services ?? [] { peripheral.discoverCharacteristics([Self.receive, Self.transmit], for: service) }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if let error { connection = error.localizedDescription; return }
        for characteristic in service.characteristics ?? [] {
            if characteristic.uuid == Self.receive { rx = characteristic }
            if characteristic.uuid == Self.transmit { tx = characteristic }
        }
        ready = rx != nil && tx != nil
        connection = ready ? "Connected to Piano Library" : "Pi service is incomplete"
    }
    @MainActor func send(_ message: [String: Any]) async throws -> [String: Any] {
        guard ready, let peripheral, rx != nil, tx != nil else { throw RemoteError.message("Connect to the Pi first") }
        guard pending == nil else { throw RemoteError.message("Wait for the current command") }
        var message = message
        requestID = UUID().uuidString
        message["requestID"] = requestID
        var raw = Data([0x1e])
        raw.append(try JSONSerialization.data(withJSONObject: message, options: [.sortedKeys, .withoutEscapingSlashes]))
        raw.append(10)
        let size = peripheral.maximumWriteValueLength(for: .withResponse)
        chunks = stride(from: 0, to: raw.count, by: size).map { raw.subdata(in: $0..<min($0+size, raw.count)) }
        incoming = Data()
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            timeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: 120_000_000_000) } catch { return }
                self?.fail("Pi response timed out. Check the displayed page before retrying a turn.")
            }
            writeNext()
        }
    }
    private func writeNext() {
        guard pending != nil, let peripheral, let rx else { return }
        if !chunks.isEmpty { peripheral.writeValue(chunks.removeFirst(), for: rx, type: .withResponse) }
        else { readNext() }
    }
    private func readNext() {
        guard pending != nil, let peripheral, let tx else { return }
        peripheral.readValue(for: tx)
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error { fail(error.localizedDescription + " — ensure this iPhone is paired and trusted on the Pi"); return }
        writeNext()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard pending != nil, characteristic.uuid == Self.transmit else { return }
        if let error { fail(error.localizedDescription); return }
        incoming.append(characteristic.value ?? Data())
        if incoming.count > 2_097_152 { fail("Pi response exceeds protocol limit"); return }
        if incoming.last == 10 {
            do {
                guard let reply = try JSONSerialization.jsonObject(with: incoming) as? [String: Any], reply["requestID"] as? String == requestID else {
                    throw RemoteError.message("Unexpected Pi response")
                }
                guard reply["ok"] as? Bool == true else { throw RemoteError.message(reply["error"] as? String ?? "Pi rejected request") }
                let continuation = pending
                pending = nil; timeout?.cancel()
                continuation?.resume(returning: reply["result"] as? [String: Any] ?? [:])
            } catch { fail(error.localizedDescription) }
        } else {
            let expected = requestID
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: incoming.isEmpty ? 100_000_000 : 5_000_000)
                if expected == requestID { readNext() }
            }
        }
    }
    private func fail(_ reason: String) {
        let continuation = pending
        pending = nil; timeout?.cancel(); chunks = []
        continuation?.resume(throwing: RemoteError.message(reason))
    }
}
