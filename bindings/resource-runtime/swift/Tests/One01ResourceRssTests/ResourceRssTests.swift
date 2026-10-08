import Foundation
import Testing
@testable import One01ResourceRss

private final class ApprovalFixture {
    var register = false, read = false, current = false, expire = false, delay = false, stopDuringApproval = false
    weak var runtime: ResourceRssRuntime?
    func approve(_ action: RssAction, _: UInt64, _ now: UInt64) -> UInt64? {
        if stopDuringApproval { runtime?.stop() }
        guard action == .register ? register : read else { return nil }
        let span: UInt64 = expire ? 0 : delay ? 1_000_000 : action == .register ? 10_000_000_000 : 1_000_000_000
        if delay { Thread.sleep(forTimeInterval: 0.003) }
        return now + span
    }
}
private func failure<T>(_ result: Result<T, RssStatus>) -> RssStatus? {
    if case .failure(let status) = result { return status }
    return nil
}

@Test func canonicalSelectedSelfRssLifecycle() throws {
    let path = try #require(Bundle.module.url(forResource: "rss-cases", withExtension: "json"))
    let fixture = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any])
    #expect(fixture["profile"] as? String == "self-current-rss-macos-mach/1")
    #expect(fixture["clock"] as? String == "CLOCK_MONOTONIC-ns")
    let names = try #require(fixture["cases"] as? [String])
    var passed: [String] = []
    func check(_ name: String, _ condition: Bool) { #expect(condition, "\(name)"); passed.append(name) }

    let f = ApprovalFixture()
    let runtime = ResourceRssRuntime(approve: f.approve, current: { _ in f.current }); f.runtime = runtime
    check("denied-register", failure(runtime.start(epoch: 11)) == .denied)
    f.register = true; f.current = true; f.expire = true
    check("expired-register", failure(runtime.start(epoch: 11)) == .denied)
    f.expire = false; f.stopDuringApproval = true
    check("stop-during-register", failure(runtime.start(epoch: 11)) == .denied)
    f.stopDuringApproval = false
    let first = try runtime.start(epoch: 11).get()
    check("accepted-register", first.epoch == 11)
    check("busy-register", failure(runtime.start(epoch: 12)) == .busy)
    let other = ResourceRssRuntime(approve: { _, _, now in now + 1_000_000_000 }, current: { _ in true })
    let foreign = try other.start(epoch: 99).get()
    check("foreign-handle", failure(runtime.read(foreign)) == .stale)
    check("denied-read", failure(runtime.read(first)) == .denied)
    f.read = true; f.expire = true
    check("expired-read", failure(runtime.read(first)) == .denied)
    f.expire = false
    let sample = try runtime.read(first).get()
    check("current-rss-read", sample.epoch == 11 && sample.sequence == 1 && sample.rssBytes > 0 && sample.capturedAtNs > 0)
    f.delay = true
    check("delayed-read-approval", failure(runtime.read(first)) == .denied)
    f.delay = false; f.current = false
    check("current-revoked", failure(runtime.read(first)) == .denied)
    f.current = true; f.stopDuringApproval = true
    check("stop-during-read", failure(runtime.read(first)) == .denied)
    f.stopDuringApproval = false
    let second = try runtime.start(epoch: 12).get()
    check("old-generation-stale", failure(runtime.read(first)) == .stale)
    let replacement = try runtime.read(second).get()
    check("replacement-read", replacement.epoch == 12 && replacement.sequence == 1 && replacement.rssBytes > 0)
    var last = replacement
    for _ in 2...32 { last = try runtime.read(second).get() }
    check("thirty-two-reads", last.sequence == 32 && failure(runtime.read(second)) == .limit)
    runtime.stop()
    check("stop-stale", failure(runtime.read(second)) == .stale)
    check("two-generation-limit", failure(runtime.start(epoch: 13)) == .limit)
    #expect(passed == names)
}

@Test func nestedReadCannotConsumeTheLastSlotBeforeItsOuterRead() throws {
    var runtime: ResourceRssRuntime!
    var handle: RssHandle!
    var reenter = false
    var nested: Result<RssSample, RssStatus>?
    runtime = ResourceRssRuntime(approve: { action, _, now in
        now + (action == .register ? 10_000_000_000 : 1_000_000_000)
    }, current: { _ in
        if reenter {
            reenter = false
            nested = runtime.read(handle)
        }
        return true
    })
    handle = try runtime.start(epoch: 91).get()
    for expected in 1...31 { #expect(try runtime.read(handle).get().sequence == expected) }
    reenter = true
    #expect(try runtime.read(handle).get().sequence == 32)
    #expect(nested.flatMap(failure) == .busy)
    #expect(failure(runtime.read(handle)) == .limit)
}

@Test func nestedStartCannotClaimAnotherGenerationDuringApproval() throws {
    var runtime: ResourceRssRuntime!
    var reenter = true
    var nested: Result<RssHandle, RssStatus>?
    runtime = ResourceRssRuntime(approve: { action, _, now in
        if action == .register && reenter {
            reenter = false
            nested = runtime.start(epoch: 92)
        }
        return now + 10_000_000_000
    }, current: { _ in true })
    #expect(try runtime.start(epoch: 91).get().epoch == 91)
    #expect(nested.flatMap(failure) == .busy)
}
