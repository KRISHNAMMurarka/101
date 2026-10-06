import Foundation

// Offline inert caller of the unchanged WatchPayload codec. No native watch/phone API is used.
@main enum WatchReportConsumer {
    static func bytes(_ text: String) -> Data? {
        if text == "-" { return Data() }
        let source = Array(text.utf8)
        guard source.count <= 512, source.count % 2 == 0 else { return nil }
        func nibble(_ value: UInt8) -> UInt8? {
            if value >= 48 && value <= 57 { return value - 48 }
            if value >= 97 && value <= 102 { return value - 87 }
            return nil
        }
        var output = Data(capacity: source.count / 2)
        for index in stride(from: 0, to: source.count, by: 2) {
            guard let high = nibble(source[index]), let low = nibble(source[index + 1]) else { return nil }
            output.append(high * 16 + low)
        }
        return output
    }
    static func result(_ report: WatchPayload?) throws -> String {
        guard let report else { return "null" }
        let value: [String: Any] = [
            "hex": report.encoded().map { String(format: "%02x", $0) }.joined(),
            "sequence": Int(report.sequence), "relayEmissionMs": UInt64(report.milliseconds),
            "orientationReported": [Double(report.orientation.x), Double(report.orientation.y), Double(report.orientation.z), Double(report.orientation.w)],
            "accelerationG": [Double(report.acceleration.x), Double(report.acceleration.y), Double(report.acceleration.z)],
            "rotationDegPerSecond": [Double(report.rotationRate.x), Double(report.rotationRate.y), Double(report.rotationRate.z)],
            "crownReported": Double(report.crown), "tap": report.tap
        ]
        return String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    static func command(_ line: [UInt8]) throws -> String {
        guard line.allSatisfy({ $0 >= 32 && $0 < 127 }), let text = String(bytes: line, encoding: .utf8) else { return "null" }
        let fields = text.split(separator: " ").map(String.init)
        if fields.count == 2, fields[0] == "D", let data = bytes(fields[1]) {
            return try result(WatchPayload.decode(data))
        }
        guard fields.count == 15, fields[0] == "E", let sequence = UInt16(fields[1]), let emission = UInt32(fields[2]),
              fields[14] == "0" || fields[14] == "1" else { return "null" }
        let values = fields[3..<14].compactMap { Float($0) }
        guard values.count == 11, values.allSatisfy({ $0.isFinite }) else { return "null" }
        let report = WatchPayload(sequence: sequence, milliseconds: emission,
            orientation: (values[0], values[1], values[2], values[3]),
            acceleration: (values[4], values[5], values[6]), rotationRate: (values[7], values[8], values[9]),
            crown: values[10], tap: fields[14] == "1")
        return try result(report)
    }
    static func main() throws {
        var line: [UInt8] = [], count = 0, outputBytes = 0
        while let chunk = try FileHandle.standardInput.read(upToCount: 4096), !chunk.isEmpty {
            for byte in chunk {
                if byte == 10 {
                    count += 1; guard count <= 128 else { exit(2) }
                    let answer = try command(line) + "\n"
                    outputBytes += answer.utf8.count; guard outputBytes <= 131072 else { exit(2) }
                    FileHandle.standardOutput.write(Data(answer.utf8)); line.removeAll(keepingCapacity: true)
                } else {
                    guard line.count < 4096 else { exit(2) }; line.append(byte)
                }
            }
        }
        guard line.isEmpty else { exit(2) }
    }
}
