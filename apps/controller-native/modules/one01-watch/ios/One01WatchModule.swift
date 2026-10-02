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

    Events("onWatchSample", "onWatchLinkChange")

    OnCreate {
      self.relay.onSample = { [weak self] data in
        self?.sendEvent("onWatchSample", ["data": data.base64EncodedString()])
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

    AsyncFunction("playHaptic") {
      // A watch cannot be driven to vibrate directly from the phone; the watch app plays its own
      // haptic when it receives this. Reporting success here would be a lie if no route exists.
      try self.relay.sendControl(["haptic": true])
    }

    OnDestroy {
      self.relay.stop()
    }
  }
}

private final class WatchRelay: NSObject, WCSessionDelegate {
  var onSample: ((Data) -> Void)?
  var onLinkChange: (([String: Any]) -> Void)?

  private var session: WCSession? { WCSession.isSupported() ? .default : nil }
  private var started = false

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
    onLinkChange?(snapshot())
  }

  func sessionDidBecomeInactive(_ session: WCSession) {
    onLinkChange?(snapshot())
  }

  func sessionDidDeactivate(_ session: WCSession) {
    // Reactivate so a watch swap does not silently end the controller for the rest of the session.
    session.activate()
    onLinkChange?(snapshot())
  }

  func sessionReachabilityDidChange(_ session: WCSession) {
    onLinkChange?(snapshot())
  }

  func sessionWatchStateDidChange(_ session: WCSession) {
    onLinkChange?(snapshot())
  }

  func session(_ session: WCSession, didReceiveMessageData messageData: Data) {
    guard started else { return }
    onSample?(messageData)
  }
}
