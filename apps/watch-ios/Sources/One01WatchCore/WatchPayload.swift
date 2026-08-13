import Foundation

/// Compact binary wire format for wrist samples.
///
/// A watch relays roughly 50 samples per second while a game is running, and every one of those
/// crosses a Bluetooth link with a small MTU and a real power cost. JSON would spend most of the
/// packet on key names that never change, so the realtime path uses a fixed little-endian layout
/// and reserves readable messages for the control path.
///
/// Layout (53 bytes):
/// ```
///  0      magic 0x31
///  1      version
///  2..3   sequence            u16
///  4..7   milliseconds        u32   (since the relay started, not wall clock)
///  8..23  orientation x,y,z,w f32 x4
/// 24..35  acceleration x,y,z  f32 x3 (g, gravity removed)
/// 36..47  rotationRate x,y,z  f32 x3 (degrees/second)
/// 48..51  crown travel        f32    (detents, monotonic)
/// 52      buttons bitfield    u8     (bit 0: tap)
/// ```
/// Nothing here identifies the wearer or their health. That is a deliberate limit, not an
/// omission: 101 treats a watch as a motion controller and nothing else.
public struct WatchPayload: Equatable, Sendable {
    public static let magic: UInt8 = 0x31
    public static let version: UInt8 = 1
    public static let byteCount = 53

    public var sequence: UInt16
    public var milliseconds: UInt32
    public var orientation: (x: Float, y: Float, z: Float, w: Float)
    public var acceleration: (x: Float, y: Float, z: Float)
    public var rotationRate: (x: Float, y: Float, z: Float)
    public var crown: Float
    public var tap: Bool

    public init(
        sequence: UInt16,
        milliseconds: UInt32,
        orientation: (x: Float, y: Float, z: Float, w: Float),
        acceleration: (x: Float, y: Float, z: Float),
        rotationRate: (x: Float, y: Float, z: Float),
        crown: Float,
        tap: Bool
    ) {
        self.sequence = sequence
        self.milliseconds = milliseconds
        self.orientation = orientation
        self.acceleration = acceleration
        self.rotationRate = rotationRate
        self.crown = crown
        self.tap = tap
    }

    public static func == (lhs: WatchPayload, rhs: WatchPayload) -> Bool {
        lhs.sequence == rhs.sequence
            && lhs.milliseconds == rhs.milliseconds
            && lhs.orientation == rhs.orientation
            && lhs.acceleration == rhs.acceleration
            && lhs.rotationRate == rhs.rotationRate
            && lhs.crown == rhs.crown
            && lhs.tap == rhs.tap
    }

    public func encoded() -> Data {
        var data = Data(capacity: Self.byteCount)
        data.append(Self.magic)
        data.append(Self.version)
        data.appendLittleEndian(sequence)
        data.appendLittleEndian(milliseconds)
        for value in [orientation.x, orientation.y, orientation.z, orientation.w] { data.appendLittleEndian(value) }
        for value in [acceleration.x, acceleration.y, acceleration.z] { data.appendLittleEndian(value) }
        for value in [rotationRate.x, rotationRate.y, rotationRate.z] { data.appendLittleEndian(value) }
        data.appendLittleEndian(crown)
        data.append(tap ? 1 : 0)
        return data
    }

    /// Returns nil rather than trapping on a short, misaligned or foreign packet. A relay must
    /// tolerate junk on the wire without taking the controller down.
    public static func decode(_ data: Data) -> WatchPayload? {
        guard data.count == byteCount else { return nil }
        let bytes = [UInt8](data)
        guard bytes[0] == magic, bytes[1] == version else { return nil }

        var offset = 2
        let sequence = bytes.littleEndianUInt16(at: &offset)
        let milliseconds = bytes.littleEndianUInt32(at: &offset)
        let qx = bytes.littleEndianFloat(at: &offset)
        let qy = bytes.littleEndianFloat(at: &offset)
        let qz = bytes.littleEndianFloat(at: &offset)
        let qw = bytes.littleEndianFloat(at: &offset)
        let ax = bytes.littleEndianFloat(at: &offset)
        let ay = bytes.littleEndianFloat(at: &offset)
        let az = bytes.littleEndianFloat(at: &offset)
        let gx = bytes.littleEndianFloat(at: &offset)
        let gy = bytes.littleEndianFloat(at: &offset)
        let gz = bytes.littleEndianFloat(at: &offset)
        let crown = bytes.littleEndianFloat(at: &offset)
        let tap = bytes[offset] & 0x01 == 0x01

        // A quaternion that is not finite would poison the motion pipeline downstream.
        for value in [qx, qy, qz, qw, ax, ay, az, gx, gy, gz, crown] where !value.isFinite {
            return nil
        }

        return WatchPayload(
            sequence: sequence,
            milliseconds: milliseconds,
            orientation: (qx, qy, qz, qw),
            acceleration: (ax, ay, az),
            rotationRate: (gx, gy, gz),
            crown: crown,
            tap: tap
        )
    }
}

private extension Data {
    mutating func appendLittleEndian(_ value: UInt16) {
        append(UInt8(value & 0xFF))
        append(UInt8((value >> 8) & 0xFF))
    }

    mutating func appendLittleEndian(_ value: UInt32) {
        for shift in stride(from: 0, to: 32, by: 8) { append(UInt8((value >> UInt32(shift)) & 0xFF)) }
    }

    mutating func appendLittleEndian(_ value: Float) {
        appendLittleEndian(value.bitPattern)
    }
}

private extension [UInt8] {
    func littleEndianUInt16(at offset: inout Int) -> UInt16 {
        defer { offset += 2 }
        return UInt16(self[offset]) | (UInt16(self[offset + 1]) << 8)
    }

    func littleEndianUInt32(at offset: inout Int) -> UInt32 {
        defer { offset += 4 }
        var value: UInt32 = 0
        for index in 0..<4 { value |= UInt32(self[offset + index]) << UInt32(index * 8) }
        return value
    }

    func littleEndianFloat(at offset: inout Int) -> Float {
        var local = offset
        let bits = littleEndianUInt32(at: &local)
        offset = local
        return Float(bitPattern: bits)
    }
}
