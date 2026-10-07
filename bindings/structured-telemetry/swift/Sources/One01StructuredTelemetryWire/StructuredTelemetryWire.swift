import Foundation
import CoreFoundation

public enum TelemetryLane: String, Sendable { case reliable, disposable }
public enum ReadingMode: String, Sendable { case countUp = "count-up", countDown = "count-down" }
public enum StructuredTelemetryWireError: Error, Equatable { case invalid }

/// The selected app:page-reading/1 schema. Step is a finite quantity in unit 1.
public struct ReadingRecord: Sendable, Equatable {
    public let step: Double
    public let mode: ReadingMode
    public let ready: Bool?
    public init(step: Double, mode: ReadingMode, ready: Bool? = nil) {
        self.step = step; self.mode = mode; self.ready = ready
    }
}

public enum ReadingValue: Sendable, Equatable {
    case record(ReadingRecord)
    case table([ReadingRecord])
}

/// An inert selected json/2 sample. Source time is preserved, never translated or granted here.
public struct StructuredTelemetrySample: Sendable, Equatable {
    public let epoch: String
    public let slot: UInt16
    public let sequence: UInt32
    public let capturedAt: Double
    public let value: ReadingValue
    public init(epoch: String, slot: UInt16, sequence: UInt32, capturedAt: Double, value: ReadingValue) {
        self.epoch = epoch; self.slot = slot; self.sequence = sequence
        self.capturedAt = capturedAt; self.value = value
    }
}

/// A selected UTF-8 JSON codec only. The host owns schema/slot selection, clocks, freshness and authority.
public enum StructuredTelemetryWire {
    public static let maxPacketBytes = 4096
    private static let maxContainerDepth = 3
    private static let envelopeFields: Set<String> = ["protocol", "version", "type", "epoch", "slot", "sequence", "capturedAt", "value"]

    private static func validEpoch(_ epoch: String) -> Bool {
        let bytes = epoch.utf8
        return bytes.count == 32 && bytes.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }
    private static func valid(_ reading: ReadingRecord) -> Bool {
        reading.step.isFinite && reading.step >= 0 && reading.step <= 100
    }
    private static func valid(_ sample: StructuredTelemetrySample) -> Bool {
        guard validEpoch(sample.epoch), sample.slot >= 1, sample.slot <= 128, sample.sequence > 0,
              sample.capturedAt.isFinite, sample.capturedAt >= 0 else { return false }
        switch sample.value {
        case .record(let reading): return valid(reading)
        case .table(let readings): return readings.count >= 1 && readings.count <= 8 && readings.allSatisfy { valid($0) }
        }
    }

    // This preflight bounds input before Foundation's complete JSON parser. It does not parse JSON grammar.
    private static func validUTF8Envelope(_ data: Data) -> Bool {
        guard !data.isEmpty, data.count <= maxPacketBytes else { return false }
        let bytes = [UInt8](data)
        // String's UTF-8 conversion can consume a leading marker. Reject its
        // raw bytes before conversion and Foundation's encoding detection.
        for index in bytes.indices where bytes[index] == 0xef && index + 2 < bytes.count {
            if bytes[index + 1] == 0xbb && bytes[index + 2] == 0xbf { return false }
        }
        guard let text = String(data: data, encoding: .utf8),
              !text.unicodeScalars.contains(where: { $0.value == 0xfeff }) else { return false }
        var depth = 0, quoted = false, escaped = false
        for byte in bytes {
            if byte < 32 {
                guard !quoted && (byte == 9 || byte == 10 || byte == 13) else { return false }
            }
            if byte == 127 { return false }
            if quoted {
                if escaped { escaped = false }
                else if byte == 92 { escaped = true }
                else if byte == 34 { quoted = false }
                continue
            }
            if byte == 34 { quoted = true }
            else if byte == 123 || byte == 91 {
                depth += 1; if depth > maxContainerDepth { return false }
            } else if byte == 125 || byte == 93 {
                guard depth > 0 else { return false }; depth -= 1
            }
        }
        return depth == 0 && !quoted && !escaped
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value, let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let result = number.doubleValue
        return result.isFinite ? result : nil
    }
    private static func boolean(_ value: Any?) -> Bool? {
        guard let value, let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    private static func integer(_ value: Any?, max: Double) -> Double? {
        guard let number = number(value), number >= 1, number <= max,
              number.rounded(.towardZero) == number else { return nil }
        return number
    }
    private static func reading(_ input: Any) -> ReadingRecord? {
        guard let fields = input as? [String: Any], fields.count >= 2, fields.count <= 3,
              fields.keys.allSatisfy({ $0 == "step" || $0 == "mode" || $0 == "ready" }),
              let step = number(fields["step"]), step >= 0, step <= 100,
              let modeText = fields["mode"] as? String, let mode = ReadingMode(rawValue: modeText) else { return nil }
        var ready: Bool?
        if fields.keys.contains("ready") {
            guard let supplied = boolean(fields["ready"]) else { return nil }
            ready = supplied
        }
        return ReadingRecord(step: step, mode: mode, ready: ready)
    }
    private static func readingValue(_ input: Any) -> ReadingValue? {
        if let row = reading(input) { return .record(row) }
        guard let inputs = input as? [Any], inputs.count >= 1, inputs.count <= 8 else { return nil }
        var rows: [ReadingRecord] = []
        rows.reserveCapacity(inputs.count)
        for input in inputs {
            guard let row = reading(input) else { return nil }; rows.append(row)
        }
        return .table(rows)
    }
    private static func object(_ reading: ReadingRecord) -> [String: Any] {
        // Match JSON.stringify's normalization of negative zero in producer bytes.
        var fields: [String: Any] = ["step": reading.step == 0 ? 0 : reading.step, "mode": reading.mode.rawValue]
        if let ready = reading.ready { fields["ready"] = ready }
        return fields
    }
    private static func object(_ value: ReadingValue) -> Any {
        switch value {
        case .record(let reading): return object(reading)
        case .table(let readings): return readings.map { object($0) }
        }
    }

    public static func encode(_ sample: StructuredTelemetrySample) throws -> Data {
        guard valid(sample) else { throw StructuredTelemetryWireError.invalid }
        let packet: [String: Any] = [
            "protocol": "connect", "version": 2, "type": "sample", "epoch": sample.epoch,
            "slot": sample.slot, "sequence": sample.sequence,
            "capturedAt": sample.capturedAt == 0 ? 0 : sample.capturedAt, "value": object(sample.value)
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys])
            guard validUTF8Envelope(data) else { throw StructuredTelemetryWireError.invalid }
            return data
        } catch { throw StructuredTelemetryWireError.invalid }
    }

    public static func decode(_ data: Data, lane: TelemetryLane) -> StructuredTelemetrySample? {
        guard lane == .disposable, validUTF8Envelope(data),
              let parsed = try? JSONSerialization.jsonObject(with: data), let fields = parsed as? [String: Any],
              Set(fields.keys) == envelopeFields,
              fields["protocol"] as? String == "connect", fields["type"] as? String == "sample",
              let version = number(fields["version"]), version == 2,
              let epoch = fields["epoch"] as? String, validEpoch(epoch),
              let slot = integer(fields["slot"], max: 128),
              let sequence = integer(fields["sequence"], max: 4294967295),
              let capturedAt = number(fields["capturedAt"]), capturedAt >= 0,
              let rawValue = fields["value"], let value = readingValue(rawValue) else { return nil }
        return StructuredTelemetrySample(epoch: epoch, slot: UInt16(slot), sequence: UInt32(sequence), capturedAt: capturedAt, value: value)
    }
}
