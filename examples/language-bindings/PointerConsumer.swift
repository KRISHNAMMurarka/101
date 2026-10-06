import Foundation
import One01PointerWire

func bytes(_ hex: String) -> Data? {
    guard hex.count <= 2048, hex.count % 2 == 0 else { return nil }
    var result = Data()
    var index = hex.startIndex
    while index < hex.endIndex {
        let end = hex.index(index, offsetBy: 2)
        guard let value = UInt8(hex[index..<end], radix: 16) else { return nil }
        result.append(value); index = end
    }
    return result
}
func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
var count = 0
while let line = readLine() {
    count += 1
    guard count <= 128, line.utf8.count <= 4096 else { exit(2) }
    let fields = line.split(separator: " ").map(String.init)
    var encoded: Data?
    if fields.count == 7, fields[0] == "E", let epoch = bytes(fields[1]),
       let slot = UInt16(fields[2]), let sequence = UInt32(fields[3]),
       let time = Double(fields[4]), let x = Double(fields[5]), let y = Double(fields[6]) {
        encoded = try? PointerWire.encode(PointerSample(epoch: epoch, slot: slot, sequence: sequence, capturedAt: time, x: x, y: y))
    } else if fields.count == 3, fields[0] == "D", let data = bytes(fields[2]),
              let lane = PointerLane(rawValue: fields[1]), let sample = PointerWire.decode(data, lane: lane) {
        encoded = try? PointerWire.encode(sample)
    }
    print(encoded.map { "{\"hex\":\"\(hex($0))\"}" } ?? "null")
}
