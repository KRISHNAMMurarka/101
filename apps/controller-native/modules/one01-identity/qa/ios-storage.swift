import Foundation
import UIKit

@main
final class IdentityFixtureApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = UIViewController()
    window?.makeKeyAndVisible()
    DispatchQueue.global().async { IdentityStorageFixture.run() }
    return true
  }
}

/** Isolated QA bundle/access group: actual production Keychain lifecycle. */
struct IdentityStorageFixture {
  static func check(_ value: Bool) throws {
    if !value { throw One01IdentityError.invalidKey }
  }
  static func rejects(_ operation: () throws -> Void) throws {
    do { try operation() } catch { return }
    throw One01IdentityError.invalidKey
  }
  static func run() {
    let store = One01IdentityStore.shared
    var output: [String: String] = [:]
    do {
      try check(try store.load() == nil)
      let first = try store.create()
      try check(try first == store.create() && first == store.load())
      let message = Data("101 iOS Keychain producer interoperability".utf8).base64EncodedString()
      let signature = try store.sign(expectedKeyId: first["keyId"]!, message: message)
      try check(try One01IdentityStore.verify(publicKey: first["publicKey"]!, message: message, signature: signature))
      try rejects { _ = try store.sign(expectedKeyId: String(repeating: "0", count: 64), message: message) }
      output = ["result": "passed", "publicKey": first["publicKey"]!, "signature": signature, "message": message,
                "protection": first["protection"]!]
      try store.remove()
      try check(try store.load() == nil)
      try rejects { _ = try store.sign(expectedKeyId: first["keyId"]!, message: message) }
      let replacement = try store.create()
      try check(replacement["keyId"] != first["keyId"])
      try rejects { _ = try store.sign(expectedKeyId: first["keyId"]!, message: message) }
    } catch { output = ["result": "failed", "failureType": String(describing: error)] }
    do { try store.remove() } catch { output["cleanup"] = "failed" }
    do {
      let path = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("result.json")
      try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]).write(to: path, options: .atomic)
    } catch { exit(1) }
  }
}
