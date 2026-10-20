import Foundation
import Testing
@testable import One01StructuredTelemetryWire

private let fixtureEpoch = "0123456789abcdef0123456789abcdef"

// Root supplies the actual installed-public-SDK producer artifact. Missing inputs block these tests.
private func actualPackets() throws -> [String: Data] {
    let path = try #require(ProcessInfo.processInfo.environment["ONE01_STRUCTURED_FIXTURES"])
    let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
    try #require(bytes.count <= 131072)
    let document = try #require(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    #expect(document["profile"] as? String == "structured-telemetry-json2/1")
    #expect(document["status"] as? String == "pass")
    let entries = try #require(document["positive"] as? [[String: Any]])
    try #require(entries.count == 5)
    var packets: [String: Data] = [:]
    for entry in entries {
        let id = try #require(entry["id"] as? String)
        let wire = try #require(entry["wireUtf8"] as? String)
        try #require(packets[id] == nil)
        packets[id] = Data(wire.utf8)
    }
    return packets
}

private func duplicateKeyNegative() throws -> (Data, Bool) {
    let path = try #require(ProcessInfo.processInfo.environment["ONE01_STRUCTURED_NEGATIVE_FIXTURES"])
    let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
    try #require(bytes.count <= 16384)
    let document = try #require(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    #expect(document["profile"] as? String == "structured-telemetry-json2/1")
    #expect(document["fixtureProfile"] as? String == "structured-telemetry-native-negative/1")
    let entries = try #require(document["negative"] as? [[String: Any]])
    try #require(entries.count == 1)
    let entry = entries[0]
    try #require(entry["id"] as? String == "duplicate-envelope-version-key")
    let wire = try #require(entry["wireUtf8"] as? String)
    let verdicts = try #require(entry["accept"] as? [String: Any])
    let expected = try #require(verdicts["swift"] as? Bool)
    return (Data(wire.utf8), expected)
}

private func packetObject(_ bytes: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
}
private func packetData(_ value: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
}
private func sample(_ value: ReadingValue, epoch: String = fixtureEpoch, slot: UInt16 = 1,
                    sequence: UInt32 = 1, capturedAt: Double = 0) -> StructuredTelemetrySample {
    StructuredTelemetrySample(epoch: epoch, slot: slot, sequence: sequence, capturedAt: capturedAt, value: value)
}

@Test func genuineSDKRecordAndTableBytesPreserveAllSelectedFields() throws {
    let packets = try actualPackets()
    let expected: [String: StructuredTelemetrySample] = [
        "record-absent": sample(.record(ReadingRecord(step: 0, mode: .countUp))),
        "record-false": sample(.record(ReadingRecord(step: 50.25, mode: .countDown, ready: false)),
                               slot: 128, sequence: UInt32.max, capturedAt: 125.5),
        "record-true": sample(.record(ReadingRecord(step: 100, mode: .countUp, ready: true)),
                              slot: 2, sequence: 4, capturedAt: 9007199254740991),
        "one-row": sample(.table([ReadingRecord(step: 1, mode: .countUp, ready: false)]),
                          sequence: 6, capturedAt: 1400.25),
        "eight-rows": sample(.table([
            ReadingRecord(step: 0, mode: .countUp), ReadingRecord(step: 12.5, mode: .countDown, ready: false),
            ReadingRecord(step: 25, mode: .countUp, ready: true), ReadingRecord(step: 37.5, mode: .countDown),
            ReadingRecord(step: 50, mode: .countUp, ready: true), ReadingRecord(step: 62.5, mode: .countDown, ready: false),
            ReadingRecord(step: 75, mode: .countUp), ReadingRecord(step: 87.5, mode: .countDown, ready: false)
        ]), slot: 128, sequence: 32, capturedAt: 1500.125)
    ]
    #expect(Set(packets.keys) == Set(expected.keys))
    for (id, bytes) in packets {
        let decoded = try #require(StructuredTelemetryWire.decode(bytes, lane: .disposable))
        #expect(decoded == expected[id])
        #expect(StructuredTelemetryWire.decode(bytes, lane: .reliable) == nil)
        let encoded = try StructuredTelemetryWire.encode(decoded)
        #expect(encoded.count <= 4096)
        #expect(StructuredTelemetryWire.decode(encoded, lane: .disposable) == expected[id])
        let output = try packetObject(encoded)
        #expect(Set(output.keys) == Set(["protocol", "version", "type", "epoch", "slot", "sequence", "capturedAt", "value"]))
        #expect(output["protocol"] as? String == "connect")
        #expect(output["type"] as? String == "sample")
        #expect((output["version"] as? NSNumber)?.intValue == 2)
    }
}

@Test func absentReadyDoesNotBecomeFalseAndFalseIsNotOmitted() throws {
    let row = ReadingRecord(step: 5, mode: .countDown)
    let absent = try packetObject(StructuredTelemetryWire.encode(sample(.record(row))))
    let falseValue = try packetObject(StructuredTelemetryWire.encode(sample(.record(ReadingRecord(step: 5, mode: .countDown, ready: false)))))
    let absentRow = try #require(absent["value"] as? [String: Any])
    let falseRow = try #require(falseValue["value"] as? [String: Any])
    #expect(!absentRow.keys.contains("ready"))
    #expect(falseRow.keys.contains("ready"))
    #expect(falseRow["ready"] as? Bool == false)
}

@Test func closedHeadersAndNumberTypesRejectMalformedSourcePackets() throws {
    let base = try packetObject(try #require(actualPackets()["record-absent"]))
    let replacements: [(String, Any)] = [
        ("protocol", "other"), ("version", 1), ("version", true), ("type", "event"), ("type", "clock"),
        ("epoch", fixtureEpoch.uppercased()), ("epoch", "short"), ("epoch", String(repeating: "g", count: 32)),
        ("slot", 0), ("slot", 129), ("slot", 1.5), ("slot", true), ("slot", "1"),
        ("sequence", 0), ("sequence", 4294967296 as UInt64), ("sequence", 1.5), ("sequence", false),
        ("capturedAt", -1), ("capturedAt", true), ("capturedAt", "0"), ("value", NSNull())
    ]
    for (key, value) in replacements {
        var bad = base; bad[key] = value
        #expect(StructuredTelemetryWire.decode(try packetData(bad), lane: .disposable) == nil)
    }
    for key in base.keys {
        var bad = base; bad.removeValue(forKey: key)
        #expect(StructuredTelemetryWire.decode(try packetData(bad), lane: .disposable) == nil)
    }
    var extra = base; extra["clockId"] = "invented-clock"
    #expect(StructuredTelemetryWire.decode(try packetData(extra), lane: .disposable) == nil)
}

@Test func sharedDuplicateKeyNegativePinsObservedArtifactVerdict() throws {
    let (bytes, expectedAccept) = try duplicateKeyNegative()
    #expect((StructuredTelemetryWire.decode(bytes, lane: .disposable) != nil) == expectedAccept)
}

@Test func futureWireRevisionCannotReinterpretSelectedRecordOrTable() throws {
    let path = try #require(ProcessInfo.processInfo.environment["ONE01_STRUCTURED_NEGATIVE_FIXTURES"])
    let bytes = try Data(contentsOf: URL(fileURLWithPath: path))
    try #require(bytes.count <= 16384)
    let document = try #require(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    let entries = try #require(document["incompatibleRevisions"] as? [[String: Any]])
    try #require(entries.count == 2)
    for entry in entries {
        let wire = try #require(entry["wireUtf8"] as? String)
        #expect(StructuredTelemetryWire.decode(Data(wire.utf8), lane: .disposable) == nil)
    }
}

@Test func selectedRecordAndArraySchemasRejectCoercionNullAndUnboundedRows() throws {
    let base = try packetObject(try #require(actualPackets()["record-absent"]))
    let validRow: [String: Any] = ["step": 0, "mode": "count-up"]
    let invalidRows: [[String: Any]] = [
        ["step": true, "mode": "count-up"], ["step": "5", "mode": "count-up"],
        ["step": -0.1, "mode": "count-up"], ["step": 100.1, "mode": "count-up"],
        ["step": NSNull(), "mode": "count-up"], ["step": 0], ["mode": "count-up"],
        ["step": 0, "mode": "up"], ["step": 0, "mode": NSNull()],
        ["step": 0, "mode": "count-up", "ready": 0], ["step": 0, "mode": "count-up", "ready": 1],
        ["step": 0, "mode": "count-up", "ready": "false"], ["step": 0, "mode": "count-up", "ready": NSNull()],
        ["step": 0, "mode": "count-up", "extra": false]
    ]
    for row in invalidRows {
        let variants: [Any] = [row, [row]]
        for value in variants {
            var bad = base; bad["value"] = value
            #expect(StructuredTelemetryWire.decode(try packetData(bad), lane: .disposable) == nil)
        }
    }
    let invalidValues: [Any] = [[], Array(repeating: validRow, count: 9), [NSNull()], [[validRow]], true, "value"]
    for value in invalidValues {
        var bad = base; bad["value"] = value
        #expect(StructuredTelemetryWire.decode(try packetData(bad), lane: .disposable) == nil)
    }
}

@Test func rawUTF8BoundDepthAndControlGuardsPrecedeFoundationAutodetection() throws {
    let original = try #require(actualPackets()["record-absent"])
    let text = try #require(String(data: original, encoding: .utf8))
    let padded = original + Data(repeating: 32, count: 4096 - original.count)
    #expect(StructuredTelemetryWire.decode(padded, lane: .disposable) != nil)
    #expect(StructuredTelemetryWire.decode(padded + Data([32]), lane: .disposable) == nil)
    for encoding in [String.Encoding.utf16, .utf16LittleEndian, .utf16BigEndian, .utf32, .utf32LittleEndian, .utf32BigEndian] {
        let wrongEncoding = try #require(text.data(using: encoding))
        #expect(StructuredTelemetryWire.decode(wrongEncoding, lane: .disposable) == nil)
    }
    for prefix in [Data([0xef, 0xbb, 0xbf]), Data([0]), Data([0x1f]), Data([0x7f]), Data([0xc0, 0xaf])] {
        #expect(StructuredTelemetryWire.decode(prefix + original, lane: .disposable) == nil)
    }
    #expect(StructuredTelemetryWire.decode(Data([32, 9, 0xef, 0xbb, 0xbf]) + original, lane: .disposable) == nil)
    #expect(StructuredTelemetryWire.decode(Data(("\t\r\n " + text + " \n").utf8), lane: .disposable) != nil)
    #expect(StructuredTelemetryWire.decode(Data(text.replacingOccurrences(of: "count-up", with: "count\\u002dup").utf8), lane: .disposable) != nil)
    #expect(StructuredTelemetryWire.decode(Data(text.replacingOccurrences(of: "\"capturedAt\":0", with: "\"capturedAt\":1e309").utf8), lane: .disposable) == nil)
    var deep = try packetObject(original)
    deep["value"] = [[[[[0]]]]]
    #expect(StructuredTelemetryWire.decode(try packetData(deep), lane: .disposable) == nil)
    #expect(StructuredTelemetryWire.decode(Data("{\"value\":\"unterminated".utf8), lane: .disposable) == nil)
}

@Test func nonzeroStartDataSlicesAndLargeFiniteSourceTimesRoundtrip() throws {
    let original = try #require(actualPackets()["record-false"])
    var prefixed = Data([127]); prefixed.append(original)
    #expect(StructuredTelemetryWire.decode(prefixed.dropFirst(), lane: .disposable) == StructuredTelemetryWire.decode(original, lane: .disposable))
    let input = sample(.record(ReadingRecord(step: 100, mode: .countUp, ready: true)), capturedAt: 1e300)
    let output = try #require(StructuredTelemetryWire.decode(try StructuredTelemetryWire.encode(input), lane: .disposable))
    #expect(output == input)
}

@Test func invalidTypedNativeEncodeProducesNoPacket() throws {
    let row = ReadingRecord(step: 0, mode: .countUp)
    var invalid = [
        sample(.record(row), epoch: ""), sample(.record(row), epoch: fixtureEpoch.uppercased()),
        sample(.record(row), slot: 0), sample(.record(row), slot: 129), sample(.record(row), sequence: 0),
        sample(.table([])), sample(.table(Array(repeating: row, count: 9)))
    ]
    invalid += [-1, Double.nan, Double.infinity, -Double.infinity].map { sample(.record(row), capturedAt: $0) }
    invalid += [-0.1, 100.1, Double.nan, Double.infinity, -Double.infinity].map { sample(.record(ReadingRecord(step: $0, mode: .countUp))) }
    for input in invalid {
        #expect(throws: StructuredTelemetryWireError.invalid) { try StructuredTelemetryWire.encode(input) }
    }
}
