import Foundation
import One01WatchCore
import WatchConnectivity

/// Relays wrist samples to 101 Link on the paired iPhone.
///
/// Watch Connectivity offers several delivery modes. 101 uses `sendMessageData` only: it is the
/// interactive, low-latency path that requires a reachable counterpart. `transferUserInfo` and
/// `updateApplicationContext` are deliberately unused — they queue and may arrive long after the
/// moment they describe, which is worse than nothing for a controller. When the counterpart is not
/// reachable, samples are dropped rather than buffered.
@MainActor
final class WatchSessionRelay: NSObject, ObservableObject {
    @Published private(set) var link = WatchLinkState()
    @Published private(set) var sentCount: UInt32 = 0
    @Published private(set) var droppedCount: UInt32 = 0
    @Published private(set) var lastError: String?

    private var policy = WatchSamplePolicy()
    private var sequence: UInt16 = 0
    private var startedAt = Date()
    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    var localityText: String { link.locality.rawValue }
    var statusNote: String { session == nil ? "Watch Connectivity is unavailable on this device." : link.note }

    func activate() {
        guard let session else { return }
        session.delegate = self
        session.activate()
        startedAt = Date()
        policy.reset()
    }

    /// Called for every motion reading. Rate limiting happens here rather than at the sensor so a
    /// settling wrist still produces one final sample.
    func relay(orientation: (x: Float, y: Float, z: Float, w: Float),
               acceleration: (x: Float, y: Float, z: Float),
               rotationRate: (x: Float, y: Float, z: Float),
               crown: Float,
               tap: Bool) {
        guard let session, link.canRelayRealtime else {
            if tap { droppedCount &+= 1 }
            return
        }

        let magnitude = Double(abs(acceleration.x) + abs(acceleration.y) + abs(acceleration.z))
            + Double(abs(rotationRate.x) + abs(rotationRate.y) + abs(rotationRate.z)) / 180
        let now = Date().timeIntervalSince(startedAt)
        guard policy.shouldSend(at: now, magnitude: magnitude, tap: tap) else { return }

        sequence &+= 1
        let payload = WatchPayload(
            sequence: sequence,
            milliseconds: UInt32(truncatingIfNeeded: Int(now * 1000)),
            orientation: orientation,
            acceleration: acceleration,
            rotationRate: rotationRate,
            crown: crown,
            tap: tap
        )

        session.sendMessageData(payload.encoded(), replyHandler: nil) { [weak self] error in
            Task { @MainActor in
                self?.droppedCount &+= 1
                self?.lastError = error.localizedDescription
            }
        }
        sentCount &+= 1
    }

    fileprivate func refresh(from session: WCSession) {
        link = WatchLinkState(
            companionPaired: true,
            appInstalled: session.isCompanionAppInstalled,
            reachable: session.isReachable
        )
        if !link.canRelayRealtime { policy.reset() }
    }
}

extension WatchSessionRelay: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let installed = session.isCompanionAppInstalled
        let reachable = session.isReachable
        let message = error?.localizedDescription
        Task { @MainActor [weak self] in
            self?.link = WatchLinkState(companionPaired: state == .activated, appInstalled: installed, reachable: reachable)
            if let message { self?.lastError = message }
        }
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor [weak self] in self?.refresh(from: session) }
    }

    nonisolated func sessionCompanionAppInstalledDidChange(_ session: WCSession) {
        Task { @MainActor [weak self] in self?.refresh(from: session) }
    }
}
