import Foundation

/// How honestly 101 can describe the route a wrist sample takes.
///
/// This mirrors `WatchLocality` in `@101/adapter-watch` so the watch, the phone and the game all
/// use one vocabulary. Watch Connectivity moves data between a watch and its own paired iPhone,
/// so an interactive message to a reachable counterpart is genuinely device-to-device. The value
/// is never upgraded on optimism: if the counterpart is not reachable, the route is `unknown`.
public enum WatchLocality: String, Sendable {
    case verifiedLocal = "verified-local"
    case assumedLocal = "assumed-local"
    case cloudPossible = "cloud-possible"
    case unknown
}

public struct WatchLinkState: Equatable, Sendable {
    public var companionPaired: Bool
    public var appInstalled: Bool
    public var reachable: Bool

    public init(companionPaired: Bool = false, appInstalled: Bool = false, reachable: Bool = false) {
        self.companionPaired = companionPaired
        self.appInstalled = appInstalled
        self.reachable = reachable
    }

    public var locality: WatchLocality {
        guard companionPaired, appInstalled, reachable else { return .unknown }
        return .verifiedLocal
    }

    /// Interactive messaging is the only path 101 uses for gameplay. Queued background transfers
    /// would arrive minutes later, which is worse than dropping the sample outright.
    public var canRelayRealtime: Bool { locality == .verifiedLocal }

    public var note: String {
        if !companionPaired { return "No paired iPhone." }
        if !appInstalled { return "101 Link is not installed on the paired iPhone." }
        if !reachable { return "101 Link is not running on the iPhone." }
        return "Connected directly to the paired iPhone."
    }
}

/// Decides which samples are worth sending.
///
/// The motion sensor can run far faster than the link needs. Sending every reading would flood a
/// Bluetooth channel that also carries the game's own traffic, so the relay drops to a fixed
/// budget and, crucially, still sends when the wrist becomes still — otherwise a game would keep
/// applying the last motion sample after the wearer stopped moving.
public struct WatchSamplePolicy: Sendable {
    public let minimumInterval: TimeInterval
    public let idleInterval: TimeInterval
    public let motionEpsilon: Double

    private var lastSentAt: TimeInterval = -.infinity
    private var lastWasMoving = false

    public init(hertz: Double = 50, idleHertz: Double = 6, motionEpsilon: Double = 0.02) {
        precondition(hertz > 0 && idleHertz > 0, "Watch sample rates must be positive")
        self.minimumInterval = 1 / hertz
        self.idleInterval = 1 / idleHertz
        self.motionEpsilon = motionEpsilon
    }

    /// - Parameter magnitude: combined motion magnitude for this reading.
    /// - Returns: whether this sample should go on the wire.
    public mutating func shouldSend(at timestamp: TimeInterval, magnitude: Double, tap: Bool) -> Bool {
        // A tap is a discrete intent. Never rate-limit it away.
        if tap {
            lastSentAt = timestamp
            lastWasMoving = magnitude > motionEpsilon
            return true
        }

        let moving = magnitude > motionEpsilon
        // The transition from moving to still must reach the game, or the last motion sticks.
        let settled = lastWasMoving && !moving
        let interval = moving ? minimumInterval : idleInterval
        let due = timestamp - lastSentAt >= interval

        guard settled || due else { return false }
        lastSentAt = timestamp
        lastWasMoving = moving
        return true
    }

    public mutating func reset() {
        lastSentAt = -.infinity
        lastWasMoving = false
    }
}
