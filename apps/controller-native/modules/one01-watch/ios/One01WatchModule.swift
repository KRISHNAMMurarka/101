import ExpoModulesCore
import WatchConnectivity

/**
 Phone-side receiver for wrist samples relayed by the 101 Apple Watch companion.

 This is the counterpart of `apps/watch-ios`. The watch sends interactive `sendMessageData`
 payloads; this activates the session, forwards each payload to JavaScript, and reports companion
 state so `@101/adapter-watch` can decide how honestly the route may be described.

 Only interactive messaging is handled. `didReceiveUserInfo` and `didReceiveApplicationContext`
 are deliberately not implemented: those arrive long after the moment they describe, which is worse
 than nothing for a controller.
 */
public final class One01WatchModule: Module {
  private let relay = WatchRelay()

  public func definition() -> ModuleDefinition {
    Name("One01Watch")

    Events("onWatchSample", "onWatchLinkChange", "onWatchResourceSample", "onWatchResourceLoss")

    OnCreate {
      self.relay.onSample = { [weak self] data in
        self?.sendEvent("onWatchSample", ["data": data.base64EncodedString()])
      }
      self.relay.onResourceSample = { [weak self] epoch, data in
        self?.sendEvent("onWatchResourceSample", ["epoch": epoch, "data": data.base64EncodedString()])
      }
      self.relay.onResourceLoss = { [weak self] epoch in
        self?.sendEvent("onWatchResourceLoss", ["epoch": epoch])
      }
      self.relay.onLinkChange = { [weak self] snapshot in
        self?.sendEvent("onWatchLinkChange", snapshot)
      }
    }

    Function("isSupported") { () -> Bool in
      WCSession.isSupported()
    }

    AsyncFunction("start") { () -> [String: Any] in
      self.relay.start()
      return self.relay.snapshot()
    }

    AsyncFunction("stop") {
      self.relay.stop()
    }

    AsyncFunction("getLinkState") { () -> [String: Any] in
      self.relay.snapshot()
    }

    AsyncFunction("enrollResources") { () -> [String: Any] in
      try self.relay.enrollResources()
    }
    AsyncFunction("startResources") { (epoch: Int) in
      try self.relay.startResources(epoch)
    }
    AsyncFunction("stopResources") { (epoch: Int) in
      self.relay.stopResources(epoch)
    }

    AsyncFunction("playHaptic") {
      // A watch cannot be driven to vibrate directly from the phone; the watch app plays its own
      // haptic when it receives this. Reporting success here would be a lie if no route exists.
      try self.relay.sendControl(["haptic": true])
    }

    OnDestroy {
      self.relay.stop()
      self.relay.retireResources()
    }
  }
}

private final class WatchRelay: NSObject, WCSessionDelegate {
  var onSample: ((Data) -> Void)?
  var onLinkChange: (([String: Any]) -> Void)?

  private var session: WCSession? { WCSession.isSupported() ? .default : nil }
  private var started = false
  var onResourceSample: ((Int, Data) -> Void)?
  var onResourceLoss: ((Int) -> Void)?
  private let resourceLock = NSRecursiveLock()
  private var resourceEpoch = 0
  private var resourceAttempts = 0
  private var resourceEnrolled = false
  private var resourceStarted = false

  // WCSession identifies only the current paired session here, not a stable hardware identity.
  func enrollResources() throws -> [String: Any] {
    guard let session else { throw Exception(name: "WatchResourceUnavailable", description: "Watch resources unavailable.") }
    session.delegate = self
    if session.activationState != .activated { session.activate() }
    resourceLock.lock()
    defer { resourceLock.unlock() }
    guard !resourceEnrolled, resourceAttempts < 64 else {
      throw Exception(name: "WatchResourceBusy", description: "Watch resource scope unavailable.")
    }
    resourceAttempts += 1
    resourceEpoch += 1
    resourceEnrolled = true
    var result = snapshot()
    result["nearby"] = false
    result["epoch"] = resourceEpoch
    return result
  }

  func startResources(_ epoch: Int) throws {
    resourceLock.lock()
    defer { resourceLock.unlock() }
    guard resourceEnrolled, epoch == resourceEpoch, !resourceStarted,
          let session, session.activationState == .activated, session.isPaired,
          session.isWatchAppInstalled, session.isReachable else {
      throw Exception(name: "WatchResourceDenied", description: "Watch resource scope is not current.")
    }
    resourceStarted = true
  }

  func stopResources(_ epoch: Int) {
    resourceLock.lock()
    if resourceEnrolled && epoch == resourceEpoch { retireResources() }
    resourceLock.unlock()
  }

  func retireResources() {
    resourceLock.lock()
    guard resourceEnrolled else { resourceLock.unlock(); return }
    let retired = resourceEpoch
    resourceEnrolled = false
    resourceStarted = false
    resourceEpoch += 1
    resourceLock.unlock()
    onResourceLoss?(retired)
  }

  private func checkResources() {
    guard let session, session.activationState == .activated, session.isPaired,
          session.isWatchAppInstalled, session.isReachable else { retireResources(); return }
  }

  func start() {
    guard let session, !started else { return }
    started = true
    session.delegate = self
    if session.activationState != .activated { session.activate() }
    onLinkChange?(snapshot())
  }

  func stop() {
    started = false
  }

  func snapshot() -> [String: Any] {
    guard let session else {
      return ["platform": "watchos", "companionPaired": false, "appInstalled": false, "reachable": false]
    }
    return [
      "platform": "watchos",
      "companionPaired": session.isPaired,
      "appInstalled": session.isWatchAppInstalled,
      "reachable": session.isReachable && session.activationState == .activated,
    ]
  }

  func sendControl(_ message: [String: Any]) throws {
    guard let session, session.isReachable else {
      throw Exception(name: "WatchUnreachable", description: "No reachable 101 watch app.")
    }
    session.sendMessage(message, replyHandler: nil, errorHandler: nil)
  }

  // MARK: - WCSessionDelegate

  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    checkResources()
    onLinkChange?(snapshot())
  }

  func sessionDidBecomeInactive(_ session: WCSession) {
    retireResources()
    onLinkChange?(snapshot())
  }

  func sessionDidDeactivate(_ session: WCSession) {
    retireResources()
    // Reactivate so a watch swap does not silently end the controller for the rest of the session.
    session.activate()
    onLinkChange?(snapshot())
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    checkResources()
    onLinkChange?(snapshot())
  }

  func sessionWatchStateDidChange(_ session: WCSession) {
    retireResources()
    onLinkChange?(snapshot())
  }

  func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
    if started { onSample?(messageData) }
    guard messageData.count == 53 else { return }
    resourceLock.lock()
    let epoch = resourceEnrolled && resourceStarted ? resourceEpoch : nil
    resourceLock.unlock()
    guard let epoch else { return }
    checkResources()
    resourceLock.lock()
    let current = resourceEnrolled && resourceStarted && resourceEpoch == epoch
    resourceLock.unlock()
    if current { onResourceSample?(epoch, messageData) }
  }
}
