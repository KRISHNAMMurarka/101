import Foundation
import Testing
@testable import One01WatchCore

@Test func payloadSurvivesARoundTrip() throws {
    let payload = WatchPayload(
        sequence: 4321,
        milliseconds: 1_234_567,
        orientation: (0.1, -0.2, 0.3, 0.927),
        acceleration: (0.5, -1.25, 0.125),
        rotationRate: (120.5, -45.25, 8),
        crown: 42.5,
        tap: true
    )
    let encoded = payload.encoded()
    #expect(encoded.count == WatchPayload.byteCount)
    let decoded = try #require(WatchPayload.decode(encoded))
    #expect(decoded == payload)
}

@Test func decodeRejectsJunkInsteadOfTrapping() {
    #expect(WatchPayload.decode(Data()) == nil)
    #expect(WatchPayload.decode(Data(repeating: 0, count: WatchPayload.byteCount)) == nil, "a zeroed buffer has no magic byte")
    #expect(WatchPayload.decode(Data(repeating: 0x31, count: 8)) == nil, "a short packet is rejected")

    var wrongVersion = WatchPayload(sequence: 1, milliseconds: 1, orientation: (0, 0, 0, 1), acceleration: (0, 0, 0), rotationRate: (0, 0, 0), crown: 0, tap: false).encoded()
    wrongVersion[1] = 99
    #expect(WatchPayload.decode(wrongVersion) == nil, "an unknown protocol version is rejected")

    var notFinite = WatchPayload(sequence: 1, milliseconds: 1, orientation: (0, 0, 0, 1), acceleration: (0, 0, 0), rotationRate: (0, 0, 0), crown: 0, tap: false).encoded()
    let nan = Float.nan.bitPattern
    for index in 0..<4 { notFinite[8 + index] = UInt8((nan >> UInt32(index * 8)) & 0xFF) }
    #expect(WatchPayload.decode(notFinite) == nil, "a non-finite quaternion must never reach the motion pipeline")
}

@Test func localityIsOnlyClaimedWhenTheCounterpartIsReachable() {
    #expect(WatchLinkState().locality == .unknown)
    #expect(WatchLinkState(companionPaired: true, appInstalled: false, reachable: false).locality == .unknown)
    #expect(WatchLinkState(companionPaired: true, appInstalled: true, reachable: false).locality == .unknown)

    let live = WatchLinkState(companionPaired: true, appInstalled: true, reachable: true)
    #expect(live.locality == .verifiedLocal)
    #expect(live.canRelayRealtime)
}

@Test func samplePolicyRateLimitsMotionButAlwaysReportsSettling() {
    var policy = WatchSamplePolicy(hertz: 50, idleHertz: 6)
    // The macro cannot call a mutating method inline, so each decision is taken first.
    let first = policy.shouldSend(at: 0, magnitude: 1, tap: false)
    let tooSoon = policy.shouldSend(at: 0.005, magnitude: 1, tap: false)
    let due = policy.shouldSend(at: 0.03, magnitude: 1, tap: false)
    let settled = policy.shouldSend(at: 0.031, magnitude: 0, tap: false)
    let stillTooSoon = policy.shouldSend(at: 0.04, magnitude: 0, tap: false)
    let idleDue = policy.shouldSend(at: 0.25, magnitude: 0, tap: false)

    #expect(first, "the first moving sample is sent")
    #expect(!tooSoon, "50 Hz means 5 ms later is too soon")
    #expect(due)
    // Coming to rest must reach the game, otherwise the last motion stays applied forever.
    #expect(settled, "settling is always reported")
    #expect(!stillTooSoon, "a still wrist then drops to the idle rate")
    #expect(idleDue)
}

@Test func tapsAreNeverRateLimitedAway() {
    var policy = WatchSamplePolicy(hertz: 50, idleHertz: 6)
    let first = policy.shouldSend(at: 0, magnitude: 1, tap: false)
    let tap = policy.shouldSend(at: 0.001, magnitude: 1, tap: true)
    #expect(first)
    #expect(tap, "a discrete tap outranks the rate limit")
}
