import Foundation
import Testing
@testable import One01PointerWire

@Test func rejectsMalformedAndReliablePacketsWithoutAuthority() throws {
    let input = PointerSample(epoch: Data(repeating: 0x11, count: 16), slot: 128, sequence: UInt32.max,
                              capturedAt: 123456789.12345679, x: 0.123456789, y: 0.876543211)
    let bytes = try PointerWire.encode(input)
    #expect(bytes.count == 48)
    let sample = try #require(PointerWire.decode(bytes, lane: .disposable))
    #expect(sample.capturedAt == input.capturedAt)
    #expect(abs(sample.x - input.x) <= pow(2, -25))
    #expect(PointerWire.decode(bytes, lane: .reliable) == nil)
    for index in [0, 1, 2, 3, 22, 23, 44, 45, 46, 47] {
        var bad = bytes; bad[index] ^= 2
        #expect(PointerWire.decode(bad, lane: .disposable) == nil)
    }
    #expect(PointerWire.decode(bytes.dropLast(), lane: .disposable) == nil)
    #expect(throws: PointerWireError.invalid) {
        try PointerWire.encode(PointerSample(epoch: input.epoch, slot: 1, sequence: 1, capturedAt: .nan, x: 0, y: 0))
    }
}
