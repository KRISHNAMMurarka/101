import Foundation
import One01StructuredTelemetryWire

// Ordinary offline caller. No transport, saved identity, sensor or device APIs are used.
@main enum StructuredTelemetryConsumer {
    private enum CallerError: Error { case framing }
    private static let maxCommands = 128
    private static let maxLineBytes = 16384
    private static let maxTotalBytes = 1048576

    private static func bytes(_ hex: String) -> Data? {
        let input = Array(hex.utf8)
        guard !input.isEmpty, input.count <= StructuredTelemetryWire.maxPacketBytes * 2, input.count % 2 == 0 else { return nil }
        func nibble(_ byte: UInt8) -> UInt8? {
            if byte >= 48 && byte <= 57 { return byte - 48 }
            if byte >= 97 && byte <= 102 { return byte - 87 }
            return nil
        }
        var output = Data(capacity: input.count / 2)
        for offset in stride(from: 0, to: input.count, by: 2) {
            guard let high = nibble(input[offset]), let low = nibble(input[offset + 1]) else { return nil }
            output.append(high * 16 + low)
        }
        return output
    }
    private static func reading(_ fields: ArraySlice<String>) -> ReadingRecord? {
        let values = Array(fields)
        guard values.count == 3, let step = Double(values[0]), let mode = ReadingMode(rawValue: values[1]) else { return nil }
        let ready: Bool?
        switch values[2] {
        case "-": ready = nil
        case "0": ready = false
        case "1": ready = true
        default: return nil
        }
        return ReadingRecord(step: step, mode: mode, ready: ready)
    }
    private static func encodingInput(_ fields: [String]) -> StructuredTelemetrySample? {
        guard fields.count >= 7, fields[0] == "E", let slot = UInt16(fields[2]),
              let sequence = UInt32(fields[3]), let capturedAt = Double(fields[4]) else { return nil }
        let value: ReadingValue
        if fields[5] == "R", fields.count == 9, let row = reading(fields[6..<9]) {
            value = .record(row)
        } else if fields[5] == "T", let count = UInt8(fields[6]), count >= 1, count <= 8,
                  fields.count == 7 + Int(count) * 3 {
            var rows: [ReadingRecord] = []
            for index in 0..<Int(count) {
                let start = 7 + index * 3
                guard let row = reading(fields[start..<(start + 3)]) else { return nil }; rows.append(row)
            }
            value = .table(rows)
        } else { return nil }
        return StructuredTelemetrySample(epoch: fields[1], slot: slot, sequence: sequence, capturedAt: capturedAt, value: value)
    }
    private static func result(_ sample: StructuredTelemetrySample?) -> String {
        guard let sample, let encoded = try? StructuredTelemetryWire.encode(sample),
              let packet = try? JSONSerialization.jsonObject(with: encoded),
              let output = try? JSONSerialization.data(withJSONObject: [
                "hex": encoded.map { String(format: "%02x", $0) }.joined(), "packet": packet
              ], options: [.sortedKeys]), let text = String(data: output, encoding: .utf8) else { return "null" }
        return text
    }
    private static func command(_ line: [UInt8]) -> String {
        guard line.allSatisfy({ $0 >= 32 && $0 < 127 }), let text = String(bytes: line, encoding: .utf8) else { return "null" }
        let fields = text.split(separator: " ").map(String.init)
        if fields.count == 3, fields[0] == "D", let lane = TelemetryLane(rawValue: fields[1]), let data = bytes(fields[2]) {
            return result(StructuredTelemetryWire.decode(data, lane: lane))
        }
        return result(encodingInput(fields))
    }
    private static func run() throws {
        var line: [UInt8] = [], commands = 0, inputBytes = 0, outputBytes = 0
        while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
            inputBytes += chunk.count; guard inputBytes <= maxTotalBytes else { throw CallerError.framing }
            for byte in chunk {
                if byte == 10 {
                    commands += 1; guard commands <= maxCommands else { throw CallerError.framing }
                    let output = Data((command(line) + "\n").utf8)
                    outputBytes += output.count; guard outputBytes <= maxTotalBytes else { throw CallerError.framing }
                    try FileHandle.standardOutput.write(contentsOf: output)
                    line.removeAll(keepingCapacity: true)
                } else {
                    guard line.count < maxLineBytes else { throw CallerError.framing }; line.append(byte)
                }
            }
        }
        guard line.isEmpty else { throw CallerError.framing }
    }
    static func main() {
        do { try run() }
        catch { exit(2) }
    }
}
