import AppKit
import CryptoKit
import Darwin
import Foundation

guard CommandLine.arguments.count == 1 else { exit(64) }
let hardEnd = ProcessInfo.processInfo.systemUptime + 10
// A sole private named pasteboard, created by the native host. No program/name,
// pasteboard type, general clipboard, URL or executable configuration is input.
let board = NSPasteboard.withUniqueName()
let ownedId = "private-pasteboard-" + UUID().uuidString.lowercased()
let selectedType = NSPasteboard.PasteboardType("org.oneohone.private.bytes.v1")
var revision = board.changeCount
var current: Data? = nil
var commands = 0, receivedBytes = 0, sentBytes = 0, lastId = 0
var exitCode: Int32 = 0

func sha(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
func emit(_ value: [String: Any]) -> Bool {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), bytes.count <= 1023,
        sentBytes + bytes.count + 1 <= 16384 else { return false }
    sentBytes += bytes.count + 1
    do { try FileHandle.standardOutput.write(contentsOf: bytes); try FileHandle.standardOutput.write(contentsOf: Data([10])); return true }
    catch { return false }
}
func hex(_ value: String) -> Data? {
    guard value.utf8.count <= 256, value.utf8.count % 2 == 0,
        value.utf8.allSatisfy({ ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }) else { return nil }
    var result = Data(); let bytes = Array(value.utf8)
    func nibble(_ byte: UInt8) -> UInt8 { byte <= 57 ? byte - 48 : byte - 87 }
    for index in stride(from: 0, to: bytes.count, by: 2) { result.append(nibble(bytes[index]) * 16 + nibble(bytes[index + 1])) }
    return result
}
func nativeCurrent() -> Bool {
    guard board.changeCount == revision else { return false }
    // A separate native instance reads actual AppKit data on this exact issued
    // board. Opaque framework allocation is outside the owned byte-buffer bound;
    // only our <=128-byte writes are admitted under a cooperative host.
    let observer = NSPasteboard(name: board.name)
    let observed = observer.data(forType: selectedType)
    guard board.changeCount == revision, observed == current else { return false }
    return observed == nil || observed!.count <= 128
}
func handle(_ line: String) -> Bool {
    guard ProcessInfo.processInfo.systemUptime < hardEnd else { return false }
    let fields = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
    guard fields.count >= 2, let id = Int(fields[0]), id > lastId, id <= 64, String(id) == fields[0], commands < 32 else { return false }
    let action = fields[1]
    guard action == "READ" ? fields.count == 2 : (action == "WRITE" ? fields.count == 5 : action == "CLEAR" && fields.count == 4) else { return false }
    var input: Data? = nil
    if action != "READ" {
        guard let expected = Int(fields[2]), expected >= 0, String(expected) == fields[2], expected <= Int(Int32.max),
            fields[3] == "absent" || fields[3].utf8.count == 64 && hex(fields[3])?.count == 32 else { return false }
        if action == "WRITE" { guard let selected = hex(fields[4]) else { return false }; input = selected }
        commands += 1; lastId = id
        guard expected == revision, fields[3] == (current.map(sha) ?? "absent") else {
            return emit(["version": 1, "kind": "result", "id": id, "action": action.lowercased(), "ok": false, "reason": "conflict"])
        }
    } else { commands += 1; lastId = id }
    guard nativeCurrent() else { return emit(["version": 1, "kind": "result", "id": id, "action": action.lowercased(), "ok": false, "reason": "unavailable"]) }
    if action == "READ" {
        return emit(["version": 1, "kind": "result", "id": id, "action": "read", "ok": true, "revision": revision,
            "hasValue": current != nil, "bytes": current.map { $0.map { String(format: "%02x", $0) }.joined() } ?? "",
            "sha256": current.map(sha) ?? "absent"])
    }
    guard ProcessInfo.processInfo.systemUptime < hardEnd else { return false }
    let previous = revision
    revision = board.clearContents()
    guard revision > previous, revision <= Int(Int32.max) else { return false }
    current = nil
    if action == "WRITE" {
        guard ProcessInfo.processInfo.systemUptime < hardEnd else { return false }
        guard board.setData(input!, forType: selectedType) else { return false }; current = input
        guard nativeCurrent() else { return false }
        return emit(["version": 1, "kind": "result", "id": id, "action": "write", "ok": true, "revision": revision,
            "sha256": sha(input!), "byteLength": input!.count])
    }
    guard nativeCurrent() else { return false }
    return emit(["version": 1, "kind": "result", "id": id, "action": "clear", "ok": true, "revision": revision, "empty": true])
}

func run() {
    defer {
        // EOF, malformed input and the fixed native lifetime all release this
        // owned board. SIGKILL/host failure cannot run defer: parent reports
        // cleanup-unverified and never claims native data removal in that case.
        board.clearContents(); current = nil
        let cleared = NSPasteboard(name: board.name).data(forType: selectedType) == nil
        board.releaseGlobally()
        _ = emit(["version": 1, "kind": "closed", "cleared": cleared, "released": true])
    }
    guard ProcessInfo.processInfo.systemUptime < hardEnd, revision >= 0, revision <= Int(Int32.max), nativeCurrent(), ProcessInfo.processInfo.systemUptime < hardEnd,
        emit(["version": 1, "kind": "ready", "boardId": ownedId, "initialRevision": revision]) else { exitCode = 64; return }
    var pending = [UInt8](), buffer = [UInt8](repeating: 0, count: 512)
    while ProcessInfo.processInfo.systemUptime < hardEnd {
        let remaining = max(1, min(10000, Int((hardEnd - ProcessInfo.processInfo.systemUptime) * 1000)))
        var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
        let polled = poll(&descriptor, 1, Int32(remaining))
        if polled == 0 { return }
        if polled < 0 { if errno == EINTR { continue }; exitCode = 64; return }
        let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
        if count == 0 { if !pending.isEmpty { exitCode = 64 }; return }
        if count < 0 { if errno == EINTR { continue }; exitCode = 64; return }
        receivedBytes += count
        if receivedBytes > 16384 { exitCode = 64; return }
        for byte in buffer.prefix(count) {
            if byte == 10 {
                guard !pending.isEmpty, let line = String(bytes: pending, encoding: .utf8), handle(line) else { exitCode = 64; return }; pending.removeAll(keepingCapacity: true)
            } else {
                guard pending.count < 511, byte == 9 || byte >= 32 && byte <= 126 else { exitCode = 64; return }; pending.append(byte)
            }
        }
    }
}
run()
exit(exitCode)
