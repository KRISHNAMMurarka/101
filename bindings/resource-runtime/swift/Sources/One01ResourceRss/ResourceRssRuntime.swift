import Darwin

public enum RssAction: Int { case register = 1, read = 2 }
public enum RssStatus: Error, Equatable { case denied, stale, busy, limit, unavailable }

/// Identity is local to this process and runtime. It is never a serializable grant.
public final class RssHandle {
    fileprivate weak var owner: ResourceRssRuntime?
    public let epoch: UInt64
    fileprivate let generation: UInt32
    fileprivate init(owner: ResourceRssRuntime, epoch: UInt64, generation: UInt32) {
        self.owner = owner; self.epoch = epoch; self.generation = generation
    }
}

public struct RssSample: Equatable {
    public let epoch: UInt64
    public let sequence: UInt32
    public let capturedAtNs: UInt64
    public let rssBytes: UInt64
}

/// Cooperative, synchronous, thread-confined macOS self-RSS lifecycle.
public final class ResourceRssRuntime {
    public typealias Approval = (RssAction, UInt64, UInt64) -> UInt64?
    private let approve: Approval
    private let current: (UInt64) -> Bool
    private var revision: UInt64 = 0
    private var generations: UInt32 = 0
    private var active: RssHandle?
    private var registrationDeadline: UInt64 = 0
    private var sequence: UInt32 = 0
    private var inCall = false
    private let ownerThread = pthread_self()

    public init(approve: @escaping Approval, current: @escaping (UInt64) -> Bool) {
        self.approve = approve; self.current = current
    }

    private static func monotonicNs() -> UInt64? {
        var time = timespec()
        guard clock_gettime(CLOCK_MONOTONIC, &time) == 0, time.tv_sec >= 0, time.tv_nsec >= 0,
              UInt64(time.tv_sec) <= (UInt64.max - UInt64(time.tv_nsec)) / 1_000_000_000 else { return nil }
        return UInt64(time.tv_sec) * 1_000_000_000 + UInt64(time.tv_nsec)
    }

    private static func selfResidentBytes() -> UInt64? {
        var info = mach_task_basic_info_data_t()
        let expectedCount = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
        var count = expectedCount
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), rebound, &count)
            }
        }
        guard result == KERN_SUCCESS, count == expectedCount, info.resident_size > 0 else { return nil }
        return UInt64(info.resident_size)
    }

    public func start(epoch: UInt64) -> Result<RssHandle, RssStatus> {
        guard pthread_equal(ownerThread, pthread_self()) != 0 else { return .failure(.denied) }
        guard epoch != 0 else { return .failure(.denied) }
        guard !inCall else { return .failure(.busy) }
        guard active == nil else { return .failure(.busy) }
        guard generations < 2 else { return .failure(.limit) }
        inCall = true
        defer { inCall = false }
        guard let first = Self.monotonicNs() else { return .failure(.unavailable) }
        let before = revision
        guard let deadline = approve(.register, epoch, first), revision == before, active == nil,
              deadline > first, deadline - first <= 10_000_000_000 else { return .failure(.denied) }
        guard let afterApproval = Self.monotonicNs(), afterApproval < deadline else { return .failure(.denied) }
        guard current(epoch), revision == before, active == nil, generations < 2,
              let afterCurrent = Self.monotonicNs(), afterCurrent < deadline else { return .failure(.denied) }
        generations += 1
        let handle = RssHandle(owner: self, epoch: epoch, generation: generations)
        active = handle; registrationDeadline = deadline; sequence = 0
        return .success(handle)
    }

    public func read(_ handle: RssHandle) -> Result<RssSample, RssStatus> {
        guard pthread_equal(ownerThread, pthread_self()) != 0 else { return .failure(.stale) }
        guard let active, active === handle, handle.owner === self,
              handle.generation == generations else { return .failure(.stale) }
        guard !inCall else { return .failure(.busy) }
        guard sequence < 32 else { return .failure(.limit) }
        inCall = true
        defer { inCall = false }
        guard let first = Self.monotonicNs() else { return .failure(.unavailable) }
        guard first < registrationDeadline, current(handle.epoch), active === self.active,
              let afterCurrent = Self.monotonicNs(), afterCurrent < registrationDeadline else { return .failure(.denied) }
        let before = revision
        guard let deadline = approve(.read, handle.epoch, afterCurrent), revision == before,
              active === self.active, deadline > afterCurrent, deadline - afterCurrent <= 1_000_000_000 else { return .failure(.denied) }
        guard let afterApproval = Self.monotonicNs(), afterApproval < deadline,
              afterApproval < registrationDeadline, revision == before, active === self.active else { return .failure(.denied) }
        guard current(handle.epoch), revision == before, active === self.active,
              let beforeNative = Self.monotonicNs(), beforeNative < deadline,
              beforeNative < registrationDeadline else { return .failure(.denied) }
        guard let rss = Self.selfResidentBytes() else { return .failure(.unavailable) }
        guard let captured = Self.monotonicNs(), captured < deadline, captured < registrationDeadline,
              revision == before, active === self.active, current(handle.epoch) else { return .failure(.stale) }
        guard let final = Self.monotonicNs(), final < deadline, final < registrationDeadline,
              revision == before, active === self.active else { return .failure(.stale) }
        guard sequence < 32 else { return .failure(.limit) }
        sequence += 1
        return .success(RssSample(epoch: handle.epoch, sequence: sequence, capturedAtNs: captured, rssBytes: rss))
    }

    /// Invalidates the handle before any later callback can run.
    public func stop() {
        guard pthread_equal(ownerThread, pthread_self()) != 0 else { return }
        revision &+= 1; active = nil; registrationDeadline = 0
    }
}
