import Foundation

public enum PointerLane: String, Sendable { case reliable, disposable }
public enum PointerWireError: Error, Equatable { case invalid }

/// Parsed samples are inert data. A host separately selects and grants a current route.
public struct PointerSample: Sendable {
    public let epoch: Data
    public let slot: UInt16
    public let sequence: UInt32
    public let capturedAt: Double
    public let x: Double
    public let y: Double
    public init(epoch: Data, slot: UInt16, sequence: UInt32, capturedAt: Double, x: Double, y: Double) {
        self.epoch = epoch; self.slot = slot; self.sequence = sequence
        self.capturedAt = capturedAt; self.x = x; self.y = y
    }
}

public enum PointerWire {
    private static func valid(_ sample: PointerSample) -> Bool {
        sample.epoch.count == 16 && sample.slot >= 1 && sample.slot <= 128 && sample.sequence > 0 &&
        sample.capturedAt.isFinite && sample.capturedAt >= 0 &&
        sample.x.isFinite && sample.x >= 0 && sample.x <= 1 && sample.y.isFinite && sample.y >= 0 && sample.y <= 1
    }
    public static func encode(_ sample: PointerSample) throws -> Data {
        guard valid(sample) else { throw PointerWireError.invalid }
        var bytes = [UInt8](repeating: 0, count: 48)
        func write(_ value: UInt64, _ offset: Int, _ count: Int) {
            for index in 0..<count { bytes[offset + index] = UInt8(truncatingIfNeeded: value >> ((count - index - 1) * 8)) }
        }
        bytes[0] = 0x43; bytes[1] = 0x4e; bytes[2] = 1; bytes[3] = 1
        bytes.replaceSubrange(4..<20, with: sample.epoch)
        write(UInt64(sample.slot), 20, 2); write(UInt64(sample.sequence), 24, 4)
        write(sample.capturedAt.bitPattern, 28, 8)
        write(UInt64(Float(sample.x).bitPattern), 36, 4); write(UInt64(Float(sample.y).bitPattern), 40, 4)
        return Data(bytes)
    }
    public static func decode(_ data: Data, lane: PointerLane) -> PointerSample? {
        guard lane == .disposable, data.count == 48 else { return nil }
        // Copy only after checking the fixed envelope; Data may have a nonzero slice start index.
        let bytes = [UInt8](data)
        guard bytes[0] == 0x43, bytes[1] == 0x4e, bytes[2] == 1, bytes[3] == 1,
              bytes[22] == 0, bytes[23] == 0, bytes[44...47].allSatisfy({ $0 == 0 }) else { return nil }
        func read(_ offset: Int, _ count: Int) -> UInt64 {
            var result: UInt64 = 0
            for index in 0..<count { result = (result << 8) | UInt64(bytes[offset + index]) }
            return result
        }
        let sample = PointerSample(epoch: Data(bytes[4..<20]), slot: UInt16(read(20, 2)), sequence: UInt32(read(24, 4)),
            capturedAt: Double(bitPattern: read(28, 8)), x: Double(Float(bitPattern: UInt32(read(36, 4)))), y: Double(Float(bitPattern: UInt32(read(40, 4)))))
        return valid(sample) ? sample : nil
    }
}
